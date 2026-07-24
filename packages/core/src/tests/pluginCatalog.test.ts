// SPDX-License-Identifier: GPL-3.0-or-later
import {
  KNOWN_PLUGINS,
  findKnownPlugin,
  renderPluginRule,
} from "../pluginCatalog.js";
import { configCommand } from "../diagnosticsCommands.js";

// DX8: `config add-plugin` helper. The catalog + resolution + snippet rendering
// are pure and tested directly; the command branch is exercised for coverage.

describe("plugin catalog", () => {
  it("lists first-party plugins with unique shorts and scoped packages", () => {
    expect(KNOWN_PLUGINS.length).toBeGreaterThanOrEqual(6);
    const shorts = KNOWN_PLUGINS.map((p) => p.short);
    expect(new Set(shorts).size).toBe(shorts.length);
    for (const p of KNOWN_PLUGINS) {
      expect(p.pkg.startsWith("@syncrona/")).toBe(true);
      expect(p.match.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ["typescript", "@syncrona/typescript-plugin"],
    ["TypeScript", "@syncrona/typescript-plugin"],
    ["typescript-plugin", "@syncrona/typescript-plugin"],
    ["@syncrona/sass-plugin", "@syncrona/sass-plugin"],
    ["  babel  ", "@syncrona/babel-plugin"],
  ])("resolves %p to %p", (query, pkg) => {
    expect(findKnownPlugin(query)?.pkg).toBe(pkg);
  });

  it.each(["", "   ", "nope", "@other/plugin"])(
    "returns undefined for unknown query %p",
    (query) => {
      expect(findKnownPlugin(query)).toBeUndefined();
    }
  );

  it("renders an install command and a rules snippet", () => {
    const ts = findKnownPlugin("typescript")!;
    const snippet = renderPluginRule(ts);
    expect(snippet).toContain("npm i -D @syncrona/typescript-plugin");
    expect(snippet).toContain('name: "@syncrona/typescript-plugin"');
    expect(snippet).toContain("options: { transpile: true }");
    expect(snippet).toContain("match: /\\.ts$/");
  });

  it("omits options for a plugin without defaults", () => {
    const babel = findKnownPlugin("babel")!;
    expect(renderPluginRule(babel)).not.toContain("options:");
  });
});

describe("config add-plugin command branch", () => {
  let savedExit: typeof process.exitCode;
  beforeEach(() => {
    savedExit = process.exitCode;
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = savedExit;
  });

  const run = (extra: Record<string, unknown>) =>
     
    configCommand({ action: "add-plugin", ...extra } as any);

  it("lists plugins when no --plugin is given", async () => {
    await run({});
    expect(process.exitCode).toBe(0);
  });

  it("succeeds for a known plugin", async () => {
    await run({ plugin: "typescript" });
    expect(process.exitCode).toBe(0);
  });

  it("fails for an unknown plugin", async () => {
    await run({ plugin: "does-not-exist" });
    expect(process.exitCode).toBe(1);
  });

  it("fails for an unknown action", async () => {
     
    await configCommand({ action: "bogus" } as any);
    expect(process.exitCode).toBe(1);
  });
});
