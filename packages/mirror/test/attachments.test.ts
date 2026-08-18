// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Attachment routing, LFS selection and the per-directory `.gitattributes`
 * (§5.13, design §8.4, WP-M12).
 *
 * Three things here are easy to get subtly wrong and impossible to notice later:
 *
 *  * **The on-disk path.** `status/verifier.ts` already reconstructs every
 *    attachment at `attachments/<table>/<record sys_id>/<attachment sys_id>_<file
 *    name>` and reports `attachment-missing` when it is not there. So the layout
 *    is not this module's to choose — the tests below pin the exact string, and a
 *    "tidier" scheme (an `lfs/` subdirectory, a scope level) fails them rather
 *    than silently turning every attachment into a verify finding.
 *  * **Where LFS membership is expressed.** git cannot match a pattern on file
 *    size, so "above the threshold goes to LFS" has to become a per-file pattern
 *    somewhere. The suite requires that pattern to name the attachment's sys_id
 *    prefix and to live in the record's own directory, because the alternative —
 *    one root file listing every large attachment on the instance — is a file
 *    rewritten by every sweep and a merge conflict for every pair of reviewers.
 *  * **INV-1.** The shard entry is committed to git, so an attachment list whose
 *    order follows the Attachment API's paging is a diff on every sync for a
 *    record nobody touched. The order is asserted against shuffled input, not
 *    against the order the fixtures happen to be written in.
 *
 * The filesystem is `statusFixtures`' recording fake, whose `readDir` answers in
 * DESCENDING order on purpose: any sortedness asserted below was produced by the
 * code under test, never by the fake.
 */
import { MAX_NAME_BYTES } from "@syncrona/sn-transport";

import { loadMirrorConfig } from "../src/config/loadConfig";
import { LFS_THRESHOLD_BYTES } from "../src/constants";
import { MirrorPathRejection } from "../src/shards/shardLayout";
import {
  applyAttachmentPlan,
  ATTACHMENTS_DIR_NAME,
  attachmentDirRelPath,
  planRecordAttachments,
  type AttachmentPayload,
} from "../src/write/attachments";
import {
  buildRootGitAttributes,
  GITATTRIBUTES_FILE_NAME,
  LFS_ATTRIBUTES,
} from "../src/write/gitAttributes";
import { toNativePath } from "../src/write/fs";
import {
  MemoryFs,
  ROOT,
  mutatingCalls,
  relToNative,
  resetCalls,
  sha256HexOf,
  testSysId,
} from "./statusFixtures";

const TABLE = "sys_script_include";
const RECORD = testSysId(0x5eed);

const bytesOf = (text: string): Uint8Array => Buffer.from(text, "utf8");
const textOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8");

/** A payload of exactly `size` bytes — the input the threshold is judged on. */
const payload = (
  sysId: string,
  fileName: string,
  size: number
): AttachmentPayload => ({
  sysId,
  fileName,
  bytes: new Uint8Array(size).fill(0x41),
});

const plan = (
  attachments: readonly AttachmentPayload[],
  lfsThresholdBytes = LFS_THRESHOLD_BYTES
) =>
  planRecordAttachments({
    table: TABLE,
    recordSysId: RECORD,
    attachments,
    lfsThresholdBytes,
  });

const A = testSysId(0xa);
const B = testSysId(0xb);
const C = testSysId(0xc);

describe("attachmentDirRelPath — the layout the verifier already checks", () => {
  it("derives attachments/<table>/<record sys_id>", () => {
    expect(attachmentDirRelPath(TABLE, RECORD)).toBe(
      `${ATTACHMENTS_DIR_NAME}/${TABLE}/${RECORD}`
    );
  });

  it("is covered by the root file's attachment glob", () => {
    // The root `.gitattributes` spells `attachments/**` as a git pattern rather
    // than deriving it from ATTACHMENTS_DIR_NAME (that import direction would be
    // a module cycle). This is the assertion that keeps the two spellings the
    // same string.
    const directives = textOf(
      buildRootGitAttributes(loadMirrorConfig({ attachments: { enabled: true } }))
    );
    expect(directives).toContain(`${ATTACHMENTS_DIR_NAME}/** -text`);
    expect(attachmentDirRelPath(TABLE, RECORD).startsWith(`${ATTACHMENTS_DIR_NAME}/`)).toBe(
      true
    );
  });

  it("rejects a table name that is not a path component", () => {
    expect(() => attachmentDirRelPath("../../etc", RECORD)).toThrow(MirrorPathRejection);
  });

  it("rejects a record sys_id that fails INV-6", () => {
    expect(() => attachmentDirRelPath(TABLE, "not-a-sys-id")).toThrow(MirrorPathRejection);
  });
});

