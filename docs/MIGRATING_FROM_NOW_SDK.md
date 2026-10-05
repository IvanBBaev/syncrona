# Coming from the ServiceNow SDK (`now-sdk`)

A practical guide for teams that use the
[ServiceNow SDK](https://www.npmjs.com/package/@servicenow/sdk) (`now-sdk`,
the Fluent `.now.ts` toolchain) and want to try SyncroNow AI (`syncrona`), or
run both side by side. It covers which `now-sdk` commands have a `syncrona`
counterpart, how the `SN_SDK_*` environment variables map, how authentication
differs, what you gain, and what is **not** covered yet.

> The two tools overlap but are not the same thing. `now-sdk` is ServiceNow's
> first-party toolchain for **Fluent** applications — source written as
> `.now.ts` code and compiled into application metadata. SyncroNow AI started
> from the other end: it mirrors an existing scoped application as plain,
> editable files, runs them through a local build pipeline, and pushes them
> back. Since 1.1.0 it also drives the SDK itself, through the optional
> `syncrona fluent` tier, so a Fluent project can use the same CLI, credential
> store and CI conventions as the rest of your scopes. For the analytical
> comparison, see [COMPARISON.md](COMPARISON.md).

## Two ways to work

- **Keep Fluent, use `syncrona` as the driver.** Install the optional tier
  next to the SDK and run `syncrona fluent <action>` where you ran
  `now-sdk <command>`. The SDK still does the compiling, packing and
  installing; syncrona supplies the credentials, the confirmations and the
  exit codes.

  ```bash
  npm install --save-dev @syncrona/fluent @servicenow/sdk
  syncrona login                 # once, into the global encrypted store
  syncrona fluent build
  syncrona fluent install        # asks first; --ci skips the prompt
  ```

  `@syncrona/fluent` declares `@servicenow/sdk` as an optional peer
  dependency pinned to `~4.13`, and the SDK is never bundled. If either
  package is missing, `syncrona fluent` exits 1 with a single install hint.
  No other command is affected.

- **Work file-based, without Fluent.** If your application lives on the
  instance (built in Studio, or by a team that does not write `.now.ts`),
  `syncrona init` / `download` mirror it as plain files, and `syncrona push`
  writes edits back. With `push --create` and `push --prune` (1.1.0), new
  local files become new records and deleted files become deleted records,
  which is the part of the source-driven workflow that previously needed the
  SDK. `init --new` creates a brand-new scoped application to start from.

You can keep file-based and Fluent scopes in one repository, one folder per
scope. [MONOREPO_GUIDE.md](MONOREPO_GUIDE.md) describes the layout, and
`fluent --project <dir>` points the Fluent tier at a scope's folder.

## Command mapping

