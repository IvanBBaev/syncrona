# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- `deploy --ci` skips the overwrite confirmation, so a deploy can run in a
  noninteractive pipeline.
- `init --ci` is now accepted. The flag was documented and read by the command,
  but `init` registered no options, so yargs' `.strict()` rejected it before the
  command ran.
- MCP fetch client now honors `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` via an
  undici `EnvHttpProxyAgent` dispatcher, composed with the existing
  mutual-TLS/custom-CA dispatcher cache (G9 follow-up).

### Changed

- Migrated breaking dependency majors, each landed and tested on its own:
  chalk 4→5 and inquirer 8→14 (no code changes — the core package is ESM),
  chokidar 3→5 (named-import surface), zod 3→4 (custom messages preserved
  via union-level `{ error }`), eslint 8→10 with typescript-eslint 6→8, and
  typescript ~5.9.3→6.0.3.
- Pressing Ctrl-C during any interactive prompt now cancels quietly with
  exit code 130 instead of printing an error stack. inquirer 14 rejects with
  `ExitPromptError`, which the CLI command runner handles centrally.
- Linting is flat-config only: the repo root uses `eslint.config.mjs`, the
  legacy root `.eslintrc` was deleted, and the eslint build plugin now falls
  back to the project's flat ESLint config (`eslint.config.js` /
  `eslint.config.mjs`) instead of generating an `.eslintrc`.
- `@syncrona/typescript-plugin`: with no `target` configured, transpiled
  output is now ES2021 (keeping `const` etc.) instead of the ES5 `var`
  downlevel. TypeScript 6 makes `target: ES5` a deprecation error and
  TypeScript 7 removes it, so users who still need ES5 must set it
  explicitly together with `ignoreDeprecations`. The plugin still emits no
  `"use strict"` prologue unless `strict`/`alwaysStrict` is configured
  (TypeScript 6 turned the prologue on by default), and configs whose
  `module` implies Classic resolution now get `Bundler` resolution instead
  of the removed `node10`.
- Modernized the tsconfigs for TypeScript 6: `NodeNext`
  module/moduleResolution across packages, an explicit per-package
  `rootDir`, explicit `types`, and removed the deprecated
  `downlevelIteration`/`baseUrl`.

### Removed

- The `.github/dependabot.yml` `ignore` list for breaking majors: with every
  migration landed, majors now arrive as normal isolated Dependabot PRs.
  (typescript 7.x is currently blocked by typescript-eslint's peer range,
  `<6.1.0`.)

### Security

- The MCP server's `run_node_code` full mode runs in a real child process with
  string code generation disabled and a credential-scrubbed environment. The
  in-process `vm` "safe sandbox" was removed after a reproduced escape to the
  host realm; its documentation now states plainly that the environment scrub is
  defense-in-depth, not isolation.
- `run_workspace_command` confirmation is default-deny. Only a small read-only
  binary allowlist runs unconfirmed, and the git gate resolves the real
  subcommand through space-separated global-option values, requires confirmation
  for any verb not on a read-only allowlist (which closes a git-alias remote
  code execution and every previously unlisted mutating verb such as `switch`,
  `pull`, `branch -D`, `worktree`, `update-ref`, `config`), and always requires
  confirmation for inline `-c`/`--config-env` configuration injection.
- The MCP audit log is a keyed, tamper-evident hash chain. It is keyed from the
  credential store's per-install secret when `SYNCRONA_STORE_KEY` is absent,
  refuses to write through a symlinked audit directory or file, fails closed on
  a mutating tool's failed write, caps quarantine-file retention, and redacts
  secret-shaped VALUES — connection strings, JWTs, PEM keys, inline
  Authorization, and vendor-prefixed API tokens (Stripe, OpenAI, GitHub, Slack,
  GitLab, Google, AWS) plus raw 256-bit hex — not just secret-named keys.
- The unified change workflow gates approval on the script that actually
  executes (remote mode analyzes `remoteScript`) and floors its risk score with
  a trusted analysis that ignores caller-supplied policy weights, so
  `riskLevel:"low"` or a zeroed `policy.weights` cannot bypass the approval and
  self-attestation gates.
- The download/pull write path refuses path components that would escape the
  workspace source root (`..`, pure dots, embedded separators in manifest table
  keys or record names), and the manifest-driven missing-file maps use
  null-prototype objects so a hostile `__proto__` table key cannot pollute
  `Object.prototype`.
- MCP guardrail policy loading fails closed: a present-but-unreadable,
  non-object, or prototype-poisoning guardrail configuration refuses instead of
  silently loading defaults.

### Fixed

- `logout` no longer claims success it did not achieve. Removing a single
  instance now reports whether a credential file was actually deleted, a
  failed removal exits non-zero instead of printing "Logged out", and
  `logout --all` only clears the active-instance marker when every credential
  file is really gone.
- `--log-level` rejects an unrecognized value instead of passing it to winston,
  which silently suppressed *all* output — including errors — for a typo.
- `status` and `doctor` report non-Basic authentication correctly. Both gated on
  `SN_USER`+`SN_PASSWORD` alone, so a healthy api-key, client-credentials or
  jwt-bearer setup was diagnosed as unconfigured.
- `push --dry-run` is side-effect-free again; it cleared the on-disk push
  checkpoint before the dry-run guard, destroying resume state for a real push.
- `push --ci` exits non-zero when a collaboration-lock conflict aborts the run,
  instead of masking a no-op deployment as success.
