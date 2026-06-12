# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Security

- Updated production dependencies to clear all `npm audit` findings (13
  vulnerabilities, 7 high — including five axios advisories such as SSRF and
  credential leakage; axios 1.5.1 → 1.17.0, webpack bumped). `npm audit
  --omit=dev` now reports 0 vulnerabilities.

### Added

- Registry-driven modular architecture: CLI commands are declared in
  `packages/core/src/cliCommands.ts` (one `CliCommandModule` entry per
  command) and MCP tool families in `packages/mcp-server/src/toolModules.ts`
  (`TOOL_HANDLER_MODULES`); the orchestrators are generic interpreters. See
  `docs/ARCHITECTURE.md` §5 for the add/remove module contract.
- Architecture and product-state documentation with mermaid diagrams
  (`docs/ARCHITECTURE.md`, `docs/PRODUCT_STATE.md`) and `CONTRIBUTING.md`.
- Zod argument schemas for every mutating MCP tool (7 previously
  unvalidated, including `sync_push` and `sn_execute_background_script`).
- Table API pagination (`sysparm_offset`) in the manifest builder — tables
  with more than 500 records are now fully enumerated; `sys_idIN` queries
  are chunked to avoid URL-length failures.
- Client-side rate limiting in the MCP server (shared 20 req/s policy from
  `@syncrona/sn-transport`, matching the CLI's axios-rate-limit).

### Fixed

- Push safety: the resume checkpoint is written only after the confirmation
  prompts (a declined prompt no longer fakes an "unfinished push"); the
  collaboration lock is acquired atomically (`wx` flag), anchored to the
  project root, and always released — `process.exit` no longer skips cleanup.
- `--scopeSwap`/`--updateSet` no longer crash for users without an existing
  user-preference record (the create path was unreachable), and the username
  is resolved through the credential chain instead of raw `SN_USER`.
- Error honesty: a present-but-broken `sync.config.js` is a hard error
  instead of a silent fallback to defaults; `refresh` reports real failures;
  `scopeCheck` no longer masks command errors as scope problems; `build`
  logs the failure reason; unknown CLI commands fail (`yargs.strict()`).
- Push retries follow the shared retry policy (no more retrying 401/403/404
  toward account lockout); a 404 reports "Could not find … on the server".
- Manifest refresh treats network failures as errors rather than "no
  records" — a partial or empty manifest can no longer overwrite a good one.
- MCP: the scoped-prefix cache is set only on 2xx responses (a 5xx could
  poison the prefix order); `checkSyncronaCapabilities` resolves the scope
  via the lightweight current-scope endpoint and no longer probes bogus
  `/api/<scope>/…` namespaces; MCP credential precedence now matches the CLI
  (project-local sources beat the global store) and resolved secrets are
  cached for 30 s (removes a blocking scrypt from every request); server
  startup connects stdio before the background scope auto-pull.
- Watcher pushes are serialized (no concurrent pushes on rapid changes);
  dev-mode interval refreshes no longer overlap; SIGINT cleans up the
  watcher and refresh timer.
- Git diff target handling uses `execFile` (paths with spaces, no shell
  injection) and follows renames/copies to the new path.
- Correctly detect file extensions for records whose names contain dots (e.g. `my.Widget.js`) by using `path.extname` instead of splitting on the first dot. This fixes wrong field/extension mapping during build and push.
- `dev` mode no longer crashes when `refreshInterval` is set to `0` (disable polling); `getRefresh()` now treats `0` as a valid value.
- `SNFileExists` now escapes and anchors the record-name regex, preventing false matches and regex errors for names containing special characters.

### Changed

- CI now runs on a macOS + Linux matrix and fails on high/critical `npm
  audit` findings in production dependencies; the mcp coverage gate also
  enforces a 70% branch threshold; `sync.config.js` option types
  are validated on load (unknown keys warn, wrong types are errors); CLI
  registry handlers are type-checked via `typedHandler<TArgs>`.
- Core is now part of the lint gate (`npm run lint` covers core + mcp-server
  with `--max-warnings=0`); the core coverage gate measures the whole source
  tree with ratchet thresholds instead of a single file.
- Workspace package metadata normalized (`engines`, `files`, `types` fields);
  per-package lockfiles removed in favor of the root lockfile.
- Removed dead, duplicated file-path parsing helpers (`parseFileNameParams`, `getParsedFilesPayload`) so `getFileContextFromPath` is the single source of truth.
- Minor cleanups: removed redundant `try/catch` rethrows and fixed a user-facing typo ("Recieved" → "Received").

## [0.4.1] - 2020-07-06

### Added

- updated deps version with security vulnerabilities [@collinparker-nuvolo]
- in dev mode, retries are disabledd from [@nrdurkin]

## [0.4.0] - 2020-06-19

### Added

- Installed Jest and added preliminary tests from [@tyler-ed]
- Added diff option to build and deploy commands from [@nrdurkin]
- Added documentation for new configuration options and commands from [@nrdurkin]

### Changed

- Dev mode will periodically refresh the manifest from [@nrdurkin]

## [0.3.10-alpha.0] - 2020-06-01

### Added

- Retry sending files when network error occurs while pushing to server from [@nrdurkin].
- Added status command to show current connection information from [@nrdurkin]
- Added "build" command to create static deployable bundles from [@nrdurkin].
- Added "deploy" command to deploy static bundles to servers from [@nrdurkin].

### Changed

- "sync push" shows record count before confirmation from [@nrdurkin].
- Validate credentials during init from [@nrdurkin].
- refactored config loading during startup to be more straight forward and performent from [@nrdurkin].

### Removed

- nothing removed

## [0.3.6] - 2020-02-12

### Added

- created by [@bbarber9](https://github.com/bbarber9).

### Changed

- no changes

### Removed

- nothing removed

[0.4.1]: https://github.com/nuvolo/syncrona/releases/tag/v0.4.1
[0.4.0]: https://github.com/nuvolo/syncrona/releases/tag/v0.4.0
[0.3.6]: https://github.com/nuvolo/
[0.3.10-alpha.0]: https://github.com/nuvolo/syncrona/releases/tag/v0.3.10-alpha.0
[@nrdurkin]: https://github.com/nrdurkin
[@tyler-ed]: https://github.com/tyler-ed
[@collinparker-nuvolo]: https://github.com/collinparker-nuvolo
