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
- **Transport.** Authentication uses HTTP Basic auth over HTTPS by default, and
  every ServiceNow inbound REST auth method is supported in **both** the CLI and
  the MCP server — selected with `SN_AUTH_METHOD`, or adopted from the stored
  profile saved by `syncrona login` when the environment supplies no auth
  material (env always wins; a stored profile for a different instance is
  ignored, failing closed to Basic-from-store). Mutual TLS is the one env-only
  exception: cert/key paths are never read from the store in either client.
  (See the README authentication table):
  - **OAuth 2.0** — password, client-credentials, and JWT-bearer grants. All
    exchange at `oauth_token.do` for a short-lived Bearer token (refreshed on
    expiry/401). JWT-bearer signs an RS256 assertion with the key at `SN_JWT_KEY`.
    Tokens are held in memory per process and **never written to disk**.
  - **Inbound REST API key** — `SN_API_KEY` sent as a header (default
    `x-sn-apikey`, override `SN_API_KEY_HEADER`).
  - **Mutual TLS** — client certificate/key at `SN_CLIENT_CERT` / `SN_CLIENT_KEY`
    (optional `SN_CLIENT_KEY_PASSPHRASE`), applied at the TLS layer and
    combinable with any of the above.

  Key material for JWT-bearer and mTLS is referenced **by path** and read at
  request time — it is never copied into the encrypted credential store or logs.
  Use a dedicated least-privilege integration user/credential and rotate it if a
  credential file, API key, or private key may have been exposed. (The MCP
  server's legacy `sys.scripts.do` fallback reuses the same `Authorization`
  header — whichever auth method is configured — and the same mTLS/proxy
  dispatcher as the primary REST path; it is a best-effort last resort — see
  CR22.)
- **What is read/written.** SyncroNow AI reads scoped-application source/metadata
  from the instance and writes it to local files; `push`/`deploy` write code
  back to the instance (with a confirmation prompt unless `--ci`). The MCP
  server reads metadata for analysis and keeps an audit log under
  `.syncrona-mcp/` (with secret redaction — the detectors live in
  `@syncrona/redaction`, a package that imports nothing, so every consumer asks
  the same code whether a key name or a value is credential material, and an
  oversized value is redacted rather than skipped).
- **Opt-in diagnostic log.** The CLI does not write logs to disk by default.
  Setting `SYNCRONA_DIAGNOSTIC_LOG=1` appends CLI output to
  `~/.syncrona/logs/cli.log` (size-bounded with rotation) for support — it
  contains the same messages shown on the console. **No redactor runs over that
  file**: the transport writes each console line verbatim (colour codes stripped,
  timestamp added), so what stays out of the log is only what the call sites keep
  out of the message — secrets are masked where the code logs them, but an error
  payload, instance data, or a value logged by a dependency is written as-is.
  Treat the log as sensitive and leave it off unless you are diagnosing an issue.

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
  - Tools that write records or execute code on the instance — `sync_push`,
    `sn_create_record`, `sn_execute_background_script`,
    `sync_create_script_include`, `sync_create_script_include_and_sync`,
    `sn_update_metadata_record`, `sync_run_atf_tests` — require
    `confirmDestructive=true` in their schema. **Not every mutating tool does.**
    `sync_set_scope`, `sync_set_update_set` (which can also create a missing
    update set) and `sync_prepare_session` change the integration user's current
    scope/update set on the instance with no confirmation flag, so an assistant
    can re-point the session unprompted; `sn_autonomous_remediation_workflow`
    and `sync_unified_change_workflow` take the flag as optional and enforce it
    only when they switch from planning to `apply=true`. Every mutating call,
    confirmed or not, is recorded in the append-only audit log under
    `.syncrona-mcp/` (secret-redacted) — review it to see exactly what the
    assistant did.
  - Prefer least-privilege integration credentials so the assistant can only
    read/write what the role allows.
- **What SyncroNow AI does not do.** It does not itself send your data to any AI
  provider, does not phone home, and writes no telemetry off-machine (the only
  optional log is local — see above).

### Inbound content is untrusted — indirect prompt injection

