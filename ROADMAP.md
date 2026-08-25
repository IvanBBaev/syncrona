# SyncroNow AI Roadmap

SyncroNow AI is a local-first CLI + AI (MCP) toolchain for ServiceNow scoped-app
development — *"treat ServiceNow code like real application code: versioned,
testable, automatable, and AI-analyzable, from your own editor."*

This roadmap captures where the project is, what is committed next, and which
items are blocked on owner decisions rather than engineering. It is derived from
the internal tracking docs ([`TODO`](TODO), [`DONE`](DONE),
[`docs/ENTERPRISE_READINESS.md`](docs/ENTERPRISE_READINESS.md),
[`docs/PRODUCT_STATE.md`](docs/PRODUCT_STATE.md),
[`docs/BUSINESS_ANALYSIS.md`](docs/BUSINESS_ANALYSIS.md)) and is the
human-facing summary of them.

- **Current version:** `1.0.0` — first stable release, cut 2026-08-25. Latest
  published on npm is `0.9.4` until the `v1.0.0` tag runs the release workflow.
- **Engineering readiness:** ~90% (9/10) — gate suite green, 0 production-dependency
  vulnerabilities, OAuth on CLI + MCP, CI hardened, and corporate proxy/TLS (G9),
  a perf baseline (G14), resumable download (G3), `config add-plugin` (DX8), an
  error taxonomy (DX19), the `repair` command, flat layout (DX17), mutation
  testing (G13) and read-only **Jira issue context** shipped. The 2026-07-13
  hardening wave added a `completion` command (23 CLI commands), a machine-checked
  MCP output contract (`outputSchema` + `structuredContent` on the stable-shape
  tools), MCP stdio stdout-purity guarantees, and raised the MCP coverage gate to
  90/80 (measured ~94% line). A second adversarial pass over the build-plugin
  pipeline, the shared Jira renderer, and the coverage-gate tooling closed seven
  more real defects (REV-4..REV-10) — three build plugins that operated on the
  disk file instead of the piped content, a tsconfig-without-`compilerOptions`
  crash, a shared-options mutation and empty-output-as-failure bug, a
  RangeError on an out-of-range Jira date node, and a coverage gate that silently
  ignored a misspelled threshold flag — each with a regression test. A third
  full-repo adversarial sweep (2026-07-16) closed twenty-one more real defects
  (REV-11..REV-31, 0 refuted): the last build plugin that re-bundled the disk file
  instead of the piped content plus a webpack compiler-resource leak and a swallowed
  config-load error, a cross-file comment-state leak in the babel plugin, `push --ci`
  and download-resume paths that silently truncated data, a non-atomic collaboration
  -lock reclaim, Table-API 400/403/404 tables marked complete-but-empty, flat-layout
  `repair`, a stalled push-retry queue, an invalid-config-file generator, a lossy
  credential filename, `^`-query and `.`/`..` path-injection gaps, a config-sandbox
  stdout leak that escaped onto the protocol channel, an uncaught health-server
  crash, and two exit-code and three governance-anchor gaps — each with a regression
  test (core 740 tests, mcp 962 tests, mcp coverage 94.14% line / 87.05% branch). A
  fourth full-repo adversarial sweep (2026-07-16) closed thirteen more real defects
  (REV-32..REV-44, 0 refuted): a push checkpoint that resumed a grown diff (dropping
  new records) or a switched instance, a cross-realm `RegExp` check that disabled every
  regex-matched build transform, a `.env` writer that corrupted backslash/quote secrets
  (dotenv v17 round-trip), an `isValidScope` that dropped every file at the repo root, a
  manifest query that omitted the configured display/differentiator fields (prune-delete
  risk), a `sync_preflight_check` false all-clear on empty overrides, a docs-drift gate
  blind to a removed last-of-family tool, a recent-changes bound it never applied, one
  undecodable credential filename hiding all instances, a typescript-plugin that fed raw
  JSON `compilerOptions` into `createProgram`, and an unrenamed aliased `@expandModule`
  import — each with a regression test (core 747 tests, mcp 967 tests, credential-store
  60, typescript-plugin 8, babel-remove-modules 10). A fifth full-repo adversarial sweep
  (2026-07-17) closed thirty-seven more real defects (REV-45..REV-81, 0 refuted): a
  `push --dry-run` that cleared the resume checkpoint it only meant to preview, a
  `push --ci` that exited 0 after a collaboration-lock abort (a no-op deploy reading as
  success), a checkpoint resume keyed on `table:sysId` that skipped a record edited after
  it succeeded, a `--log-level` typo that winston turned into silence for every line
  including errors, a documented `init --ci` that yargs `.strict()` rejected and a
  `deploy` that never registered `--ci` at all, `status` and `doctor` diagnosing every
  non-Basic auth method as unconfigured, a `logout` that announced purges it had not
  performed, a Jira `HTTP 403` routed to the re-login hint, a manifest query passing its
  already-resolved display field as its own fallback, a global/sticky `lastIndex` leak
  across `determinePlugins` calls, a `sync_validate_before_push` that reported `ready`
  while holding errors and degraded a failed conflict query into a silent all-clear, a
  `sync_compare_instances` that read a fulfilled non-2xx as a diff, a
  `run_workspace_command` whose destructive gate matched a substring and which never
  wrote a mutation audit entry, a brand display name used as an npm identifier, zod
  schemas rejecting the empty string their own tool defaults emit, an OAuth token fetch
  that silently ignored `timeoutMs` for lack of an abort signal, an `SN_AUTH_METHOD`
  resolved against `Object.prototype`, three ADF holes (block/inline confusion, a
  never-throws contract that threw, a missing `embedCard`), a `removeAllCredentials`
  counting what it listed rather than what it deleted plus a config cast that accepted
  valid-JSON non-objects, six build-plugin defects (a comment-tag regex swallowing the
  next prose word, fused adjacent comments, an unguarded options deref, a forced
  `moduleResolution`, eslint options never forwarded, and a function-form webpack config
  flattened by `Object.assign`), and five holes in the governance gates themselves —
  unparseable metadata swallowed into `{}`, zero-test `dist` modules invisible to the
  coverage verdict, quote-style-only tool extraction, an indentation-anchored claims
  parse, and a docs-drift gate that failed from any cwd but the root — each with a
  regression test (core 788 tests / 76 suites, mcp 1040 tests, jira 97, credential-store
  66, sn-transport 52, mcp coverage 94.94% line / 87.07% branch). A sixth,
  security-focused adversarial wave (2026-07-17..18) closed forty-eight more findings
  (REV-82..REV-129), each re-attacked by an independent adversarial pass before closing:
  the in-process `vm` "safe sandbox" was removed after a reproduced host RCE
  (`console.log.constructor` escape) in favor of a real child process with string code
  generation disabled and a credential-scrubbed environment; `run_workspace_command`
  moved to a default-deny read-only allowlist whose git gate resolves the real
  subcommand through global-option values, confirms any verb not on a read-only
  allowlist (closing a git-alias RCE and every unlisted mutating verb), and always
  confirms inline `-c`/`--config-env` config injection; guardrail policy loading fails
  closed on unreadable, non-object, or prototype-poisoning configs; the audit log became
  a keyed tamper-evident HMAC chain (store-derived key without SYNCRONA_STORE_KEY,
  symlinked-path refusal, quarantine retention cap, fail-closed mutating writes) with
  value-based secret redaction broadened to vendor-prefixed API tokens and raw 256-bit
  hex; the unified change workflow analyzes the actually-executed script and floors its
  risk on a trusted no-caller-policy analysis, so neither `riskLevel:"low"` nor zeroed
  `policy.weights` bypasses the approval and self-attestation gates; core's pull path
  gained path-traversal containment re-anchored to the workspace source root and
  null-prototype missing-file maps (manifest-driven arbitrary-write and
  prototype-pollution primitives closed); and three honest-limits notes now document
  what the machine-derived chain key, the final-component symlink checks, and the
  child-environment scrub deliberately do NOT guarantee — each behavioral fix with a
  regression test (core 807 tests / 81 suites, mcp 1271 tests, mcp coverage 94.84%
  line / 87.92% branch). A seventh full-repo adversarial sweep (2026-07-24..25)
  triaged 108 raw findings down to 85 and confirmed **59** through a three-lens
  panel that defaults to refuting under uncertainty (REV-130..REV-192; 20 high,
  39 medium, 26 refuted): every build plugin failed to load at runtime
  (`await import()` of a directory throws `ERR_UNSUPPORTED_DIR_IMPORT`), `build`
  exited 0 when records failed to build, `push <relative-path>` silently pushed
  nothing because containment ran on the unresolved path, a 403 on one table
  silently dropped it from the rebuilt manifest so `repair --prune` then deleted
  its local source, `repair --prune` also deleted live manifest-tracked files
  whose bytes had drifted, and `init` derived package directory names from the
  server-supplied scope with no path-component validation; the audit chain kept
  its high-water marker in world-shared `/tmp`, rewrote a symlinked log in place,
  returned early on a fully-legacy log so the truncation tripwire never ran, and
  emitted duplicate seq numbers under concurrent writers; the git allowlist
  validated the subcommand verb but never its own options (unconfirmed RCE and
  arbitrary file clobber) and matched binaries on basename alone; `dryRun` was
  ignored by `run_workspace_command`/`run_node_code` and never handed to
  `sync_unified_change_workflow`, so a simulation performed the real apply and
  was audited as a dry run; the typescript-plugin ignored `extends` chains and
  silently downgraded a string-valued `target` to CommonJS (unrunnable in Rhino);
  and the repo's own gates leaked — the boundary self-test ignored rule severity
  (every rule could be downgraded to `warn` with both gates green), CI omitted
  `verify:pack`, and the packed-bin smoke symlinked the whole workspace
  `node_modules` into the staged package so it could not detect an undeclared
  runtime dependency — each with a regression test (core 868 tests / 89 suites,
  mcp 1408 tests, jira 102, credential-store 66, sn-transport 55, mcp coverage
  95.41% line / 88.57% branch). The remaining distance
  to 10/10 is owner/live-gated (npm publish, live-instance verification, Windows host,
  business decisions), not engineering-completable offline.
