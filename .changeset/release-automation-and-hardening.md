---
"@syncro-now-ai/core": patch
---

Release automation and hardening:

- Adopt Changesets for versioning, changelog generation, and publishing
  (`npm run changeset` / `version-packages` / `release`); all `@syncro-now-ai/*`
  packages version in lockstep.
- Enforce module boundaries in CI via dependency-cruiser (`npm run
  lint:boundaries`): no circular dependencies and the shared foundation
  packages (`types`, `credential-store`, `sn-transport`) may not depend on the
  `core`/`mcp-server` consumers.
- Strengthen at-rest credential storage: the credential-store encryption key is
  now resolved from `SYNCRONA_STORE_KEY` (CI / secrets manager) or the OS
  keychain when available, falling back to the legacy machine-derived key so
  existing stores keep decrypting.