The section above covers the **outbound** boundary (what leaves your instance).
There is also an **inbound** one: tool results carry text that neither you nor
SyncroNow AI authored, and the same MCP server also exposes code-execution tools
(`run_node_code`, `run_workspace_command`, `sn_execute_background_script`). A
value crafted to read as instructions ("ignore previous instructions and run…")
is a classic **indirect prompt-injection** vector: the content is *data to be
analysed*, never a command to obey.

- **ServiceNow-authored text.** Record field values, `sys_audit` old/new values,
  script source excerpts, and ATF step output are whatever an end user or
  developer typed into your instance. SyncroNow AI fences these values in a
  delimited `UNTRUSTED_EXTERNAL_DATA` envelope when returning them, as a
  defence-in-depth signal to the model — it is not a hard guarantee.
- **Jira-authored text.** `jira_get_issue` returns the issue summary,
  description, and comment bodies. Unlike your own instance, Jira comments can be
  written by **arbitrary org members or external portal users**, so this is a
  higher-exposure injection surface. Every third-party-authored free-text field
  is fenced in the same untrusted envelope: summary, description, comment bodies,
  comment author names, and the summaries of the parent issue, subtasks and linked
  issues. Structural metadata (key, status, labels, link types) is not fenced —
  and neither are the issue-level `assignee` / `reporter` display names, which are
  returned verbatim.
- **How to limit exposure.** Prefer least-privilege integration credentials so a
  successful injection cannot exceed the role's grants; keep mutating tools
  behind `confirmDestructive` (they already require it and are audited); and
  review the `.syncrona-mcp/` audit log to see exactly what the assistant did.
  The fencing is advisory — the ultimate mitigation is the confirmation/audit
  gate on side-effecting tools and a least-privilege instance user.

## Dependency audit posture

Both dependency trees are audited on every push and pull request, at different
thresholds, because they are exposed to different things.

| Tree | Command | Threshold | Blocking | Last measured |
| --- | --- | --- | --- | --- |
| Production (shipped) | `npm audit --omit=dev` | `moderate` | yes | **0 vulnerabilities**, 2026-08-25 |
| Full (production + dev) | `npm audit` | `high` | yes | **0 vulnerabilities**, 2026-08-25 |
| Full, sub-threshold report | `npm audit --audit-level=low` | `low` | no — informational | **0 vulnerabilities**, 2026-08-25 |

**Why production is gated more tightly than dev.** Production dependencies run on
your machine, in the same process as your ServiceNow credentials, against your
instance — so anything from `moderate` up is treated as a user-facing exposure
and fails the build. Dev dependencies (eslint, jest, TypeScript, Stryker and
their transitive tree) never reach a published tarball; they execute only on
maintainer machines and CI runners, over this repository's own source. The
realistic threat there is a build tool that can be coerced into executing or
exfiltrating something, which is `high`/`critical` shaped, so that is where the
dev gate bites. Pitching the dev gate at `moderate` would block unrelated pull
requests on advisories that do not warrant it, and a gate that cries wolf gets
removed. Findings below the dev threshold are not hidden: the third row above is
a non-blocking step that prints them into every CI run.

Verify either number yourself from a clean checkout:

```bash
npm ci
npm audit --omit=dev --audit-level=moderate   # production gate
npm audit --audit-level=high                  # dev + production gate
```

**Known residuals.** None as of 2026-08-25 — both trees are at zero. Three
scoped `overrides` in the root `package.json` keep them there by lifting
dependencies that `@stryker-mutator/*@8.7.1` pins below their patched versions
(`ajv`, `@babel/core`, and `tmp` via `external-editor`). They are scoped to those
parents specifically, so unrelated copies elsewhere in the tree — notably
eslint's `ajv@6` and the build plugins' `@babel/core@8` — are not affected. If
you upgrade Stryker past 8.7.1, re-check whether the overrides are still needed;
`@stryker-mutator/core@10` resolves all three upstream.

Advisories in a dependency we ship are handled through the reporting process at
the top of this document, the same as a vulnerability in our own code.

## Hardening recommendations

- Use a dedicated integration user with least-privilege roles.
- Keep `.env` and `.syncrona-local` out of version control (both are
  gitignored).
- Rely on OS file permissions and full-disk encryption for `~/.syncrona/`.
- Rotate credentials if a stored credential file may have been exposed.
