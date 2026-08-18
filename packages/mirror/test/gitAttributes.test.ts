// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The repository-root `.gitattributes` scaffold (§5.13, design §8.1, WP-M12).
 *
 * Three lines of policy carry this file, and each of them fails in a way that no
 * unit test of any other module could see:
 *
 *  * `* text=auto eol=lf` — INV-1 says an unchanged instance produces a
 *    byte-identical tree. A Windows checkout without this line rewrites every
 *    text file to CRLF, so the tree the mirror wrote and the tree git checked
 *    out disagree on every byte of every record, forever.
 *  * `_derived/** linguist-generated` — INV-9's views are regenerated wholesale,
 *    so they churn. Marking them keeps a review of a real change from being
 *    buried under them.
 *  * the attachment stanza — attachment bytes ARE the artifact, so a
 *    normalization pass over them is corruption, not tidying.
 *
 * The assertions below are deliberately about the DIRECTIVE lines rather than
 * about the whole blob. A golden over every byte would make the explanatory
 * comments in the generated file part of the contract, and the next person to
 * improve a sentence would be told they broke a test; the comments are for the
 * human reading the mirror repo, the directives are what git obeys.
 */
import { loadMirrorConfig } from "../src/config/loadConfig";
import type { MirrorConfig } from "../src/contracts";
import { DERIVED_DIR_NAME } from "../src/derived/render";
import {
  buildRootGitAttributes,
  GITATTRIBUTES_FILE_NAME,
  provisionGitAttributes,
} from "../src/write/gitAttributes";
import { MemoryFs, ROOT, mutatingCalls, relToNative, resetCalls } from "./statusFixtures";

const configWith = (attachmentsEnabled: boolean): MirrorConfig =>
  loadMirrorConfig({ attachments: { enabled: attachmentsEnabled } });

const textOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8");

/** The lines git acts on — comments and blank separators dropped. */
function directives(bytes: Uint8Array): string[] {
  return textOf(bytes)
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"));
}

describe("buildRootGitAttributes — the directives §5.13 names", () => {
  it("emits the three §5.13 lines when attachments are enabled", () => {
    expect(directives(buildRootGitAttributes(configWith(true)))).toEqual([
      "* text=auto eol=lf",
      "_derived/** linguist-generated",
      "attachments/** -text",
    ]);
  });

  it("omits the attachment stanza when attachments are disabled", () => {
    // A repository that will never hold an attachment should not carry a rule
    // about a directory it will never have: the file is read by humans too, and
    // a stanza about attachments is a claim that there are some.
    expect(directives(buildRootGitAttributes(configWith(false)))).toEqual([
      "* text=auto eol=lf",
      "_derived/** linguist-generated",
    ]);
  });

  it("never declares a global LFS filter", () => {
    // §5.13: "LFS patterns only under attachment paths". A `filter=lfs` line at
    // the root would route `record.json` through a pointer file, which forfeits
    // exactly the delta compression that makes git cheap for text — the measured
    // loss `LFS_THRESHOLD_BYTES` exists to avoid.
    for (const enabled of [true, false]) {
      expect(textOf(buildRootGitAttributes(configWith(enabled)))).not.toContain(
        "filter=lfs"
      );
    }
  });

  it("marks the directory `derived/` actually writes to", () => {
    // The builder spells `_derived/**` as a git pattern instead of importing the
    // constant (a `write/` -> `derived/` edge for one token). This assertion is
    // what makes a rename of that directory a test failure rather than a tree
    // that quietly stops being marked as generated.
    expect(directives(buildRootGitAttributes(configWith(true)))).toContain(
      `${DERIVED_DIR_NAME}/** linguist-generated`
    );
  });

  it("is canonical text: LF only, exactly one trailing newline", () => {
    const text = textOf(buildRootGitAttributes(configWith(true)));
    expect(text).not.toContain("\r");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("is a pure function of the config — two builds are byte-identical", () => {
    // Nothing dated, nothing random: INV-1 reaches the scaffold too.
    expect(buildRootGitAttributes(configWith(true))).toEqual(
      buildRootGitAttributes(configWith(true))
    );
  });
});

describe("provisionGitAttributes", () => {
  it("writes the file at the repository root", async () => {
    const fs = new MemoryFs();
    await provisionGitAttributes(fs, ROOT, configWith(true));

    const written = fs.files.get(relToNative(GITATTRIBUTES_FILE_NAME));
    expect(written).toEqual(buildRootGitAttributes(configWith(true)));
  });

  it("writes atomically — the bytes arrive through a staging rename (R4)", async () => {
    const fs = new MemoryFs();
    await provisionGitAttributes(fs, ROOT, configWith(true));

    expect(
      mutatingCalls(fs).some((line) => line.startsWith("rename ") && line.includes(".mirror-tmp-"))
    ).toBe(true);
  });

  it("performs no write when the file on disk already matches", async () => {
    // `mirror init` is re-runnable, and a re-run that rewrites an identical file
    // still touches its mtime — which is enough to make a watched working tree
    // and every fsmonitor downstream of it re-stat the repository for nothing.
    const fs = new MemoryFs();
    await provisionGitAttributes(fs, ROOT, configWith(true));
    resetCalls(fs);

    await provisionGitAttributes(fs, ROOT, configWith(true));
    expect(mutatingCalls(fs)).toEqual([]);
  });

  it("rewrites the file when the config changed the directives", async () => {
    const fs = new MemoryFs();
    await provisionGitAttributes(fs, ROOT, configWith(false));
    resetCalls(fs);

    await provisionGitAttributes(fs, ROOT, configWith(true));
    expect(mutatingCalls(fs)).not.toEqual([]);
    expect(directives(fs.files.get(relToNative(GITATTRIBUTES_FILE_NAME)) as Uint8Array)).toContain(
      "attachments/** -text"
    );
  });

  it("notices an edit that kept the file the same length", async () => {
    // `eol=lf` -> `eol=cr` is two bytes swapped in place, and it is exactly the
    // edit someone reaches for after a bad day with a Windows checkout. A
    // same-length comparison that stopped at the byte count would call this file
    // current and leave the setting that INV-1 depends on inverted forever.
    const desired = buildRootGitAttributes(configWith(true));
    const tampered = Buffer.from(textOf(desired).replace("eol=lf", "eol=cr"), "utf8");
    expect(tampered.length).toBe(desired.length);

    const fs = new MemoryFs();
    await fs.makeDir(ROOT);
    await fs.writeFile(relToNative(GITATTRIBUTES_FILE_NAME), tampered);
    resetCalls(fs);

    await provisionGitAttributes(fs, ROOT, configWith(true));
    expect(fs.files.get(relToNative(GITATTRIBUTES_FILE_NAME))).toEqual(desired);
  });

  it("replaces a hand-edited file — the scaffold is generated, not merged", async () => {
    const fs = new MemoryFs();
    await fs.makeDir(ROOT);
    await fs.writeFile(relToNative(GITATTRIBUTES_FILE_NAME), Buffer.from("* -text\n"));

    await provisionGitAttributes(fs, ROOT, configWith(true));
    expect(directives(fs.files.get(relToNative(GITATTRIBUTES_FILE_NAME)) as Uint8Array)).toEqual([
      "* text=auto eol=lf",
      "_derived/** linguist-generated",
      "attachments/** -text",
    ]);
  });
});
