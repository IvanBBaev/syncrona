// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Attachment binaries: where they land, which ones go through git-LFS, and what
 * the shard entry says about them (§4.3, §5.13, design §8.4, WP-M12).
 *
 * ## The layout is not this module's to choose
 *
 * `attachments/<table>/<record sys_id>/<attachment sys_id>_<file name>` is
 * already what `status/verifier.ts` reconstructs when it checks a mirror, so a
 * tidier scheme invented here would not be a refactor — it would turn every
 * attachment on the instance into an `attachment-missing` finding. The layout is
 * outside `instance/`, and deliberately: a record can be renamed or move scope,
 * and an attachment path that followed the record's directory would relocate a
 * 76 MB blob in git history every time somebody edited a display name.
 *
 * The `<attachment sys_id>_` prefix does the same job one level down. Two
 * attachments on one record may share a file name — ServiceNow does not stop
 * that — and the sys_id is the only thing that distinguishes them, keeps the
 * name stable when the file is re-uploaded, and (INV-6) is guaranteed to contain
 * nothing a filesystem or a glob would interpret.
 *
 * ## Pure plan, then effects
 *
 * The split into {@link planRecordAttachments} and {@link applyAttachmentPlan}
 * is what the writer's unchanged-record shortcut needs. That shortcut compares
 * the entry it is about to write with the one already in the shard and skips the
 * record entirely when they match — which is only sound if the attachment list is
 * part of the entry BEFORE anything is written. It has to be: an attachment added
 * to a record does not touch that record's `sys_updated_on` or `sys_mod_count`
 * (attachments are rows in `sys_attachment`), so an entry compared without them
 * would report "unchanged" for a record that just gained a file, and keep doing so
 * on every sweep from then on.
 *
 * The plan is also, by construction, free of anything non-deterministic: sizes and
 * hashes come from the bytes in hand rather than from the instance's claim about
 * them (`AttachmentMeta.sizeBytes` is nullable and a truncated download would make
 * it a lie), and the order is byte-wise by sys_id rather than the order the
 * Attachment API happened to page them in — INV-1 is a property of a committed
 * file, and a re-ordered list is a diff.
 *
 * ## What is deliberately NOT here
 *
 * No pointer files. git-LFS's clean filter converts the working-tree bytes into a
 * pointer at `git add` time and stores the object under `.git/lfs/objects` as it
 * goes; a pointer this module wrote by hand would name an object that was never
 * stored, and the push would fail — or, worse, succeed against a server that does
 * not verify, leaving a repository whose large attachments cannot be checked out
 * by anyone. Real bytes on disk plus the pattern from
 * {@link buildAttachmentGitAttributes} is the whole mechanism.
 */
import {
  foldNameComponent,
  MAX_NAME_BYTES,
  truncateToNameByteCap,
} from "@syncrona/sn-transport";

import type { RecordEntry } from "../contracts";
import { compareBytewise } from "../order";
import {
  assertMirrorPathComponent,
  assertMirrorSysId,
  MirrorPathRejection,
  repoPath,
} from "../shards/shardLayout";

import { atomicWriteFile, isStagingName, removeFileIfPresent } from "./atomicWrite";
import { sha256Hex } from "./contentHash";
import { toNativePath, type WriterFs } from "./fs";
import { buildAttachmentGitAttributes, GITATTRIBUTES_FILE_NAME } from "./gitAttributes";

/** Top-level directory holding every attachment binary (design §8.4). */
export const ATTACHMENTS_DIR_NAME = "attachments";

/**
 * Bytes left for a folded file name once the sys_id prefix is accounted for.
 *
 * 32 hex characters plus the `_` is 33 bytes, and the component cap the whole
 * project works to is `MAX_NAME_BYTES`. Folding the name against the full cap and
 * only then prefixing would produce a 233-byte component — under ext4's 255 but
 * over the budget every other name in this repository is held to, and the point of
 * a shared cap is that no path in the tree needs its own exception.
 */
