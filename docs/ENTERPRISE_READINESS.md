# Public 1.0 / Enterprise readiness

What it takes to take SyncroNow AI from "alpha-ready" to a **public 1.0** that an
enterprise can adopt. Companion to [BUSINESS_ANALYSIS.md](BUSINESS_ANALYSIS.md)
(§10 enterprise gate) and the engineering `TODO`/`DONE`. Status as of 2026-06-21.

Legend: ✅ done · 🟡 AI-completable (in-repo, scheduled) · 🔴 owner-gated
(needs an account, a credential, a live instance, or a decision).

## 1. Authentication & security
- ✅ **OAuth 2.0 (CLI)** — password grant, Bearer + refresh, `SN_OAUTH_*`; Basic
  stays default (G1).
- ✅ **OAuth 2.0 (MCP server)** — DONE: `createTokenManager` moved to
  `@syncrona/sn-transport` (shared); `servicenowCore` sends Bearer + refresh on
  401, Basic fallback, via the same `SN_OAUTH_*` vars (3 mcp tests). The legacy
  `sys.scripts.do` fallback stays Basic (best-effort; CR22).
- ✅ **Full ServiceNow auth-method coverage** — DONE: one `SN_AUTH_METHOD`-driven
  layer in `@syncrona/sn-transport`, wired identically into CLI (axios) and MCP
  (native fetch). Adds OAuth **client-credentials** and **JWT-bearer** grants
  (RS256 via Node `crypto`, `SN_JWT_KEY`), **inbound REST API key**
  (`SN_API_KEY`, header `x-sn-apikey`), and orthogonal **mutual TLS**
  (`SN_CLIENT_CERT`/`SN_CLIENT_KEY`, combinable with any method). `syncrona login`
  gains a method picker + non-interactive flags; cert/JWT keys are referenced by
  path, never copied into the encrypted store. Backward-compatible: absent config
  infers Basic or OAuth-password exactly as before.
- 🔴 **SSO / authorization-code grant** — interactive browser flow; needs product
  decision + per-instance OAuth app config. (Non-interactive service auth is now
  fully covered by the methods above.)
- ✅ **At-rest credential strength (AR2)** — DONE: the store key is resolved via
  `SYNCRONA_STORE_KEY` (explicit 32-byte key for CI / secrets managers) > OS
  keychain (the DEFAULT backend, via the optional `@napi-rs/keyring`; opt out with
  `SYNCRONA_USE_KEYCHAIN=0` on headless CI without a keychain) > the legacy
  machine-derived key (automatic fallback when the keychain / `@napi-rs/keyring` is
  unavailable, and keeps old files decrypting). The machine-derived fallback stays
  obfuscation-grade; the keychain default or an explicit key gives real at-rest
  protection.
- ✅ **Security policy & data-handling** — SECURITY.md (disclosure + what is
  read/written + opt-in diagnostic log).
- ✅ **Secret scanning in CI** — gitleaks runs in the GitHub Actions workflow
  (full-history job, fixtures allowlisted via `.gitleaks.toml`).
- ✅ **Dependency audit gate** — `npm audit --omit=dev --audit-level=high` = 0,
  enforced in CI.
- ✅ **Jira integration (read-only)** — the `jira` CLI command and the
  `jira_get_issue` MCP tool fetch issue context over HTTPS only. Credentials
  (Cloud API token or Server/DC PAT) live in the same encrypted CredentialStore
  as ServiceNow, resolved via `--profile` > `JIRA_*` env vars > default profile.
  Untrusted issue prose (summary / description / comment bodies) is fenced before
  it reaches an LLM, so it cannot be read as instructions. No write path exists.

## 2. Distribution & release (D5)
- 🔴 **npm publish** — `@syncrona/*` not yet published; verify scope
  ownership + enable 2FA, add the `NPM_TOKEN` secret, then release via the
  `Release` workflow (`changeset publish`, exposed locally as `npm run release`).
- 🔴 **Homebrew tap** — create `homebrew-tap` repo + Formula + release action.
- 🔴 **Windows** — PowerShell install script + Windows Credential Manager (and
  native-Windows support beyond WSL).
