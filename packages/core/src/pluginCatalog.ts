// SPDX-License-Identifier: GPL-3.0-or-later
// DX8: a small catalog of the first-party build plugins so `config add-plugin`
// can help users wire one without knowing its exact npm name or boilerplate.
// Pure data + formatting (no I/O); the command layer adds installed-detection.

export interface KnownPlugin {
  /** Short alias users type, e.g. "typescript". */
  short: string;
  /** Full npm package name. */
  pkg: string;
  /** One-line description. */
  description: string;
  /** Suggested file-match regular expression (as it appears in sync.config.js). */
  match: string;
  /** Optional default options object rendered into the snippet. */
  options?: string;
}

// Ordered most-specific-first, the same order users should add them as rules.
export const KNOWN_PLUGINS: readonly KnownPlugin[] = [
  {
    short: "typescript",
    pkg: "@syncrona/typescript-plugin",
    description: "Type-check and compile TypeScript files.",
    match: "/\\.ts$/",
    options: "{ transpile: true }",
  },
  {
    short: "babel",
    pkg: "@syncrona/babel-plugin",
    description: "Run Babel on .js / .ts files.",
    match: "/\\.(js|ts)$/",
  },
  {
    short: "webpack",
    pkg: "@syncrona/webpack-plugin",
    description: "Bundle files with Webpack.",
    match: "/\\.bundle\\.js$/",
  },
  {
    short: "sass",
    pkg: "@syncrona/sass-plugin",
    description: "Compile Sass / SCSS to CSS.",
    match: "/\\.s[ac]ss$/",
  },
  {
    short: "prettier",
    pkg: "@syncrona/prettier-plugin",
    description: "Format output files with Prettier.",
    match: "/\\.(js|ts|json)$/",
  },
  {
    short: "eslint",
    pkg: "@syncrona/eslint-plugin",
    description: "Run ESLint over files on build.",
    match: "/\\.(js|ts)$/",
  },
];

/**
 * Resolve a plugin from a user query, accepting the short alias
 * ("typescript"), the full package name ("@syncrona/typescript-plugin"),
 * or a loose form ("typescript-plugin"). Case-insensitive.
 */
export function findKnownPlugin(query: string): KnownPlugin | undefined {
  const raw = String(query || "").trim();
  if (!raw) {
    return undefined;
  }
  const normalized = raw
    .toLowerCase()
    .replace(/^@syncrona\//, "")
    .replace(/-plugin$/, "");
  return KNOWN_PLUGINS.find(
    (p) => p.short === normalized || p.pkg.toLowerCase() === raw.toLowerCase()
  );
}

/**
 * Render a ready-to-paste `rules` entry for a plugin, including the npm install
 * command. The snippet is a documentation aid; the user pastes it into the
 * `rules` array of sync.config.js (most specific match first).
 */
export function renderPluginRule(plugin: KnownPlugin): string {
  const optionsPart = plugin.options ? `, options: ${plugin.options}` : "";
  return [
    `# Install:`,
    `npm i -D ${plugin.pkg}`,
    ``,
    `# Add to the \`rules\` array in sync.config.js (most specific match first):`,
    `{`,
    `  match: ${plugin.match},`,
    `  plugins: [`,
    `    { name: "${plugin.pkg}"${optionsPart} },`,
    `  ],`,
    `},`,
  ].join("\n");
}