describe("planRecordAttachments — LFS routing by size", () => {
  it("keeps an attachment one byte below the threshold in plain git", () => {
    const [entry] = plan([payload(A, "small.bin", LFS_THRESHOLD_BYTES - 1)]).entries;
    expect(entry.lfs).toBe(false);
    expect(entry.sizeBytes).toBe(LFS_THRESHOLD_BYTES - 1);
  });

  it("routes an attachment exactly ON the threshold to LFS", () => {
    // `LFS_THRESHOLD_BYTES` documents itself as the size "at or above which" an
    // attachment is stored through git-LFS. The boundary has to be decided one
    // way and pinned, because it is the only place the two answers differ.
    expect(plan([payload(A, "edge.bin", LFS_THRESHOLD_BYTES)]).entries[0].lfs).toBe(true);
  });

  it("routes an attachment above the threshold to LFS", () => {
    expect(plan([payload(A, "big.bin", LFS_THRESHOLD_BYTES + 1)]).entries[0].lfs).toBe(true);
  });

  it("honours a threshold the config lowered", () => {
    const entries = plan([payload(A, "a.bin", 8), payload(B, "b.bin", 4)], 8).entries;
    expect(entries.map((entry) => entry.lfs)).toEqual([true, false]);
  });

  it("measures the bytes it actually has, not the size the instance claimed", () => {
    // `AttachmentMeta.sizeBytes` may be null, and a truncated download would make
    // it a lie. The entry records what will be on disk, because that is what
    // `mirror verify` re-hashes.
    const entry = plan([{ sysId: A, fileName: "a.bin", bytes: bytesOf("1234") }])
      .entries[0];
    expect(entry.sizeBytes).toBe(4);
  });

  it("records the sha-256 of the bytes", () => {
    const bytes = bytesOf("payload");
    const entry = plan([{ sysId: A, fileName: "a.bin", bytes }]).entries[0];
    expect(entry.sha256).toBe(sha256HexOf(bytes));
  });
});

describe("planRecordAttachments — determinism (INV-1)", () => {
  it("sorts entries by sys_id whatever order they arrived in", () => {
    const forwards = plan([
      payload(A, "a.bin", 1),
      payload(B, "b.bin", 1),
      payload(C, "c.bin", 1),
    ]);
    const backwards = plan([
      payload(C, "c.bin", 1),
      payload(B, "b.bin", 1),
      payload(A, "a.bin", 1),
    ]);
    expect(forwards.entries.map((entry) => entry.sysId)).toEqual([A, B, C]);
    expect(backwards.entries).toEqual(forwards.entries);
    expect(backwards.writes.map((write) => write.path)).toEqual(
      forwards.writes.map((write) => write.path)
    );
  });

  it("yields an empty plan for a record with no attachments", () => {
    const empty = plan([]);
    expect(empty.entries).toEqual([]);
    expect(empty.writes).toEqual([]);
    expect(empty.gitAttributes).toBeNull();
  });

  it("rejects two attachments claiming the same sys_id", () => {
    // Both would derive the same path, so one would silently overwrite the other
    // while the shard claimed two files. R3 forbids the silent half.
    expect(() => plan([payload(A, "one.bin", 1), payload(A, "two.bin", 1)])).toThrow(
      MirrorPathRejection
    );
  });

  it("rejects an attachment sys_id that fails INV-6", () => {
    expect(() => plan([payload("../escape", "x.bin", 1)])).toThrow(MirrorPathRejection);
  });
});

describe("planRecordAttachments — file names", () => {
  const nameOf = (raw: string, sysId = A): string =>
    plan([{ sysId, fileName: raw, bytes: bytesOf("x") }]).entries[0].fileName;

  it("prefixes the on-disk name with the attachment sys_id", () => {
    expect(plan([payload(A, "report.pdf", 1)]).writes[0].path).toBe(
      `${attachmentDirRelPath(TABLE, RECORD)}/${A}_report.pdf`
    );
  });

  it("replaces separators so a hostile file name stays one component", () => {
    expect(nameOf("../../etc/passwd")).not.toContain("/");
    expect(nameOf("a\\b")).not.toContain("\\");
  });

  it("normalizes to NFC so a decomposed name is not a second file", () => {
    const decomposed = "café.txt";
    expect(nameOf(decomposed)).toBe(decomposed.normalize("NFC"));
  });

  it("rejects a file name the instance did not send as a string", () => {
    // `sys_attachment.file_name` arrives as JSON. The type annotation is a claim
    // about this package's callers, not about the instance.
    expect(() =>
      plan([{ sysId: A, fileName: 42 as unknown as string, bytes: bytesOf("x") }])
    ).toThrow(MirrorPathRejection);
  });

  it("leaves room for the sys_id prefix inside the component byte cap", () => {
    const name = nameOf(`${"n".repeat(400)}.bin`);
    expect(Buffer.byteLength(`${A}_${name}`, "utf8")).toBeLessThanOrEqual(MAX_NAME_BYTES);
  });

  it("falls back to the sys_id when the name folds away entirely", () => {
    expect(nameOf("")).toBe(A);
    expect(nameOf("...")).toBe(A);
  });

  it("falls back to the sys_id when truncation leaves only dots", () => {
    // Reachable: a name that is 180 dots followed by a character survives the
    // fold (it is not dots-only) and becomes dots-only when cut to the prefix
    // budget. Writing `..........` as a file name is how a mirror escapes its
    // own directory.
    expect(nameOf(`${".".repeat(180)}x`)).toBe(A);
  });
});