const ATTACHMENT_NAME_BUDGET = MAX_NAME_BYTES - 33;

/** Names this module could itself have written, and may therefore remove. */
const MIRRORED_ATTACHMENT_NAME = /^[0-9a-f]{32}_/;

/** One downloaded attachment, as the fetcher hands it over. */
export interface AttachmentPayload {
  /** `sys_attachment.sys_id` — INV-6 checked before it becomes a path. */
  sysId: string;
  /** `sys_attachment.file_name`, raw. Folded here, never trusted. */
  fileName: string;
  /** The downloaded bytes. The size and the hash are taken from these. */
  bytes: Uint8Array;
}

/** One attachment as the shard records it (§4.3). */
export type AttachmentEntry = NonNullable<RecordEntry["attachments"]>[number];

/** Everything one record's attachments will do to the tree, decided up front. */
export interface AttachmentPlan {
  /** Repo-relative directory the binaries live in. */
  dir: string;
  /** Sorted attachment list for the shard entry. */
  entries: AttachmentEntry[];
  /** Binaries to write, in entry order. `path` is repo-relative. */
  writes: ReadonlyArray<{ name: string; path: string; bytes: Uint8Array }>;
  /** The directory's `.gitattributes`, or `null` when nothing needs LFS. */
  gitAttributes: Uint8Array | null;
}

/** Arguments of {@link planRecordAttachments}. */
export interface AttachmentPlanRequest {
  /** Table the record belongs to. */
  table: string;
  /** The record's sys_id. */
  recordSysId: string;
  /** Every attachment the sweep fetched for this record. */
  attachments: readonly AttachmentPayload[];
  /** Size at or above which an attachment is stored through git-LFS. */
  lfsThresholdBytes: number;
}

/**
 * Repo-relative directory of one record's attachments (design §8.4).
 *
 * Both components are validated even though the caller has usually validated them
 * already, because this is a path-derivation site and INV-6 puts the check at the
 * derivation, not at the caller's discretion.
 */
export function attachmentDirRelPath(table: string, recordSysId: string): string {
  assertMirrorPathComponent(table, "table name");
  assertMirrorSysId(recordSysId, "record sys_id");
  return repoPath(ATTACHMENTS_DIR_NAME, table, recordSysId);
}

/**
 * The on-disk name for one attachment's file-name half.
 *
 * Folded twice, and the second fold is not belt-and-braces. `foldNameComponent`
 * refuses a name that is blank or only dots — the `..` that would climb out of the
 * directory — but it applies its own 200-byte cap first, so a name that is 180 dots
 * followed by a letter passes it and only becomes dots-only when this function cuts
 * it to the prefix budget. Re-folding after the cut is what catches that.
 *
 * The `typeof` guard stays despite the annotation: this value is
 * `sys_attachment.file_name` as the instance's JSON sent it, and the type is a
 * claim about this package's callers rather than about the wire.
 */
function foldAttachmentFileName(rawFileName: string, attachmentSysId: string): string {
  if (typeof rawFileName !== "string") {
    throw new MirrorPathRejection("attachment file name", rawFileName);
  }
  const capped = truncateToNameByteCap(
    foldNameComponent(rawFileName),
    ATTACHMENT_NAME_BUDGET
  );
  const folded = foldNameComponent(capped);
  return folded === "" ? attachmentSysId : folded;
}

/**
 * Decide everything about one record's attachments without touching the disk.
 *
 * `attachments` is a plain array rather than an optional one on purpose. "No
 * attachments" and "attachments were not fetched" are different facts with
 * opposite consequences — the first means the record's directory should be emptied,
 * the second means it must be left exactly as it is, or a sweep run with
 * attachments disabled would delete every attachment a previous sweep mirrored.
 * Keeping that distinction in the caller leaves this function with one meaning per
 * input instead of a branch whose two sides are indistinguishable in a plan.
 */
