// SPDX-License-Identifier: GPL-3.0-or-later
import fs from "fs";
import os from "os";
import path from "path";
import { Sync } from "@syncro-now-ai/types";

// G8: lock the public plugin contract that external `@syncro-now-ai/*-plugin`
// authors depend on. Two layers of protection:
//   1. Type — `referencePlugin` is written exactly as an external author
//      would, typed against the published `Sync.Plugin`/`PluginFunc`. Any
//      incompatible change to those interfaces fails to COMPILE here.
//   2. Runtime — a conforming plugin is loaded through the real PluginManager
//      (resolved from <rootDir>/node_modules/<name>, the documented location)
//      and exercised, asserting the call shape, output chaining, first-match
//      rule selection, and short-circuit-on-failure behavior.

jest.mock("../config", () => ({
  getRootDir: jest.fn(),
  getConfig: jest.fn(),
}));

import * as ConfigManager from "../config";
import PluginManager from "../PluginManager";

const getRootDir = ConfigManager.getRootDir as jest.Mock;
const getConfig = ConfigManager.getConfig as jest.Mock;

// The contract an external plugin module must satisfy, written the way a
// plugin author writes it. If `Sync.Plugin`/`PluginFunc`/`FileContext`/
// `PluginResults` change incompatibly, this stops compiling.
const referencePlugin: Sync.Plugin = {
  run: async (
    context: Sync.FileContext,
    content: string,
    options: { tag?: string }
  ): Promise<Sync.PluginResults> => {
    // Touch every documented FileContext field so a removed/renamed field
    // is a compile error, not a silent runtime break for plugin authors.
    void (
      context.filePath +
      context.name +
      context.tableName +
      context.targetField +
      context.ext +
      context.sys_id +
      context.scope
    );
    return { success: true, output: `${content}:${options.tag ?? ""}` };
  },
};

let tmpRoot: string;

// A conforming CommonJS plugin module written to the resolved plugin location.
function writePlugin(name: string, body: string): void {
  const dir = path.join(tmpRoot, "node_modules", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, main: "index.js" }));
  fs.writeFileSync(path.join(dir, "index.js"), body);
}

const context: Sync.FileContext = {
  filePath: "/proj/src/x_table/Rec/script.ts",
  name: "Rec",
  tableName: "x_table",
  targetField: "script",
  ext: "ts",
  sys_id: "rec-1",
  scope: "x_demo",
};

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-plugin-contract-"));

  // Records the exact (context, content, options) it was called with, then
  // appends "|A" so chaining is observable.
  writePlugin(
    "syncrona-contract-plugin-a",
    `const fs = require("fs");
     module.exports.run = async (context, content, options) => {
       fs.writeFileSync(${JSON.stringify(path.join("__ARGS__"))}, JSON.stringify({ context, content, options }));
       return { success: true, output: content + "|A" };
     };`.replace("__ARGS__", path.join(tmpRoot, "a-args.json"))
  );
  // Echoes an option value so options pass-through is observable.
  writePlugin(
    "syncrona-contract-plugin-b",
    `module.exports.run = async (context, content, options) => {
       return { success: true, output: content + "|B(" + (options.tag || "") + ")" };
     };`
  );
  // Always fails — used to assert the chain short-circuits.
  writePlugin(
    "syncrona-contract-plugin-fail",
    `module.exports.run = async () => ({ success: false, output: "" });`
  );

  getRootDir.mockReturnValue(tmpRoot);
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("plugin contract", () => {
  it("type-level: a reference plugin satisfies Sync.Plugin and returns PluginResults", async () => {
    const result = await referencePlugin.run(context, "hello", { tag: "v1" });
    expect(result).toEqual({ success: true, output: "hello:v1" });
  });

  it("determinePlugins picks the FIRST matching rule only", async () => {
    getConfig.mockReturnValue({
      rules: [
        { match: /\.secret\.ts$/, plugins: [] },
        { match: /\.ts$/, plugins: [{ name: "syncrona-contract-plugin-a", options: {} }] },
      ],
    } as Pick<Sync.Config, "rules">);
    await PluginManager.loadPluginConfig();

    const secret = PluginManager.determinePlugins({ ...context, filePath: "/p/x.secret.ts" });
    expect(secret).toEqual([]);

    const plain = PluginManager.determinePlugins({ ...context, filePath: "/p/x.ts" });
    expect(plain).toEqual([{ name: "syncrona-contract-plugin-a", options: {} }]);
  });

  it("runPlugins resolves modules from node_modules, chains output, and passes the documented args", async () => {
    const plugins: Sync.PluginConfig[] = [
      { name: "syncrona-contract-plugin-a", options: {} },
      { name: "syncrona-contract-plugin-b", options: { tag: "v2" } },
    ];

    const result = await PluginManager.runPlugins(plugins, context, "src");

    // Output of plugin A is the input to plugin B (chaining), options honored.
    expect(result).toEqual({ success: true, content: "src|A|B(v2)" });

    // Plugin A received exactly (FileContext, content, options).
    const recorded = JSON.parse(fs.readFileSync(path.join(tmpRoot, "a-args.json"), "utf-8"));
    expect(recorded.content).toBe("src");
    expect(recorded.options).toEqual({});
    expect(recorded.context).toMatchObject({
      filePath: context.filePath,
      sys_id: "rec-1",
      tableName: "x_table",
      targetField: "script",
      scope: "x_demo",
    });
  });

  it("runPlugins short-circuits and reports failure when a plugin returns success:false", async () => {
    const plugins: Sync.PluginConfig[] = [
      { name: "syncrona-contract-plugin-a", options: {} },
      { name: "syncrona-contract-plugin-fail", options: {} },
      { name: "syncrona-contract-plugin-b", options: {} },
    ];

    const result = await PluginManager.runPlugins(plugins, context, "src");
    expect(result).toEqual({ success: false, content: "" });
  });
});