describe("planRecordAttachments — the per-directory .gitattributes", () => {
  it("emits nothing when no attachment reaches the threshold", () => {
    expect(plan([payload(A, "a.bin", 10), payload(B, "b.bin", 20)]).gitAttributes).toBeNull();
  });

  it("emits one sys_id-prefixed LFS pattern per large attachment, sorted", () => {
    const rendered = plan([
      payload(C, "c.bin", LFS_THRESHOLD_BYTES),
      payload(A, "a.bin", 1),
      payload(B, "b.bin", LFS_THRESHOLD_BYTES),
    ]).gitAttributes;
    const lines = textOf(rendered as Uint8Array)
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"));

    expect(lines).toEqual([`${B}_* ${LFS_ATTRIBUTES}`, `${C}_* ${LFS_ATTRIBUTES}`]);
  });

  it("matches by sys_id prefix rather than by the literal file name", () => {
    // `.gitattributes` has no escape syntax, so a file name containing `*`, `?`
    // or `[` written literally into a pattern would match the wrong files — or,
    // worse, silently match nothing and leave a 70 MB blob in plain git. A
    // sys_id is 32 hex digits and carries no glob metacharacter at all.
    const rendered = plan([payload(A, "a[0-9]*.bin", LFS_THRESHOLD_BYTES)]).gitAttributes;
    expect(textOf(rendered as Uint8Array)).toContain(`${A}_* ${LFS_ATTRIBUTES}`);
    expect(textOf(rendered as Uint8Array)).not.toContain("a[0-9]");
  });

  it("ends with exactly one newline and no CR", () => {
    const text = textOf(plan([payload(A, "a.bin", LFS_THRESHOLD_BYTES)])
      .gitAttributes as Uint8Array);
    expect(text).not.toContain("\r");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });
});

