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
- `dryRun` is honored end to end. `run_workspace_command` and `run_node_code`
  accepted the flag, satisfied the `requireDryRun` guardrail with it, and then
  executed for real — auditing the real run as a simulation;
  `sync_unified_change_workflow` was never handed the flag at all, so
  `dryRun: true` performed the actual apply with preflight disabled.
  `sync_unified_change_workflow`'s `dryRun` therefore changed meaning, and its
  `metadata.version` is bumped to `1.2.0` so clients caching tool definitions learn
  that an input they already knew about now takes precedence over `apply`.
- The two remaining `dryRun` enforcement points key on what the tool honors, not on
  what the caller asked for. The preflight gate was skipped whenever a dry run was
  merely *requested*, so the first mutating tool added without a dry-run-aware handler
  would silently lose its preflight; and the `requireDryRun` guardrail — an operator
  lock meaning "this tool may only be planned here" — inverted on any tool whose
  handler ignores the flag, making `dryRun: true` the only accepted shape while still
  performing the real mutation. An unenforceable `requireDryRun` entry is now refused
  outright.
- The `run_workspace_command` git gate allowlists the global options that may precede
  a subcommand instead of blocking only the ones known to be dangerous. Flags that
  point git at a caller-chosen program or repository — `--exec-path`, `-C`,
  `--git-dir`, `--work-tree`, `--namespace`, `--super-prefix` — now require
  confirmation even in front of a read-only verb, which is exactly where they landed:
  `git --exec-path=/tmp/evil ls-remote https://host/r` executed
  `/tmp/evil/git-remote-https` while `ls-remote` kept the call off the confirmation
  path entirely.
- The `run_workspace_command` git gate validates a subcommand's own options, not
  just the verb. `git status --exec=...`-style option smuggling and an allowlisted
  verb carrying a destructive option now require confirmation, and only a bare
  command name can be allowlisted at all: a command carrying a path separator
  (`./git`, `/tmp/evil/git`) is a caller-chosen executable and always requires
  confirmation, where previously it matched the allowlist on its basename alone
  and ran an attacker-planted binary unconfirmed.
- Audit-chain hardening: the truncation high-water marker moved out of the
  world-shared `/tmp` (symlink clobber and silent tripwire defeat), the integrity
  checker refuses to rewrite through a symlink, the tripwire is consulted for a
  fully-legacy log instead of returning early (wholesale erasure read as "valid"),
  concurrent writers no longer mint duplicate `seq` numbers that poison the chain
  as permanently tampered, and value-based redaction no longer switches itself off
  for values over 8192 characters.
- A non-object `policy`, `policy.tools` or `policy.environments` node is rejected
  instead of being coerced to `{}` — a malformed guardrail file failed open.
- `init` validates the path components it derives from the server-supplied
  application scope, and `docs` no longer interpolates that scope straight into a
  filename; a hostile scope value could write outside the workspace.
- The Jira MCP untrusted-data fence covers every attacker-controlled free-text
  field — comment author display names and parent/subtask/link summaries were
  passed through verbatim. (Assignee and reporter stay verbatim by design; that
  limit is now documented.)
- The CLI fails instead of silently downgrading: incomplete api-key or JWT-bearer
  material no longer falls back to Basic auth, and an unrecognized
  `SN_AUTH_METHOD` is rejected rather than quietly resolving to an inferred grant
  (a typo could POST a password to the OAuth token endpoint). An unrecognized
  selector is now surfaced everywhere it can be: the MCP server refuses to start
  on it *even when mutual TLS is configured* — a client certificate excuses missing
  Authorization material, but it never excuses picking a different grant — and
  every CLI command that authenticates warns once, naming the rejected value and
  the method it fell back to. A merely incomplete configuration stays quiet there,
  so first-run `init`/`login` is unaffected.
