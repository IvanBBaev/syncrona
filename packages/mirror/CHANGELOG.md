# @syncrona/mirror

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