- **Seventh-wave re-examination + release hardening (2026-08-17):** the six
  findings the seventh-wave panel refuted were re-examined with reproduction
  harnesses instead of argument — **all six reproduced as real defects** and are
  now fixed, each with a test that fails on the unfixed code (watch-mode retry
  ladder, keychain key-provision write race, Jira empty-comment-page wipe,
  `sys.scripts.do` abort-before-auth, webpack-plugin Windows config discovery,
  MCP credential-store auth-method degradation to Basic). The profile
  instance-fallback second look resolved with a loud once-per-process warning
  (MCP path included), win32 path semantics are pinned by a host-independent
  regression suite (drive-letter-case fix in `isUnderPath`), and the release
  pipeline gained the git identity `changeset publish` needs to create its
  per-package tags (the silent failure that shipped 0.9.0/0.9.1 untagged).
  0.9.4 is live on npm with provenance (16 packages; `@syncrona/mirror` and
  `@syncrona/redaction` joined at 0.9.3, and 0.9.2 was never published). 0.9.4 is
  a patch over 0.9.3: the record-metadata layer announced there only worked on
  instances *without* the companion scoped app, which is the opposite of the
  documented setup.
  Suite totals as measured for the release (2026-08-20): **4786 tests** — core
  1238 / 114 suites, mcp 1696, mirror 1290 / 43 suites, jira 126,
  credential-store 70, redaction 132, sn-transport 151, and 83 across the eight
  build plugins.
  The remaining distance to 1.0 was owner/live-gated (live-instance
  verification, native Windows CI host, Homebrew tap, business decisions), not
  engineering-completable offline.