describe("applyAttachmentPlan", () => {
  const dirNative = () => toNativePath(ROOT, attachmentDirRelPath(TABLE, RECORD));

  it("writes real bytes for an LFS attachment, never a pointer file", async () => {
    // A pointer whose object was never staged into `.git/lfs/objects` cannot be
    // pushed: the clean filter is what converts the working-tree bytes at `git
    // add` time, and it needs the bytes to be there. Writing a pointer here
    // would be data loss dressed as a saving.
    const fs = new MemoryFs();
    const built = plan([payload(A, "big.bin", LFS_THRESHOLD_BYTES)]);
    await applyAttachmentPlan(fs, ROOT, built);

    const written = fs.files.get(
      relToNative(`${attachmentDirRelPath(TABLE, RECORD)}/${A}_big.bin`)
    );
    expect(written).toHaveLength(LFS_THRESHOLD_BYTES);
    expect(textOf(written as Uint8Array)).not.toContain("git-lfs");
  });

  it("writes the binaries and the .gitattributes together", async () => {
    const fs = new MemoryFs();
    await applyAttachmentPlan(
      fs,
      ROOT,
      plan([payload(A, "small.bin", 4), payload(B, "big.bin", LFS_THRESHOLD_BYTES)])
    );

    const dir = attachmentDirRelPath(TABLE, RECORD);
    expect(fs.files.has(relToNative(`${dir}/${A}_small.bin`))).toBe(true);
    expect(fs.files.has(relToNative(`${dir}/${B}_big.bin`))).toBe(true);
    expect(fs.files.has(relToNative(`${dir}/${GITATTRIBUTES_FILE_NAME}`))).toBe(true);
  });

  it("writes atomically — every payload arrives through a staging rename (R4)", async () => {
    const fs = new MemoryFs();
    await applyAttachmentPlan(fs, ROOT, plan([payload(A, "a.bin", 4)]));

    expect(mutatingCalls(fs).some((line) => line.startsWith("rename "))).toBe(true);
  });

  it("touches nothing at all for an empty plan on a record that never had attachments", async () => {
    const fs = new MemoryFs();
    await applyAttachmentPlan(fs, ROOT, plan([]));
    expect(mutatingCalls(fs)).toEqual([]);
  });

  it("removes an attachment the instance no longer has", async () => {
    const fs = new MemoryFs();
    await applyAttachmentPlan(fs, ROOT, plan([payload(A, "a.bin", 4), payload(B, "b.bin", 4)]));
    await applyAttachmentPlan(fs, ROOT, plan([payload(A, "a.bin", 4)]));

    const dir = attachmentDirRelPath(TABLE, RECORD);
    expect(fs.files.has(relToNative(`${dir}/${A}_a.bin`))).toBe(true);
    expect(fs.files.has(relToNative(`${dir}/${B}_b.bin`))).toBe(false);
  });

  it("removes a stale .gitattributes once nothing is large enough for LFS", async () => {
    // The other direction of the same problem: an attachment that shrank leaves
    // a pattern claiming a file git-LFS never stored, and `git lfs pull` on a
    // fresh clone then reports a missing object for a file that is right there.
    const fs = new MemoryFs();
    await applyAttachmentPlan(fs, ROOT, plan([payload(A, "a.bin", LFS_THRESHOLD_BYTES)]));
    await applyAttachmentPlan(fs, ROOT, plan([payload(A, "a.bin", 4)]));

    expect(
      fs.files.has(relToNative(`${attachmentDirRelPath(TABLE, RECORD)}/${GITATTRIBUTES_FILE_NAME}`))
    ).toBe(false);
  });

  it("removes a crashed run's staging leftover", async () => {
    const fs = new MemoryFs();
    await fs.makeDir(dirNative());
    await fs.writeFile(
      toNativePath(dirNative(), ".mirror-tmp-deadbeef"),
      bytesOf("half a download")
    );

    await applyAttachmentPlan(fs, ROOT, plan([payload(A, "a.bin", 4)]));
    expect(fs.files.has(toNativePath(dirNative(), ".mirror-tmp-deadbeef"))).toBe(false);
  });

  it("leaves a file it could not have written alone", async () => {
    // The prune only claims names of its own shape. A note a human dropped in
    // beside the attachments is not the mirror's to delete, and a recursive
    // clean of a directory the mirror manages is a far worse failure than an
    // untidy tree.
    const fs = new MemoryFs();
    await fs.makeDir(dirNative());
    await fs.writeFile(toNativePath(dirNative(), "NOTES.md"), bytesOf("mine"));

    await applyAttachmentPlan(fs, ROOT, plan([payload(A, "a.bin", 4)]));
    expect(fs.files.has(toNativePath(dirNative(), "NOTES.md"))).toBe(true);
  });

  it("never recurses into a directory someone else created", async () => {
    const fs = new MemoryFs();
    await fs.makeDir(toNativePath(dirNative(), "extracted"));
    await fs.writeFile(toNativePath(dirNative(), "extracted/keep.txt"), bytesOf("k"));

    await applyAttachmentPlan(fs, ROOT, plan([payload(A, "a.bin", 4)]));
    expect(fs.files.has(toNativePath(dirNative(), "extracted/keep.txt"))).toBe(true);
  });

  it("prunes every attachment when the record loses all of them", async () => {
    const fs = new MemoryFs();
    await applyAttachmentPlan(fs, ROOT, plan([payload(A, "a.bin", LFS_THRESHOLD_BYTES)]));
    await applyAttachmentPlan(fs, ROOT, plan([]));

    const dir = attachmentDirRelPath(TABLE, RECORD);
    expect(fs.files.has(relToNative(`${dir}/${A}_a.bin`))).toBe(false);
    expect(fs.files.has(relToNative(`${dir}/${GITATTRIBUTES_FILE_NAME}`))).toBe(false);
  });

  it("is byte-stable across a re-run and across arrival order (INV-1)", async () => {
    // The two failure modes this rules out: a second sweep of an unchanged
    // record producing different bytes, and two runs that saw the Attachment
    // API's pages in different orders producing different trees.
    const attachments = [
      payload(C, "c.bin", LFS_THRESHOLD_BYTES),
      payload(A, "a.bin", 12),
      payload(B, "b.bin", 3),
    ];

    const first = new MemoryFs();
    await applyAttachmentPlan(first, ROOT, plan(attachments));
    resetCalls(first);
    await applyAttachmentPlan(first, ROOT, plan([...attachments].reverse()));

    const second = new MemoryFs();
    await applyAttachmentPlan(second, ROOT, plan([...attachments].reverse()));

    expect([...first.files.keys()].sort()).toEqual([...second.files.keys()].sort());
    for (const [path, bytes] of first.files) {
      expect(sha256HexOf(bytes)).toBe(sha256HexOf(second.files.get(path) as Uint8Array));
    }
  });
});
