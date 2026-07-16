// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

export {};

const mockLoggerWarn = jest.fn();

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: jest.fn(),
    error: jest.fn(),
    isRoutedToStderr: () => false,
  },
}));

describe("sync.config.js shape validation (G2)", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    jest.resetModules();
    jest.clearAllMocks();
  });

  async function loadConfigFrom(configSource: string) {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-config-shape-"));
    fs.writeFileSync(path.join(project, "sync.config.js"), configSource);
    process.chdir(project);
    const cfg = await import("../config.js");
    const store = cfg.createConfigStore();
    await store.loadConfigs();
    return store;
  }

  it("warns about unknown option names (typo catcher) but keeps loading", async () => {
    const store = await loadConfigFrom(
      "module.exports = { sourceDirectory: 'src', excldues: {}, refreshInterval: 30, tableOptions: {} };\n"
    );

    expect(store.getConfig().sourceDirectory).toBe("src");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Unknown option "excldues"')
    );
  });

  it("rejects wrong option types as a hard error", async () => {
    await expect(
      loadConfigFrom(
        "module.exports = { sourceDirectory: 'src', refreshInterval: 'soon', tableOptions: {} };\n"
      )
    ).rejects.toThrow(/"refreshInterval" must be a number/);
  });

  it("rejects a non-object config export", async () => {
    await expect(loadConfigFrom("module.exports = [1, 2, 3];\n")).rejects.toThrow(
      /expected module.exports to be an object/
    );
  });

  // Invariant #6 / CR20: a present-but-broken config must fail hard, never
  // silently fall back to DEFAULT_CONFIG (which would run push/build with the
  // wrong includes/excludes/rules). Locks the throw at config.ts loadConfig().
  it("treats a syntactically broken config as a hard error, not a silent default", async () => {
    await expect(
      loadConfigFrom("module.exports = { sourceDirectory: 'src',\n") // unterminated object literal
    ).rejects.toThrow(/Failed to load config file/);
  });

  it("accepts a fully valid config without warnings", async () => {
    const store = await loadConfigFrom(
      "module.exports = { sourceDirectory: 'src', buildDirectory: 'build', pushConcurrency: 5, rules: [], includes: {}, excludes: {}, tableOptions: {}, refreshInterval: 30 };\n"
    );

    expect(store.getConfig().pushConcurrency).toBe(5);
    expect(mockLoggerWarn).not.toHaveBeenCalledWith(
      expect.stringContaining("Unknown option")
    );
  });
});