- An ADF code block can no longer break out of its own fence. Jira content whose
  code text contains a ``` run is now fenced with a longer backtick run, so
  attacker-authored issue text cannot escape into the surrounding Markdown and be
  read as instructions.
- SECURITY.md no longer overstates two protections. It claimed *all* mutating MCP
  tools require `confirmDestructive=true`; it now names the ones that do, and names
  `sync_set_scope`, `sync_set_update_set` and `sync_prepare_session` (no
  confirmation flag) plus the two workflow tools that enforce it only on
  `apply=true`. It also claimed the opt-in diagnostic file log redacts known
  credential fields; no redactor runs over that file, and the document now says so.
- A JWT private key is no longer reproduced in a filesystem error message. Key and
  certificate settings accept either PEM text or a path, and anything without PEM
  armor was read as a path — so Node's `ENOENT`/`ENAMETOOLONG` message, which quotes
  the path verbatim, printed a base64-encoded key in full to stderr, into the audit
  trail and into the error text returned to an MCP client. The audit secret scanner
  could not catch it, because it matches literal PEM armor, which is exactly the
  shape that goes down this path. The replacement message names the setting, states
  that the value was read as a path, and reports the fs error code and the value's
  byte length — never the value. Fixed in the CLI and the MCP server alike.
- Confirmation for a destructive workspace command no longer depends on where the
  verb sits. The gate resolved a single "first operand", so a global option that
  takes a space-separated value (`--logLevel debug push`, `--instance-profile dev
  push`, `-d main push`) shifted the verb out of view and a live push to a
  ServiceNow instance was reported as needing no confirmation. Any destructive verb
  anywhere in the operand region now requires confirmation, in the same default-deny
  way the git option regions already worked.
- The MCP identifier gate no longer validates one value and forwards another. Every
  identifier schema trims before matching its pattern, so a padded value parsed
  clean while the untrimmed original — newlines included — reached the Table API URL
  builder and the audit line. The normalized value is written back, and a
  whitespace-only identifier becomes empty rather than arriving supplied-but-blank
  at handlers that test it for truthiness.
- A tool name that names an `Object.prototype` member is rejected as an unknown
  tool. `toolArgSchemas[name]` returned the inherited member for `"constructor"`,
  so the call failed as an internal error instead of an argument error. The same
  own-property fix applies to the display-field and file-type lookups in the CLI,
  where an inherited function was returned typed as a string and sent on as a
  ServiceNow field name or interpolated into a filename.
- A manifest `type` can no longer escape the build directory. The source-tree writer
  was hardened against a manifest-supplied path component; the build-tree writer was
  not, and the value is interpolated into the output filename and written without a
  containment check, so `js/../../../../evil` left both the build directory and the
  workspace.
- The MCP audit sanitizer bounds its walk over client-supplied arguments on depth
  and breadth, and states in the record when it truncated.
- A timed-out child process is escalated on a budget: SIGTERM, then SIGKILL, so a
  child that ignores SIGTERM cannot hold a tool call open indefinitely.
- The high-severity production advisories are cleared again: `fast-uri` (host
  confusion via a backslash authority introducer, reached through `ajv`) and
  `ip-address` (three SSRF / trust-boundary bypasses, reached through
  `express-rate-limit` under the MCP SDK). Both are transitive, so both are
  pinned in the root `overrides`, alongside a `hono` bump that also clears four
  moderate advisories. Two moderates remain deliberately: `undici` stays on 6.x
  because 8.x reintroduces GHSA-4c8g-83qw-93j6, and `@hono/node-server`'s fix
  requires a 2.x that sits outside the MCP SDK's declared range for a
  `serve-static` path traversal the stdio server never reaches.
- The download write seam validates every path component at the chokepoint,
  before `path.join` sees it. The source-root containment guard only anchors at
  the workspace root, so a field named `../Bar/script` written from record Foo's
  folder relocated the write onto a *sibling record* and stayed inside the root
  the whole time — quieter, not safer. `writeSNFileCurry` and
  `writeFlatSNFileCurry` now reject unsafe file names, file types and record
  names outright, and the download pipeline names which component failed and
  which boundary it would have crossed.

### Fixed

- A tracked field whose value on the instance is legitimately empty now
  converges. The download wrote it as a zero-byte file, and `SNFileExists` read
  zero bytes as "placeholder, not fetched yet", so every later refresh reported
  the field missing and fetched it again — forever — while the command printed
  "Download complete". The ambiguity is removed at the write seam rather than at
  the probe: a request carrying no `content` key (a manifest entry) writes
  nothing at all, `{ content: "" }` (a fetched empty value) writes the zero-byte
  file, and existence is once again the whole answer. The skeleton phase still
  materialises every record directory, so `init` lays out the tree as before.
- Manifest paging is stable and no longer truncates. Record paging walked
  `offset += pageSize` over a query with no `ORDERBY`, so the Table API was free
  to return a different order for the second page and a row that crossed the
  boundary in between was never returned at all — it never reached the manifest,
  `findOrphanFiles` reported its local file as unclaimed, and
  `repair --apply --prune` deleted it. Every paged query now carries a
  `sys_id` ordering (`withStableOrder`, which leaves an ordering the caller
  already chose alone, since ServiceNow honours the first `ORDERBY` as the
  primary key). Separately, field and table discovery called the Table API once
  with a fixed limit and no offset loop, so a table with more dictionary rows
  than the limit produced a quietly incomplete manifest — no error, no warning,
  and the same partial answer on every run. Both now page; the lookups that
  cannot truncate by construction stay unpaged with the reason written down.
- `mcp --instance-profile <name>` no longer aims the MCP server at the wrong
  instance. The generated secrets file took the *stored active instance* over the
  profile named on the command line, so after `syncrona use prod`, an explicit
  `mcp --instance-profile qa` resolved qa's credentials and then wrote prod's host
  next to them — the server talked to production while the flag said qa, and
  nothing in the output said so. An explicit profile now wins; the stored instance
  is still the default when no profile is given. Both directions are pinned by
  tests.
- `mcp --mcp-server-path <path>` now fails loudly when that path does not exist.
  A typo fell through to the automatic discovery candidates, so the command either
  started a **different** server than the one that was asked for, or reported
  "unable to find the MCP server" without ever naming the path it was handed.
- A **relative** `--mcp-server-path` (or `SYNCRONA_MCP_SERVER_PATH`) is resolved
  against the invoking directory before it is validated, and that absolute path
  is what reaches every consumer. It was stat'ed as given — cwd-relative — while
  the client configs and the server spawn both run with `cwd` set to the
  workspace root, so a relative path that passed validation was then consumed
  against a different base: a silently persistent misconfiguration in
  `.vscode/mcp.json` and the desktop-client configs. The not-found error now
  names the resolved location, so the typo hunt starts from the right base.
- Auto-configure no longer corrupts an MCP client config whose JSON root is an
  array. `typeof [] === "object"` passed the validity check, and `JSON.stringify`
  drops an array's non-index properties — so the `mcpServers` entry was written,
  silently discarded on serialisation, and the run still reported success. A
  non-object config is now treated as malformed and replaced, with a warning
  naming the file (previously it was replaced in silence).
- The same guard now applies one level down: a config whose **`mcpServers` value**
  is an array also passed the object check, and spreading it registered every
  element as a server named by its index (`"0"`, `"1"`, ...) — one garbage client
  entry per element, written back as a success. An array there is replaced like
  any other non-map value.
- `mcp --auto-configure` on Windows without `APPDATA` set now says so. It resolved
  no Claude Desktop or Cursor target and reported a successful configure that had
  written nothing.
- The MCP server reported the wrong version to its clients. `SERVER_VERSION` was
  a hardcoded `"0.1.0"` while the package was at 0.9.1, so the `initialize`
  handshake, `sync_health` and every tool-module banner understated the server by
  eight minor releases — enough for a client to gate a feature it actually had.
  The version is now read from the package's own `package.json` at runtime, the
  same fix `syncrona --version` received in 0.9.1; if that lookup ever fails the
  handshake reports `0.0.0-unknown` rather than guessing a number.
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
- Build plugins load again. `PluginManager` resolved a plugin to its package
  directory and `await import()`ed that path, which throws
  `ERR_UNSUPPORTED_DIR_IMPORT` on Node — every configured build plugin failed to
  load at runtime.
- `syncrona build` exits non-zero when records fail to build; it reported the
  failures and then exited 0, so a pipeline continued to `deploy`.
- `syncrona push <relative-path>` no longer silently pushes nothing. The
  workspace-containment check compared the raw, unresolved argument against the
  absolute source root, so no file ever matched.
- `repair --prune` no longer deletes live, manifest-tracked files whose on-disk
  bytes have drifted from the manifest, and a 403/404 on a single table no longer
  drops that table from the rebuilt manifest — which turned every one of its
  local sources into an "orphan" for the next prune. The same applies to a
  *partially* refused read: a table whose records came back incomplete (one
  refused `sys_id` chunk, a refused metadata lookup, or a refused field lookup)
  keeps the records the previous manifest knew about instead of being rewritten
  as if the short answer were the whole table.
- The download checkpoint is keyed by more than the scope, so a re-fetched
  manifest no longer skips whole tables and leaves zero-byte files behind a
  "Download complete" message. The bounded download pool now surfaces the first
  worker rejection instead of discarding every later error, and a bulk Table-API
  response with a missing field no longer coerces it to `""` and truncates the
  local file.
- Record names that collide on a case-insensitive or Unicode-normalizing volume
  are disambiguated with the record's `sys_id` instead of merely warned about.
  Both names were written to the manifest, the records overwrote each other's
  files, and `push` then uploaded one record's content into the other's `sys_id`.
  (The suffix is decided in one pass over the whole result set, so it does not
  depend on the Table API's unstable row order.) Relatedly, when both layouts
  claim the same record field after `flat` has been toggled, `push` now fails with
  an "Ambiguous push" error naming both files instead of picking one by
  directory-walk order.
- Ctrl-C is handled consistently in the last two places that missed it: the push
  confirmation printed a raw stack trace and exited 1 instead of 130, and
  `scopeCheck` swallowed the inquirer `ExitPromptError` into a bogus error banner.
  Aborting the `init` wizard now exits without writing the MCP configuration —
  it exited 0 and wrote it anyway.
- The CLI's ServiceNow data-path client and its OAuth token client both have a
  request timeout (default 120 s; `SN_REQUEST_TIMEOUT` in milliseconds overrides
  it, `0` restores the old unbounded behaviour); a hung socket or token endpoint
  parked a connection-pool slot — or the whole command — indefinitely.
- Jira: an explicit `--profile` whose credentials are missing or undecryptable now
  fails instead of silently querying whichever site the environment points at, and
  an ADF `expand`/`nestedExpand` title is no longer dropped from the rendered text.
- `@syncrona/typescript-plugin`: `tsconfig.json` `extends` chains are resolved
  (only the leaf file's `compilerOptions` were used), a string-valued `target` in
  plugin options no longer downgrades the emit to CommonJS — which produced
  `exports.` code that cannot run in Rhino — and plugin-supplied `compilerOptions`
  now reach the type check that hard-fails the build, so the documented escape
  hatches work.
- `@syncrona/eslint-plugin` writes the `--fix` result. Autofixes were computed and
  then thrown away.
- `@syncrona/babel-plugin-remove-modules`: a trailing same-line `//@keepModule`
  attached to the *next* import, so the tagged module was deleted and an untagged
  one kept.
