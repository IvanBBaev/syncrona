# Working with multiple ServiceNow instances

Syncrona resolves credentials from three places, in this order (first match
wins). `syncrona status` prints the winner as `Credentials from: …`, and
`syncrona status --debug-credentials` shows every source and why each was or
wasn't used.

1. **`--instance-profile <name>`** → `SN_INSTANCE_<NAME>` / `SN_USER_<NAME>` /
   `SN_PASSWORD_<NAME>` environment variables.
2. **Plain `SN_INSTANCE` / `SN_USER` / `SN_PASSWORD`** (a project `.env` is
   loaded into the environment at startup).
3. **The global encrypted credential store** (`syncrona login` / `syncrona use`).

Project-local sources deliberately beat the global store, and the MCP server
follows the same precedence.

## Option A — credential store (recommended for humans)

Save each instance once, then switch between them:

```bash
syncrona login dev12345.service-now.com    # prompts + stores credentials
syncrona login prod98765.service-now.com
syncrona instances                         # list stored instances + active marker
syncrona use dev12345.service-now.com      # make dev the active instance
syncrona status                            # confirm: "Credentials from: credential store"
```

`syncrona logout <instance>` removes one; `syncrona logout --all` clears all.

> At-rest protection is machine-key obfuscation, not strong cryptography — see
> the "Credential storage security" section in the core README. Treat the
> machine as the trust boundary.

## Option B — instance profiles (recommended for scripts/CI)

Define profile-suffixed env vars and select a profile per command:

```bash
export SN_INSTANCE_DEV=dev12345.service-now.com
export SN_USER_DEV=dev.user
export SN_PASSWORD_DEV=dev.password

export SN_INSTANCE_PROD=prod98765.service-now.com
export SN_USER_PROD=prod.user
export SN_PASSWORD_PROD=prod.password

syncrona status  --instance-profile dev
syncrona push    --instance-profile prod --dry-run
```

A profile var falls back to its base var when unset (e.g. `SN_USER_DEV` →
`SN_USER`), so you can share a username across profiles and vary only the
instance.

### Avoid repeating `--instance-profile`

Drop a gitignored `.syncrona-local` file in the working directory to set a
default profile so you don't pass the flag on every command:

```json
{ "instanceProfile": "dev" }
```

An explicit `--instance-profile` on the command line still wins over it.
`.syncrona-local` is already in `.gitignore`.

## OAuth 2.0 (optional)

By default the CLI authenticates with HTTP Basic auth. To use OAuth 2.0
instead, register an OAuth API client in ServiceNow (System OAuth → Application
Registry) and set its client id/secret alongside your usual credentials:

```bash
export SN_INSTANCE=dev12345.service-now.com
export SN_USER=integration.user
export SN_PASSWORD=...
export SN_OAUTH_CLIENT_ID=<client_id>
export SN_OAUTH_CLIENT_SECRET=<client_secret>
```

The CLI exchanges the username/password for a Bearer token at `oauth_token.do`
(OAuth 2.0 password grant) and refreshes it on expiry or a 401. The CLI OAuth
vars also support `_<PROFILE>` suffixes (`SN_OAUTH_CLIENT_ID_DEV`, …) like the
other `SN_*` vars. Remove them to fall back to Basic auth. Tokens live in memory
for the process only — they are not written to disk.

The **MCP server** honors the same `SN_OAUTH_CLIENT_ID`/`SN_OAUTH_CLIENT_SECRET`
(base vars; the MCP server uses a single instance config, not profiles) and
likewise sends a Bearer token with refresh-on-401, falling back to Basic when
they are unset.

## A safe dev → prod workflow

```bash
# 1. Develop against dev
syncrona use dev12345.service-now.com
syncrona dev

# 2. Build and preview the prod push before committing to it
syncrona build
syncrona push --instance-profile prod --dry-run

# 3. Push for real once the dry run looks right
syncrona push --instance-profile prod
```

`push`, `download` and `deploy` confirm before writing; add `--ci` to skip the
prompt in automation.

## CI/CD

In CI, prefer profile env vars (or plain `SN_*`) from the runner's secret store
over the on-disk credential store, and pass `--ci` to skip confirmations:

```yaml
env:
  SN_INSTANCE: ${{ secrets.SN_INSTANCE }}
  SN_USER: ${{ secrets.SN_USER }}
  SN_PASSWORD: ${{ secrets.SN_PASSWORD }}
steps:
  - run: npx syncrona build
  - run: npx syncrona push --ci
```

## Troubleshooting

- `status` says **credentials missing** but you logged in → the stored file may
  not decrypt on this machine. Run `syncrona status --debug-credentials`; if it
  reports a decrypt failure, re-run `syncrona login`.
- Talking to the **wrong instance** → check `Credentials from:` in `status`; a
  stale `.env` beats the store. Remove/fix the `.env` or use a profile.
