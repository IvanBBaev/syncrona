/**
 * dependency-cruiser configuration — machine-enforced module boundaries (G10).
 *
 * Enforces the ARCHITECTURE §5 / §6 contract in `npm run lint`:
 *  - no circular dependencies anywhere;
 *  - the shared foundation packages (`types`, `credential-store`,
 *    `jira`, `sn-transport`) never depend on the `core` / `mcp-server`
 *    consumers — dependency arrows point down only;
 *  - `@syncrona/types` stays a pure leaf;
 *  - the `core` and `mcp-server` consumers never import each other directly;
 *  - the 8 build-plugin packages are leaves that may only import `types`.
 *
 * IMPORTANT — scope coupling with `lint:boundaries` in the root package.json:
 * the `--include-only` glob there MUST keep `packages/types` in scope, because
 * `types` ships a root-level `index.d.ts` and has NO `src/` directory. If the
 * glob is narrowed back to `^packages/[^/]+/src`, `packages/types/index.d.ts`
 * drops out of the module set and every `types`-scoped rule below silently
 * matches zero modules and can never fire. Keep the two in lockstep.
 *
 * Self-test against silent zero-match rot: run `npm run lint:boundaries:selftest`
 * (a fixture that intentionally violates each rule below); a config change that
 * makes a rule un-fireable will let the fixture pass and fail that check. See the
 * `known` self-check comment on each rule for the module it is expected to reach.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment:
        "Circular dependencies make modules impossible to reason about, test in isolation, or load deterministically. Type-only cycles are erased at compile time, so only runtime cycles are flagged.",
      severity: "error",
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } },
    },
    {
      name: "foundation-no-consumers",
      comment:
        "Shared foundation packages (types, credential-store, jira, sn-transport) must never import the core/mcp-server consumers — dependency arrows point down only. (Reaches: packages/credential-store/src, packages/jira/src, packages/sn-transport/src, packages/types/index.d.ts.)",
      severity: "error",
      from: {
        path: "^packages/(credential-store|jira|sn-transport)/src|^packages/types/",
      },
      to: {
        path: "(@syncrona/(core|mcp-server)(/|$)|^packages/(core|mcp-server)/)",
      },
    },
    {
      name: "types-is-leaf",
      comment:
        "@syncrona/types is a pure leaf and must not depend on any other @syncrona package. NOTE: `types` has no src/ — its declarations live in packages/types/index.d.ts, so the `from` path matches the package root, not `/src`. (Reaches: packages/types/index.d.ts.)",
      severity: "error",
      from: { path: "^packages/types/" },
      to: {
        path: "(@syncrona/(?!types[/$])[a-z-]+|^packages/(?!types/)[a-z-]+/)",
      },
    },
    {
      name: "consumers-are-siblings",
      comment:
        "The `core` and `mcp-server` consumers are siblings and must never import each other directly — shared logic belongs in a foundation package (types/sn-transport/credential-store/jira). A cross-consumer import ALWAYS uses the bare `syncrona` / `@syncrona/mcp-server` specifier, so the `to` matches that specifier form only. Matching the specifier (rather than the resolved path) is deliberate and required: dependency-cruiser has no back-reference from `to` to `from`, so a resolved-path `to: ^packages/(core|mcp-server)/` would flag every intra-package relative edge (core->core) as a violation — an empirically-confirmed false positive. ENFORCEMENT CAVEAT: at runtime the specifier resolves through `node_modules/@syncrona/<pkg>` into that package's compiled `dist`, which `options.doNotFollow` drops, so this rule fires on the source-resolvable specifier edge rather than a followed dist edge. It is an executable statement of intent guarded by the self-test. (Reaches: packages/core/src, packages/mcp-server/src.)",
      severity: "error",
      from: { path: "^packages/(core|mcp-server)/src" },
      to: {
        path: "@syncrona/(core|mcp-server)(/|$)",
      },
    },
    {
      name: "plugins-are-leaves",
      comment:
        "The 8 build-plugin packages (babel-plugin, babel-plugin-remove-modules, babel-preset-servicenow, eslint-plugin, prettier-plugin, sass-plugin, typescript-plugin, webpack-plugin) are leaves of the graph: they may import `@syncrona/types` for shared types (a source-resolvable `.d.ts` edge that IS enforced), but must never import another `@syncrona` package (another plugin, a foundation runtime package, or a consumer). Cross-package imports always use the `@syncrona/<pkg>` specifier, so the `to` matches every `@syncrona/*` specifier EXCEPT `types`; intra-package relative imports carry no such specifier and are never flagged. (A resolved-path `to` would false-positive on intra-package edges, same as `consumers-are-siblings`.) (Reaches: each plugin's src/index.ts.)",
      severity: "error",
      from: {
        path: "^packages/(babel-plugin|babel-plugin-remove-modules|babel-preset-servicenow|eslint-plugin|prettier-plugin|sass-plugin|typescript-plugin|webpack-plugin)/src",
      },
      to: {
        path: "@syncrona/(?!types(/|$))[a-z-]+",
      },
    },
  ],
  options: {
    // Record cross-package edges (which resolve to a sibling's compiled `dist`)
    // but never descend into node_modules or compiled output. NOTE: because
    // `/dist/` is not followed, RUNTIME cross-package edges are dropped and only
    // source-resolvable edges (notably `@syncrona/types` -> index.d.ts) are
    // graph-visible; see the enforcement caveat on the sibling/leaf rules.
    doNotFollow: { path: "(node_modules|/dist/)" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    exclude: { path: "(\\.test\\.ts$|/tests/)" },
  },
};
