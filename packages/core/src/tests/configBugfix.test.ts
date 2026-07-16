// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

describe("config merge bugfixes", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    jest.resetModules();
  });

  it("loadConfigs does not leak includes across projects", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-config-"));
    const projectA = path.join(root, "project-a");
    const projectB = path.join(root, "project-b");

    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });

    fs.writeFileSync(
      path.join(projectA, "sync.config.js"),
      "module.exports = { includes: { zzz_a_only: true } };\n"
    );
    fs.writeFileSync(
      path.join(projectB, "sync.config.js"),
      "module.exports = { includes: { zzz_b_only: true } };\n"
    );

    process.chdir(projectA);
    const cfgA = await import("../config.js");
    await cfgA.loadConfigs();
    const projectAIncludes = cfgA.getConfig().includes || {};
    expect(projectAIncludes.zzz_a_only).toBe(true);

    jest.resetModules();
    process.chdir(projectB);
    const cfgB = await import("../config.js");
    await cfgB.loadConfigs();
    const projectBIncludes = cfgB.getConfig().includes || {};

    expect(projectBIncludes.zzz_b_only).toBe(true);
    expect(projectBIncludes.zzz_a_only).toBeUndefined();
  });

  it("loadConfigs reloads updated sync.config.js without stale import cache", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-config-reload-"));
    const configPath = path.join(project, "sync.config.js");

    fs.writeFileSync(
      configPath,
      "module.exports = { refreshInterval: 12, includes: { reload_test: true } };\n"
    );

    process.chdir(project);
    const cfg = await import("../config.js");
    await cfg.loadConfigs();
    expect(cfg.getConfig().refreshInterval).toBe(12);

    fs.writeFileSync(
      configPath,
      "module.exports = { refreshInterval: 77, includes: { reload_test: true } };\n"
    );

    await cfg.loadConfigs();
    expect(cfg.getConfig().refreshInterval).toBe(77);
  });

  it("resetConfigState clears singleton state and factory stores stay isolated", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-config-store-"));
    const projectA = path.join(root, "project-a");
    const projectB = path.join(root, "project-b");

    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });
    fs.writeFileSync(
      path.join(projectA, "sync.config.js"),
      "module.exports = { refreshInterval: 11, includes: { alpha_only: true } };\n"
    );
    fs.writeFileSync(
      path.join(projectB, "sync.config.js"),
      "module.exports = { refreshInterval: 22, includes: { beta_only: true } };\n"
    );

    const cfg = await import("../config.js");

    process.chdir(projectA);
    await cfg.loadConfigs();
    expect(cfg.getConfig().refreshInterval).toBe(11);

    cfg.resetConfigState();
    expect(() => cfg.getConfig()).toThrow("Error getting config");

    const storeA = cfg.createConfigStore();
    const storeB = cfg.createConfigStore();

    process.chdir(projectA);
    await storeA.loadConfigs();

    process.chdir(projectB);
    await storeB.loadConfigs();

    expect(storeA.getConfig().includes?.alpha_only).toBe(true);
    expect(storeA.getConfig().includes?.beta_only).toBeUndefined();
    expect(storeB.getConfig().includes?.beta_only).toBe(true);
    expect(storeB.getConfig().includes?.alpha_only).toBeUndefined();
  });

  it("getDefaultConfigFile escapes a hostile source dir into syntactically valid JS", async () => {
    const vm = await import("vm");
    const cfg = await import("../config.js");
    // A source dir with a quote, backslash and newline used to emit broken JS
    // (`sourceDirectory: "a"b"`) that threw at load and bricked every command.
    const hostile = 'a"b\\c\nd';
    const code = cfg.getDefaultConfigFile(hostile);
    const sandbox: { module: { exports: { sourceDirectory?: string } } } = {
      module: { exports: {} },
    };
    expect(() => vm.runInNewContext(code, sandbox)).not.toThrow();
    // Round-trips the exact value — proof the escaping is lossless, not stripped.
    expect(sandbox.module.exports.sourceDirectory).toBe(hostile);
  });

  it("routes sync.config.js console output to stderr when stdout is a protocol channel", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-config-console-"));
    fs.writeFileSync(
      path.join(project, "sync.config.js"),
      'console.log("STDOUT_LEAK");\nmodule.exports = { includes: {} };\n'
    );
    process.chdir(project);

    // Import config first so its Logger.js singleton is the one we drive here.
    const cfg = await import("../config.js");
    const { logger } = await import("../Logger.js");

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdoutSpy = jest
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
    const stderrSpy = jest
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(String(chunk));
        return true;
      });

    try {
      logger.routeAllToStderr(); // stdout is now a machine protocol channel
      await cfg.loadConfigs();
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    // The config's console.log must NOT reach stdout (would corrupt the channel)…
    expect(stdoutChunks.join("")).not.toContain("STDOUT_LEAK");
    // …it is redirected to stderr instead.
    expect(stderrChunks.join("")).toContain("STDOUT_LEAK");
  });

  it("treats packages scope directories as standalone workspace roots when only ancestor config exists", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-monorepo-"));
    const scopeDir = path.join(repoRoot, "packages", "cs");

    fs.mkdirSync(scopeDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "sync.config.js"),
      "module.exports = { sourceDirectory: 'root-src', buildDirectory: 'root-build' };\n"
    );

    process.chdir(scopeDir);
    const cfg = await import("../config.js");
    await cfg.loadConfigs();

    const expectedScopeDir = fs.realpathSync(scopeDir);

    expect(cfg.checkConfigPath()).toBe(false);
    expect(fs.realpathSync(cfg.getRootDir())).toBe(expectedScopeDir);
    expect(fs.realpathSync(path.dirname(cfg.getSourcePath()))).toBe(expectedScopeDir);
    expect(fs.realpathSync(path.dirname(cfg.getBuildPath()))).toBe(expectedScopeDir);
  });
});
