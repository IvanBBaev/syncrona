// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

export {};

// Edge branches of config.ts the other config suites leave open: a config that
// throws a non-Error, blank source/build directories, a diff manifest path that
// cannot be read for a reason other than absence, global/sticky rule patterns in
// the shadowing check, reloadManifest before any load, and the default config
// file template's argument handling.

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    isRoutedToStderr: () => false,
  },
}));

const cfg = await import("../config.js");

describe("config edges", () => {
  const originalCwd = process.cwd();
  const projects: string[] = [];

  afterEach(() => {
    process.chdir(originalCwd);
    for (const dir of projects.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function loadStoreFrom(configSource: string, setup?: (project: string) => void) {
    const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-config-edges-")));
    projects.push(project);
    fs.writeFileSync(path.join(project, "sync.config.js"), configSource);
    setup?.(project);
    process.chdir(project);
    const store = cfg.createConfigStore();
    await store.loadConfigs();
    return { store, project };
  }

  it("reports a non-Error thrown by sync.config.js in the load failure", async () => {
    await expect(loadStoreFrom('throw "boom";')).rejects.toThrow(
      /Failed to load config file .*sync\.config\.js: boom$/
    );
  });

  it("reports a failing require() inside sync.config.js by the error's message", async () => {
    await expect(
      loadStoreFrom('module.exports = require("./no-such-helper-module.js");')
    ).rejects.toThrow(
      // The host-realm error's message is used as-is (no "Error: " prefix); its
      // wording depends on the module loader (Node vs. jest), so only the module
      // name is pinned.
      /Failed to load config file .*sync\.config\.js: (?!Error: )[^]*no-such-helper-module/
    );
  });

  it("reports an Error raised in the loader's realm by its bare message", async () => {
    // An Error constructed inside the vm sandbox fails `instanceof Error` (a
    // different realm), so reach one created here through the shared `process`.
    const hook = process as unknown as { __configEdgesFail?: () => never };
    hook.__configEdgesFail = () => {
      throw new Error("bad config");
    };
    try {
      await expect(loadStoreFrom("process.__configEdgesFail();")).rejects.toThrow(
        /Failed to load config file .*sync\.config\.js: bad config$/
      );
    } finally {
      delete hook.__configEdgesFail;
    }
  });

  it("falls back to src and build for whitespace-only directory names", async () => {
    const { store, project } = await loadStoreFrom(
      'module.exports = { sourceDirectory: "   ", buildDirectory: "  " };'
    );
    expect(store.getSourcePath()).toBe(path.join(project, "src"));
    expect(store.getBuildPath()).toBe(path.join(project, "build"));
  });

  it("flags a diff manifest that exists but cannot be read as corrupt", async () => {
    const { store, project } = await loadStoreFrom("module.exports = {};", (dir) => {
      // A directory in its place fails the read with EISDIR, not ENOENT.
      fs.mkdirSync(path.join(dir, "sync.diff.manifest.json"));
    });
    expect(store.isDiffFileCorrupt()).toBe(true);
    expect(() => store.getDiffFile()).toThrow(cfg.DiffFileCorruptError);
    expect(() => store.getDiffFile()).toThrow(
      `Could not read ${path.join(project, "sync.diff.manifest.json")}:`
    );
  });

  it("treats reloadManifest before any load as a no-op", async () => {
    const store = cfg.createConfigStore();
    await expect(store.reloadManifest()).resolves.toBeUndefined();
    expect(store.getManifest(true)).toBeUndefined();
  });
});

describe("checkRuleOrder with global and sticky patterns", () => {
  it("reports every rule a /g pattern shadows and leaves the user's regex untouched", () => {
    const broad = /\.ts$/g;
    broad.lastIndex = 3;
    const rules = [
      { match: broad },
      { match: /\.secret\.ts$/ },
      { match: /\.spec\.ts$/ },
    ];

    expect(cfg.checkRuleOrder(rules)).toEqual([
      { laterIndex: 1, earlierIndex: 0, sample: "file.secret.ts" },
      { laterIndex: 2, earlierIndex: 0, sample: "file.spec.ts" },
    ]);
    expect(broad.lastIndex).toBe(3);
  });

  it("matches a sticky later pattern against its own sample", () => {
    expect(cfg.checkRuleOrder([{ match: /\.js$/ }, { match: /\.min\.js$/y }])).toEqual([
      { laterIndex: 1, earlierIndex: 0, sample: "file.min.js" },
    ]);
  });
});

describe("getDefaultConfigFile", () => {
  const sourceDirectoryOf = (template: string) => {
    const sandbox = { module: { exports: {} as { sourceDirectory?: string } } };
    new Function("module", template)(sandbox.module);
    return sandbox.module.exports.sourceDirectory;
  };

  it("uses src when called without an argument", () => {
    expect(sourceDirectoryOf(cfg.getDefaultConfigFile())).toBe("src");
  });

  it("uses src for an empty, explicitly passed directory", () => {
    expect(sourceDirectoryOf(cfg.getDefaultConfigFile(""))).toBe("src");
  });

  it("uses src for a whitespace-only directory and trims a padded one", () => {
    expect(sourceDirectoryOf(cfg.getDefaultConfigFile("   "))).toBe("src");
    expect(sourceDirectoryOf(cfg.getDefaultConfigFile("  lib  "))).toBe("lib");
  });
});