- `sn_search_scripts` no longer reports a run in which every table query failed as
  a successful zero-match result. The response is flagged as an error and carries
  `searchComplete: false`, so "unknown" is distinguishable from "absent". A table
  name the tool does not cover is likewise no longer dropped in silence: it comes
  back in `unknownTables`, `searchComplete` requires that list to be empty too, and
  the schema now enumerates the searchable tables (metadata `1.1.0`).
- `dryRun` is reported honestly in the audit trail. Four scope-knowledge tools
  declare and honor the flag but were missing from the dry-run-aware registry, so a
  simulation was recorded as a real write; `sync_set_scope` accepted the string
  `"true"` through validation and then performed the real scope switch; and three
  tools described a dry-run payload in their **output** schema without declaring
  `dryRun` as an input, so the contract gave no way to ask for it.
- Jira remediation text now names the credential source the call actually used. An
  explicit `--profile` is the exclusive source by design, so advising the user to set
  `JIRA_BASE_URL`/`JIRA_TOKEN` was advice that provably could not fix the call; the
  same applied to the 401 hint and to `jira-login`'s own failure hint, which pointed
  at environment variables for credentials just typed at its prompt. Fixed on the MCP
  handler as well as the CLI, where an agent acts on the text literally.
- `@syncrona/typescript-plugin`'s README documented its configuration precedence
  backwards. `tsconfig.json` is the base and `compilerOptions` from `sync.config.js`
  are merged on top (the plugin option wins) — the README said the reverse, so
  following it produced the opposite emit with no warning. The section now documents
  the real order and the reason behind each plugin default.
