# Monorepo / multi-scope guide

A ServiceNow instance often has several scoped apps. SyncroNow AI treats each scope
as its own project: you run commands **from the scope's directory**, and each
scope carries its own config, manifest, and (optionally) `.env`.

## Layout

```text
my-sn-repo/
  packages/
    x_acme_cs/            # one scoped app
      sync.config.js
      sync.manifest.json
      .env                # optional, gitignored
      src/
        <table>/<record>/<field>.ext
    x_acme_inventory/     # another scoped app
      sync.config.js
      sync.manifest.json
      src/
  package.json            # workspace root (npm workspaces / lerna)
  node_modules/           # shared dependencies, incl. @syncro-now-ai/* plugins
```

`syncro-now-ai init` can scaffold `packages/x_*/` for every scope discovered on the
instance; it confirms before creating directories.

## Per-scope vs shared

- **Per scope:** `sync.config.js`, `sync.manifest.json`, and `.env`. Run every
  command from inside the scope directory so it picks up the right config:

  ```bash
  cd packages/x_acme_cs
  syncro-now-ai status
  syncro-now-ai dev
  ```

- **Shared:** `node_modules` at the repo root. Install build plugins
  (`@syncro-now-ai/typescript-plugin`, etc.) once at the root; each scope's
  `sync.config.js` references them by name and they resolve up the tree.

## Credentials across scopes

All scopes on the same instance can share one credential source. Use the global
store (`syncro-now-ai login` / `syncro-now-ai use`) or instance-profile env vars — see
[MULTI_INSTANCE.md](MULTI_INSTANCE.md). A per-scope `.env` overrides the store
for that scope only, which is handy when one app lives on a different instance.

## CI/CD

Iterate scopes and run the same gated pipeline per scope:

```yaml
strategy:
  matrix:
    scope: [x_acme_cs, x_acme_inventory]
steps:
  - run: npm ci
  - run: npx syncro-now-ai build
    working-directory: packages/${{ matrix.scope }}
  - run: npx syncro-now-ai push --ci
    working-directory: packages/${{ matrix.scope }}
    env:
      SN_INSTANCE: ${{ secrets.SN_INSTANCE }}
      SN_USER: ${{ secrets.SN_USER }}
      SN_PASSWORD: ${{ secrets.SN_PASSWORD }}
```

## Tips

- Keep each scope's `sync.config.js` rules ordered most-specific-extension-first
  (the first matching rule wins).
- Commit `sync.config.js` and `src/`; gitignore `.env`, `node_modules/`,
  `build/`, and `.syncrona-mcp/`.
- `syncro-now-ai status` from a scope directory confirms which instance, scope, and
  credential source that scope resolves to.