- **1.0.0 (2026-08-25).** Two of those gates closed. The primary workflow was
  run end to end against a live **Yokohama patch 13** instance — byte-exact
  `download`, a `push` edit that landed and was restored, `build --diff`,
  `deploy --ci`, `--json` and `--dry-run` (recorded in
  [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)) — and the Homebrew formula
  was verified against the real registry tarball: `brew style`,
  `brew audit --strict --online`, build-from-source, install, `brew test`, and
  the installed binary printing its version. The dev-dependency tree, which no
  workflow audited, is now gated in CI and at zero findings. **Still open past
  1.0:** a native Windows CI host, the `homebrew-tap` repository itself (the
  `update-homebrew` job has never run), a live-instance E2E job in CI (G11), and
  the business decisions (BA1 external users, BA5 support tier).
- **Shared foundation grew by one leaf (2026-08-17):** the credential detectors
  that had been hardened inside the MCP audit trail over five reviews moved out
  into **`@syncrona/redaction`**, a fifteenth workspace package that imports
  nothing — `@syncrona/types` included — so a security primitive at the bottom of
  the graph can be audited on its own. A `redaction-is-leaf` dependency-cruiser
  rule and the package's own manifest contract test both enforce that. In the same
  pass `@syncrona/sn-transport` gained `mirrorPolicy.ts` (instance-failure
  taxonomy — transient / auth / ACL / not-found / fatal, retry schedule, and a
  tri-state reachability probe that keeps wrong-credentials, wrong-URL and
  hibernating-instance as three distinct operator actions) and `pathSafety.ts`
  (turning instance-supplied names into filenames legal on every supported
  filesystem: separator folding, a byte-rather-than-code-point cap, deterministic
  collision resolution). `@syncrona/redaction` is not on npm yet — it publishes
  with the next release, which the fixed changesets version group handles without
  configuration.
