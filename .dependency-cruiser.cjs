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
        "Shared foundation packages (types, credential-store, jira, sn-transport) must never import the core/mcp-server consumers — dependency arrows point down only. REV-139: the specifier alternative used to read `@syncrona/(core|mcp-server)`, but `@syncrona/core` is a package name that exists nowhere in the workspace — the core CLI publishes as the unscoped `syncrona` (packages/core/package.json). (Reaches: packages/credential-store/src, packages/jira/src, packages/sn-transport/src, packages/types/index.d.ts.)",
      severity: "error",
      from: {
        path: "^packages/(credential-store|jira|sn-transport)/src|^packages/types/",
      },
      to: {
        path: "(@syncrona/mcp-server(/|$)|^syncrona(/|$)|^packages/(core|mcp-server)/)",
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
        "The `core` and `mcp-server` consumers are siblings and must never import each other directly — shared logic belongs in a foundation package (types/sn-transport/credential-store/jira). REV-139: this rule USED TO match the bare specifier only (`@syncrona/(core|mcp-server)`) on the theory that a resolved-path `to` would false-positive on intra-package edges. Both halves of that theory were wrong. dependency-cruiser matches `to.path` against the dependency's RESOLVED path, and in the real workspace every package is symlinked under node_modules, so `import '@syncrona/mcp-server'` resolves to `packages/mcp-server/dist/index.js` — which the specifier regex never matched, so the rule could only ever fire in a node_modules-less fixture (empirically confirmed: a cross-consumer import in the real layout produced zero violations). And `@syncrona/core` names no package at all — the core CLI publishes as the unscoped `syncrona`. The intra-package false positive is instead ruled out with group matching: `from.path` captures the package directory and `to.pathNot: ^packages/$1/` exempts every edge that stays inside the importing package. Both the resolved-path and the specifier form are matched so the rule holds before and after `npm install` links the workspace. (Reaches: packages/core/src, packages/mcp-server/src.)",
      severity: "error",
      from: { path: "^packages/(core|mcp-server)/src" },
      to: {
        path: "(@syncrona/mcp-server(/|$)|^syncrona(/|$)|^packages/(core|mcp-server)/)",
        pathNot: "^packages/$1/",
      },
    },
    {
      name: "plugins-are-leaves",
      comment:
        "The 8 build-plugin packages (babel-plugin, babel-plugin-remove-modules, babel-preset-servicenow, eslint-plugin, prettier-plugin, sass-plugin, typescript-plugin, webpack-plugin) are leaves of the graph: they may import `@syncrona/types` for shared types, but must never import another `@syncrona` package (another plugin, a foundation runtime package, or a consumer). REV-139: like `consumers-are-siblings`, the `to` matched the bare `@syncrona/<pkg>` specifier only, so in the real (symlinked) workspace — where such an import resolves to `packages/<pkg>/dist/index.js` — the rule could never fire. The resolved-path alternative is added here, with `types` exempted in both forms and intra-package relative edges exempted through the `from` capture group (`to.pathNot: ^packages/$1/`). (Reaches: each plugin's src/index.ts.)",
      severity: "error",
      from: {
        path: "^packages/(babel-plugin|babel-plugin-remove-modules|babel-preset-servicenow|eslint-plugin|prettier-plugin|sass-plugin|typescript-plugin|webpack-plugin)/src",
      },
      to: {
        path: "(@syncrona/(?!types(/|$))[a-z-]+|^syncrona(/|$)|^packages/(?!types/)[a-z-]+/)",
        pathNot: "^packages/$1/",
      },
    },
  ],
  options: {
    // Record cross-package edges (which resolve to a sibling's compiled `dist`)
    // but never descend into node_modules or compiled output. REV-139: the note
    // that used to sit here claimed `doNotFollow` DROPS runtime cross-package
    // edges so only specifier-form matching could work. It does not — the edge is
    // still recorded, with `resolved` pointing at `packages/<pkg>/dist/...` (the
    // symlink's real path); only the traversal INTO that file is skipped. The
    // boundary rules therefore match the resolved path as well as the specifier.
    doNotFollow: { path: "(node_modules|/dist/)" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    exclude: { path: "(\\.test\\.ts$|/tests/)" },
  },
};
