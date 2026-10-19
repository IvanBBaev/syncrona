// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The `.gitignore` inside `.mirror/` (design §8.1, INV-1).
 *
 * This scaffold has one job and it is load-bearing for an invariant that lives in
 * another file entirely. INV-1 says a second sync of an unchanged instance leaves a
 * byte-identical tree — and the mirror's own state does not stand still: the resume
 * checkpoint is written and deleted every run, and the run counter is incremented by
 * every run that completes. Without this file, `git status` reports `.mirror/` as
 * untracked on the very first sync, and the first `git add -A` in any wrapper
 * commits one machine's cadence position into everyone else's clone.
 *
 * Two properties therefore carry the whole module, and both are asserted below
 * rather than assumed:
 *
 *  - the pattern is `*` with NO `!.gitignore` exception, so git — which applies a
 *    directory's ignore file to that file too — hides the entire directory instead
 *    of leaving the scaffold itself untracked forever;
 *  - the file sits INSIDE the directory it hides, so the mirror never half-owns a
 *    root `.gitignore` a human wrote (the merge problem `provisionGitAttributes`
 *    explicitly refuses).
 *
 * The provisioning tests mirror `gitAttributes.test.ts` one for one, including the
 * same-length tamper: a comparison that stopped at the byte count would call a
 * file whose `*` was edited to `#` current, and the directory would silently become
 * visible again.
 */
import {
  buildMirrorGitIgnore,
  MIRROR_IGNORE_REL_PATH,
  provisionMirrorGitIgnore,
} from "../src/write/gitIgnore";
import { CHECKPOINT_REL_PATH } from "../src/write/sweepProgress";
import { MemoryFs, ROOT, mutatingCalls, relToNative, resetCalls } from "./statusFixtures";

const textOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8");

/** The lines git acts on — comments and blank separators dropped. */
const patterns = (bytes: Uint8Array): string[] =>
  textOf(bytes)
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"));

const onDisk = (fs: MemoryFs): Uint8Array | undefined =>
  fs.files.get(relToNative(MIRROR_IGNORE_REL_PATH));

/** The directory the scaffold hides — `.mirror`, derived rather than restated. */
const MIRROR_DIR = MIRROR_IGNORE_REL_PATH.slice(0, MIRROR_IGNORE_REL_PATH.indexOf("/"));

describe("buildMirrorGitIgnore", () => {
  it("ignores everything in the directory, with no exception for itself", () => {
    // A `!.gitignore` line would leave this file — and only this file — visible,
    // so every fresh clone of the mirror would carry a scaffold nobody wrote and
    // `git status` would never be clean until somebody committed it.
    expect(patterns(buildMirrorGitIgnore())).toEqual(["*"]);
  });

  it("is canonical text: LF only, exactly one trailing newline", () => {
    const text = textOf(buildMirrorGitIgnore());
    expect(text).not.toContain("\r");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("is a pure function — two builds are byte-identical (INV-1)", () => {
    expect(buildMirrorGitIgnore()).toEqual(buildMirrorGitIgnore());
  });
});

describe("MIRROR_IGNORE_REL_PATH", () => {
  it("sits inside the directory that holds the checkpoint and the counter", () => {
    // Derived from `CHECKPOINT_REL_PATH` in production and re-derived here, so a
    // §3 rename of `.mirror/` that moved one and not the other fails this test
    // rather than quietly exposing the state directory.
    expect(MIRROR_IGNORE_REL_PATH).toBe(
      `${CHECKPOINT_REL_PATH.slice(0, CHECKPOINT_REL_PATH.indexOf("/"))}/.gitignore`
    );
    expect(CHECKPOINT_REL_PATH.startsWith(`${MIRROR_DIR}/`)).toBe(true);
  });
});

describe("provisionMirrorGitIgnore", () => {
  it("writes the scaffold atomically, creating the directory it hides (R4)", async () => {
    const fs = new MemoryFs();
    await provisionMirrorGitIgnore(fs, ROOT);

    expect(onDisk(fs)).toEqual(buildMirrorGitIgnore());
    expect(
      mutatingCalls(fs).some(
        (line) => line.startsWith("rename ") && line.includes(".mirror-tmp-")
      )
    ).toBe(true);
  });

  it("performs no write when the file on disk already matches", async () => {
    // Every run provisions, so the no-op path is the common one. Rewriting an
    // identical file restamps the mtime of the directory git stats on every
    // `git status`, which is exactly the fsmonitor churn the read-and-compare
    // exists to avoid.
    const fs = new MemoryFs();
    await provisionMirrorGitIgnore(fs, ROOT);
    resetCalls(fs);

    await provisionMirrorGitIgnore(fs, ROOT);
    expect(mutatingCalls(fs)).toEqual([]);
    expect(onDisk(fs)).toEqual(buildMirrorGitIgnore());
  });

  it("notices an edit that kept the file the same length", async () => {
    // `*` commented out to `#` is one byte swapped in place, and it is what a
    // debugging session leaves behind after somebody wanted to see the
    // checkpoint in `git status` once. A comparison that stopped at the byte
    // count would call the file current and leave the state directory visible.
    const desired = buildMirrorGitIgnore();
    const tampered = Buffer.from(`${textOf(desired).slice(0, -2)}#\n`, "utf8");
    expect(tampered.length).toBe(desired.length);
    expect(patterns(tampered)).toEqual([]);

    const fs = new MemoryFs();
    await fs.makeDir(relToNative(MIRROR_DIR));
    await fs.writeFile(relToNative(MIRROR_IGNORE_REL_PATH), tampered);
    resetCalls(fs);

    await provisionMirrorGitIgnore(fs, ROOT);
    expect(onDisk(fs)).toEqual(desired);
  });

  it("replaces a shorter hand-edited file — the scaffold is generated, not merged", async () => {
    const fs = new MemoryFs();
    await fs.makeDir(relToNative(MIRROR_DIR));
    await fs.writeFile(
      relToNative(MIRROR_IGNORE_REL_PATH),
      Buffer.from("checkpoint.json\n", "utf8")
    );

    await provisionMirrorGitIgnore(fs, ROOT);
    // The hand-written pattern ignored the checkpoint and nothing else, so the
    // run counter would have been left visible. Generated wins.
    expect(patterns(onDisk(fs) as Uint8Array)).toEqual(["*"]);
  });

  it("self-heals a tree provisioned by a build that predates the file", async () => {
    // The state directory exists (an older build wrote a checkpoint into it) but
    // holds no ignore file. Per-run provisioning is what reaches this case;
    // `mirror init` cannot, because init runs before `.mirror/` exists at all.
    const fs = new MemoryFs();
    await fs.makeDir(relToNative(MIRROR_DIR));
    await provisionMirrorGitIgnore(fs, ROOT);
    expect(onDisk(fs)).toEqual(buildMirrorGitIgnore());
  });
});