- The Jira error hint no longer tells a user hitting `HTTP 403` to check their
  credentials; a forbidden response now gets its own permissions hint.

## [0.9.1] - 2026-07-04

### Fixed

- `syncrona --version` now reports the CLI's own version. It is wired explicitly
  from the package's `package.json`; yargs' default detection derived the path
  from the yargs module's `node_modules` parent, which under a hoisted/symlinked
  install resolved to an unrelated `package.json`.

### Changed

- Package metadata: set the npm `homepage` of every published package to the
  project site (https://ivanbbaev.github.io/syncrona/) instead of the
  auto-generated GitHub `#readme` URL, and sharpened the `syncrona`,
  `@syncrona/babel-plugin` and `@syncrona/babel-preset-servicenow` descriptions.
  All packages remain in lockstep.

## [0.9.0] - 2026-07-03

First public release to npm. The `syncrona` core CLI, the `@syncrona/mcp-server`
runtime, their shared libraries (`@syncrona/sn-transport`,
`@syncrona/credential-store`, `@syncrona/jira`, `@syncrona/types`) and the
first-party build plugins (`@syncrona/babel-plugin`,
`@syncrona/babel-plugin-remove-modules`, `@syncrona/babel-preset-servicenow`,
`@syncrona/webpack-plugin`, `@syncrona/typescript-plugin`, `@syncrona/sass-plugin`,
`@syncrona/prettier-plugin`, `@syncrona/eslint-plugin`) are published together at
`0.9.0` with build provenance.

This release consolidates everything previously developed under the `0.x` line,
including the ServiceNow authentication methods work (Basic, OAuth
password / client-credentials / JWT-bearer, inbound REST API key, optional mutual
TLS) and the shared encrypted credential store.

### Security

- Stronger at-rest credential key (AR2 / D5): the credential-store encryption key
  is resolved from `SYNCRONA_STORE_KEY` (explicit 32-byte key for CI / secrets
  managers) or, **by default**, a random 256-bit key held in the OS keychain
  (via the optional `@napi-rs/keyring`; opt out with `SYNCRONA_USE_KEYCHAIN=0`),
  falling back to the legacy machine-derived key so existing credential files
  keep decrypting.
- Relicensed the project from MIT to **GPL-3.0-or-later** (SPDX headers across
  the source tree; `LICENSE` and package `license` fields updated).
- Custom CA bundle support in the shared transport (`SYNCRONA_CA_BUNDLE`, and
  `NODE_EXTRA_CA_CERTS`) for corporate TLS-inspection / private-CA setups.
- Updated production dependencies to clear all `npm audit` findings (13
  vulnerabilities, 7 high — including five axios advisories such as SSRF and
  credential leakage; axios 1.5.1 → 1.17.0, webpack bumped). `npm audit
  --omit=dev` now reports 0 vulnerabilities.

### Added

- **Jira issue context** (`@syncrona/jira`): new `jira`, `jira-login` and
  `jira-logout` CLI commands and a `jira_get_issue` MCP tool that fetch
  read-only issue context (summary, description, status, comments, links, …).
  Supports Jira Cloud (email + API token) and Server / Data Center (PAT),
  auto-detecting the deployment from the base URL; the `jira` command resolves
  the issue key from its argument or the current git branch name. Credentials
  are stored in the encrypted global CredentialStore, with named profiles.
- OAuth 2.0 client-credentials auth for the CLI (G1): set `SN_OAUTH_CLIENT_ID` /
  `SN_OAUTH_CLIENT_SECRET` (with `SN_USER` / `SN_PASSWORD`, optional per-profile
  `_<PROFILE>` suffixes) and the CLI exchanges them for a Bearer token at
  `oauth_token.do`, refreshing on expiry/401; without them it stays on Basic.
- `repair` command: reconciles the manifest with local files — reports (default)
  or re-downloads files the manifest expects but that are missing locally
  (`--apply`), and optionally prunes orphan files no record claims (`--prune`).
- `config add-plugin`: lists the first-party build plugins (with install status)
  and prints a paste-ready `rules` snippet for `sync.config.js`.
- Resumable downloads (G3): `download` / `refresh` checkpoint progress and resume
  the tables not yet fetched instead of restarting after an interruption.
- Flat project layout support: projects can keep source directly under the
  project root (flat) in addition to the `src/` layout.
  `npm run changeset` / `version-packages` / `release`; all `@syncrona/*`
  packages version in lockstep.
- Machine-enforced module boundaries (G10): dependency-cruiser runs in
  `npm run lint` (`lint:boundaries`) — no circular dependencies, and the shared
  foundation packages may not import the core/mcp-server consumers.
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

[Unreleased]: https://github.com/IvanBBaev/syncrona/compare/v0.9.1...HEAD
[0.9.1]: https://github.com/IvanBBaev/syncrona/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/IvanBBaev/syncrona/releases/tag/v0.9.0
[0.4.1]: https://github.com/IvanBBaev/syncrona/releases/tag/v0.4.1
[0.4.0]: https://github.com/IvanBBaev/syncrona/releases/tag/v0.4.0
[0.3.6]: https://github.com/IvanBBaev/syncrona/releases/tag/v0.3.6
[0.3.10-alpha.0]: https://github.com/IvanBBaev/syncrona/releases/tag/v0.3.10-alpha.0
[@nrdurkin]: https://github.com/nrdurkin
[@tyler-ed]: https://github.com/tyler-ed
[@collinparker-nuvolo]: https://github.com/collinparker-nuvolo
