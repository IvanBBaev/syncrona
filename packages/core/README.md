# syncrona

<!-- badges:start -->
| ![npm: not yet published](https://img.shields.io/badge/npm-not%20yet%20published-lightgrey?style=flat-square&logo=npm&logoColor=white) | [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org) | [![license](https://img.shields.io/github/license/IvanBBaev/syncrona?style=flat-square&color=blue&label=license)](../../LICENSE) | [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/syncrona/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/syncrona/actions/workflows/ci.yml) | [![coverage](https://img.shields.io/codecov/c/github/IvanBBaev/syncrona/main?flag=core&style=flat-square&logo=codecov&logoColor=white&label=coverage)](https://codecov.io/gh/IvanBBaev/syncrona) | [![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) |
|:--:|:--:|:--:|:--:|:--:|:--:|
<!-- badges:end -->

This module contains the core of SyncroNow AI. It is required to use SyncroNow AI at all.
It can interact with other plugins after you configure them.

## Credential resolution order

Commands resolve ServiceNow credentials in this order (first match wins):

1. `--instance-profile <name>` → `SN_INSTANCE_<NAME>` / `SN_USER_<NAME>` /
   `SN_PASSWORD_<NAME>` environment variables;
2. plain `SN_INSTANCE` / `SN_USER` / `SN_PASSWORD` environment variables
   (a `.env` in the project root is loaded into the environment at startup);
3. the global encrypted credential store (`syncrona login`, `syncrona use`).

Project-local sources deliberately beat the global store, and the MCP server
follows the same precedence (see the mcp-server README).

## Push recovery and locking

`syncrona push` maintains two state files in the **project root** (next to
`sync.config.js`); both are safe to delete when no push is running:

- `sync.push.checkpoint.json` — written after you confirm a push, updated
  with the per-record outcome, and removed when every record succeeds. If a
  push is interrupted or partially fails, the next push offers to **resume
  only the failed records**. Declining a confirmation prompt leaves no
  checkpoint behind.
- `sync.collaboration.lock.json` — an atomically-created lock that prevents
  two concurrent pushes against the same workspace. A crash cannot leave it
  behind for long: locks older than 30 minutes are treated as stale and
  replaced automatically.

Push retries only network errors and retryable HTTP statuses (5xx/408/429);
authentication failures fail fast instead of being retried.

## Update notifications

The CLI performs a best-effort check for a newer published version at most once
per day and, when one is available, prints a single notice to **stderr** (it
never writes to stdout, so piped output stays clean). The check is non-blocking,
swallows all failures, and never prevents a command from running.

The notifier is automatically skipped when:

- running in CI (`CI` is set) or under tests (`JEST_WORKER_ID` is set), or
- stderr is not an interactive terminal (e.g. output is piped).

To opt out explicitly, set either of these environment variables to `1` or
`true`:

- `SYNCRONA_NO_UPDATE_NOTIFIER`
- `NO_UPDATE_NOTIFIER`

The last check is cached in `~/.syncrona/update-check.json`.

## Environment variables

### Authentication method selection

`SN_AUTH_METHOD` selects the ServiceNow inbound REST auth method: `basic`
(default), `oauth-password`, `oauth-client-credentials`, `oauth-jwt-bearer`, or
`api-key`. When unset it is inferred for backward compatibility (OAuth password
when a client id/secret pair **and** a password are present, otherwise Basic).
Every variable below also accepts a per-profile `_<NAME>` suffix.

| Variable | Method | Purpose |
| --- | --- | --- |
| `SN_OAUTH_CLIENT_ID` / `SN_OAUTH_CLIENT_SECRET` | oauth-* | OAuth client id/secret (reused by password, client-credentials, jwt-bearer). |
| `SN_API_KEY` | api-key | Inbound REST API key value. |
| `SN_API_KEY_HEADER` | api-key | Header name override (default `x-sn-apikey`). |
| `SN_JWT_KEY` | oauth-jwt-bearer | Path to (or inline) RS256 private-key PEM used to sign the assertion. |
| `SN_JWT_KID` / `SN_JWT_ISS` / `SN_JWT_SUB` / `SN_JWT_AUD` | oauth-jwt-bearer | Optional JWT header `kid` and `iss`/`sub`/`aud` claim overrides (defaults derived from client id + user + instance). |
| `SN_CLIENT_CERT` / `SN_CLIENT_KEY` | mTLS | Client certificate + private-key PEM paths (mutual TLS, combinable with any method). |
| `SN_CLIENT_KEY_PASSPHRASE` | mTLS | Passphrase for an encrypted client key. |

`SN_JWT_KEY`, `SN_CLIENT_CERT` and `SN_CLIENT_KEY` are file **paths** — the key
material is read at request time and never copied into the credential store.

### Other variables

Besides the credential variables above (`SN_INSTANCE` / `SN_USER` / `SN_PASSWORD`
and their named `SN_*_<NAME>` forms), the auth-method variables, and the
update-notifier opt-outs, the core CLI reads:

| Variable                       | Purpose                                                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SYNCRONA_DATA_TABLES`         | Comma-separated allowlist of table names whose data records are materialized into the manifest (e.g. `x_my_table,sys_choice`). Empty/unset materializes none by default. |
| `SYNCRONA_INCLUDE_DATA_FIELDS` | Materialize data fields for **all** tables. Truthy (`1`/`true`/`yes`/`on`) enables it; falsey (`0`/`false`/`no`/`off`) disables. Unset falls back to the allowlist above. |
| `SYNCRONA_MCP_SERVER_PATH`     | Explicit path to the MCP server entry (`dist/index.js`) used by `syncrona mcp`. Overrides the built-in workspace/`node_modules` lookup; useful for local development. |


