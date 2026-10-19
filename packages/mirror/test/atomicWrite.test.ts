// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * R4 — "any failure leaves the tree in the pre-write or post-write state, never in
 * between" (acceptance criterion 1, §12).
 *
 * The test that would be easy to write here is the one that proves nothing: a fake
 * filesystem, a fake rename, and an assertion that the fake agreed with itself.
 * Atomicity is a property of the real `rename(2)`, so the production code runs
 * against a REAL temporary directory throughout this file. The only thing faked is
 * the moment of death.
 *
 * Death is modelled by a seam that starts failing at call N and never stops — which
 * is what a `SIGKILL` looks like from the filesystem's point of view, and is
 * strictly harsher than the alternative, because it also denies the cleanup handler
 * the chance to tidy up. The sweep runs N over every call the write makes, so no
 * step is left untested by an off-by-one in the harness.
 *
 * A `spawnSync` child that is really killed was considered and rejected: the child
 * cannot load the ts-jest-compiled module, so it would have to re-implement the
 * write sequence, and a test that re-implements the code under test measures the
 * copy. Interrupting the real function is both closer to the truth and precise about
 * where the interruption lands.
 *
 * Non-vacuity is carried by `naiveWriteFile` at the bottom: the same assertions are
 * run against a deliberately non-atomic write, and they must FAIL to hold. Without
 * that control, "the destination is either old or new" is a sentence that would also
 * pass if the harness never actually interrupted anything.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  atomicRemoveDir,
  atomicWriteFile,
  isStagingName,
  removeFileIfPresent,
  STAGING_PREFIX,
  stagingSiblingOf,
} from "../src/write/atomicWrite";
import {
  nodeWriterFs,
  toNativePath,
  type WriterDirEntry,
  type WriterFs,
} from "../src/write/fs";

const OLD_BYTES = Buffer.from("previous contents\n", "utf8");
const NEW_BYTES = Buffer.from(`${"x".repeat(4096)}\n`, "utf8");

class SimulatedCrash extends Error {
  constructor(operation: string) {
    super(`simulated process death during ${operation}`);
    this.name = "SimulatedCrash";
  }
}

/**
 * A real filesystem that dies at the Nth call and stays dead.
 *
 * "Stays dead" matters: `atomicWriteFile` has a cleanup handler that removes the
 * staging file when the rename fails, and a seam that recovered after one throw
 * would let the cleanup run — which a killed process never gets to do. Keeping every
 * later call failing measures the harsher, more honest case.
 */
class DyingFs implements WriterFs {
  readonly operations: string[] = [];
  private seen = 0;
  private dead = false;

  constructor(
    private readonly inner: WriterFs,
    private readonly dieAt: number
  ) {}

  private gate(operation: string): void {
    this.operations.push(operation);
    this.seen += 1;
    if (this.dead || this.seen >= this.dieAt) {
      this.dead = true;
      throw new SimulatedCrash(operation);
    }
  }

  async makeDir(dir: string): Promise<void> {
    this.gate("makeDir");
    return this.inner.makeDir(dir);
  }
  async writeFile(filePath: string, bytes: Uint8Array): Promise<void> {
    this.gate("writeFile");
    return this.inner.writeFile(filePath, bytes);
  }
  async rename(from: string, to: string): Promise<void> {
    this.gate("rename");
    return this.inner.rename(from, to);
  }
  async readFile(filePath: string): Promise<Uint8Array | null> {
    this.gate("readFile");
    return this.inner.readFile(filePath);
  }
  async readDir(dir: string): Promise<WriterDirEntry[] | null> {
    this.gate("readDir");
    return this.inner.readDir(dir);
  }
  async removeRecursive(target: string): Promise<void> {
    this.gate("removeRecursive");
    return this.inner.removeRecursive(target);
  }
}