- MCP semantic index: an invalidation arriving during an in-flight build is no
  longer swallowed, out-of-band deletions mark the index stale instead of serving
  deleted symbols indefinitely, and the "non-blocking" async getter no longer runs
  a full synchronous filesystem walk on every call including cache hits.
- The MCP OAuth token manager resolves its undici dispatcher per token request
  instead of pinning the one captured when the manager was created, which had
  defeated the certificate-rotation fix; and it no longer runs the credential-store
  password through the environment-value cleaner, which could silently alter a
  stored secret.
- Documentation corrections: the README claimed `refresh` re-lays an existing
  workspace when `flat` is switched on (nothing does — the correct procedure is
  now documented), `@syncrona/types`' README declared MIT for a GPL-3.0-or-later
  package, and six per-package README configuration examples were unusable
  (`rules` shown as an object where an array is required, and a plugin list that
  is a JavaScript syntax error).
- Releasing the collaboration lock no longer deletes a collaborator's live lock. A
  push that outlives the staleness window is legitimately reclaimed by another
  developer while it is still running; the old unconditional unlink then removed the
  new owner's lock, and the next push proceeded with no mutual exclusion at all. Each
  acquisition now records an owner token and only removes a lock it can prove is its
  own. A lock left behind by a crashed process is still reclaimed immediately, since
  its pid stops answering.
- A reference field no longer aborts the download of every table. ServiceNow returns
  a reference column as a `{ link, value }` object unless the request opts out, which
  this client does not, so a `displayField` or `differentiatorField` pointing at a
  reference column raised `name.replace is not a function` from outside the per-table
  error handling — failing the whole download and naming neither table nor record.
  Such a value is now read as its display value.
- Records with unusable names are skipped with a counted warning instead of
  corrupting the workspace: a record whose `sys_id` is `..` no longer materializes
  the parent directory as a record folder, a record with no `sys_id` no longer lands
  under the literal name `undefined`, and a record named `__proto__` no longer
  vanishes from the manifest while the run reports success.
- `repair --apply --prune` no longer deletes files the manifest does claim. Presence
  on disk was decided with a case-insensitive filesystem call while the orphan lookup
  compared names byte-exactly, so on macOS and Windows a record differing only in
  case was neither reported missing nor recognized as claimed — and was deleted along
  with any unpushed local edits. Name comparison now folds case the same way the
  manifest builder does when it detects colliding record names.
- The missing-record probe looks where the writer actually writes. Where a manifest
  key and the record's name differed, the record was permanently stuck:
  re-downloaded on every run, then deleted by `repair --prune` as an orphan.

### Testing

- The mutation run can no longer be silently switched off by the config that is
  meant to protect it. `testPathIgnorePatterns` has to skip a leftover
  `.stryker-tmp/` sandbox when Jest runs from the package root, yet find those same
  tests when Stryker starts Jest *inside* that sandbox — and because the patterns
  are matched against the ABSOLUTE path, an unanchored `/\.stryker-tmp/` satisfies
  the first requirement and destroys the second. It did: `npm run test:mutation`
  died with "No tests were found" while the ordinary suite stayed green, because
  nothing outside the mutation run exercises the sandbox path. The patterns are now
  anchored with `<rootDir>/`, which Jest expands against whichever root it was
  started with, and `strykerSandboxDiscovery.test.ts` pins both halves plus the
  rule that these entries are regexes rather than globs. The same anchoring is
  applied to a new `modulePathIgnorePatterns`, which closes the neighbouring hole
  `testPathIgnorePatterns` cannot: it filters only which files Jest *runs*, so a
  leftover sandbox still reached the haste map as a second `package.json` claiming
  the name `syncrona` — a naming collision Jest resolves arbitrarily, letting an
  import bind to the stale copy.