export function planRecordAttachments(request: AttachmentPlanRequest): AttachmentPlan {
  const dir = attachmentDirRelPath(request.table, request.recordSysId);
  const seen = new Set<string>();
  const planned: Array<{ entry: AttachmentEntry; write: AttachmentPlan["writes"][number] }> =
    [];

  for (const attachment of request.attachments) {
    assertMirrorSysId(attachment.sysId, "attachment sys_id");
    if (seen.has(attachment.sysId)) {
      // Two rows claiming one sys_id derive one path, so one would overwrite the
      // other while the shard listed both. R3 forbids the silent half of that.
      throw new MirrorPathRejection("attachment sys_id", attachment.sysId);
    }
    seen.add(attachment.sysId);

    const fileName = foldAttachmentFileName(attachment.fileName, attachment.sysId);
    const sizeBytes = attachment.bytes.length;
    planned.push({
      entry: {
        sysId: attachment.sysId,
        fileName,
        sizeBytes,
        sha256: sha256Hex(attachment.bytes),
        lfs: sizeBytes >= request.lfsThresholdBytes,
      },
      write: {
        name: `${attachment.sysId}_${fileName}`,
        path: repoPath(dir, `${attachment.sysId}_${fileName}`),
        bytes: attachment.bytes,
      },
    });
  }

  planned.sort((left, right) => compareBytewise(left.entry.sysId, right.entry.sysId));
  const lfsSysIds = planned
    .filter((item) => item.entry.lfs)
    .map((item) => item.entry.sysId);

  return {
    dir,
    entries: planned.map((item) => item.entry),
    writes: planned.map((item) => item.write),
    gitAttributes:
      lfsSysIds.length === 0 ? null : buildAttachmentGitAttributes(lfsSysIds),
  };
}

/**
 * Whether this module is entitled to delete a directory entry it did not just write.
 *
 * Three shapes, and nothing else. A staging file is a crashed run's leftover; the
 * `.gitattributes` is this module's own and has to go when the last large
 * attachment shrinks or disappears, or git-LFS keeps looking for an object nobody
 * stored; and a `<32 hex>_` prefix is the name shape this module mints. Anything
 * else in the directory belongs to a human — an extracted archive, a note — and a
 * mirror that clears a directory it merely manages is a far worse failure than an
 * untidy tree.
 */
function isPrunableAttachmentName(name: string): boolean {
  return (
    isStagingName(name) ||
    name === GITATTRIBUTES_FILE_NAME ||
    MIRRORED_ATTACHMENT_NAME.test(name)
  );
}

/**
 * Write the plan and remove what it superseded.
 *
 * A missing directory answers `null` from `readDir` and ends the pass there, so a
 * record that never had an attachment costs one listing and no mutation at all —
 * which is what makes `applyAttachmentPlan` safe to call for every record of every
 * sweep rather than only for the ones the caller believes have attachments.
 *
 * An emptied directory is left standing. git does not track directories, so it is
 * invisible in the commit either way, and removing it would race the next record of
 * the same sweep re-creating it.
 */
export async function applyAttachmentPlan(
  fs: WriterFs,
  root: string,
  plan: AttachmentPlan
): Promise<void> {
  const dirAbs = toNativePath(root, plan.dir);
  const keep = new Set<string>();

  if (plan.writes.length > 0) {
    await fs.makeDir(dirAbs);
    for (const write of plan.writes) {
      keep.add(write.name);
      await atomicWriteFile(fs, toNativePath(root, write.path), write.bytes);
    }
    if (plan.gitAttributes !== null) {
      keep.add(GITATTRIBUTES_FILE_NAME);
      await atomicWriteFile(
        fs,
        toNativePath(dirAbs, GITATTRIBUTES_FILE_NAME),
        plan.gitAttributes
      );
    }
  }

  const listing = await fs.readDir(dirAbs);
  if (listing === null) {
    return;
  }
  for (const entry of listing) {
    if (entry.isDirectory || keep.has(entry.name)) {
      continue;
    }
    if (isPrunableAttachmentName(entry.name)) {
      await removeFileIfPresent(fs, toNativePath(dirAbs, entry.name));
    }
  }
}
