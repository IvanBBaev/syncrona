# Public 1.0 / Enterprise readiness

What it takes to take Syncrona from "alpha-ready" to a **public 1.0** that an
enterprise can adopt. Companion to [BUSINESS_ANALYSIS.md](BUSINESS_ANALYSIS.md)
(§10 enterprise gate) and the engineering `TODO`/`DONE`. Status as of 2026-06-16.

Legend: ✅ done · 🟡 AI-completable (in-repo, scheduled) · 🔴 owner-gated
(needs an account, a credential, a live instance, or a decision).

## 1. Authentication & security
- ✅ **OAuth 2.0 (CLI)** — password grant, Bearer + refresh, `SN_OAUTH_*`; Basic
  stays default (G1).
- ✅ **OAuth 2.0 (MCP server)** — DONE: `createTokenManager` moved to
  `@syncrona/sn-transport` (shared); `servicenowCore` sends Bearer + refresh on
  401, Basic fallback, via the same `SN_OAUTH_*` vars (3 mcp tests). The legacy
  `sys.scripts.do` fallback stays Basic (best-effort; CR22).
- 🔴 **SSO / authorization-code grant** — beyond password grant; needs product
  decision + per-instance OAuth app config.
- 🟡/🔴 **At-rest credential strength (AR2)** — current store key is machine-
  derived (obfuscation-grade). Plan: OS keychain via `keytar` (adds a native
  dep — needs your OK) with an env/secrets-manager path for CI.
- ✅ **Security policy & data-handling** — SECURITY.md (disclosure + what is
  read/written + opt-in diagnostic log).
- 🟡 **Secret scanning in CI** — add gitleaks (external action) (G16 remainder).
- ✅ **Dependency audit gate** — `npm audit --omit=dev --audit-level=high` = 0,
  enforced in CI.

## 2. Distribution & release (D5)
- 🔴 **npm publish** — `@syncrona/core` not yet published; verify scope
  ownership + enable 2FA, then `npm run release:core`.
- 🔴 **Homebrew tap** — create `homebrew-tap` repo + Formula + release action.
- 🔴 **Windows** — PowerShell install script + Windows Credential Manager (and
  native-Windows support beyond WSL).
- 🟡 **Release automation (G6)** — changesets for version+changelog+publish
  (adds a dev dep — needs your OK).
- 🟡 **CI publish with provenance** — publish from CI with `--provenance` + 2FA
  instead of a laptop (depends on npm publish decision).

## 3. Compatibility & support
- ✅ **ServiceNow compatibility statement** — README (release-agnostic via REST/
  Table API, with/without companion app); 🔴 a **formal supported-version
  matrix** needs testing against named releases (live instances).
- ✅ **Support docs** — SUPPORT.md (channels, diagnostics, no-SLA disclaimer),
  CODE_OF_CONDUCT.md, issue/feature templates.
- 🔴 **Support SLA / commercial tier** — business decision (BA5).
- 🔴 **CR22** — verify the `sys.scripts.do` fallback against a live instance.

## 4. Quality, CI/CD, governance
- ✅ **Gates** — `npm run check` green (201 tests); coverage ratchet
  (core 70/57/61/70, mcp 70% lines+branches); tool-contract + docs-drift +
  release-checklist gates.
- ✅ **CI matrix** — GitHub Actions on ubuntu + macOS, full chain + audit gate;
  least-privilege `permissions: contents: read`.
- 🟡 **CI hardening (remainder)** — pin actions to commit SHAs.
- 🟡 **Module-boundary enforcement (G10)** — dependency-cruiser in lint (dev dep
  — needs your OK).
- 🟡 **Mutation/perf baselines (G13/G14)** — Stryker / bench (dev deps).
- 🔴/🟡 **ts-jest migration of mcp tests (AR9)** — HIGH RISK; deferred.

## 5. Legal, brand, governance gates (owner)
- 🔴 **IP / provenance clearance (BA8 / R1)** — verify ownership of pre-existing
  code and the right to distribute publicly **before the repo goes public**.
  "ServiceNow" trademark disclaimer is in place.
- 🔴 **Repository goes public** — currently private; flip only after IP clearance.
- 🔴 **Brand unification (BA6)** — `syncro-now-ai` / `@syncrona/*` / `syncrona`
  CLI; pick one name before a public launch (changes the published package name).
- 🟡 **Per-package READMEs** — npm landing pages for published packages.

## Recommended sequence
1. 🟡 **MCP-server OAuth** — finishes the enterprise auth story (next AI task).
2. 🔴 **IP/provenance clearance** — gates everything public.
3. 🔴 **Decide brand + repo-public + npm scope/2FA** (one decision block).
4. 🟡 **Keychain (AR2) + G6 changesets + CI SHA-pinning + per-package READMEs**
   (AI-completable once deps/decisions are cleared).
5. 🔴 **Distribution (Homebrew/Windows) + compatibility matrix + SLA** — needs
   accounts, live instances, and a support model.
6. **Cut 1.0** once §1–§3 gates are green and the Definition of Done in
   `repo-standard` is met.

> Bottom line: the **engineering** is close to 1.0-grade. What gates a public/
> enterprise 1.0 is mostly **owner decisions** (IP, brand, repo-public, npm,
> SLA) and **distribution**, not code. The largest remaining *code* item is
> MCP-server OAuth (scheduled next).