- The Stryker timeout budget is back at the default. It had been raised to
  `timeoutMS` 30000 / `timeoutFactor` 3 on the theory that slow, variable ts-jest
  ESM startup under machine load was expiring the budget on mutants the suite never
  reacted to. Measurement disproved it: on an idle machine the raised budget —
  2.7x the effective per-mutant allowance, since that is `timeoutMS` plus
  `timeoutFactor` times the ~17s dry run — timed out on 70 of the first 262
  mutants, 26.7% against the 26.5% it was meant to fix. Neither `static` (6 vs 8)
  nor coverage breadth (10.6 vs 11.7 covering tests, 2.85 vs 2.58 covering test
  files) separates Timeout from Killed; what does correlate is the mutated file —
  48% of `genericUtils.ts` against 5% of `repairCommand.ts`.
- The core mutation score is now quoted as a band, because the timeouts behind it
  were shown to be non-deterministic. Re-running `genericUtils.ts` under
  `coverageAnalysis: "off"` — 363 tests per mutant instead of 18, twenty times the
  work — barely moved the rate (58.3% to 55.6%) but almost entirely changed *which*
  mutants timed out: only 32 of 60 timed out in both, 27 that had "timed out" were
  killed by a real assertion, 22 that had been killed timed out instead, and one
  mutant scored as detected was in fact a **survivor** (with two known survivors
  scored as kills the other way). A genuine infinite loop times out in every
  configuration; a coin flip does not. Since Stryker counts a TimedOut mutant as
  DETECTED, each of those flips silently promotes an undetected mutant to a kill, so
  the honest reading of the 2026-08-17 run is the band `[59.2%, 85.92%]` — 763
  mutants, 14 min 9 s, 203 timeouts (26.6%) — and not the 85.92%.
- `dist/semanticIndexState.js` carries the third declared second reading in the
  mcp-server per-file coverage table: 98.63 / 94.03 measured on darwin, 98.63 /
  94.20 on the ubuntu leg of the CI matrix — the first entry where the two
  platforms split rather than one run flickering. The uncovered-line list is
  byte-identical in both readings, darwin prints 63/67 branches under Node
  22.23.0 and 22.23.2 alike, and 65/69 is the only nearby pair that renders
  94.20 — V8 range granularity across platforms, not behaviour, so per the
  gate's own procedure the second reading is declared rather than chased with a
  test, lower value first so the headroom audit keeps checking the floor
  against the conservative measurement.
- Cross-test `process.exitCode` leakage in `packages/core` is now prevented by
  the harness rather than by each suite remembering. 41 source sites set the
  value and one reads it (`downloadCommand`, to decide whether a partial pull is
  announced as success), while `process.exitCode` is per-process and Jest runs
  many suites in one worker. Suites guarded it two ways, and only one of them
  held: saving in `beforeEach` and restoring in `afterEach` survives a failing
  test, whereas saving at the top of a test body and restoring at the bottom is
  skipped the moment an assertion between them throws — so the first genuine
  failure silently poisoned every test after it. A global hook
  (`jest.exitcode.cjs`, via `setupFilesAfterEnv`) now resets the value around
  every test — to `undefined`, Node's pristine value, rather than to a snapshot
  taken when the setup file loads: workers are reused across test files and a
  top-level suite `afterEach` runs after this hook, so a suite that parks the
  code at `0` would otherwise become the next file's baseline. It touches only
  the boundary between tests, never what the code under test sets inside one. `exitCodeIsolation.test.ts` pins it with a
  deliberate polluter, a clean-slate assertion and a test that throws past a
  would-be inline restore; with the hook removed two of its four cases fail.
  Coverage is unchanged (97.52 / 87.53, all 42 `// measured` annotations still
  exact), which answers the open question the earlier per-suite fix could not:
  nothing in the tree had been covered by the leak.
- The download write seam is pinned against a tampered manifest over a real
  filesystem, not a mocked one: a field name, a file type and a flat-layout
  record name each carrying a traversal, in both the folder and the flat layout,
  plus the two chokepoint writers driven directly. The fixtures join their
  segments raw rather than through `path.join`, because `path.join` normalizes
  as it builds and would collapse the very `x/..` sequences the exploit depends
  on — a tampered manifest is a JSON string, not something Node normalized on
  the way in. Two companion tests assert the legitimate dot-walked names
  (`inputs.script` on `sys_atf_step`, the `<record>~<field>` flat stem) still
  write, so the guard cannot be tightened into a regression.
- The empty-field convergence is pinned end to end — the manifest entry creates
  no file and still reads as missing, the fetched empty value writes zero bytes
  and then reads as present, and `findMissingFiles` stops naming the field after
  the download that supplied it.
