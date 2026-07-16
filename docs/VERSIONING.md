# Versioning and Stability

How SyncroNow AI versions its packages, what stability is promised at each
surface, and which runtimes are supported. The step-by-step release procedure
lives in
[release-governance.md](../packages/mcp-server/docs/release-governance.md) —
this page describes the policy, not the checklist.

## Semantic versioning, in lockstep

All published packages follow [semantic versioning](https://semver.org/):

- **Minor** versions add backward-compatible features.
- **Major** versions are reserved for breaking changes — most importantly,
  breaking MCP tool-contract changes.

Releases are managed with [Changesets](https://github.com/changesets/changesets),
and `.changeset/config.json` pins every `@syncrona/*` package into a single
**fixed group**: `npx changeset version` moves the whole family
(`syncrona`, `@syncrona/types`, `@syncrona/mcp-server`, the build plugins, and
the rest) to the same version in one step. You never need to reason about
cross-package version compatibility — matching versions are compatible by
construction.

Two version numbers are intentionally *not* part of the lockstep:

- The **root `package.json`** is a private workspace container; its version
  stays behind by design and must not be "fixed".
- The **website badge** (`docs/index.html`) tracks
  `packages/core/package.json` and is bumped as part of the release checklist;
  a claims-drift gate (run as a unit test) fails the build if it is forgotten.

The project is currently **pre-1.0** (`0.x`): surfaces are stable in practice
and guarded by the gates below, but the 1.0 line is where the promises become
contractual.

## Stability promises by surface

### MCP tool contract

The MCP server currently exposes **61 tools**
(reference: [MCP_TOOLS.md](MCP_TOOLS.md), generated from the schemas). The
tool contract is the most strictly guarded surface:

- **Tool names are hash-pinned in CI.** A contract gate keeps a pinned list of
  required tool names and checks it *both ways* — a missing tool, a renamed
  tool, a duplicate, or a new tool that was not consciously added to the pin
  all fail the build. A short contract hash computed over the sorted tool
  names makes any change to the name set visible at a glance.
- **Additive schema updates are preferred.** New optional inputs and new
  output fields are backward-compatible; existing tool names stay stable.
- **Removals and renames are breaking** — they require a major version, a
  deprecation window, and migration guidance (see
  [release-governance.md](../packages/mcp-server/docs/release-governance.md)).

### CLI

The CLI exposes **23 commands** (see the README
[command table](../README.md#commands)). Documentation-drift gates keep the
README command table, `CLAUDE.md`, and the actual command registry aligned, so
a command cannot be added, renamed, or removed without the change being
visible in the user-facing docs in the same commit. Command removals or
renames are treated like tool-contract changes: deprecation notice first,
removal in a major version.

### Configuration and file formats

`sync.config.js`, `sync.manifest.json`, and the checkpoint files are consumed
by the same lockstep-versioned code, so no cross-version compatibility matrix
is needed. Unknown config keys warn and are ignored (never a hard failure),
which keeps older configs working across upgrades.

## Node.js support window

| Component | Requirement |
| --- | --- |
| Repository baseline | Node.js **>= 22**, npm **>= 10** (root `engines`; `.nvmrc` pins `22`) |
| `syncrona` (core CLI) | Node.js **>= 22.12** |
| All other `@syncrona/*` packages | Node.js **>= 22** |

The support floor moves forward only in a **major** release.
`syncrona check-env` verifies the local runtime against these requirements.

## Deprecation policy

When a surface covered by a stability promise has to change incompatibly:

1. The old behavior is kept working and marked deprecated, with migration
   guidance in the `CHANGELOG.md` release notes.
2. The deprecation ships in a minor release and remains through a deprecation
   window.
3. The removal lands only in a major release.

Every release updates the top-level [CHANGELOG.md](../CHANGELOG.md) with added
tools, behavioral changes, and migration notes — that file is the canonical
place to check before upgrading.
