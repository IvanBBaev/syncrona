# Contributing to SyncroNow AI

## Prerequisites

- Node.js **22** and npm **10+** (see `.nvmrc` / `.node-version`)
- `npm install` at the repository root (npm workspaces; per-package lockfiles
  are intentionally absent — only the root `package-lock.json` is canonical)

## Repository tour

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first — it documents the
package graph, the two ServiceNow clients and their shared transport policy,
and (section 5) the **module contract**: the exact recipe for adding or
removing a CLI command (`packages/core/src/cliCommands.ts` registry) or an
MCP tool family (`packages/mcp-server/src/toolModules.ts` registry).
[docs/PRODUCT_STATE.md](docs/PRODUCT_STATE.md) tracks what is done and what
remains; `TODO` and `DONE` are the working journals.

## Quality gates — run before every change is "done"

```bash
npm run build      # build:deps (credential-store, sn-transport) + all workspaces
npm run typecheck  # tsc across core + mcp-server
npm run lint       # eslint core + mcp-server, --max-warnings=0
npm run test       # core jest (146+) + mcp node:test (172+)
npm run check      # the full gate: build + typecheck + lint + tests + coverage + governance
```

CI runs the same gates plus governance checks (tool-contract hash,
README/CLAUDE.md docs-drift, release checklist) — on GitHub via
`.github/workflows/ci.yml` (matrix: ubuntu + macOS) and, for Azure DevOps,
`azure-pipelines.yml`.

**Running a single test file:** run it from inside the package — ts-jest is
configured per-package — e.g. `cd packages/core && npx jest src/tests/foo.test.ts`,
or `npm --workspace @syncro-now-ai/core test`. Running `npx jest <file>` from the
**repo root** falls back to Babel and fails to parse TypeScript (`as` casts);
that's a runner-resolution quirk, not a code error.

## Conventions

- **Coverage is a ratchet.** `packages/core/jest.config.js` thresholds may be
  raised, never lowered.
- **stdout discipline (MCP):** the MCP server speaks JSON-RPC on stdout —
  log only to stderr (`logger.ts`).
- **Transport policy lives in `@syncro-now-ai/sn-transport`** — never re-hardcode
  scoped prefixes, retry statuses, or endpoint-not-found statuses in a client.
- **Command tables drift-checked:** changing the CLI surface requires updating
  README and CLAUDE.md in the same change, or CI fails.
- **Destructive CLI actions confirm first** and support `--dry-run`/`--ci`.
- **Security:** never commit `.env` / credentials; `npm audit --omit=dev`
  should stay at 0 vulnerabilities — fix or document exceptions.
- Tests must be order-independent: restore `global.fetch`, close servers in
  `finally`, and reset module caches via the provided seams
  (`clearServiceNowSecretsCache`, `clearScopedApiPrefixCache`).