/** A deliberately non-atomic write — the control that makes the assertions bite. */
async function naiveWriteFile(
  fs: WriterFs,
  filePath: string,
  bytes: Uint8Array
): Promise<void> {
  const half = Math.floor(bytes.length / 2);
  await fs.writeFile(filePath, bytes.slice(0, half));
  await fs.writeFile(filePath, bytes);
}

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "syncrona-atomic-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("R4: atomic file replacement", () => {
  it("stages beside the destination, so rename can never cross a filesystem", () => {
    // EXDEV is the failure that tempts a copy-then-unlink fallback, and a
    // copy-then-unlink fallback is a non-atomic write reintroduced by an error
    // handler. Same directory means same filesystem, always — asserted directly
    // rather than left to a comment.
    const destination = join(workspace, "deep", "record.json");
    const staging = stagingSiblingOf(destination);
    expect(dirname(staging)).toBe(dirname(destination));
    expect(isStagingName(basename(staging))).toBe(true);
  });

  it("never produces the same staging name twice", () => {
    // A collision would mean two concurrent writes sharing a temp file, which is
    // the corrupted record the prefix scheme exists to make impossible.
    const names = new Set(
      Array.from({ length: 500 }, () => stagingSiblingOf(join(workspace, "f.json")))
    );
    expect(names.size).toBe(500);
  });

  it("leaves the destination fully old or fully new at every crash point", async () => {
    const destination = join(workspace, "record.json");

    // How many filesystem calls a successful write makes — measured, not assumed,
    // so the sweep below cannot silently stop covering a step that gets added.
    const counter = new DyingFs(nodeWriterFs(), Number.MAX_SAFE_INTEGER);
    await writeFile(destination, OLD_BYTES);
    await atomicWriteFile(counter, destination, NEW_BYTES);
    const stepCount = counter.operations.length;
    expect(stepCount).toBeGreaterThanOrEqual(2);

    for (let dieAt = 1; dieAt <= stepCount; dieAt += 1) {
      await rm(destination, { force: true });
      await writeFile(destination, OLD_BYTES);
      const fs = new DyingFs(nodeWriterFs(), dieAt);

      await expect(atomicWriteFile(fs, destination, NEW_BYTES)).rejects.toThrow(
        SimulatedCrash
      );

      const observed = await readFile(destination);
      // The whole of R4 in one line: the reader saw one of the two committed
      // states. Not a truncated file, not a zero-length file, not the new bytes
      // half written.
      expect([OLD_BYTES.toString("utf8"), NEW_BYTES.toString("utf8")]).toContain(
        observed.toString("utf8")
      );

      // Whatever the crash left behind is recognisable as garbage rather than as
      // content, so a later sweep can prune it and `git status` can ignore it.
      const leftovers = (await readdir(workspace)).filter(
        (name) => name !== "record.json"
      );
      for (const name of leftovers) {
        expect(name.startsWith(STAGING_PREFIX)).toBe(true);
      }
    }
  });

  it("would catch a non-atomic write (anti-vacuity control)", async () => {
    // The identical assertion applied to a write that truncates before it fills.
    // If this ever stops failing, the sweep above is not interrupting anything and
    // every assertion in it is passing for free.
    const destination = join(workspace, "record.json");
    await writeFile(destination, OLD_BYTES);
    const fs = new DyingFs(nodeWriterFs(), 2);

    await expect(naiveWriteFile(fs, destination, NEW_BYTES)).rejects.toThrow(
      SimulatedCrash
    );

    const observed = (await readFile(destination)).toString("utf8");
    expect([OLD_BYTES.toString("utf8"), NEW_BYTES.toString("utf8")]).not.toContain(
      observed
    );
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.length).toBeLessThan(NEW_BYTES.length);
  });

  it("removes its staging file and re-throws the original error when rename fails", async () => {
    // Both halves are load-bearing: swallowing the error would turn an ENOSPC into
    // a silent no-op, and swallowing the cleanup would litter the user's repo with
    // temp files on every failed sweep.
    const inner = nodeWriterFs();
    const failure = new Error("ENOSPC: no space left on device");
    const fs: WriterFs = {
      ...inner,
      rename: async (): Promise<void> => {
        throw failure;
      },
    };
    const destination = join(workspace, "record.json");

    await expect(atomicWriteFile(fs, destination, NEW_BYTES)).rejects.toBe(failure);
    expect(await readdir(workspace)).toEqual([]);
  });

  it("keeps the original error even when the cleanup itself fails", async () => {
    const failure = new Error("EIO");
    const fs: WriterFs = {
      ...nodeWriterFs(),
      rename: async (): Promise<void> => {
        throw failure;
      },
      removeRecursive: async (): Promise<void> => {
        throw new Error("cleanup also failed");
      },
    };
    await expect(
      atomicWriteFile(fs, join(workspace, "record.json"), NEW_BYTES)
    ).rejects.toBe(failure);
  });
});

