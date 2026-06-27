/**
 * dependency-cruiser configuration — machine-enforced module boundaries (G10).
 *
 * Enforces the ARCHITECTURE §5 / §6 contract in `npm run lint`:
 *  - no circular dependencies anywhere;
 *  - the shared foundation packages (`types`, `credential-store`,
 *    `jira`, `sn-transport`) never depend on the `core` / `mcp-server`
 *    consumers — dependency arrows point down only;
 *  - `@syncro-now-ai/types` stays a pure leaf.
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
        "Shared foundation packages (types, credential-store, jira, sn-transport) must never import the core/mcp-server consumers — dependency arrows point down only.",
      severity: "error",
      from: { path: "^packages/(types|credential-store|jira|sn-transport)/src" },
      to: {
        path: "(@syncro-now-ai/(core|mcp-server)(/|$)|^packages/(core|mcp-server)/)",
      },
    },
    {
      name: "types-is-leaf",
      comment:
        "@syncro-now-ai/types is a pure leaf and must not depend on any other @syncro-now-ai package.",
      severity: "error",
      from: { path: "^packages/types/src" },
      to: {
        path: "(@syncro-now-ai/(?!types[/$])[a-z-]+|^packages/(?!types/)[a-z-]+/)",
      },
    },
  ],
  options: {
    // Record cross-package edges (which resolve to a sibling's compiled `dist`)
    // but never descend into node_modules or compiled output.
    doNotFollow: { path: "(node_modules|/dist/)" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    exclude: { path: "(\\.test\\.ts$|/tests/)" },
  },
};
