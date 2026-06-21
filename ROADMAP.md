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

- **Current version:** `0.4.2-alpha.8` (private alpha)
- **Engineering readiness:** ~8.5/10 — gate suite green, 0 production-dependency
  vulnerabilities, OAuth on CLI + MCP, CI hardened.
- **Last updated:** 2026-06-21

## Status legend

| Marker | Meaning |
|---|---|
| ✅ | Shipped |
| 🚧 | In progress |
| 📋 | Planned (engineering-completable) |
| 🔒 | Blocked on an owner decision (legal / brand / account / business) |

---

## Where SyncroNow AI is today (v0.4.x alpha)

The engineering foundation is in place and validated end-to-end against scoped
applications. The following are **shipped**:

### CLI core & workflow ✅
- Registry-driven CLI (`commander` interpreter, open/closed command registry),
  16 commands: `init`, `refresh`, `dev`, `push`, `download`, `build`, `deploy`,
  `docs`, `status`, `check-env`, `doctor`, `plugins`, `config`, `login`,
  `logout`, `instances`, `use`.
- Typed CLI args (`typedHandler<TArgs>`), `--dry-run` across mutating commands,
  `--log-level` profiling, column-aligned dry-run tables.
- Push safety: connection preflight, partial-push checkpoint/resume,
  collaboration lock (atomic acquire/release, 30-min stale recovery),
  configurable concurrency (`push --concurrency N`).
- Config: `sync.config.js` shape validation (hard errors + typo warnings),
  rule-order validation (`build --check-config`), `config show-defaults`.

### Auth & security ✅
- **OAuth 2.0** on both the CLI and the MCP server (password grant, Bearer +
  refresh on 401/expiry, shared token manager in `@syncro-now-ai/sn-transport`).
  Basic auth stays the default; OAuth is opt-in via `SN_OAUTH_CLIENT_ID` /
  `SN_OAUTH_CLIENT_SECRET`.
- Multi-instance credentials (env / encrypted store / interactive, profile
  aware), credential-source visibility in `status`, decrypt-failure warnings.
- Encrypted credential store (`@syncro-now-ai/credential-store`, AES-256-GCM),
  policy-as-code + secrets-provider chain, Zod input validation, audited tool
  calls, VM-sandboxed script execution.

### MCP & AI ✅
- ~60 MCP tools across 11 handler modules: metadata/impact/dependency analysis,
  scope knowledge graphs, scope docs + Mermaid diagrams, minimal-footprint
  planning, unified change workflow (with gates and optional remote apply),
  health/metrics, AI next-action suggestions.
- Tool contract + lifecycle metadata, rate limiting, graceful shutdown,
  correlation IDs, structured logging, audit log rotation + integrity checks.

### Quality & CI ✅
- Full gate suite green: core + MCP unit/integration tests, coverage ratchet
  (core lines ~70%, MCP lines ~83% / branches ~75%), tool-contract, docs-drift,
  CLAUDE-docs-drift, and release-checklist gates.
- GitHub Actions CI matrix (Ubuntu + macOS), least-privilege token, all actions
  SHA-pinned.
- **Security automation:** `npm audit` gate (0 high/critical in prod deps),
  gitleaks secret scanning, CodeQL SAST (activates when the repo goes public),
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
  public step below.**
- ✅ **Brand unification** (BA6) — **decided & implemented**: product **SyncroNow
  AI**, npm scope `@syncro-now-ai/*`, CLI command `syncro-now-ai`, MCP server
  `syncro-now-ai-mcp-server`. On-disk conventions (`.syncrona*`) and the
  versioned at-rest crypto salt are intentionally left unchanged (no migration
  pre-publish). Repo rename to match is the only owner step left (cosmetic).
- 🔒 **Repository → public** — flip only after IP clearance. Also activates the
  CodeQL workflow (currently guarded to public repos).
- 🔒 **npm publish + 2FA** (D5) — claim the `@syncro-now-ai` scope, enable 2FA,
  then run the `release` workflow (Changesets publish with provenance).
- 🔒 **Business model / sustainability** (BA5) — OSS-only vs OSS + paid support;
  ownership and co-maintainer (bus factor is 1 today).

### Engineering (completable once decisions land)
- ✅ **Release automation** (G6) — Changesets wired in (`.changeset/`,
  `npm run changeset` / `version-packages` / `release`); `@syncro-now-ai/*` packages
  version in lockstep. The publish step itself stays owner-gated.
