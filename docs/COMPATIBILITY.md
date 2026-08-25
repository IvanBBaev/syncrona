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
| **Yokohama** (`glide-yokohama-12-18-2024__patch13-hotfix5`) | ✅ manually live-verified 2026-08-21 | Full round trip on a vendor instance with **no companion app installed**, so the Table API path is the one that was exercised: `check-env`, `doctor`, `status`, `download` (byte-exact — the fetched `sys_script_include` script hashed identical to the instance value), `build`, `build --diff <ref>`, `push` (a reversible edit landed and was restored), `deploy --ci`, plus the `--json` and `--dry-run` contracts |
| Other current-family releases (Xanadu / Zurich era) | 🟡 expected-compatible | Table API + scoped fallback are stable across these releases; the `sys.scripts.do` fallback path was separately live-verified 2026-07-03 (CR22) |
| Earlier releases | 🟡 likely | Table API has been stable for many releases; same caveat |

**Honest gap:** the ✅ above is a **dated manual run by a maintainer**, not a
test anyone else can re-run — there is no live-instance compatibility job in CI
yet, because it needs real credentials. In CI, behavior is validated against a
**mock Table API** in the e2e network suite. Treat every 🟡 row as expected, not
guaranteed, and treat the ✅ row as true of that release on that date, until a
record-replay or live smoke test lands.

## Authentication

All methods are implemented in **both** clients (CLI axios + MCP native fetch) and
selected via `SN_AUTH_METHOD`; see the README authentication table for the env vars.

| Method | Status |
|---|---|
| HTTP Basic (over HTTPS) | ✅ default |
| OAuth 2.0 — Resource Owner Password grant | ✅ CLI + MCP (`SN_OAUTH_CLIENT_ID`/`SN_OAUTH_CLIENT_SECRET`) |
| OAuth 2.0 — Client Credentials grant | ✅ CLI + MCP (`SN_AUTH_METHOD=oauth-client-credentials`) |
| OAuth 2.0 — JWT Bearer grant | ✅ CLI + MCP (`SN_AUTH_METHOD=oauth-jwt-bearer`, RS256 via `SN_JWT_KEY`) |
| Inbound REST API Key | ✅ CLI + MCP (`SN_AUTH_METHOD=api-key`, header `x-sn-apikey`) |
| Mutual TLS (client certificate) | ✅ CLI + MCP (`SN_CLIENT_CERT`/`SN_CLIENT_KEY`, combinable with any method) |
| SSO / authorization-code / SAML | 🔴 not yet |

## How to report a compatibility result

If you run SyncroNow AI against a specific ServiceNow release, please open an
issue with the release name and the outcome (`syncrona doctor` /
`check-env` output helps). Verified results will be promoted from 🟡 to ✅ here.
