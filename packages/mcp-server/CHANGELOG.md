# @syncrona/mcp-server

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
