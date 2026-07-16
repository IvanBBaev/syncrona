# Troubleshooting

A symptom → cause → fix index for the most common SyncroNow AI problems. Each
section is linkable, so error reports and reviews can point straight at a fix.
For the short version, see the README's
[Getting unstuck](../README.md#getting-unstuck) list; for MCP-operator
procedures, see the
[MCP troubleshooting playbook](../packages/mcp-server/docs/troubleshooting-playbook.md).

## First diagnostics

Run these before anything else — most issues identify themselves here:

| Command | What it tells you |
| --- | --- |
| `syncrona status` | Instance, scope, manifest state, and **which credential source is active** (`Credentials from:`). |
| `syncrona status --debug-credentials` | Per-source credential resolution detail, including decrypt failures in the global store. |
| `syncrona doctor` | Connectivity and instance-side diagnostics. |
| `syncrona check-env` | OS/WSL, Node.js, and Git prerequisites — no instance needed. |
| `<command> --log-level debug` | Full request/response detail for any command. |
| `<command> --dry-run` | Shows what a command *would* do without writing anything. |

Errors are classified into categories (`network`, `auth`, `config`, `data`)
and printed with an actionable hint — the hint usually names the exact
follow-up command from the table above. HTTP 401/403 are treated as auth
problems, 404 as data problems, and 408/429/5xx plus TLS/certificate errors
as network problems.

## Authentication failures (401 / 403)

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `401 Unauthorized` on every request | Wrong username/password, wrong OAuth client id/secret, or a revoked/locked user. | Re-run `syncrona login` for the instance; verify with `syncrona status --debug-credentials`. |
| `401` with OAuth after working for a while | Token refresh failed (e.g. the refresh token was revoked instance-side). The client refreshes tokens proactively before expiry and force-refreshes once after a 401 — a *persisting* 401 means the grant itself no longer works. | Re-run `syncrona login` to establish a fresh grant; check the OAuth application registry entry on the instance. |
| `403 Forbidden` on specific tables | Credentials are valid but the user lacks access (roles/ACLs) to that table or scope. | Verify the user's roles and cross-scope access on the instance; retry with an account known to have access to confirm. |
| `credentials missing` although you logged in | The stored credential file does not decrypt on this machine (the store is encrypted with AES-256-GCM and is machine/user-bound). | Run `syncrona status --debug-credentials`; if it reports a decrypt failure, re-run `syncrona login`. |
| Commands hit the **wrong instance** | A stale project `.env` — plain `SN_*` variables and the project `.env` take precedence over the global store; `--instance-profile` variables beat both. | Check `Credentials from:` in `syncrona status`; fix or remove the stale `.env`, switch with `syncrona use <instance>`, or pass `--instance-profile`. See [MULTI_INSTANCE.md](MULTI_INSTANCE.md). |
| API-key auth gets 401 but the key is right | The instance's inbound REST API key policy expects a different header name. | Set the header via `SN_API_KEY_HEADER` (or `syncrona login --auth-method api-key --api-key-header <name>`). |

## Instance connectivity

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `ENOTFOUND` / `EAI_AGAIN` | DNS cannot resolve the instance host — typo in the instance name, or DNS only works through a corporate proxy/VPN. | Verify the host in `syncrona status`; connect the VPN; configure the proxy (next section). |
| `ECONNREFUSED` / `EHOSTUNREACH` / `ETIMEDOUT` | Firewall, VPN, or proxy blocking the connection. | `syncrona doctor` from the same shell; confirm the instance is reachable in a browser; configure `HTTPS_PROXY` if your network requires it. |
| `429` or `5xx` mid-run | Instance throttling or transient server errors — classified as network problems, and long operations checkpoint their progress. | Re-run the command: `download` resumes from `sync.download.checkpoint.json`, `push` offers to resume only the failed records. Throttle with `--concurrency 5` on push. |
| `Custom scope not found — building manifest from Table API...` | Informational, not an error: the Sincronia/SyncroNow companion scoped app is not installed, so the CLI uses Table API compatibility mode. | Nothing to fix — everything works without the companion app. If your instance hosts the scoped API under a custom prefix, set `SYNCRONA_SCOPED_API_PREFIXES` (comma-separated; default `x_nuvo_sinc,x_nuvo_sync`). |

## Proxy and TLS

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Works in the browser, fails in the CLI | Traffic must go through a corporate proxy. | Set `HTTPS_PROXY` (and `NO_PROXY` for exceptions) — the CLI honors them automatically. |
| `unable to verify the first certificate`, `self-signed certificate in certificate chain`, or similar TLS errors | A TLS-intercepting proxy or private CA that Node.js does not trust. | Point `SYNCRONA_CA_BUNDLE` at a PEM bundle containing the corporate root CA. `NODE_EXTRA_CA_CERTS` also works and additionally covers the MCP server. |
| Same, but you cannot obtain the CA certificate | — | As an **insecure last resort**, `SYNCRONA_TLS_REJECT_UNAUTHORIZED=0` (also accepts `false`/`no`) disables server-certificate verification. Do not leave this on. |
| Instance requires a client certificate (mutual TLS) | mTLS policy on the instance or an intermediate gateway. | Set `SN_CLIENT_CERT`, `SN_CLIENT_KEY`, and (if the key is encrypted) `SN_CLIENT_KEY_PASSPHRASE` — or provide them via `syncrona login --client-cert/--client-key`. |

## Manifest drift and repair

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Local files and `sync.manifest.json` disagree (missing files, orphans) | Files were moved/deleted outside the tool, or a download was interrupted long ago. | `syncrona repair` reports the drift; `repair --apply` re-downloads missing files; `repair --prune` removes orphans; `--ci` skips prompts. |
| A record created on the instance never appears locally | The manifest predates the record. | `syncrona refresh` re-downloads the manifest and creates newly tracked files (watch mode does this on its polling interval too). |
| Deleting a local file did not delete the record | Delete propagation is intentionally not supported — a local delete never deletes on the instance. | Delete the record on the instance, then run `syncrona repair` to reconcile the local tree. |
| `syncrona download` overwrote local edits | `download` is destructive by design (it confirms first; `--ci` skips the prompt). | Keep the project in git so a bad download is a `git checkout` away; diff before continuing. |
| Push exits non-zero, some records failed | Per-record failures (auth, ACL, network) — progress is checkpointed in `sync.push.checkpoint.json`. | Fix the cause and run `syncrona push` again; it offers to resume only the records that failed last time. |
| Two records produce the same file path | Duplicate display values on a table. | Configure `tableOptions.differentiatorField` for that table in `sync.config.js` (see the README "Examples"). |

## Watch mode (`syncrona dev`) not pushing

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Saving a **new** file does nothing | The file is not tracked by the manifest — the watcher says so: `New file detected: ... it is not tracked by the manifest, so it will not be pushed.` Records must exist on the instance first. | Create the record on the instance, then run `syncrona refresh` (or `syncrona repair`) to register it. |
| Saving an existing file does nothing | The file is outside `sourceDirectory`, or an exclude rule filters its table/field. | Check `sourceDirectory` in `sync.config.js` and the effective excludes via `syncrona config show-defaults`; run with `--log-level debug` to see what the watcher sees. |
| Saves push, but the built output is wrong | The wrong rule matches — the **first** matching rule in `rules` wins, so a broad pattern can shadow a specific one. | Run `syncrona build --check-config` to detect shadowed rules; reorder `rules`. |
| New instance records take long to appear during dev | Manifest polling runs on `refreshInterval` (default 30 s). | Lower `refreshInterval`, pass `--refresh-interval <s>`, or set `0` to disable polling and refresh manually. Overlapping refreshes are skipped by design — slow instances just refresh less often. |
| Push rejected due to scope mismatch | Your session's current application scope on the instance differs from the file's scope. | Push with `--scope-swap` to switch the session scope automatically, or fix the scope in the instance UI. |

## MCP server

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Client shows the server as failed right after start | Node.js older than 22, or the client launches the server in the wrong directory. | `node --version` must report >= 22 (`syncrona check-env` verifies this). Launch via `syncrona mcp --auto-configure`, which writes correct client config for the current project. |
| Server runs but has no/wrong credentials | Credential resolution order: process env → `.syncrona-mcp/secrets.json` (or `SYNCRONA_SECRETS_FILE`) → project `.env` → global store; results are cached ~30 s per project directory. | Make sure the client's `cwd`/env matches the project you expect; consult the [MCP server README](../packages/mcp-server/README.md) for the exact order. |
| No log output anywhere | By design: stdio transport means stdout carries only the protocol — all logs go to **stderr**. | Read the client's stderr capture; set `SYNCRONA_LOG_LEVEL=debug` to surface normally-swallowed diagnostics (failed secrets/`.env` loading, audit-log write failures). |
| Startup floods the project with downloads | Auto-pull downloads all scopes into `packages/<scope>/` in the background after connect. | Set `SYNCRONA_MCP_AUTO_PULL_ALL_SCOPES=false` (also accepts `0`/`no`/`off`). See [mcp-quickstart.md](mcp-quickstart.md). |
| Need liveness monitoring | — | Enable the optional HTTP health endpoint with `SYNCRONA_HEALTH_HTTP_PORT` (plus `SYNCRONA_HEALTH_HTTP_HOST`/`SYNCRONA_HEALTH_HTTP_PATH`). |

For tool-by-tool reference, see [MCP_TOOLS.md](MCP_TOOLS.md); for deeper
operational procedures, the
[troubleshooting playbook](../packages/mcp-server/docs/troubleshooting-playbook.md)
and [operator runbook](../packages/mcp-server/docs/operator-runbook.md).

## Environment

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Anything on native Windows | Native Windows is not supported yet. | Run inside WSL (Ubuntu) — `syncrona check-env` confirms the setup; see the README "Windows users" section. |
| Version-related install/build errors | Runtime below the support window. | Node.js >= 22 and npm >= 10 are required (see [VERSIONING.md](VERSIONING.md)); `nvm use` picks up the repo's `.nvmrc`. |

Still stuck? Check [SUPPORT.md](../SUPPORT.md) for where to ask, and include
the output of `syncrona status` and the failing command with
`--log-level debug`.
