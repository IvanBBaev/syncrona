# @syncrona/redaction

<!-- badges:start -->
| [![npm](https://img.shields.io/npm/v/@syncrona/redaction?style=flat-square&logo=npm&logoColor=white&label=npm)](https://www.npmjs.com/package/@syncrona/redaction) | [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org) | [![license](https://img.shields.io/github/license/IvanBBaev/syncrona?style=flat-square&color=blue&label=license)](../../LICENSE) | [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/syncrona/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/syncrona/actions/workflows/ci.yml) | [![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) |
|:--:|:--:|:--:|:--:|:--:|
<!-- badges:end -->

Shared **secret detection and redaction** for SyncroNow AI. This package is the
single source of truth for the question "is this a credential?", asked by every
component that persists ServiceNow data or tool traffic:

- the **MCP server** audit trail —
  [`packages/mcp-server/src/audit.ts`](../mcp-server/src/audit.ts)
- the **instance mirror** redactor (`@syncrona/mirror`), which writes an entire
  instance into a git tree

The detectors grew inside the audit trail, hardened one security review at a time.
They moved here when the mirror needed them, because two copies of a secret
scanner drift, and the copy nobody is actively reviewing is the one that falls
behind — in the consumer that writes to a **repository** rather than a local log.

## What lives here

### Sensitive key names
- `isSensitiveKey(key)` — true when a property NAME suggests credential material
  (`password`, `apiKey`, `x-auth-token`, `session`, `passphrase`, `otp`, …).
  Deliberately over-eager: it also matches `keyword` and `monkey`. A redacted key
  name costs a reviewer one lookup; a leaked credential costs a rotation.

### Secret-shaped values
- `looksLikeSecretValue(value)` — true when a VALUE looks like credential
  material regardless of the key it arrived under: `scheme://user:pass@host` and
  bare `user:pass@host` connection strings, JWTs, PEM private keys, inline
  `Authorization` headers, AWS access-key IDs, vendor-prefixed API keys (Stripe,
  OpenAI, GitHub, Slack, GitLab, Google) and raw 256-bit hex key material.
- `SCAN_BUDGET` (`8192`) — the maximum length scanned in full. **Fails closed:** a
  longer value is reported as a secret without being scanned. The historical
  behaviour was the opposite, and padding a secret past the budget was all it took
  to launder it into a log in cleartext.

### Stable redaction markers
- `redactValue(value)` — `__SYNCRONA_REDACTED__<sha256-12>`.
- `REDACTION_MARKER_PREFIX`, `REDACTION_MARKER_HASH_CHARS`.

The marker embeds a short digest **of the plaintext**, so the same secret yields
the same marker on every sync (a mirror re-run of an unchanged instance must be
byte-identical) while a *rotated* secret yields a different one. A constant marker
would erase that history: a credential could be replaced with no diff at all.

## Design notes

This module is intentionally a **leaf**: it depends on no other `@syncrona`
package, only on `node:crypto`. A security primitive at the bottom of the
dependency graph can be audited on its own and can never be made to import
something that imports it back.

It is also **pure and synchronous** — no I/O, no clock, no configuration. The MCP
server calls it while holding the audit lock and the mirror calls it once per
field of every record on an instance, so the cost must be bounded and the result
must be a function of the input alone.

### What is not here

**Field-type deny** — dropping a column because `sys_dictionary` reports its
`internal_type` as `password`/`password2` — belongs to the caller, which has the
schema knowledge this package deliberately does not. It is nevertheless the
*strongest* of the three signals: measured on a real instance, a `password2`
column returns a 106-character ciphertext over the Table API, which no
value-shape rule here would flag. Never weaken that path on the strength of this
one.

### False positives are a cost, not a bonus

A match redacts the **whole** value, so an over-eager value pattern destroys the
forensic detail of the record an operator is reading. Two patterns here have
already been narrowed after exactly that regression (a bare `Basic`/`Bearer`
keyword matched ordinary prose; a bare `user:pass@host` form matched
`npm:lodash@4.17.21`). Each carries its honest limit in a comment beside it. The
corpus tests in `test/` assert both directions — every rule has a true positive
**and** a near-miss that must pass through verbatim.