- **Last updated:** 2026-08-25

## Status legend

| Marker | Meaning |
|---|---|
| ✅ | Shipped |
| 🚧 | In progress |
| 📋 | Planned (engineering-completable) |
| 🔒 | Blocked on an owner decision (legal / brand / account / business) |

---

## Where SyncroNow AI is today (v0.9.x pre-release)

The engineering foundation is in place and validated end-to-end against scoped
applications. The following are **shipped**:

### CLI core & workflow ✅
- Registry-driven CLI (`commander` interpreter, open/closed command registry),
  23 commands: `init`, `refresh`, `dev`, `push`, `download`, `build`, `deploy`,
  `docs`, `status`, `check-env`, `doctor`, `plugins`, `config`, `repair`,
  `completion`, `mcp`, `login`, `logout`, `instances`, `use`, `jira`,
  `jira-login`, `jira-logout`.
- Typed CLI args (`typedHandler<TArgs>`), `--dry-run` across mutating commands,
  `--log-level` profiling, column-aligned dry-run tables.
- Push safety: connection preflight, partial-push checkpoint/resume,
  collaboration lock (atomic acquire/release, 30-min stale recovery),
  configurable concurrency (`push --concurrency N`).
- Config: `sync.config.js` shape validation (hard errors + typo warnings),
  rule-order validation (`build --check-config`), `config show-defaults`.

### Auth & security ✅
- **OAuth 2.0** on both the CLI and the MCP server (password grant, Bearer +
  refresh on 401/expiry, shared token manager in `@syncrona/sn-transport`).
  Basic auth stays the default; OAuth is opt-in via `SN_OAUTH_CLIENT_ID` /
  `SN_OAUTH_CLIENT_SECRET`.
- Multi-instance credentials (env / encrypted store / interactive, profile
  aware), credential-source visibility in `status`, decrypt-failure warnings.
- Encrypted credential store (`@syncrona/credential-store`, AES-256-GCM),
  policy-as-code + secrets-provider chain, Zod input validation, audited tool
  calls, child-process script execution (the in-process VM sandbox was removed
  2026-07-17 after a reproduced escape; string code generation disabled,
  credential-scrubbed environment).

### MCP & AI ✅
- 61 MCP tools across the handler modules: metadata/impact/dependency analysis,
  scope knowledge graphs, scope docs + Mermaid diagrams, minimal-footprint
  planning, unified change workflow (with gates and optional remote apply),
  health/metrics, AI next-action suggestions, and read-only Jira issue context
  (`jira_get_issue`).
- Tool contract + lifecycle metadata, rate limiting, graceful shutdown,
  correlation IDs, structured logging, audit log rotation + integrity checks.
- Declared **output contract**: the stable-shape tools advertise an
  `outputSchema` and return matching `structuredContent` on every success
  result. The schemas are rendered into the tool reference and the whole
  surface (names, schemas, docs) is drift-checked in CI.

### Quality & CI ✅
- Full gate suite green: core + MCP unit/integration tests, coverage ratchet
  (core lines ~95%, MCP lines ~94% — gate raised to 90/80), tool-contract,
  docs-drift, tool-reference, CLAUDE-docs-drift, claims-drift, and
  release-checklist gates.
- GitHub Actions CI matrix (Ubuntu + macOS), least-privilege token, all actions
  SHA-pinned.
- **Security automation:** `npm audit` gate (0 high/critical in prod deps),
  gitleaks secret scanning, CodeQL SAST (active — the repo is public),
  Dependabot.

### Docs & governance ✅
- README, ARCHITECTURE, PLUGIN_DEVELOPMENT, MONOREPO_GUIDE, MULTI_INSTANCE,
  COMPARISON, BUSINESS_ANALYSIS, ENTERPRISE_READINESS, SECURITY, SUPPORT,
  CODE_OF_CONDUCT, issue/feature templates.

