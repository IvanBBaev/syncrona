// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import type { Sync } from "@syncrona/types";

// Covers the PluginManager edge branches the process suite leaves out: a
// config with no `rules` (files are copied as-is), an ESM plugin that has
// neither a `run` nor a default export (reported as "does not export run"),
// and a plugin whose module body throws during import (the load error keeps
// the original message) — including a non-Error throw value.
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-pm-edges-"));

const writePackage = (
  name: string,
  files: Record<string, string>,
  pkg: Record<string, unknown> = {}
) => {
  const dir = path.join(FIXTURE_ROOT, "node_modules", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", main: "index.js", ...pkg })
  );
  for (const [file, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), body);
  }
};

beforeAll(() => {
  writePackage(
    "esm-norun",
    { "index.mjs": "export const transform = () => 'nope';\n" },
    { main: "index.mjs" }
  );
  writePackage(
    "esm-run",
    {
      "index.mjs":
        "export const run = async (_c, output) => ({ success: true, output: output.toUpperCase() });\n",
    },
    { main: "index.mjs" }
  );
  writePackage("returns-nothing", { "index.js": "exports.run = async () => undefined;\n" });
  writePackage("returns-no-output", {
    "index.js": "exports.run = async () => ({ success: true });\n",
  });
  writePackage("returns-number-output", {
    "index.js": "exports.run = async () => ({ success: true, output: 42 });\n",
  });
  writePackage("returns-string-success", {
    "index.js": "exports.run = async () => ({ success: 'yes', output: 'x' });\n",
  });
  writePackage("fails-without-output", {
    "index.js": "exports.run = async () => ({ success: false });\n",
  });
  writePackage("throws-error", {
    "index.js": "throw new Error('plugin init exploded');\n",
  });
  writePackage("throws-string", {
    "index.js": "throw 'plain string failure';\n",
  });
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

const loggerDebug = jest.fn();

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    debug: (...a: unknown[]) => loggerDebug(...a),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const PluginManager = (await import("../PluginManager.js")).default;

const context = (filePath: string, fileContents?: string): Sync.FileContext =>
  ({
    filePath,
    fileContents,
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
  PluginManager.pluginRules = [];
});

describe("PluginManager.loadPluginConfig — config without rules", () => {
  it.each([
    ["no config at all", undefined],
    ["a config with no rules key", {}],
    ["a config with rules: null", { rules: null }],
  ])("copies the file as-is for %s", async (_label, conf) => {
    getConfig.mockReturnValue(conf);

    const out = await PluginManager.getFinalFileContents(
      context("/virtual/a.js", "gs.info(1);")
    );

    expect(out).toBe("gs.info(1);");
    expect(PluginManager.pluginRules).toEqual([]);
    expect(loggerDebug).toHaveBeenCalledWith(
      "build: /virtual/a.js matched no rule — copied as-is"
    );
  });

  it("adopts the rules a config does provide", async () => {
    const rules = [{ match: /\.js$/, plugins: [] }];
    getConfig.mockReturnValue({ rules });

    await PluginManager.loadPluginConfig();

    expect(PluginManager.pluginRules).toBe(rules);
  });
});

describe("PluginManager.runPlugins — plugin module shapes", () => {
  it("rejects an ESM plugin with neither a run export nor a default export", async () => {
    await expect(
      PluginManager.runPlugins(
        [{ name: "esm-norun" }] as Sync.PluginConfig[],
        context("/virtual/a.js"),
        "x"
      )
    ).rejects.toThrow(
      'Build plugin "esm-norun" does not export a run(context, content, options) function.'
    );
  });

  it("uses a named ESM run export directly", async () => {
    await expect(
      PluginManager.runPlugins(
        [{ name: "esm-run" }] as Sync.PluginConfig[],
        context("/virtual/a.js"),
        "abc"
      )
    ).resolves.toEqual({ success: true, content: "ABC" });
  });

  it.each([
    "returns-nothing",
    "returns-no-output",
    "returns-number-output",
    "returns-string-success",
  ])(
    "rejects a plugin that %s with a clear invalid-result error",
    async (name) => {
      await expect(
        PluginManager.runPlugins(
          [{ name }] as Sync.PluginConfig[],
          context("/virtual/a.js"),
          "x"
        )
      ).rejects.toThrow(
        `Build plugin "${name}" returned an invalid result for /virtual/a.js: expected { success: boolean, output: string }.`
      );
    }
  );

  it("accepts a failed result that carries no output", async () => {
    await expect(
      PluginManager.runPlugins(
        [{ name: "fails-without-output" }] as Sync.PluginConfig[],
        context("/virtual/a.js"),
        "x"
      )
    ).resolves.toEqual({ success: false, content: "" });
  });

  it("keeps the original Error message when the plugin module throws on import", async () => {
    const run = PluginManager.runPlugins(
      [{ name: "throws-error" }] as Sync.PluginConfig[],
      context("/virtual/a.js"),
      "x"
    );
    await expect(run).rejects.toThrow(
      /Build plugin "throws-error" could not be loaded from .*throws-error.*Run 'npm install throws-error'\. \(plugin init exploded\)$/
    );
  });

  it("stringifies a non-Error value thrown on import", async () => {
    await expect(
      PluginManager.runPlugins(
        [{ name: "throws-string" }] as Sync.PluginConfig[],
        context("/virtual/a.js"),
        "x"
      )
    ).rejects.toThrow(/\(plain string failure\)$/);
  });
});
