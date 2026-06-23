# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately — **do not open a public
issue** for security reports. Use GitHub's "Report a vulnerability" (Security
Advisories) on the repository, or contact the maintainer directly. We aim to
acknowledge reports within a few business days.

When reporting, include: affected version, reproduction steps, and impact.

## Supported versions

This project is pre-1.0 (`0.x`, alpha). Only the latest published version
receives fixes until a stable line is declared.

## Data handling

SyncroNow AI is a developer tool that talks to your ServiceNow instance. You should
understand what it touches:

- **Credentials.** The CLI authenticates to ServiceNow. Credentials come from
  (in precedence order) `--instance-profile` env vars, plain `SN_*` env vars / a
  project `.env`, or the global credential store written under `~/.syncrona/`.
  Run `syncrona status --debug-credentials` to see which source is used.
- **At-rest protection.** The credential store encrypts files (AES-256-GCM). The
  key is resolved as: `SYNCRONA_STORE_KEY` (explicit) > the **OS keychain**
  (default; macOS Keychain / Windows Credential Manager / libsecret via the
  optional `@napi-rs/keyring`, opt out with `SYNCRONA_USE_KEYCHAIN=0`) > a legacy
  machine-derived key (obfuscation-grade fallback when no keychain is available).
  Prefer the keychain or an explicit key; treat the machine as the trust boundary
  for the fallback. For CI/shared environments use `SYNCRONA_STORE_KEY` from a
  secrets manager. See the "Credential storage security" section in the core README.
- **Transport.** Authentication uses HTTP Basic auth over HTTPS by default.
  **OAuth 2.0** (Resource Owner Password Credentials grant) is supported in the
  CLI: set `SN_OAUTH_CLIENT_ID` + `SN_OAUTH_CLIENT_SECRET` and the same
  username/password are exchanged at `oauth_token.do` for a short-lived Bearer
  token (refreshed on expiry/401). Tokens are held in memory per process and
  never written to disk. **Both the CLI and the MCP server** support OAuth via
  the same `SN_OAUTH_CLIENT_ID`/`SN_OAUTH_CLIENT_SECRET` vars. Use a dedicated
  least-privilege integration user and rotate its password if a credential file
  may have been exposed. (The MCP server's legacy `sys.scripts.do` fallback
  remains Basic-only; it is a best-effort last resort — see CR22.)
- **What is read/written.** SyncroNow AI reads scoped-application source/metadata
  from the instance and writes it to local files; `push`/`deploy` write code
  back to the instance (with a confirmation prompt unless `--ci`). The MCP
  server reads metadata for analysis and keeps an audit log under
  `.syncrona-mcp/` (with secret redaction).
- **Opt-in diagnostic log.** The CLI does not write logs to disk by default.
  Setting `SYNCRONA_DIAGNOSTIC_LOG=1` appends CLI output to
  `~/.syncrona/logs/cli.log` (size-bounded with rotation) for support — it
  contains the same messages shown on the console (credentials are masked).
  Leave it off unless you are diagnosing an issue.

## AI / MCP data flow

The MCP server is the feature that lets an AI assistant analyze your ServiceNow
scope. Understand the trust boundary it creates — this is **separate** from the
credential/transport story above:

- **What leaves the instance.** When an MCP client (an LLM application) calls a
  SyncroNow AI tool, the tool returns ServiceNow data to that client — scoped
  application source code, dictionary/metadata, query results, dependency and
  impact graphs, and script-analysis output. Whatever a tool returns is visible
  to the connected AI application.
- **Where it then goes is outside SyncroNow AI's control.** The MCP **client**
  (e.g. Claude Desktop, an IDE assistant, a custom agent) forwards that data to
  **its** LLM provider. SyncroNow AI secures the link between your machine and
  your ServiceNow instance; it does **not** control what the LLM client does with
  the results afterward. Treat MCP tool output as **leaving your security
  perimeter** to whatever model/provider the client is configured with.
- **The boundary, explicitly:** `instance ⇄ SyncroNow AI MCP server` is yours to
  secure (auth, least privilege, audit). `MCP client ⇄ LLM provider` is governed
  by **your AI client's** data-retention, training, and residency policy — review
  it before connecting the server to instances holding regulated or sensitive data.
- **How to limit exposure.**
  - Point the MCP server only at instances/scopes whose code/metadata you are
    comfortable sending to an LLM (dev/test instances first).
  - Use an AI client backed by a model/provider with an acceptable data policy
    (e.g. a no-training/zero-retention enterprise tier, or a self-hosted/local model).
  - Mutating tools require `confirmDestructive=true` and are recorded in the
    append-only audit log under `.syncrona-mcp/` (secret-redacted) — review it to
    see exactly what the assistant did.
  - Prefer least-privilege integration credentials so the assistant can only
    read/write what the role allows.
- **What SyncroNow AI does not do.** It does not itself send your data to any AI
  provider, does not phone home, and writes no telemetry off-machine (the only
  optional log is local — see above).

## Hardening recommendations

- Use a dedicated integration user with least-privilege roles.
- Keep `.env` and `.syncrona-local` out of version control (both are
  gitignored).
- Rely on OS file permissions and full-disk encryption for `~/.syncrona/`.
- Rotate credentials if a stored credential file may have been exposed.
