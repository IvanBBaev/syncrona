# @syncrona/mirror

<!-- badges:start -->
| [![npm](https://img.shields.io/npm/v/@syncrona/mirror?style=flat-square&logo=npm&logoColor=white&label=npm)](https://www.npmjs.com/package/@syncrona/mirror) | [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org) | [![license](https://img.shields.io/github/license/IvanBBaev/syncrona?style=flat-square&color=blue&label=license)](../../LICENSE) | [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/syncrona/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/syncrona/actions/workflows/ci.yml) | [![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) |
|:--:|:--:|:--:|:--:|:--:|
<!-- badges:end -->

**Instance mirror engine** for SyncroNow AI — the read-only pipeline that turns a
ServiceNow instance into a byte-stable local tree, so that an unchanged instance
produces an unchanged tree and every diff means something.

The full design lives in
[`docs/design/mirror-architecture.md`](../../docs/design/mirror-architecture.md).
This package implements it stage by stage; the sections below describe what is
shipped today.

## What lives here

### Serializer (`src/serialize/serializer.ts`)

One Table API row in, the canonical value set for that record out. This is the
single place where "what the instance said" becomes "what git will see".

- `serializeRow(row, tableEntry)` — the whole stage, as one pure function.
- `canonicalJsonText(value)` / `canonicalJsonBytes(value)` — the canonical
  rendering of any JSON-shaped value.
- `encodeUtf8(text)` — UTF-8 bytes, never a BOM.
- `withTrailingNewline(contents)` — exactly one trailing newline, nothing else
  touched.

The canonical byte format (architecture §8), each rule implemented once:

| Rule | Effect |
|---|---|
| Sorted keys | Object keys ascending by UTF-16 code unit, **at every nesting level** |
| Empties dropped | `""` is absence, not a value — the Table API returns every column |
| Suppression | Noise and denied columns are absent entirely |
| Extraction | Scripts, styles and templates become sibling files with a trailing newline |
| JSON blobs | Parsed and re-emitted canonically; unparsable content is kept verbatim behind a `raw:` marker and reported |
| Encoding | UTF-8, LF, exactly one trailing newline, two-space indent, no BOM |

## Design notes

The serializer is **pure** (INV-7): a function of the row and the catalog entry
and of nothing else — no config, no clock, no filesystem, no environment, no
module-level state. That is not a style rule. The mirror's value is that a re-run
diffs to nothing, and any hidden input turns a re-run into a whole-tree diff.
`test/serializerPurity.test.ts` walks the module's import graph and fails if a
forbidden dependency, ambient global or module-level mutable binding appears.

The emitted bytes are **versioned** (INV-8). Every rule above is pinned by a
golden fixture under `test/golden/serializer/`, and the fixtures are pinned to
`FORMAT_VERSION`. Changing what the serializer emits is therefore not a refactor:
it requires bumping `FORMAT_VERSION` and shipping a migration, because every
mirror already on disk would otherwise rewrite itself on the next run.

Naming is normalized, **content never is**. Extracted file names are NFC-normalized
(D18) so macOS and Linux agree on the path; file contents are reproduced byte for
byte, because the mirror records what the instance has.