---

## v0.5 — First public publish (beta)

Goal: ship SyncroNow AI to npm and open the repository. This milestone is gated
mostly by **owner decisions**, with a small amount of engineering left.

### Owner decisions (must clear first)
- 🔒 **IP / provenance clearance** (BA8 / R1) — verify ownership of pre-existing
  code and the right to distribute it publicly. Code carried prior `nuvolo`
  references; the repo now lives on a personal account. **Hard gate on every
  public step below.** Full analysis, current compliance state, and the exact
  legal sign-off still required: [docs/PROVENANCE.md](docs/PROVENANCE.md).
- ✅ **Brand unification** (BA6) — **decided & implemented**: product **SyncroNow
  AI**, npm scope `@syncrona/*`, CLI command `syncrona`, MCP server
  `syncrona-mcp-server`. On-disk conventions (`.syncrona*`) and the
  versioned at-rest crypto salt are intentionally left unchanged (no migration
  pre-publish). Repo rename to match is the only owner step left (cosmetic).
- ✅ **Repository → public** — done 2026-06-21; the repo is now public and the
  CodeQL workflow (guarded to public repos) activates automatically. (Confirm IP
  clearance below is settled, since it was the intended gate for this step.)
- ✅ **npm publish + 2FA** (D5) — done 2026-08-17: the `@syncrona` scope is
  claimed with 2FA + an automation token, and 0.9.1 shipped to npm with
  provenance for all 14 packages via the `release` workflow. Follow-up fix in
  [`release.yml`](.github/workflows/release.yml): `changeset publish` creates
  annotated tags, which need a committer identity on the runner — without one
  the tag call fails silently inside changesets (the reason 0.9.0/0.9.1
  published without per-package tags).
- 🔒 **Business model / sustainability** (BA5) — OSS-only vs OSS + paid support;
  ownership and co-maintainer (bus factor is 1 today).

### Engineering (completable once decisions land)
- ✅ **Release automation** (G6) — Changesets wired in (`.changeset/`,
  `npm run changeset` / `version-packages` / `release`); `@syncrona/*` packages
  version in lockstep. The publish step itself stays owner-gated.
- ✅ **CI publish with provenance** (D5) — [`release.yml`](.github/workflows/release.yml)
  publishes via Changesets with `--provenance` (`id-token: write`); dormant until
  the `NPM_TOKEN` secret + public repo land.
- ✅ **Per-package READMEs** — npm landing pages for every published package
  (all 13 have a README and `repository`/`author` metadata).
- ✅ **OS keychain credential strength** (AR2) — the at-rest key resolves from
  `SYNCRONA_STORE_KEY` (CI / secrets manager) or the OS keychain (the DEFAULT
  backend via the optional `@napi-rs/keyring`; opt out with
  `SYNCRONA_USE_KEYCHAIN=0`), falling back to the legacy machine-derived key.

---

## v1.0 — Production & enterprise

Goal: a supportable, broadly installable 1.0 that clears the enterprise gate.

### Distribution
- 🚧 **Homebrew tap** (D5) — formula template shipped in
  [`packaging/homebrew/`](packaging/homebrew/syncrona.rb); owner step left is
  creating the `homebrew-tap` repo and the first publish (release action fills the
  tarball `url`/`sha256`).
- 🚧 **Windows support** (D5) — [`packaging/windows/install.ps1`](packaging/windows/install.ps1)
  shipped; Windows Credential Manager works natively via `@napi-rs/keyring`
  (the keychain is the default; disable with `SYNCRONA_USE_KEYCHAIN=0`).
  Win32 path semantics are now regression-tested on any host (the suite forces
  `path.win32`): drive-letter case-folding in `isUnderPath` (a lowercase `c:`
  cwd from Git Bash / VS Code no longer makes `push`/`build` see zero files),
  traversal/containment invariants, and the webpack-plugin's Windows config
  discovery (`path.join` + `pathToFileURL` instead of a POSIX-style split that
  produced an invalid import specifier) —
  `packages/core/src/tests/win32PathSemantics.test.ts`,
  `packages/webpack-plugin/test/win32ConfigDiscovery.test.js`. Reserved device
  names (`CON`, `NUL`) and trailing dots/spaces stay as-is by contract (renaming
  would diverge on-disk layouts; `repair`'s canonical-name check already defuses
  the prune vector). Remaining: a native `windows-latest` CI runner (proposed as
  a non-required job).

