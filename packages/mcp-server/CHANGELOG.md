# @syncrona/mcp-server

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