| `now-sdk` | SyncroNow AI | Notes |
| --- | --- | --- |
| `now-sdk auth` | `syncrona login` / `logout` / `instances` / `use` | One global encrypted credential store (AES-256-GCM) shared by every command and the MCP server. See [Authentication](#authentication-differences) below. |
| `now-sdk init` | `syncrona fluent init --name <n> --scope <s>` | Creates a Fluent project locally, with no instance call (`--template`, `--packageName`, `--description`). |
| `now-sdk init --from <sys_id>` | `syncrona fluent init --from <sys_id>` | Converts an existing instance application into a Fluent project. Needs credentials. |
| — (new scoped app, file-based) | `syncrona init --new --name "<display>"` | Creates the `sys_app` on the instance (scope `x_<vendor-prefix>_<name>`, or `--scope`; `--vendor-prefix` skips the lookup) and binds the directory to it. `--dry-run` prints the body only. |
| `now-sdk build` | `syncrona fluent build` | `--frozenKeys`, `--errorOnConflict`, `--skipClean`. Exit code 2 on build errors. |
| `now-sdk transform` | `syncrona fluent transform` | Local `--paths` (with `--table`, `--force`), one `--update-set <sys_id>`, `--incremental`, or a complete transform. |
| `now-sdk download` | `syncrona fluent transform --incremental` (Fluent) or `syncrona refresh` / `download` (file-based) | There is no separate `fluent download` action: the incremental or complete transform pulls from the instance and converts in one step. |
| `now-sdk pack` | `syncrona fluent pack` | `--out <path>`. |
| `now-sdk install` | `syncrona fluent install` | Confirms before installing unless `--ci`; `--store`, `--sync`, `--no-demo-data`, `--skipFlowActivation`. Without a terminal, or with `--json`, it exits 1 and asks for `--ci`. Exits 0 once the install is submitted; `fluent status` exits 2 while it is still running. |
| `now-sdk clean` | — | `now-sdk clean` only empties the local build output directory. syncrona has no separate clean action: delete the output directory, or run `syncrona fluent build` (it cleans first unless `--skipClean`). Do not confuse it with `syncrona fluent install --reinstall`, which is the counterpart of `now-sdk install --reinstall` and uninstalls the application from the instance before installing it again. |
| `now-sdk dependencies` | `syncrona fluent dependencies` / `syncrona fluent types` | `dependencies --table <t> --ids <a,b> --scope <s>` adds a dependency; without `--table` (or with `types --scripts` / `--fluent`) it downloads type definitions. `fluent types --native` generates table types from `sys_dictionary` without the SDK, and a plain `fluent types` falls back to it when the SDK is not installed. |
| `now-sdk run` | `syncrona fluent run --script <name>` | Runs a project script locally through the SDK. The script gets no instance credential. |
| — | `syncrona fluent status` | The SDK version and the last install's progress. |
| `now-sdk query <table>` | `syncrona query <table>` | The SDK's query flags except `-s/--select` and `-a/--auth` (`-q` required, `--limit 100`, `--offset`, `-f/--fields`, `--display-value`, `--exclude-reference-link`, `--no-count`, `--view`, `--timeout`). `-o json` prints the same `{ok, hasMore, nextOffset, records}` envelope, so scripts written against `now-sdk query -o json` keep working as long as they do not use `--select`; pick the instance with `syncrona use` instead of `--auth`. Read-only; needs no SDK. |
| `now-sdk cicd` | `syncrona cicd <action>` | Drives `api/sn_cicd` directly, with no SDK: `run-suite`, `run-test`, `install`, `publish`, `rollback`. Polls the progress tracker (`--poll-ms`, `--timeout`); `--progress-id` resumes a run that outlived `--timeout`. Exit codes are 0 succeeded, 1 could not finish, and 2 tests failed or the work ended in error. Needs the `sn_cicd.sys_ci_automation` role. |
| `now-sdk explain` | `syncrona fluent explain [topic]` | Reads the documentation bundled with the installed SDK, offline: an exact topic prints the document, a partial match lists candidates, `--list` prints the topic index (filtered by the topic when given) and `--peek` shows summaries. Needs no project, instance or credentials. Exit code 1 when nothing matches. |
| `now-sdk move` | `syncrona fluent move-to-app --ids <sys_id,...>` | Moves global records into the project's global application and writes them as Fluent sources. It creates `sys_claim` records on the instance, so it confirms first unless `--ci`; without a terminal, or with `--json`, it exits 1 and asks for `--ci`. `--dry-run` previews the call. Global-scoped projects only. Exit code 2 when the instance moved none of the records. |

Every `fluent` action takes `--project <dir>` (default: the nearest
`now.config.json`), `--json` for the machine-readable result, and `--dry-run`,
which prints the SDK call it would make without loading the SDK or resolving
any credentials. `cicd` and `query` have no preview mode and refuse `--dry-run`
instead of ignoring it.

## Environment variables

The SDK reads its own `SN_SDK_*` variables. syncrona does **not** read them; it
uses the same `SN_*` variables, `.env` file and instance profiles as every
other `syncrona` command ([MULTI_INSTANCE.md](MULTI_INSTANCE.md)).

| `now-sdk` | SyncroNow AI | Notes |
| --- | --- | --- |
| `SN_SDK_INSTANCE_URL` | `SN_INSTANCE` | Host name or URL, in `.env` or the environment. |
| `SN_SDK_NODE_ENV=SN_SDK_CI_INSTALL` | `--ci` | syncrona has no CI mode switch. `--ci` skips the prompts, and credentials come from the environment when they are present. |
| `SN_SDK_AUTH_TYPE=basic` with `SN_SDK_USER` / `SN_SDK_USER_PWD` | `SN_USER` / `SN_PASSWORD` | Basic is the default method (`SN_AUTH_METHOD=basic`). |
| `SN_SDK_AUTH_TYPE=oauth` with `SN_SDK_OAUTH_CLIENT_ID` / `SN_SDK_OAUTH_CLIENT_SECRET` | `SN_AUTH_METHOD=oauth-client-credentials` with `SN_OAUTH_CLIENT_ID` / `SN_OAUTH_CLIENT_SECRET` | The SDK's `oauth` type is the client-credentials grant. In syncrona, `SN_AUTH_METHOD=oauth` is an alias for `oauth-password`, which also needs `SN_USER` / `SN_PASSWORD`. JWT-bearer (`SN_JWT_*`) is supported too. |
| `SN_SDK_SESSION_BEARER_TOKEN` | — | syncrona obtains and refreshes the OAuth token itself. There is no variable to inject a pre-issued bearer token. |
| `SN_SDK_SESSION_TOKEN` / `SN_SDK_SESSION_COOKIE` | — | syncrona never accepts a raw UI session. A Basic profile logs in to the UI session for you when an SDK action needs one. |
| `NO_TELEMETRY=1` | (always on) | `@syncrona/fluent` sets `NO_TELEMETRY=1` before it loads the SDK. syncrona itself sends no telemetry. |
| one set of variables per shell | `--instance-profile <name>` | Reads `SN_INSTANCE_<NAME>`, `SN_USER_<NAME>`, `SN_PASSWORD_<NAME>` (and the other `SN_*` variables with the same suffix), falling back to the base variables. |

A minimal CI job that used `SN_SDK_*` secrets becomes:

```bash
export SN_INSTANCE=$SN_SDK_INSTANCE_URL
export SN_USER=$SN_SDK_USER
export SN_PASSWORD=$SN_SDK_USER_PWD
npx syncrona fluent build
npx syncrona fluent install --ci
npx syncrona cicd run-suite --suite-name "Smoke tests"
```

Credentials from the environment win over the global store only when they
form a usable credential, so a stray `SN_INSTANCE` on its own does not shadow a
stored login. `syncrona status` shows which source is active.

## Authentication differences

The SDK and syncrona authenticate differently:

- **The SDK never sends HTTP Basic.** Its `basic` type logs in through the UI
  (`angular.do`) and then carries a session token and cookie. syncrona's own
  commands (`push`, `download`, `query`, `cicd`, …) use real REST
  authentication: HTTP Basic, OAuth 2.0 (password, client-credentials and
  JWT-bearer grants), an inbound REST API key, and optionally mutual TLS.
- **Three SDK endpoints accept only a UI session:**
  `sn_appclient_upload_processor.do` (install), `xmlhttp.do` (reinstall and
  clean) and `fluent_update_set_export.do` (`transform --update-set`). For
  those, the Fluent tier bridges your syncrona profile into the SDK:
  - A **Basic** profile performs the UI-session login on your behalf, and
    never logs the credentials.
  - An **OAuth** profile hands its bearer token to the SDK, which bootstraps
    the session's CSRF token itself. That bootstrap reads `sys_user_session`,
    so the integration user needs read access to it.
  - **API-key and mutual-TLS profiles are refused** for every `fluent` action
    that contacts the instance (`install`, `status`, `types`, `dependencies`,
    `init --from`, and the instance-side `transform` modes), with an error that
    names the reason. The exception is `fluent types --native`, which reads the
    Table API with syncrona's own client and accepts every profile. The local actions (`build`, `pack`, `run`, plain `init`,
    `transform --paths`) need no credentials at all.
