# Writing a SyncroNow AI plugin

A plugin is an npm package that transforms a file's contents on its way from
your local source to ServiceNow (build/push) — for example transpiling
TypeScript, bundling with Webpack, or prettifying output. SyncroNow AI ships
several (`@syncro-now-ai/typescript-plugin`, `@syncro-now-ai/babel-plugin`,
`@syncro-now-ai/webpack-plugin`, `@syncro-now-ai/sass-plugin`, `@syncro-now-ai/prettier-plugin`,
`@syncro-now-ai/eslint-plugin`); this guide covers writing your own.

## The contract

A plugin module exports a `run` function matching `Sync.Plugin`:

```ts
import type { Sync, SN } from "@syncro-now-ai/types";

export const run: Sync.PluginFunc = async (
  context: Sync.FileContext,
  content: string,
  options: unknown
): Promise<Sync.PluginResults> => {
  // transform `content` however you like…
  const output = content.toUpperCase();
  return { success: true, output };
};
```

- **`context: FileContext`** — metadata about the file being processed:
  `filePath`, `name` (record name), `tableName`, `targetField`, `ext`,
  `sys_id`, `scope`, and optional `fileContents`.
- **`content: string`** — the current file contents. In a rule with multiple
  plugins, this is the **output of the previous plugin** (plugins chain in
  order).
- **`options`** — whatever you put in the rule's `options` object (plugin-
  defined shape).
- **return `{ success: boolean; output: string }`** — on `success: false` the
  chain short-circuits and the build/push for that record fails; otherwise
  `output` becomes the input to the next plugin (or the final pushed value).

This contract is locked by a contract test in the core package
(`pluginContract.test.ts`); a breaking change to `Sync.Plugin`/`PluginFunc`
fails the build.

## Wiring it into a project

Plugins are resolved from the project's `node_modules` by package name, so
install your plugin (or `npm link` it during development) and reference it in
`sync.config.js` `rules`:

```js
// sync.config.js
module.exports = {
  rules: [
    {
      // Most specific extension first — the FIRST matching rule wins and is
      // the only one that runs.
      match: /\.secret\.ts$/,
      plugins: [], // no transform; ship as-is
    },
    {
      match: /\.ts$/,
      // Plugins run in order; each receives the previous one's output.
      plugins: [
        { name: "@syncro-now-ai/typescript-plugin", options: { transpile: true } },
        { name: "my-org-plugin", options: { tag: "v1" } },
      ],
    },
  ],
};
```

## Conventions

- Keep `run` pure and synchronous-in-effect (no global state); return a result,
  don't write files.
- Validate `options` defensively — a misconfigured rule should fail with a
  clear message, not a crash.
- Return `{ success: false, output: "" }` (or throw) on unrecoverable input;
  SyncroNow AI reports the failing `table=>sys_id`.
- Publish as a normal npm package whose main module exports `run`.

## Local development

```bash
cd my-plugin && npm link
cd /path/to/scope-project && npm link my-plugin
# reference "my-plugin" in sync.config.js rules, then:
syncro-now-ai build
```
