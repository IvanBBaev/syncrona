# syncrona

## 0.9.3

### Minor Changes

- New `syncrona mirror` command — a full-instance git mirror with `init`, `sync`, `status`, `verify` and `report` subcommands. Exit codes: 0 clean, 1 the run could not finish, 2 completed with drift or findings.
- Record metadata now round-trips. Each record gets a `<record>~.meta.json` sidecar holding its non-file columns, and edits to the sidecar are pushed back by `push`, `dev` and `deploy` in the same request as the field files. `meta: false` opts out; `metaPush: false` keeps the sidecar read-only.
- `deploy --ci` skips the overwrite confirmation so a deploy can run in a noninteractive pipeline, and `init --ci` is finally accepted — the flag was documented and read, but `init` registered no options, so yargs' `.strict()` rejected it before the command ran.
- Data-safety and exit-code hardening across the CLI: writes are contained, fan-out is bounded, stale `dev` state no longer survives a restart, and `process.exitCode` resets to `undefined` rather than to a setup snapshot.
- A tracked field resolves to whatever extension the workspace actually keeps, instead of assuming the one the manifest was written with.

## 0.9.1

### Patch Changes

- Fix `syncrona --version` so it reports the CLI's own version. It is now wired
  explicitly from the package's `package.json`; yargs' default detection derived
  the path from the yargs module's `node_modules` parent, which under a
  hoisted/symlinked install resolved to an unrelated `package.json`.
- Package metadata: set the npm `homepage` to the project site
  (https://ivanbbaev.github.io/syncrona/) and sharpen the package descriptions.
- Updated dependencies
  - @syncrona/sn-transport@0.9.1
  - @syncrona/credential-store@0.9.1
  - @syncrona/jira@0.9.1
  - @syncrona/types@0.9.1

## 0.4.2

### Patch Changes

- 5898869: Release automation and hardening:

  - Adopt Changesets for versioning, changelog generation, and publishing
    (`npm run changeset` / `version-packages` / `release`); all `@syncrona/*`
    packages version in lockstep.
  - Enforce module boundaries in CI via dependency-cruiser (`npm run
lint:boundaries`): no circular dependencies and the shared foundation
    packages (`types`, `credential-store`, `sn-transport`) may not depend on the
    `core`/`mcp-server` consumers.
  - Strengthen at-rest credential storage: the credential-store encryption key is
    now resolved from `SYNCRONA_STORE_KEY` (CI / secrets manager) or the OS
    keychain when available, falling back to the legacy machine-derived key so
    existing stores keep decrypting.
  - @syncrona/credential-store@0.4.2
  - @syncrona/sn-transport@0.4.2