- ✅ **Release automation (G6)** — DONE: Changesets wired in (`.changeset/`,
  `npm run changeset` / `version-packages` / `release`); all `@syncrona/*`
  packages version in lockstep. Publishing itself stays owner-gated (npm scope +
  2FA).
- 🟡 **CI publish with provenance** — publish from CI with `--provenance` + 2FA
  instead of a laptop (depends on npm publish decision).

## 3. Compatibility & support
- ✅ **ServiceNow compatibility statement** — README (release-agnostic via REST/
  Table API, with/without companion app); 🔴 a **formal supported-version
  matrix** needs testing against named releases (live instances).
- ✅ **Support docs** — SUPPORT.md (channels, diagnostics, no-SLA disclaimer),
  CODE_OF_CONDUCT.md, issue/feature templates.
- 🔴 **Support SLA / commercial tier** — business decision (BA5).
- ✅ **CR22** — verified live 2026-07-03: fixed the fallback trigger (it keyed on
  HTTP 404, but a live instance without the scoped app answers `400`) and
  confirmed the documented CSRF limit — `sys.scripts.do` under Basic-only auth
  returns 200 but does not execute the script without a UI session token.

## 4. Quality, CI/CD, governance
- ✅ **Gates** — `npm run check` green (381 tests: 206 core + 175 mcp); coverage ratchet
  (core 70/57/61/70, mcp 70% lines+branches); tool-contract + docs-drift +
  release-checklist gates.
- ✅ **CI matrix** — GitHub Actions on ubuntu + macOS, full chain + audit gate;
  least-privilege `permissions: contents: read`.
- ✅ **CI hardening** — least-privilege permissions + GitHub Actions pinned to commit SHAs.
- ✅ **Module-boundary enforcement (G10)** — DONE: dependency-cruiser runs in
  `npm run lint` (`lint:boundaries`); enforces no-circular and that the shared
  foundation packages never import the core/mcp-server consumers.
- 🟡 **Mutation/perf baselines (G13/G14)** — Stryker / bench (dev deps).
- 🔴/🟡 **ts-jest migration of mcp tests (AR9)** — HIGH RISK; deferred.

## 5. Legal, brand, governance gates (owner)
- 🔴 **IP / provenance clearance (BA8 / R1)** — verify ownership of pre-existing
  code and the right to distribute publicly **before the repo goes public**.
  "ServiceNow" trademark disclaimer is in place.
- ✅ **Repository public** — done 2026-06-21; CodeQL now active. (Was gated on IP
  clearance below — confirm that clearance is settled.)
- 🔴 **Brand unification (BA6)** — `syncrona` / `@syncrona/*` / `syncrona`
  CLI; pick one name before a public launch (changes the published package name).
- 🟡 **Per-package READMEs** — npm landing pages for published packages.

## Recommended sequence
1. ✅ **MCP-server OAuth** — done (enterprise auth story complete: CLI + MCP).
2. ✅ **CI hardening** — done (least-privilege + SHA-pinned actions).
3. 🟡 **Pre-publish package hygiene** — per-package READMEs, bin-path/metadata
   normalization, `repository`/`author` fields (in progress).
4. 🔴 **IP/provenance clearance** — gates everything public.
5. 🔴 **Decide brand + repo-public + npm scope/2FA** (one decision block).
6. ✅ **Keychain (AR2) + G6 changesets + module boundaries (G10)** — done.
7. 🔴 **Distribution (Homebrew/Windows) + compatibility matrix + SLA** — needs
   accounts, live instances, and a support model.
8. **Cut 1.0** once the gates above are green and the `repo-standard` Definition
   of Done is met.

> Bottom line: the **engineering** is essentially 1.0-grade (OAuth complete on
> both clients, CI hardened, gates green). What gates a public/enterprise 1.0 is
> now almost entirely **owner decisions** (IP/provenance, brand, repo-public,
> npm scope/2FA, SLA) and **distribution** — not code.