### Auth & connectivity
- ✅ **Proxy / TLS configuration** (G9) — CLI honors `HTTPS_PROXY` / `NO_PROXY`
  automatically; custom CA bundle via `SYNCRONA_CA_BUNDLE` / `NODE_EXTRA_CA_CERTS`,
  plus a warned `SYNCRONA_TLS_REJECT_UNAUTHORIZED=0` opt-out for test instances.
  The MCP fetch-client follow-up shipped 2026-07-18: the native-fetch client now
  routes through an undici `EnvHttpProxyAgent` dispatcher honoring
  `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`, composed with the existing
  mutual-TLS/custom-CA dispatcher cache.
- 🔒 **SSO / authorization-code grant** — beyond password grant; needs a product
  decision and per-instance OAuth app configuration.

### Quality & enforcement
- ✅ **Machine-enforced module boundaries** (G10) — dependency-cruiser runs in
  `npm run lint` (`lint:boundaries`): no circular dependencies, and the shared
  foundation packages may not import the core/mcp-server consumers.
- ✅ **Mutation testing** (G13) — done 2026-06-21: Stryker (jest runner,
  `npm run test:mutation`, non-blocking gate) wired on `credential-store` +
  `sn-transport`; the credential-store mutation score was later lifted to 81.6%
  (2026-06-24).
- ✅ **Performance baseline** (G14) — `npm run bench` measures the manifest →
  doc pipeline over a deterministic synthetic dataset (median/p95/runs-sec) and
  can fail on a `--max-ms` threshold for a non-blocking CI job.
- ✅ **Thin handler coverage** (QA-2) — done 2026-06-21: five per-handler test
  suites (against `dist`, per the AR9 decision) cover the weakest handlers'
  validation/guard/dry-run paths. The old "ratchet toward 80%" target is long
  passed — MCP coverage stands at 95.41% line / 88.57% branch against 90/80 gates.
- ✅ **Re-examine the six refuted high-severity findings** (seventh wave,
  2026-07-25) — done 2026-08-17, and the second look was warranted: reproduction
  harnesses confirmed **all six** as real defects (every refutation had been
  argued, not executed). Each fix landed with a test that fails on the unfixed
  code: the `Watcher.ts` retry ladder never engaged because push failures
  resolve to `{ success: false }` instead of rejecting — failed watch pushes
  now requeue with capped exponential backoff
  (`watcherResolvedPushFailureRetry.test.ts`); the `keyFromKeychain()` write
  race (two processes both generating a fresh key, the lost write leaving
  stored credentials permanently undecryptable) is closed with a cross-process
  lock plus a double-checked re-read (`keychainProvisionRace.test.ts`); an
  empty dedicated Jira comment response no longer wipes the embedded comment
  page (`commentMergeEmptyResponse.test.ts`); the `sys.scripts.do` fallback
  resolves auth before arming the abort timer and budgets the OAuth token leg
  (`backgroundScriptFallbackAuthBudget.test.js`); the webpack-plugin discovers
  `webpack.config.js` on Windows via `path.join` + `pathToFileURL` — the old
  POSIX split produced an invalid import specifier that threw on every file
  (`win32ConfigDiscovery.test.js`); and the MCP server now adopts the stored
  profile's auth method — OAuth grants, API key — all-or-nothing instead of
  silently degrading to Basic, with env auth material always winning and an
  instance mismatch failing closed (`authStoreMultiMethod.test.js`; mTLS stays
  env-only in both clients, and the stale SECURITY claim that the fallback is
  "Basic-only" is corrected — it reuses the full Authorization and mTLS
  dispatcher).
- ✅ **Second look: profile fallback to the base instance** (review pass,
  2026-08-07) — resolved 2026-08-17. The contract stays (a credentials-only
  profile that overrides no instance remains legal — a hard error would break
  that documented overlay use), but the fallback is no longer silent: when a
  named profile defines no instance and resolution falls back to the base
  `SN_INSTANCE`, the CLI warns once per process, naming the profile, the
  fallback instance, and the variable that silences the warning (e.g.
  `SN_INSTANCE_QA`). The `mcp` path is covered without extra code —
  `syncrona mcp` resolves credentials *before* persisting
  `.syncrona-mcp/secrets.json`, so the warning fires (on stderr, MCP-protocol
  safe) before the fallback is inherited by later sessions
  (`profileInstanceFallbackWarning.test.ts`, `mcpProfileFallbackWarning.test.ts`).