describe("R4: staged directory removal", () => {
  it("makes the directory disappear in one step", async () => {
    const fs = nodeWriterFs();
    const target = join(workspace, "a_record");
    await fs.makeDir(target);
    await writeFile(join(target, "record.json"), OLD_BYTES);
    await writeFile(join(target, "script.js"), OLD_BYTES);

    const seen: string[] = [];
    const observing: WriterFs = {
      ...fs,
      rename: async (from, to): Promise<void> => {
        seen.push("rename");
        await fs.rename(from, to);
        // Observed at the one instant an interrupted removal could be seen: the
        // record's own path is already gone, so nothing can read a directory that
        // has lost half its files.
        expect(await fs.readDir(target)).toBeNull();
      },
      removeRecursive: async (victim): Promise<void> => {
        seen.push("removeRecursive");
        await fs.removeRecursive(victim);
      },
    };

    await atomicRemoveDir(observing, target);
    expect(seen).toEqual(["rename", "removeRecursive"]);
    expect(await readdir(workspace)).toEqual([]);
  });

  it("is idempotent when the directory is already gone", async () => {
    // A reconcile that runs twice must not fail the second time; the second run is
    // exactly what happens after an interrupted first one.
    const fs = nodeWriterFs();
    await expect(atomicRemoveDir(fs, join(workspace, "absent"))).resolves.toBeUndefined();
  });

  it("removes a single file without touching anything around it", async () => {
    const fs = nodeWriterFs();
    await writeFile(join(workspace, "stale.js"), OLD_BYTES);
    await writeFile(join(workspace, "record.json"), OLD_BYTES);
    await removeFileIfPresent(fs, join(workspace, "stale.js"));
    await removeFileIfPresent(fs, join(workspace, "never-existed.js"));
    expect(await readdir(workspace)).toEqual(["record.json"]);
  });
});

/**
 * The `null`-vs-throw decision inside the real seam.
 *
 * `readFile` and `readDir` are the only two `WriterFs` methods that swallow an
 * error, and everything above them reads that `null` as "this is not on disk yet".
 * The distinction they draw is therefore load-bearing in a direction that is easy
 * to get wrong: a seam that returned `null` for EVERY failure would turn a full
 * disk, a permission error or a corrupt mount into "the record is new", and the
 * writer would answer by writing the whole table again and — worse — the deletion
 * reconciler would see an empty directory listing and read it as evidence.
 * INV-5 says a deletion needs a fresh complete sweep behind it; an unreadable
 * directory reported as empty is exactly the forged evidence it forbids.
 *
 * These cases run against real errno values from the real kernel rather than a fake
 * that throws an object with a `code` property, because the mapping being tested IS
 * the errno mapping. A fake would be asserting that the test file and the source
 * file agree on a spelling.
 */
describe("nodeWriterFs — which errors mean absence and which do not", () => {
  it("reports a missing file and a missing directory as absent", async () => {
    const fs = nodeWriterFs();
    expect(await fs.readFile(join(workspace, "absent.json"))).toBeNull();
    expect(await fs.readDir(join(workspace, "absent"))).toBeNull();
  });

  it("reports a path whose parent is a file as absent, not as an error", async () => {
    // ENOTDIR, not ENOENT. It is reached whenever a stale shard entry names a path
    // under something that has since become a record file, and it means the same
    // thing to every caller as ENOENT does: there is nothing there to read.
    const fs = nodeWriterFs();
    const file = join(workspace, "record.json");
    await writeFile(file, OLD_BYTES);
    expect(await fs.readDir(file)).toBeNull();
    expect(await fs.readDir(join(file, "nested"))).toBeNull();
  });

  it("rethrows a read failure that is not absence", async () => {
    // EISDIR. The bytes are unavailable, but the path is emphatically THERE, and a
    // caller told `null` would overwrite a directory with a file.
    const fs = nodeWriterFs();
    const dir = join(workspace, "a_record");
    await fs.makeDir(dir);
    await expect(fs.readFile(dir)).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("maps the empty repo-relative path to the repo root itself", () => {
    // The one input `toNativePath` must NOT append a separator for. It is how the
    // writer names the root when it walks scopes, and a `root + sep` result would
    // make every path derived from it start with a doubled separator — which POSIX
    // tolerates and Windows does not.
    expect(toNativePath(workspace, "")).toBe(workspace);
    expect(toNativePath(workspace, "/")).toBe(workspace);
    expect(toNativePath(workspace, "a")).toBe(join(workspace, "a"));
  });

  it("rethrows a listing failure that is not absence", async () => {
    // ENAMETOOLONG — chosen over EACCES because a suite that happens to run as root
    // can read a mode-000 directory, and a test that silently stops testing on one
    // machine is worse than no test. Every POSIX filesystem caps a single path
    // component at 255 bytes.
    const fs = nodeWriterFs();
    await expect(
      fs.readDir(join(workspace, "n".repeat(300)))
    ).rejects.toMatchObject({ code: "ENAMETOOLONG" });
  });
});
