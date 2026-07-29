// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// REV-140 regression suite. `runPlugins` used to hand `<root>/node_modules/<name>`
// — a DIRECTORY — straight to `await import()`. Under real Node ESM that throws
// ERR_UNSUPPORTED_DIR_IMPORT, so every configured build plugin was dead in a real
// install while the existing jest suites stayed green: jest resolves dynamic
// imports with its own CJS-style resolver, which happily does directory +
// package.json "main" lookup. These tests therefore assert on the SPECIFIER and
// hand it to a real `node` subprocess, so jest's resolver cannot mask the bug.
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-rev140-"));
const PLUGIN_NAME = "@syncrona/fixture-plugin";
const PLUGIN_DIR = path.join(FIXTURE_ROOT, "node_modules", PLUGIN_NAME);
// The entry lives in a subdirectory pointed at by "main", so an assertion that
// the specifier ends at the entry FILE cannot accidentally pass on the directory.
const PLUGIN_ENTRY = path.join(PLUGIN_DIR, "lib", "index.js");

beforeAll(() => {
  fs.mkdirSync(path.join(PLUGIN_DIR, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(FIXTURE_ROOT, "package.json"),
    JSON.stringify({ name: "fixture-root", version: "1.0.0" })
  );
  fs.writeFileSync(
    path.join(PLUGIN_DIR, "package.json"),
    JSON.stringify({ name: PLUGIN_NAME, version: "1.0.0", main: "lib/index.js" })
  );
  fs.writeFileSync(
    PLUGIN_ENTRY,
    "module.exports = { run: async (_c, output) => ({ success: true, output: output + '\\n// transformed' }) };\n"
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

beforeEach(() => {
  jest.clearAllMocks();
  getRootDir.mockReturnValue(FIXTURE_ROOT);
});

// Runs an ESM snippet in a real `node` process — no jest resolver involved.
const runInRealNode = (source: string) =>
  spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: FIXTURE_ROOT,
    encoding: "utf-8",
  });

describe("PluginManager plugin specifier (REV-140)", () => {
  it("resolves a plugin to its entry FILE url, not to the package directory", async () => {
    const { resolvePluginSpecifier } = await import("../PluginManager.js");

    const specifier = resolvePluginSpecifier(PLUGIN_NAME);

    expect(specifier.startsWith("file://")).toBe(true);
    expect(fs.realpathSync(fileURLToPath(specifier))).toBe(
      fs.realpathSync(PLUGIN_ENTRY)
    );
    // The old value was the package directory; that is exactly what breaks Node.
    expect(fileURLToPath(specifier)).not.toBe(PLUGIN_DIR);
  });

  it("produces a specifier a real Node ESM process can import and run", async () => {
    const { resolvePluginSpecifier } = await import("../PluginManager.js");
    const specifier = resolvePluginSpecifier(PLUGIN_NAME);

    const result = runInRealNode(
      `const m = await import(${JSON.stringify(specifier)});\n` +
        `const plugin = typeof m?.run === "function" ? m : (m?.default ?? m);\n` +
        `const out = await plugin.run({}, "src");\n` +
        `process.stdout.write(String(out.output));\n`
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("// transformed");
  });

  it("pins the failure of the old directory specifier under real Node ESM", async () => {
    // Guards the fix from being reverted to path.join(root, "node_modules", name).
    const result = runInRealNode(
      `await import(${JSON.stringify(PLUGIN_DIR)});\n`
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ERR_UNSUPPORTED_DIR_IMPORT");
  });

  it("still reports the install hint when the plugin is genuinely absent", async () => {
    getConfig.mockReturnValue({ rules: [] });
    const PluginManager = (await import("../PluginManager.js")).default;

    await expect(
      PluginManager.runPlugins(
        [{ name: "@syncrona/definitely-not-installed", options: {} }],
        { filePath: path.join(FIXTURE_ROOT, "src", "x.js") } as never,
        "content"
      )
    ).rejects.toThrow(/could not be loaded from .*Is it installed\?/s);
  });
});
