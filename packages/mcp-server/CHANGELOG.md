# @syncrona/mcp-server

## 1.2.0

### Minor Changes

- - New `bearer` auth method for a pre-issued OAuth access token, the counterpart of now-sdk's `SN_SDK_SESSION_BEARER_TOKEN`. Set `SN_BEARER_TOKEN` (optionally with `SN_AUTH_METHOD=bearer`, aliases `bearer-token` and `access-token`), and the CLI, the MCP server and the Fluent tier send `Authorization: Bearer <token>`. Like the SDK, a token in the environment is inferred ahead of every other method unless `SN_AUTH_METHOD` names a different one. The token is environment-only: `syncrona login` refuses `--auth-method bearer` and clears a stale `SN_BEARER_TOKEN` from `.env` on a re-login, and syncrona never refreshes the token. The per-profile `SN_BEARER_TOKEN_<PROFILE>` suffix works like every other auth variable.
- Background scripts no longer need a scoped companion app (IND-4). `sn_execute_background_script`, the ATF trigger and remote mode of `sync_unified_change_workflow` now run scripts through the platform's own Scripts - Background page: the server signs in a short-lived UI session through `login.do`, reads the session's CSRF token from `sys.scripts.do`, posts the script in the global scope, parses the printed output and signs out. The page exists on every instance, answers synchronously with the script output, and records every run in `sys_script_execution_history`; a scheduled `sysauto_script` was rejected because it runs asynchronously and returns no output, and Basic auth alone is not enough because the page needs a UI session. The governance semantics are unchanged: `confirmDestructive`, `dryRun` and write-plan tokens gate the call as before. Behaviour changes: the caller needs the `admin` role and a password login (SSO/MFA-only accounts cannot sign in this way; token auth methods send their `Authorization` header instead); a compile or execution error reported by the page is now returned as an error rather than a successful run; the current scope is read from the `apps.current_app` user preference and an unset preference reports `global` instead of an empty scope; `sync_check_instance_capabilities` and `sync_health_check` report the probes `tableApi`, `currentScope`, `scopeRecord` and `backgroundScript`. `endpointPath` still posts `{ script }` as JSON to a REST endpoint of your own. Removed from the public API: `snScopedApiRequest` and `clearScopedApiPrefixCache`; added: `getCurrentScope`.

### Patch Changes

- Docs: package READMEs drop the legacy upstream references. The fluent README states the ServiceNow SDK licensing notes inline, the MCP server examples use a neutral `x_acme_*` scope, and the repository `NOTICE` now carries only the project copyright and the ServiceNow trademark notice.
- - The text-format logger writes a field value that contains whitespace or a control character (and a message that contains a control character) as a JSON string literal, so a tool name, error message or child-process output carrying a line break can no longer end the record early and forge a second log line.
  - The JSON-format logger no longer throws when a field value is circular or a `BigInt` (such values are written as strings), and a field named `level`, `time` or `message` is written as `field_<name>` instead of overwriting the record's own key.
- - The workspace layout is re-read from `sync.config.js` on every request instead of being pinned by the module cache at the first read, so switching `flat` or `sourceDirectory` mid-session no longer leaves `sync_diff_instance_vs_local` and `sync_create_script_include` looking at paths for the old layout.
- - The tool-metrics summary (`sync_health_check` and the HTTP health snapshot) keys its per-tool counters by a `Map`, so a client calling a tool named `__proto__` or `constructor` no longer writes `total`/`ok`/`error`/`avgLatencyMs` onto `Object.prototype` for the whole server process, and such a call is counted like any other tool.
  - `sn_query_records` with `analyzeField` (and the public `summarizeRows`) now counts field values such as `constructor` or `__proto__` as ordinary keys instead of resolving them to inherited `Object.prototype` members.
- - `sync_suggest_tests` no longer takes the class name from the word "class" in a header comment (e.g. `/* Utility class for incident routing. */`): an ES6 class is recognised only when its body or `extends` clause follows the name, so a `Class.create()` Script Include gets `new <ClassName>()` instead of `new for()`.
- - `sync_generate_release_notes` (Markdown format) keeps each update set label, change type, action and name on one line, so an instance value containing a line break can no longer forge a `## <type>` section or a `- ACTION: <name>` entry, and a change with an empty type is listed under `## unknown` instead of a bare `## ` heading.
  - Scope knowledge Markdown and per-table field docs (`sync_generate_scope_knowledge`, `sync_generate_scope_docs`) escape `|` and flatten line breaks in dictionary cells, so a `javascript:` default value with `||` or several lines no longer splits a field row into extra columns or cuts the table off; object, table and scheduled-job headings, scheduled-job script excerpts and Mermaid edge labels are kept on one line as well.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @syncrona/sn-transport@1.2.0
  - @syncrona/credential-store@1.2.0
  - @syncrona/jira@1.2.0
  - @syncrona/redaction@1.2.0

## 1.1.0

### Patch Changes

- 4bc6790: Scope discovery now reads a scope's scheduled jobs from `sysauto_script`. It queried `sys_trigger`, which has no `sys_scope` column, so ServiceNow dropped the scope condition and every scope's knowledge listed up to 500 unrelated instance-wide triggers.
- Updated dependencies [e33dd3e]
- Updated dependencies [76458e2]
- Updated dependencies [6d7ec9b]
- Updated dependencies [976a3d5]
  - @syncrona/credential-store@1.1.0
  - @syncrona/jira@1.1.0
  - @syncrona/redaction@1.1.0
  - @syncrona/sn-transport@1.1.0

## 1.0.0

### Patch Changes

- @syncrona/credential-store@1.0.0
- @syncrona/jira@1.0.0
- @syncrona/redaction@1.0.0
- @syncrona/sn-transport@1.0.0

## 0.9.4

### Patch Changes

- @syncrona/credential-store@0.9.4
- @syncrona/jira@0.9.4
- @syncrona/redaction@0.9.4
- @syncrona/sn-transport@0.9.4

## 0.9.3

### Patch Changes

- Execution, policy and audit-trail hardening (SEC-1..SEC-8), plus three silent false-clear paths closed: a failed clear now reports failure rather than success.
- Read paths and audit retention are best-effort — an unreadable audit file no longer takes the server down with it.
- Stale caches, unbounded growth and silent truncation are all stopped; the governance gates were hardened and the code-vs-docs drift they were supposed to catch was fixed.
- The fetch client honors `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` through an undici `EnvHttpProxyAgent`, composed with the existing mutual-TLS/custom-CA dispatcher cache.

## 0.9.1

### Patch Changes

- Package metadata: set the npm `homepage` to the project site
  (https://ivanbbaev.github.io/syncrona/) and sharpen the package descriptions.
  No runtime or API changes.
- Updated dependencies
  - @syncrona/sn-transport@0.9.1
  - @syncrona/credential-store@0.9.1
  - @syncrona/jira@0.9.1

## 0.4.2

### Patch Changes

- @syncrona/credential-store@0.4.2
- @syncrona/sn-transport@0.4.2
