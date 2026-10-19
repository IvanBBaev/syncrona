# @syncrona/mirror

## 1.2.0-beta.0

### Patch Changes

- Updated dependencies [cd08ae2]
- Updated dependencies [f88a98e]
- Updated dependencies [bc33b76]
- Updated dependencies [3f54d54]
  - @syncrona/sn-transport@1.2.0-beta.0
  - @syncrona/credential-store@1.2.0-beta.0
  - @syncrona/redaction@1.2.0-beta.0

## 1.1.0

### Patch Changes

- b10ccc0: The forms view now escapes `sys_ui_element` names like every other instance string, so a line break or `|` in an element name can no longer inject Markdown lines into a derived form document.
- bcb81e6: Generating the derived views no longer aborts when a mirrored `sys_dictionary` reference column names a target table that is not a safe path component (for example a hand-edited `../escape`). The refs view now skips verifying that column and names it once in the anomaly list, as it already did for other unreadable tree content.
- bd53c99: A sweep resumed from a cursor is no longer graded partial/not-visible for the rows read before the cursor.
- 2f2ce8e: Compare record directories case-insensitively before authorising a deletion. A full sweep that writes a live record as `Foo` while a deleted record's stale entry names `foo` no longer removes the live record's directory on APFS or NTFS. The same applies to a tombstone whose path another shard entry claims under a case-variant name.
- Updated dependencies [e33dd3e]
- Updated dependencies [6d7ec9b]
- Updated dependencies [976a3d5]
  - @syncrona/credential-store@1.1.0
  - @syncrona/redaction@1.1.0
  - @syncrona/sn-transport@1.1.0

## 1.0.0

### Patch Changes

- @syncrona/credential-store@1.0.0
- @syncrona/redaction@1.0.0
- @syncrona/sn-transport@1.0.0

## 0.9.4

### Patch Changes

- @syncrona/credential-store@0.9.4
- @syncrona/redaction@0.9.4
- @syncrona/sn-transport@0.9.4

## 0.9.3

### Minor Changes

- First published release. The engine catalogs an instance from `sys_dictionary`, sweeps every in-scope table over the Table API and writes a sharded, deterministically ordered tree.
- Four invariants are machine-enforced rather than documented: a re-sync over an unchanged instance is byte-identical; the engine issues no state-changing request; the `complete` flag is the only completion signal; and an unreadable manifest is never reported as an empty one.
- Ships CommonJS so the ESM core CLI reaches it through Node's interop, and carries 100/100/100/100 coverage floors.

## 0.9.1

### Minor Changes

- Initial package: the mirror engine's **serializer** stage (architecture §5.6)
  and the canonical byte format (§8). Ships `serializeRow`, `canonicalJsonText`,
  `canonicalJsonBytes`, `encodeUtf8` and `withTrailingNewline`, together with the
  `FieldDescriptor` / `TableCatalogEntry` / `SerializedRecord` contracts and the
  `FORMAT_VERSION` constant the on-disk format is pinned to. No runtime
  dependencies: the serializer is a pure function of (row, catalog entry).