- ✅ **CI publish with provenance** (D5) — [`release.yml`](.github/workflows/release.yml)
  publishes via Changesets with `--provenance` (`id-token: write`); dormant until
  the `NPM_TOKEN` secret + public repo land.
- ✅ **Per-package READMEs** — npm landing pages for every published package
  (all 13 have a README and `repository`/`author` metadata).
- ✅ **OS keychain credential strength** (AR2) — the at-rest key resolves from
  `SYNCRONA_STORE_KEY` (CI / secrets manager) or the OS keychain (opt-in
  `SYNCRONA_USE_KEYCHAIN`, optional `@napi-rs/keyring`), falling back to the
  legacy machine-derived key.

---

## v1.0 — Production & enterprise

Goal: a supportable, broadly installable 1.0 that clears the enterprise gate.

### Distribution
- 🚧 **Homebrew tap** (D5) — formula template shipped in
  [`packaging/homebrew/`](packaging/homebrew/syncro-now-ai.rb); owner step left is
  creating the `homebrew-tap` repo and the first publish (release action fills the
  tarball `url`/`sha256`).
- 🚧 **Windows support** (D5) — [`packaging/windows/install.ps1`](packaging/windows/install.ps1)
  shipped; Windows Credential Manager works natively via `@napi-rs/keyring`
  (`SYNCRONA_USE_KEYCHAIN=1`). Remaining: broader native-Windows path testing.

### Auth & connectivity
- 📋 **Proxy / TLS configuration** (G9) — `HTTPS_PROXY` + custom CA bundle for
  corporate networks and self-signed certificates.
- 🔒 **SSO / authorization-code grant** — beyond password grant; needs a product
  decision and per-instance OAuth app configuration.

### Quality & enforcement
- ✅ **Machine-enforced module boundaries** (G10) — dependency-cruiser runs in
  `npm run lint` (`lint:boundaries`): no circular dependencies, and the shared
  foundation packages may not import the core/mcp-server consumers.
- 📋 **Mutation testing** (G13) — Stryker on `credential-store` + `sn-transport`.
- 📋 **Performance baseline** (G14) — `npm run bench` for manifest build / push,
  with a CI threshold to catch regressions.
- 📋 **Thin handler coverage** (QA-2) + coverage ratchet toward 80%.

### Product & support
- 🔒 **ServiceNow compatibility matrix** — test against named ServiceNow releases
  on live instances (today: documented as release-agnostic via REST/Table API).
- 🔒 **Support SLA / commercial tier** (BA5) — business decision.
- 🔒 **CR22** — verify the `sys.scripts.do` fallback against a live instance.
- 🚧/📋 **Telemetry + KPIs** (G7 / BA7) — opt-in local diagnostic log shipped;
  structured metrics + KPI instrumentation (downloads, activation, retention)
  to follow.

---

## Backlog / post-1.0

Engineering-completable, not release-blocking; sequenced by demand.

- 📋 **Download progress/resume** (G3) — bring download to parity with push.
- 📋 **`--flat` mode** (DX17) — flat local layout, converted before push/pull.
- 📋 **`syncrona repair`** — compare manifest vs actual files and repair drift.
- 📋 **Error taxonomy** (DX19) — Network / Config / Data categories with
  actionable next steps for every error.
- 📋 **`config add-plugin`** (DX8) — interactive plugin chooser.
- 📋 **Push progress bar** — `Pushing [███░] 30/100`.
- 📋 **ts-jest migration of MCP tests** (AR9) — run against source, not `dist`
  (high-risk; 172 tests currently green against `dist`).
- 📋 **Module-state context object** (AR11) — encapsulate `TOOL_METRICS`/caches.
- 📋 **Live E2E record-replay** (G11 follow-up).

---

## Discovery & validation (continuous)

- 🔒 **Target persona / user-research loop** (BA1) — 5–8 interviews with the
  SI/consultancy beachhead to tie the roadmap to real demand.
- 🔒 **Quantify the value proposition** (BA2) — pilot with 1–2 teams to measure
  edit-loop cycle time, change safety, onboarding time, and impact-analysis time.

---

> **Note:** SyncroNow AI is currently a **private** repository. Public-facing items
> (npm publish, repo visibility, CodeQL activation, Homebrew) all sit behind the
> IP/provenance and brand decisions above. Internal item IDs (G*, AR*, CR*, DX*,
> BA*) reference [`TODO`](TODO) and [`DONE`](DONE).
