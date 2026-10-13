/**
 * Internal path folding shared by the deletion authority and the reconciler.
 *
 * Kept in its own module, not re-exported from the package index, because it is an
 * implementation detail of rule 2 rather than part of the mirror's public surface.
 */
import { canonicalFoldName } from "@syncrona/sn-transport";

/**
 * The on-disk identity of a repo-relative path: every segment folded the way the
 * name resolver folds a record name (NFC, lower-case, trailing dots and spaces).
 * APFS and NTFS treat `Foo` and `foo` as one directory, so rule 2 has to compare
 * paths the way the filesystem does, not byte for byte.
 */
export function foldRepoPath(path: string): string {
  return path.split("/").map(canonicalFoldName).join("/");
}
