# Migrating from Sincronia (`sinc`)

A practical guide for teams moving an existing
[Sincronia](https://github.com/nuvolo/sincronia) (`sinc`) project to
SyncroNow AI (`syncrona`). SyncroNow AI is a GPL-3.0 derivative work of
Sincronia (see [PROVENANCE.md](PROVENANCE.md) and the repository
[NOTICE](../NOTICE)), so the mental model — a local project folder that mirrors
your scoped app as plain files, with a manifest and a plugin build pipeline —
carries over directly. This page covers what maps one-to-one, what is new, and
the shortest path to a working setup.

> Sincronia's own CLI surface is described here as of its last public releases.
> If your `sinc` version lacks a command mentioned below, the `syncrona` side
> of the mapping still applies. For an analytical feature comparison, see
> [COMPARISON.md](COMPARISON.md).

## The first day

```bash
# 1. Install (not yet on npm — install from source, see README "Installation")
git clone https://github.com/IvanBBaev/syncrona
cd syncrona && npm ci && npm run build
npm link --workspace syncrona

# 2. Store credentials once, globally (replaces per-project .env secrets)
syncrona login

# 3a. Fresh start — run the wizard in a clean folder (no .env present)
mkdir my-scope && cd my-scope && npm init -y
syncrona init          # pick the scope; downloads manifest + files

# 3b. In-place migration — inside your existing Sincronia repo:
#     port sinc.config.js -> sync.config.js (next section), commit, then
syncrona download <your_scope>   # fresh sync.manifest.json + files; confirms first

# 4. Work
syncrona dev
```

Two behaviors to know before you pick a path:

- **`syncrona init` changes mode when a `.env` exists.** In a folder *without*
  a `.env`, `init` runs an interactive wizard: it resolves credentials (env,
  then the credential store, then prompts), lets you pick a scope, downloads
  the manifest and source files, and writes `.env` and `sync.config.js`. In a
  folder *with* a `.env` — which an existing Sincronia repo has — `init`
  switches to **all-scope auto-initialization**: it lists every scoped app it
  can discover on the instance and, after an explicit confirmation, creates
  one folder per scope under `packages/` and downloads each. That is the
  fast path to the monorepo layout ([MONOREPO_GUIDE.md](MONOREPO_GUIDE.md)),
  but it is not an in-place, single-scope migration — for that, use
  `syncrona download <scope>` as in step 3b. `--dry-run` previews either mode
  without writing anything.
- **`download` is destructive by design** (it confirms first; `--ci` skips the
  prompt): it overwrites local files under the source directory. Keep your
  Sincronia repo committed in git, run the download, and diff the result
  against your old tree before you continue.

`syncrona refresh` only keeps an *existing* manifest up to date — it cannot
bootstrap a project. The fresh `sync.manifest.json` comes from `init` (wizard
or auto-init) or `download`.

## Command mapping

| Sincronia | SyncroNow AI | Notes |
| --- | --- | --- |
| `sinc init` | `syncrona init` | Interactive project provisioning; see the `.env` mode switch above. |
| `sinc dev` | `syncrona dev` (alias `d`) | Watch mode; `--refresh-interval <s>` tunes manifest polling (0 disables). |
| `sinc refresh` | `syncrona refresh` (alias `r`) | Re-downloads the manifest and creates newly tracked files. |
| `sinc push` | `syncrona push [target]` | Adds `--diff <branch>`, `--scope-swap`, `--update-set <name>`, `--concurrency <n>`, `--ci`, and resume-after-partial-failure. |
| `sinc download <scope>` | `syncrona download <scope>` | Destructive by design (confirms first; `--ci` skips); resumes from a checkpoint after partial failures. |
| `sinc build` | `syncrona build` | Runs the plugin pipeline into `buildDirectory`; `--check-config` detects shadowed rules. |
| `sinc deploy` | `syncrona deploy` | Pushes built artifacts. |
| `sinc status` | `syncrona status` | Extended diagnostics, including which credentials are active (`--debug-credentials`). |

Commands with **no Sincronia counterpart** — new capabilities you get after
migrating:

| Command | What it does |
| --- | --- |
| `syncrona login` / `logout` / `instances` / `use` | Global encrypted credential store and multi-instance switching ([MULTI_INSTANCE.md](MULTI_INSTANCE.md)). |
| `syncrona repair` | Reconciles the manifest with local files — re-downloads missing files, prunes orphans. |
| `syncrona doctor` / `check-env` | Connectivity and environment diagnostics (Node, WSL, Git). |
| `syncrona docs` | Generates Markdown docs and Mermaid diagrams for the scope. |
| `syncrona plugins` / `config <action>` | Inspects plugin rules and configuration (e.g. `config show-defaults`, `config add-plugin`). |
| `syncrona mcp` | Starts the MCP server so AI clients can analyze and operate on the scope. |
| `syncrona jira` / `jira-login` / `jira-logout` | Jira issue context for the current branch or a given key. |

## Configuration: `sinc.config.js` → `sync.config.js`

The config file is renamed, but the shape is intentionally compatible — the
keys Sincronia used carry over unchanged. Copy your `rules`, `includes`,
`excludes` and `tableOptions` as-is into `sync.config.js`, and update plugin
package names from the `@sincronia/*` scope to `@syncrona/*`.

Before (Sincronia):

```javascript
// sinc.config.js
module.exports = {
  sourceDirectory: "src",
  rules: [
    {
      match: /\.ts$/,
      plugins: [{ name: "@sincronia/typescript-plugin", options: {} }],
    },
  ],
  excludes: {},
  includes: {},
  tableOptions: {},
};
```

After (SyncroNow AI):

```javascript
// sync.config.js
module.exports = {
  sourceDirectory: "src",
  buildDirectory: "build",
  rules: [
    {
      match: /\.ts$/,
      plugins: [{ name: "@syncrona/typescript-plugin", options: {} }],
    },
  ],
  excludes: {},
  includes: {},
  tableOptions: {},
  refreshInterval: 30,
};
```

Notes:

- Recognized keys are `sourceDirectory`, `buildDirectory`, `pushConcurrency`,
  `rules`, `includes`, `excludes`, `tableOptions`, `refreshInterval`, and the
  experimental `flat`. Unknown keys are not fatal — the CLI warns and ignores
  them, so a straight copy of an old config will tell you what it did not
  understand. A recognized key with the **wrong type** (e.g. `rules` as an
  object) is a hard error, as is a present-but-broken config file — it never
  silently falls back to defaults.
- `syncrona config show-defaults` prints the built-in include/exclude
  defaults, so you can see what your overrides apply on top of.
- The manifest lives in `sync.manifest.json`. A manifest produced by `sinc` is
  not reused — `syncrona init` or `syncrona download` generates a fresh one
  (and `refresh` keeps it current), which is also the safest way to pick up
  the current instance state.

## Environment and authentication

Your existing Sincronia `.env` keeps working unchanged: `SN_INSTANCE`,
`SN_USER` and `SN_PASSWORD` have the same names and meaning (Basic auth is
still the default method). What changes is what you *can* do:

- **Global credential store.** `syncrona login` stores credentials once,
  encrypted (AES-256-GCM) in your home directory, instead of plain text in
  every project's `.env`. Precedence when both exist: instance-profile
  variables (`--instance-profile`) win, then plain `SN_*` / project `.env`,
  then the global store — so a leftover project `.env` silently overrides the
  store; `syncrona status` shows which source is active.
- **More auth methods.** Beyond Basic: OAuth 2.0 (password,
  client-credentials, JWT-bearer grants), inbound REST API keys, and optional
  mutual TLS — selected via `SN_AUTH_METHOD` or the `syncrona login` method
  picker. See the README "Authentication" section.
- **Multiple instances.** `syncrona instances` / `syncrona use` switch the
  active stored instance ([MULTI_INSTANCE.md](MULTI_INSTANCE.md)).

## What carries over

- **The data model.** A manifest of tables → records → fields, mirrored as
  plain files (`<table>/<record>/<field>.<ext>`), with the same field-type
  mapping heritage.
- **The build pipeline concept.** `rules` match file extensions and run plugin
  chains; first matching rule wins. Plugin packages moved from `@sincronia/*`
  to `@syncrona/*` but keep the same contract
  ([PLUGIN_DEVELOPMENT.md](PLUGIN_DEVELOPMENT.md)).
- **The companion scoped app.** SyncroNow AI still speaks the scoped REST
  namespaces (`x_nuvo_sinc` is tried first, then `x_nuvo_sync`), so an
  instance that already has Sincronia's server app installed works as-is.

## What changes

- **The companion app is now optional.** Where Sincronia required its server
  scoped app, SyncroNow AI falls back to the plain ServiceNow Table API when
  the scoped endpoints are unavailable — no instance-side install needed.
- **Node 22.** The supported runtime is Node.js >= 22 (see
  [VERSIONING.md](VERSIONING.md)).
- **Names.** CLI binary `sinc` → `syncrona`; npm scope `@sincronia/*` →
  `@syncrona/*`; config `sinc.config.js` → `sync.config.js`; manifest →
  `sync.manifest.json`.
- **Credentials move out of the project.** The global encrypted store replaces
  per-project plain-text secrets (the `.env` path still works for CI or
  overrides).
- **New surface.** Diagnostics (`status`, `doctor`, `check-env`, `repair`),
  scope documentation (`docs`), Jira integration, and the MCP server for AI
  clients ([../packages/mcp-server/README.md](../packages/mcp-server/README.md)).

If something misbehaves after migrating, work through
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) — the auth, manifest and connectivity
sections cover the most common first-day issues.
