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
- **At-rest protection is obfuscation-grade, not strong cryptography.** The
  credential store encrypts files with a key derived from your machine
  hostname + username — see the "Credential storage security" section in the
  core README. Treat the machine as the trust boundary; for CI/shared
  environments prefer environment variables or a dedicated secrets manager.
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

## Hardening recommendations

- Use a dedicated integration user with least-privilege roles.
- Keep `.env` and `.syncrona-local` out of version control (both are
  gitignored).
- Rely on OS file permissions and full-disk encryption for `~/.syncrona/`.
- Rotate credentials if a stored credential file may have been exposed.