- **One store for everything.** A login made with `syncrona login` serves the
  file-based commands, `query`, `cicd`, `fluent`, `mirror` and the MCP server.
  `syncrona instances` and `syncrona use` switch between instances.

## What SyncroNow AI adds

Beyond what the SDK covers:

- **File-based sync for any scoped app.** `download`, `refresh`, `dev` (watch
  mode) and `push` work on applications that were never written in Fluent,
  with or without the Sincronia companion app on the instance. Opt-in
  data-model records (`dataModelTables`) bring tables, columns, choices, ACLs,
  roles and UI policies into review as editable sidecars
  ([DATA_MODEL.md](DATA_MODEL.md)).
- **A local build pipeline.** First-party plugins for TypeScript, Babel,
  Webpack, Sass, Prettier and ESLint run on your sources before they are
  pushed ([PLUGIN_DEVELOPMENT.md](PLUGIN_DEVELOPMENT.md)). `syncrona plugins`
  and `config add-plugin` show and wire them.
- **`repair`.** Reconciles the manifest with the local tree. It reports by
  default, `--apply` re-downloads missing files, and `--apply --prune` deletes
  orphans.
- **`mirror`.** A full-instance, GET-only git mirror of the whole instance,
  not only one application, with drift detection (`status`, `verify`).