- `withStableOrder` is pinned including its two ways to be wrong: it must not
  double-order a query that already has an `ORDERBY` (which would silently
  demote the caller's sort to secondary rather than replace it), and it must not
  mistake an ordinary column whose name merely contains `orderby` for an
  ordering clause. The paging tests drive a full first page so a second request
  is forced, and assert both requests carry byte-identical query text — an
  offset only means the same row on the second request if the ordering it
  indexes into is identical.
- The audit log retires a file two ways — rotation on size and quarantine on
  corruption — and both named the retired file after the millisecond they ran in,
  so both collided when the same file was retired twice inside one millisecond.
  The collision arm is what decides whether the second file is written beside the
  first or `renameSync`d on top of it, i.e. whether the history the audit log
  exists to keep survives at all. It was one duplicated block and is now one
  helper, `withCollisionSuffix`, behind the two exported names `toRotatedAuditPath`
  and `toCorruptAuditPath` (the `corrupt.` infix stays load-bearing: it is how
  `pruneRotatedAuditFiles` and `pruneCorruptAuditFiles` tell the two kinds of
  retired file apart).
  Both now take the instant they stamp as a parameter — production still calls the
  one-argument form — because the embedded clock made the arm untestable rather
  than merely untested. Nothing but machine speed had ever reached it: the
  `.corrupt.` cap test quarantines five times in a tight loop, which collides on an
  idle machine and does not under load, so `dist/audit.js` was recorded three
  different ways (96.33/91.74, 96.57/92.12, 96.25/91.70) across runs of an
  unchanged tree, while the rotation copy of the arm was never covered at all.
  `auditIntegrity.test.js` now drives both with a frozen clock and pins the
  `.1`/`.2` suffixes, that neither earlier file is clobbered, that a rotated name
  carries no `corrupt.` marker, and that the default arm still stamps wall-clock
  time. Two consecutive gate runs now report byte-identical per-file rows.
- The metrics store carried the third copy of that same clock-named path, and it
  is closed the same way. `toRotatedMetricsPath` stamps a rotated
  `metrics.jsonl` with the millisecond it was retired, so two rotations inside
  one millisecond produce one name twice and the `renameSync` below the call
  lands the second on top of the first — discarding samples nothing else holds a
  copy of. The arm's only coverage was accidental in exactly the audit shape: the
  prune test rotates four times in a row, which collides on an idle host and does
  not under load. The function now takes the instant it stamps (production still
  calls the one-argument form) and is exported, so a frozen clock drives the
  collision on purpose; the tests pin the `.1`/`.2` suffixes, that neither
  earlier rotated file is clobbered, and that the default arm still stamps
  wall-clock time. That closes the last of the three sites the original grep
  found.
- `resolveServerVersion`'s fallbacks are driven deliberately rather than left to
  the shape of the checkout: an unreadable manifest, an unparseable one, one with
  no `version`, an empty string and a non-string all resolve to the
  `0.0.0-unknown` sentinel, and `SERVER_VERSION` is asserted to be *derived* from
  the package manifest rather than equal to a literal — the failure that shipped
  the wrong version through the `initialize` handshake for eight minor releases.
- The audit lock's contention arms are now driven deterministically instead of
  by scheduling luck — a fourth run-dependence carrier next to the embedded
  clock, the clock-named path and shared process state: **cross-process lock
  contention**, where the concurrent full suite decides which rare arm of
  `acquireAuditLock` executes. The arms ran only incidentally (the stale-reclaim
  body and the release best-effort catch usually never; the vanished-lock and
  deadline arms 3–4 times per suite), so `dist/audit.js` measured 92.15 branches
  on some full-chain runs and 92.18 on others — caught by the annotations gate —
  and a quiet machine could have dropped below either.
  `auditLockContention.test.js` stages each arm from outside the (unexported)
  lock: a planted fresh lock must stall the writer to the 500ms deadline and
  then be left standing while the record is still written; a planted stale lock
  must be reclaimed, not waited on; a lock vanishing between the failed `O_EXCL`
  open and the stat (one-shot `fs.statSync` interception) must retry
  immediately; and a release that finds its lock already stale-reclaimed
  (one-shot `fs.unlinkSync` interception) must stay best-effort. `dist/audit.js`
  now measures 96.83/92.62, byte-identical across three consecutive gate runs.
- `downloadCommand`'s partial-pull guard is now tested rather than inherited.
  `commands.ts` ends by branching on `process.exitCode` — set by `downloadAllFiles`
  when a table could not be fetched — to warn instead of printing "Download
  complete ✅" over an incomplete pull. `process.exitCode` is per-process, not
  per-test: Jest runs many suites in one worker, around twenty source sites set a
  non-zero code, and not every suite restores it, so which arm ran depended on what
  executed earlier in the same worker (`commands.ts` measured 96.73/83.11 on one
  full run and 96.19/81.81 on another, with no source change). `commandsDownload.test.ts`
  now pins the value around every test — which also stops the suite leaking onto its
  neighbours — and drives the failure arm deliberately, asserting that the warning is
  printed, that the success line is not, and that the non-zero exit code survives the
  command so CI cannot show a green step over missing files.
- The REV-197 fail-closed refusal in `policyConfig` — a `requireDryRun` guardrail
  naming a tool whose handler cannot honour a dry run — is now driven by its own
  tests. It previously had none: every tool the suite named with `requireDryRun` is
  dry-run aware, so the refusal arm was reached only incidentally by the concurrent
  full run, which made `dist/policyConfig.js` report 100.00/100.00 on most runs and
  97.60/99.00 on others and flipped the new annotation gate red at random. Both the
  refusal and its negative control (`dryRun: true` must not buy a pass) are pinned,
  along with the logged operator error.
- `npm run test:coverage:annotations` — a new link in the check chain (and a CI
  step) that compares every `// measured L/B` comment beside a coverage floor with
  the report the package actually produced. Both floor audits enforce a maximum
  *headroom* against those comments, so a stale one silently corrupts the decision
  about whether a floor is safe to raise. Ten had drifted, in both directions. The
  checker takes its keys from the two configs by `require()` — the audited set is
  by construction the enforced set — and fails closed on a missing, unreadable or
  stale report rather than reporting "no drift".
- The annotation checker's fail-closed contract gained the case its own doctrine
  had missed: a **partial** report. A filtered `jest --testPathPatterns` run with
  coverage on overwrites the summary with subset numbers, `collectCoverageFrom`
  still lists every unloaded file at 0%, and the report is *newer* than the
  sources — so the missing-data and staleness checks both read healthy, and the
  gate prescribed `fix: // measured 0.00 / 0.00` transcriptions of the artifact.
  An annotated file at 0.00% lines against a non-zero annotation now exits 2
  ("cannot judge — re-run the full suite") instead of 1 ("drift"). Its staleness
  check also now counts the measurement's configuration among the inputs a
  report must be newer than: `jest.setup.cjs` (decides whether keychain branches
  are reachable at all) and each package's `package.json` (carries the test
  invocation the report comes from).
