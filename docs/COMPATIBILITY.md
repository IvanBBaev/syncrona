# Compatibility

This page states what SyncroNow AI is known to work with, what is expected to
work, and what is not yet verified. It is intentionally honest: where something
has not been tested against a live instance, it says so.

> Status legend: ✅ tested · 🟡 expected-compatible (not formally verified) ·
> 🔴 not supported / unverified

## Runtime

| Component | Requirement | Status |
|---|---|---|
| Node.js | **>= 22** (see `.nvmrc`) | ✅ CI on 22 |
| npm | **>= 10** | ✅ |
| OS — macOS | supported | ✅ CI (macos-latest) |
| OS — Linux | supported | ✅ CI (ubuntu-latest) |
| OS — Windows (WSL) | supported, recommended | 🟡 documented; not in CI |
| OS — Windows (native) | `packaging/windows/install.ps1` | 🔴 code-complete, **unverified** (no Windows host in CI) |

## ServiceNow

SyncroNow AI talks to ServiceNow over the **REST Table API** (stable across
releases) and, when present, an optional **scoped companion app** endpoint
(`x_nuvo_sinc` / `x_nuvo_sync`) for bulk operations — with automatic fallback to
the Table API when the scoped endpoint is unavailable. This design makes the
core workflow largely **release-version-agnostic**.

| ServiceNow release | Status | Notes |
|---|---|---|
| Current family (Xanadu / Yokohama / Zurich era) | 🟡 expected-compatible | Table API + scoped fallback are stable; the `sys.scripts.do` fallback path was **manually live-verified on a PDI 2026-07-03** (CR22), but the named-release matrix is **not yet covered by a CI live-instance test** |
| Earlier releases | 🟡 likely | Table API has been stable for many releases; same caveat |

**Honest gap:** there is no live-instance compatibility test in CI yet (it needs
real credentials). Behavior is validated against a **mock Table API** in the e2e
network suite, not a real instance. Treat the ServiceNow rows as expected, not
guaranteed, until a record-replay or live smoke test lands.

## Authentication

| Method | Status |
|---|---|
| HTTP Basic (over HTTPS) | ✅ default |
| OAuth 2.0 (Resource Owner Password grant) | ✅ CLI + MCP (`SN_OAUTH_CLIENT_ID`/`SN_OAUTH_CLIENT_SECRET`) |
| SSO / authorization-code / SAML | 🔴 not yet |

## How to report a compatibility result

If you run SyncroNow AI against a specific ServiceNow release, please open an
issue with the release name and the outcome (`syncro-now-ai doctor` /
`check-env` output helps). Verified results will be promoted from 🟡 to ✅ here.
