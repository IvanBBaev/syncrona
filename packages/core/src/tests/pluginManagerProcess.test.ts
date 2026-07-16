// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import vm from "node:vm";
import type { Sync } from "@syncrona/types";

// Drives PluginManager.processFile / runPlugins / getFinalFileContents against
// real on-disk plugin fixtures (built into a temp dir at runtime so the test is
// hermetic and portable) — this exercises the dynamic plugin import for real.
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-pm-"));
const SOURCE_FILE = path.join(FIXTURE_ROOT, "src", "script.js");

const writePlugin = (name: string, body: string) => {
  const dir = path.join(FIXTURE_ROOT, "node_modules", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.js"), body);
};

beforeAll(() => {
  fs.mkdirSync(path.join(FIXTURE_ROOT, "src"), { recursive: true });
  fs.writeFileSync(SOURCE_FILE, 'gs.info("hello");\n');
  writePlugin(
    "okplugin",
    "module.exports = { run: async (_c, output) => ({ success: true, output: output + '\\n// transformed' }) };"
  );
  writePlugin(
    "failplugin",
    "module.exports = { run: async () => ({ success: false, output: '' }) };"
  );
});

afterAll(() => {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

const getConfig = jest.fn();
const getRootDir = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getConfig: (...a: unknown[]) => getConfig(...a),
  getRootDir: (...a: unknown[]) => getRootDir(...a),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const context = (filePath: string): Sync.FileContext =>
  ({
    filePath,
    tableName: "sys_script",
    sys_id: "abc",
    targetField: "script",
    name: "script",
    ext: ".js",
    scope: "x_test",
  }) as unknown as Sync.FileContext;

beforeEach(() => {
  jest.clearAllMocks();
  getRootDir.mockReturnValue(FIXTURE_ROOT);
});

describe("PluginManager.getFinalFileContents", () => {
  it("returns raw file contents when processFile is disabled", async () => {
    getConfig.mockReturnValue({ rules: [] });
    const PluginManager = (await import("../PluginManager.js")).default;
    const out = await PluginManager.getFinalFileContents(context(SOURCE_FILE), false);
    expect(out).toContain('gs.info("hello")');
  });

  it("copies a file as-is when no rule matches its path", async () => {
    getConfig.mockReturnValue({ rules: [{ match: /\.ts$/, plugins: [] }] });
    const PluginManager = (await import("../PluginManager.js")).default;
    const out = await PluginManager.getFinalFileContents(context(SOURCE_FILE));
    expect(out).toContain('gs.info("hello")');
    expect(out).not.toContain("transformed");
  });

  it("runs the matched plugin chain and returns transformed output", async () => {
    getConfig.mockReturnValue({
      rules: [{ match: /\.js$/, plugins: [{ name: "okplugin", options: {} }] }],
    });
    const PluginManager = (await import("../PluginManager.js")).default;
    const out = await PluginManager.getFinalFileContents(context(SOURCE_FILE));
    expect(out).toContain("// transformed");
  });

  it("throws a build error when a plugin reports failure", async () => {
    getConfig.mockReturnValue({
      rules: [{ match: /\.js$/, plugins: [{ name: "failplugin", options: {} }] }],
    });
    const PluginManager = (await import("../PluginManager.js")).default;
    await expect(
      PluginManager.getFinalFileContents(context(SOURCE_FILE))
    ).rejects.toThrow("Failed to build sys_script=>abc");
  });

  // #2: config.ts loads sync.config.js through vm.runInNewContext, so a regex
  // literal in the config file is created with the vm realm's RegExp intrinsic.
  // `instanceof RegExp` is false cross-realm, which used to silently skip the
  // rule and disable every build transform. util.types.isRegExp is realm-safe,
  // so a cross-realm regex still matches and the plugin chain still runs.
  it("matches a cross-realm RegExp produced by vm-loaded config (#2)", async () => {
    const crossRealmRegex = vm.runInNewContext("/\\.js$/") as RegExp;
    // Sanity: this regex is a real RegExp but fails the old instanceof gate.
    expect(crossRealmRegex instanceof RegExp).toBe(false);

    getConfig.mockReturnValue({
      rules: [{ match: crossRealmRegex, plugins: [{ name: "okplugin", options: {} }] }],
    });
    const PluginManager = (await import("../PluginManager.js")).default;
    const out = await PluginManager.getFinalFileContents(context(SOURCE_FILE));
    expect(out).toContain("// transformed");
  });
});