- The annotation checker's exact-match rule rested on a premise that measurement
  falsified: that two runs over an unchanged tree produce the same numbers. Over
  45 saved mcp-server coverage tables, `dist/audit.js` reported 96.83 / 92.62 in
  42 and 96.83 / 92.65 in 3, and `dist/inputValidation.js` reported 99.30 / 96.15
  in 44 and 99.30 / 96.30 in 1 — so the gate reddened on trees nobody had
  touched. The mechanism rules out a test-side fix: numerator *and* denominator
  each move by one (226/244 vs 227/245), and every one of the 45 tables reported
  the same uncovered-lines list, so V8 is occasionally counting one extra range
  that was already executing — there is nothing uncovered to cover.
  `--no-flush-bytecode` and `--no-lazy-feedback-allocation` were both tried and
  refuted under interleaved, load-controlled A/B; the second flag flaked more
  than the default. A `measured >= recorded` rule is refuted too
  (`dist/workflowHandlers.js` moves 99/118 → 99/122, percentage *down*), and a
  blind tolerance would absorb regressions this repo has actually caught at 0.42
  points. So annotations may now **declare** a second reading —
  `// measured 96.83 / 92.62 (also 96.83 / 92.65: cause)` — where exactly those
  two readings pass and a third is still drift. The cause is mandatory, the
  lower reading must come first (both floor audits parse only the first pair, so
  a higher one there would silently widen their headroom allowance), and the
  form is accepted **only** on the mcp-server/V8 target: three full core runs
  produced a byte-identical `coverage-summary.json`, so the istanbul side keeps
  exact match with no escape hatch. The gate header now carries the diagnostic —
  diff the uncovered-*lines* column before the percentage: a moved column is a
  real branch change, an identical one is V8 range granularity.
- That first pass declared two files and missed a third. Every driver script
  printed a hand-picked watch list, and `dist/toolService.js` was not on it: it
  reads 92.60 / 92.05 in 61 of 62 default-config runs and 92.60 / 91.53 in one,
  uncovered-lines column byte-identical. It is now declared, and it corrects the
  doctrine in two ways. The class runs in **both** directions — here the odd
  reading is *lower* (162/176 = 92.05 against 162/177 = 91.53, an extra range
  that was *not* executing, enlarging the denominator alone), so the
  lower-reading-first rule puts the value you will almost always measure in the
  parentheses. And the counters are now ground truth rather than arithmetic: raw
  V8 data confirms `toolService` 162/176, `audit` 226/244 and `inputValidation`
  25/26, since percentages alone never pin a fraction (162/176 vs 162/177 and
  324/352 vs 324/354 both render 92.05 / 91.53). A new test divides every
  declared fraction out and asserts it renders the reading beside it. Two limits
  stated rather than glossed: the 177 denominator is *derived* — no run printing
  91.53 was caught while capturing raw data — and completeness is not
  established, since a reading seen once in 62 escapes a sample that size about
  37% of the time.
- The annotation checker itself gained five fixes found by review: declaration
  comparisons now round to the two decimals the instrument actually has (raw
  `Number` comparisons in one place and rounding in another let a `fix:`
  directive emit text the same gate rejects as malformed); "this target does not
  accept a second reading" now outranks "this one is written wrong", so the
  istanbul side no longer advises a form it refuses unconditionally; a cause must
  contain a letter, so `.` or an invisible U+200B no longer satisfies it; the
  failure banner offers the declaration recipe only when a failing target allows
  one; and a doubled word in three "cannot judge" messages is gone.
- `mcpCommand.ts` went from **no named floor and the weakest file in the tree** to
  100.00% lines / 98.27% branches behind a 97/93 floor. It was the direct cause of
  a red ubuntu build: the tree-wide floors had been sized against *its* macOS
  numbers (83.33 / 68.18), while on Linux it measured 77.77 / 52.27 and missed the
  line floor by one line. With that anchor gone the tree-wide globs ratchet from
  78/62 to **81/67**.
