# @syncrona/mirror

## 0.9.1

### Minor Changes

- Initial package: the mirror engine's **serializer** stage (architecture §5.6)
  and the canonical byte format (§8). Ships `serializeRow`, `canonicalJsonText`,
  `canonicalJsonBytes`, `encodeUtf8` and `withTrailingNewline`, together with the
  `FieldDescriptor` / `TableCatalogEntry` / `SerializedRecord` contracts and the
  `FORMAT_VERSION` constant the on-disk format is pinned to. No runtime
  dependencies: the serializer is a pure function of (row, catalog entry).