- **The MCP server.** `syncrona mcp` gives AI clients 63 governed tools for
  metadata, dependency and impact analysis, with dry-run, policy and an audit
  trail ([../packages/mcp-server/README.md](../packages/mcp-server/README.md)).
- **Jira context.** `syncrona jira` pulls the issue for the current branch, on
  Jira Cloud or Server/Data Center.
- **Diagnostics.** `status`, `doctor` and `check-env` tell you which
  credentials are active and why a connection fails
  ([TROUBLESHOOTING.md](TROUBLESHOOTING.md)).
- **Table types without the SDK.** `syncrona fluent types --native` reads
  `sys_db_object`, `sys_dictionary` and `sys_choice` over the Table API and
  writes one `.d.ts` to `@types/syncrona/tables.d.ts` in the project (or
  `--out`). It covers the project scope (or `--scope`, or the tables named with
  `--table`) plus every table they extend:
  - one interface per table, extending its parent's interface;
  - `internal_type` mapped to TypeScript (`boolean`, `number`, `SysId` for
    references, `GlideDateTime` and the other date aliases, `string` otherwise);
  - dropdown choice columns as literal unions, including a child table's
    narrowed choices;
  - mandatory columns required, every other column optional.

  The output is sorted and carries no timestamp, so regenerating an unchanged
  scope gives a clean diff. A plain `fluent types` still uses the SDK when it is
  installed, because the SDK also downloads script and Fluent definitions
  (`--scripts`, `--fluent`) that the native generator does not produce. When the
  SDK is missing, it falls back to the native generator.

## Not covered (yet)

Being honest about the gaps:

- **API-key and mutual-TLS profiles in the Fluent tier.** The SDK's
  session-only endpoints cannot use them, so these profiles are refused for
  instance-side `fluent` actions. Use a Basic or OAuth profile for Fluent work.
- **Composite data-model documents are opt-in.** By default, data-model
  records (a table and its columns, a choice list) are independent sidecar
  records. `dataModelLayout: "composite"` keeps a table, its columns and their
  choices as one document (`data-model/<table>.json`); a workspace that mixes
  both layouts is refused.
- **Flow Designer and UI Builder editing.** The file-based tier does not
  edit flows or UI Builder pages as source. Whatever the SDK supports in
  Fluent still builds and installs through `syncrona fluent`, because the SDK
  does that work.
- **Injecting a pre-issued session or bearer token** (`SN_SDK_SESSION_*`) is
  not supported. syncrona always authenticates from a stored or environment
  credential.
- **Live-instance verification is pending for the 1.1.0 write paths.**
  `push --create` / `--prune`, `init --new`, the `cicd` actions,
  `fluent install` and the data-model round-trip are covered by mocked tests,
  but they have not yet been run against a live instance. The read paths
  (including the vendor-prefix lookup) have been. Try them on a
  non-production instance first, with `--dry-run` where the command supports
  it (`push`, `init`, `fluent move-to-app`); `cicd` has no preview mode and
  refuses `--dry-run`.

If something misbehaves, start with `syncrona doctor` and
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).