- `check-env`'s third platform arm (anything that is neither win32 nor linux) was
  covered only *by accident*, because the developer machines run macOS and the host
  walked into it; on ubuntu nothing reached it. It is now pinned by a test, which
  makes the whole core tree's coverage host-independent — re-measured by forcing
  `process.platform` to `linux` for a full suite run, every annotated file lands on
  the same number as macOS.
- A test asserting that MCP client configs are merged rather than overwritten was
  **vacuous on Linux** — it mirrored the source's own `process.platform` branching
  to build its expected paths, so on the OS CI runs, both arms went false, the
  array came out empty, and the assertion loop iterated zero times. It now pins the
  platform, and asserts the array is non-empty before looping.
- Per-file coverage floors in both packages, so a weak module can no longer hide
  behind a green global ratchet: 21 module floors plus raised tree-wide thresholds in
  the core CLI, and 19 module floors plus an 80% line / 45% branch default in the MCP
  server. A floor whose pattern no longer matches any file fails the gate rather than
  silently gating nothing, and dedicated tests prove each floor rejects a file below
  it.
- `bench:guard` and `scan:secrets` are now links in `npm run check` and steps in CI.
  A test re-derives the check chain from `package.json` and fails the build if a link
  has no matching CI step, so the local gate and CI cannot drift apart. The
  performance guard asserts a median against a deliberately loose ceiling — it is a
  blowup detector for accidental quadratic behavior, not a microbenchmark.
- Property-based tests grew from three files to eight, covering manifest name
  derivation, transport auth, MCP input validation and the command safety policy.
  They found the reference-field crash, the `..` sys_id escape and the `__proto__`
  disappearance listed above.
- First measured mutation scores for the MCP policy layer: 100% for endpoint policy,
  87% for input validation, 83% for create-table policy, and 63% for the command
  safety policy — where 327 of 383 survivors were a single shape, deleting one entry
  from a policy table. The suite tested the helpers thoroughly and the table contents
  barely at all, so a new contract suite now asserts the observable decision for
  every entry of every table (including all 302 allowlisted git subcommand options),
  alongside 34 targeted regression tests. The MCP suite grew from 1585 to 1610 tests.
  Re-measured afterwards, the command safety policy scores **94.90%** (1039 mutants:
  985 killed, 1 timeout, 53 survived) — the `StringLiteral` class that was the whole
  finding fell from 327 survivors to 9.
- A multi-process race harness for the push collaboration lock (`npm run race:lock`)
  spawns N real processes against one real directory and releases them from a
  busy-wait barrier into the same millisecond. It exposed that
  `writeFile(path, body, {flag:"wx"})` is atomic in exclusion but **not** in
  publication — `O_CREAT|O_EXCL` publishes the name before the bytes, so a concurrent
  reader can see an empty file and treat the lock as abandoned. The lock and its
  eviction claims are now staged under a private name and published with `link()`,
  which has no such split. Four earlier designs failed this harness; the current one
  survived 195 rounds at up to 24 concurrent racers with zero violations.
- A hostile-input harness over the real MCP stdio boundary
  (`packages/mcp-server/scripts/stdio-fuzz.js`, wired into the suite as
  `test/stdioFuzz.test.js`). Every other test in that package calls exported
  functions directly, so transport framing, the JSON-RPC parser, a log line on the
  wrong file descriptor and a fatal unhandled rejection were all untested — on the
  only surface a real client touches. It spawns the compiled server as a child
  process and feeds 42 hostile frames down a real pipe (truncated JSON, NUL and
  lone-surrogate bytes, batches, duplicate ids, prototype-pollution keys,
  1000-deep nesting, a 1 MB payload, a Trojan Source bidi tool name), checking
  after each that stdout stays pure JSON-RPC, the process still answers a ping, no
  id is invented or reused, and no stack frame or absolute path leaks into an
  error payload. It also verifies from the server's own audit log that no frame
  reached real work — a claim added after two frames were found to be spawning a
  real `syncrona status` subprocess. It found that the server was reporting the
  wrong version in its handshake (see Fixed), and runs in 221 ms.
- The two path-escape tests in `fileUtilsCoverage.test.ts` asserted on
  `os.tmpdir()` itself rather than on a directory they owned, so they could neither
  clean up after the escape they provoke nor survive an unrelated file of the same
  name. The mutation run made that concrete: a mutant with the traversal guard
  removed genuinely wrote outside the root and left the file behind, breaking every
  later run. The source root is now nested inside a tracked sandbox.
- The eviction-claim scheme that publishes the collaboration lock arrived with the
  race harness but without unit coverage, which the per-file floor caught. Its
  branches are now driven on a real filesystem rather than through mocks: a path made
  a directory is occupied for `link()` yet unreadable for `readFile()`, a dangling
  symlink makes `stat()` report `ENOENT`, and a backdated mtime ages a claim. That
  covers the generation walk, the step budget, the back-off behind a live evictor and
  the sweep's short-circuits, and pins the rule that only *positive* evidence abandons
  a claim — an unparseable or unstattable claim is treated as live. `push` also now
  proves it fails the shell when the instance is unreachable, before touching any
  record. `pushCommand.ts` measures 100% lines / 93.91% branches and its floor was
  raised accordingly.

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