### Product & support
- 🔒 **ServiceNow compatibility matrix** — test against named ServiceNow releases
  on live instances (today: documented as release-agnostic via REST/Table API).
- 🔒 **Support SLA / commercial tier** (BA5) — business decision.
- ✅ **CR22** — verified live (2026-07-03). Fixed a trigger bug (the fallback
  keyed on HTTP 404, but a real instance without the scoped app answers `400`)
  and confirmed the documented limit: `sys.scripts.do` under Basic-only auth
  returns 200 but does **not** execute the script without a UI session/CSRF
  token. Now correctly reachable; still Basic-auth-limited as documented.
- ✅ **Diagnostic telemetry** (G7, engineering part) — shipped 2026-06-13:
  opt-in local diagnostic log (`SYNCRONA_DIAGNOSTIC_LOG=1` appends CLI output to
  `~/.syncrona/logs/cli.log`; rotated, off by default, documented in SECURITY.md).
- 🔒 **KPI metrics** (G7 remainder / BA7) — the opt-in structured-events schema
  (downloads, activation, retention) instruments the KPI set defined in BA7,
  which is gated on the publish/owner decisions above.

---

## Backlog / post-1.0

Engineering-completable, not release-blocking; sequenced by demand.

- ✅ **Download progress/resume** (G3) — per-table progress + a
  `sync.download.checkpoint.json` so an interrupted download resumes instead of
  starting over (parity with push).
- ✅ **`--flat` mode** (DX17) — core shipped 2026-06-21: lossless, reversible
  flat↔folder conversion, `flat` config flag, README docs. (The automatic
  pull/push pipeline wiring stays an opt-in preview until a live-instance
  round-trip validates it.)
- ✅ **`syncrona repair`** (DX18) — shipped 2026-06-21: reconciles the manifest
  against local files; `--apply` re-downloads missing files, `--apply --prune`
  deletes orphans (confirmed unless `--ci`).
- ✅ **Error taxonomy** (DX19) — shipped 2026-06-21: `classifyError` sorts any
  failure into network / auth / config / data / unknown, and every CLI error
  sink prints an actionable `→ <hint>` next-step line.
- ✅ **`config add-plugin`** (DX8) — shipped 2026-06-21: resolves a plugin by
  alias or package name, reports installed-vs-missing, and prints the install
  command plus a paste-ready `rules` snippet.
- ✅ **Push progress bar** (DX24) — shipped 2026-06-21: TTY-only
  `[====   ] 30/100 (30%) ~2m 10s left` bar with a throughput-derived ETA,
  wired into both push phases (the ETA-rendering bug was fixed the same day,
  with a regression test).
- **ts-jest migration of MCP tests** (AR9) — deferred by decision (2026-06-21,
  re-confirmed 2026-06-24): TODO marks it high-risk for zero behavior change
  and not engineering-completable offline; testing the compiled `dist` is a
  deliberate choice, and the 1271 MCP tests stay green against `dist`.
- ✅ **Module-state context object** (AR11) — done 2026-06-21: `TOOL_METRICS` is
  no longer an exported, externally-spliced array; it is encapsulated behind
  accessors mutated in one place and reset/rehydrated explicitly.
- 🔒 **Live E2E record-replay** (G11 follow-up) — recording requires a live
  ServiceNow instance with credentials; the local E2E slices shipped 2026-06-12.

---

## Discovery & validation (continuous)

- 🔒 **Target persona / user-research loop** (BA1) — 5–8 interviews with the
  SI/consultancy beachhead to tie the roadmap to real demand.
- 🔒 **Quantify the value proposition** (BA2) — pilot with 1–2 teams to measure
  edit-loop cycle time, change safety, onboarding time, and impact-analysis time.

---

> **Note:** SyncroNow AI is now a **public** repository (2026-06-21) with CodeQL
> active, and the `@syncrona/*` packages are **live on npm** with provenance
> (0.9.1, 2026-08-17). The remaining public-facing item (Homebrew tap) still
> sits behind the owner steps above. Internal item IDs (G*, AR*, CR*, DX*, BA*)
> reference [`TODO`](TODO) and [`DONE`](DONE).
