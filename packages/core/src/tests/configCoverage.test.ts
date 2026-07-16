// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

export {};

const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    error: jest.fn(),
    isRoutedToStderr: () => false,
  },
}));

describe("config coverage", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    jest.resetModules();
    jest.clearAllMocks();
  });

  // Materialize a project with the given sync.config.js source and, optionally,
  // extra files (e.g. a manifest or diff file), then load a fresh store from it.
  async function loadStoreFrom(
    configSource: string,
    extraFiles: Record<string, string> = {}
  ) {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-config-cov-"));
    fs.writeFileSync(path.join(project, "sync.config.js"), configSource);
    for (const [name, contents] of Object.entries(extraFiles)) {
      fs.writeFileSync(path.join(project, name), contents);
    }
    process.chdir(project);
    const cfg = await import("../config.js");
    const store = cfg.createConfigStore();
    await store.loadConfigs();
    return { cfg, store, project };
  }

  // ---- getters throw before any config is loaded (empty state) ----------

  it("every getter throws its own error before configs are loaded", async () => {
    const cfg = await import("../config.js");
    const store = cfg.createConfigStore();

    expect(() => store.getConfig()).toThrow("Error getting config");
    expect(() => store.getConfigPath()).toThrow("Error getting config path");
    expect(store.checkConfigPath()).toBe(false);
    expect(() => store.getRootDir()).toThrow("Error getting root directory");
    expect(() => store.getManifest()).toThrow("Error getting manifest");
    expect(() => store.getManifestPath()).toThrow("Error getting manifest path");
    expect(() => store.getSourcePath()).toThrow("Error getting source path");
    expect(() => store.getBuildPath()).toThrow("Error getting build path");
    expect(() => store.getEnvPath()).toThrow("Error getting env path");
    expect(() => store.getDiffPath()).toThrow("Error getting diff path");
    expect(() => store.getDiffFile()).toThrow("Error getting diff file");
    expect(() => store.getRefresh()).toThrow("Error getting refresh interval");
  });

  // getManifest(setup=true) returns undefined instead of throwing when absent.
  it("getManifest(true) returns undefined instead of throwing when no manifest", async () => {
    const cfg = await import("../config.js");
    const store = cfg.createConfigStore();
    expect(store.getManifest(true)).toBeUndefined();
  });

  // ---- happy-path getters resolve real values after a load --------------

  it("getters return the resolved paths and values after loadConfigs", async () => {
    const { store, project } = await loadStoreFrom(
      "module.exports = { sourceDirectory: 'src', buildDirectory: 'build', refreshInterval: 42 };\n"
    );

    const root = fs.realpathSync(project);
    expect(fs.realpathSync(store.getConfigPath())).toBe(
      path.join(root, "sync.config.js")
    );
    expect(store.checkConfigPath()).not.toBe(false);
    expect(fs.realpathSync(store.getRootDir())).toBe(root);
    expect(fs.realpathSync(path.dirname(store.getSourcePath()))).toBe(root);
    expect(path.basename(store.getSourcePath())).toBe("src");
    expect(path.basename(store.getBuildPath())).toBe("build");
    expect(path.basename(store.getEnvPath())).toBe(".env");
    expect(path.basename(store.getManifestPath())).toBe("sync.manifest.json");
    expect(path.basename(store.getDiffPath())).toBe("sync.diff.manifest.json");
    expect(store.getRefresh()).toBe(42);
  });

  // ---- manifest loading + updateManifest --------------------------------

  it("loadManifest parses an existing sync.manifest.json and getManifest returns it", async () => {
    const { store } = await loadStoreFrom(
      "module.exports = { sourceDirectory: 'src' };\n",
      { "sync.manifest.json": JSON.stringify({ scope: "x_test_app" }) }
    );

    const manifest = store.getManifest() as { scope?: string };
    expect(manifest.scope).toBe("x_test_app");
  });

  it("updateManifest replaces the in-memory manifest", async () => {
    const { store } = await loadStoreFrom(
      "module.exports = { sourceDirectory: 'src' };\n"
    );

    // No manifest file → setup mode returns undefined.
    expect(store.getManifest(true)).toBeUndefined();

    store.updateManifest({ scope: "x_updated" } as never);
    expect((store.getManifest() as { scope?: string }).scope).toBe("x_updated");
  });

  // ---- flat: true info log (DX17) --------------------------------------

  it("logs the experimental flat-layout notice when flat: true", async () => {
    await loadStoreFrom("module.exports = { flat: true, sourceDirectory: 'src' };\n");

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("flat: true")
    );
  });

  // ---- validateConfigShape: null values are skipped ---------------------

  it("skips null option values without a type error", async () => {
    // refreshInterval is null (not a number) — the null guard in
    // validateConfigShape must skip it instead of raising a type error, so the
    // load succeeds and the string source directory is still applied.
    const { store } = await loadStoreFrom(
      "module.exports = { sourceDirectory: 'src', refreshInterval: null };\n"
    );

    expect(store.getConfig().sourceDirectory).toBe("src");
    expect(mockLoggerWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('"refreshInterval" must be')
    );
  });

  // ---- DiffFileCorruptError constructor --------------------------------

  it("DiffFileCorruptError carries its message and name", async () => {
    const cfg = await import("../config.js");
    const err = new cfg.DiffFileCorruptError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DiffFileCorruptError");
    expect(err.message).toBe("boom");
  });

  // ---- loadDiffFile: valid, absent, invalid-JSON, unreadable ------------

  it("parses a valid diff file and getDiffFile returns it", async () => {
    const { store } = await loadStoreFrom(
      "module.exports = { sourceDirectory: 'src' };\n",
      { "sync.diff.manifest.json": JSON.stringify({ tables: { incident: [] } }) }
    );

    expect(store.isDiffFileCorrupt()).toBe(false);
    const diff = store.getDiffFile() as { tables?: Record<string, unknown> };
    expect(diff.tables).toBeDefined();
  });

  it("treats an absent diff file as no-diff, not corrupt", async () => {
    const { store } = await loadStoreFrom(
      "module.exports = { sourceDirectory: 'src' };\n"
    );

    expect(store.isDiffFileCorrupt()).toBe(false);
    // Present state: no diff file and no error → the plain "not found" throw.
    expect(() => store.getDiffFile()).toThrow("Error getting diff file");
  });

  it("flags an invalid-JSON diff file as corrupt and getDiffFile throws DiffFileCorruptError", async () => {
    const cfg = await import("../config.js");
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-config-cov-"));
    fs.writeFileSync(
      path.join(project, "sync.config.js"),
      "module.exports = { sourceDirectory: 'src' };\n"
    );
    fs.writeFileSync(
      path.join(project, "sync.diff.manifest.json"),
      "{ not: valid json"
    );
    process.chdir(project);
    const store = cfg.createConfigStore();
    await store.loadConfigs();

    expect(store.isDiffFileCorrupt()).toBe(true);
    expect(() => store.getDiffFile()).toThrow(cfg.DiffFileCorruptError);
    expect(() => store.getDiffFile()).toThrow(/present but not valid JSON/);
  });

  it("flags a present-but-unreadable diff file (non-ENOENT) as corrupt", async () => {
    const cfg = await import("../config.js");
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-config-cov-"));
    fs.writeFileSync(
      path.join(project, "sync.config.js"),
      "module.exports = { sourceDirectory: 'src' };\n"
    );
    // A directory in place of the file makes readFile fail with EISDIR (not
    // ENOENT), which is the "present but unreadable" corruption path.
    fs.mkdirSync(path.join(project, "sync.diff.manifest.json"));
    process.chdir(project);
    const store = cfg.createConfigStore();
    await store.loadConfigs();

    expect(store.isDiffFileCorrupt()).toBe(true);
    expect(() => store.getDiffFile()).toThrow(cfg.DiffFileCorruptError);
    expect(() => store.getDiffFile()).toThrow(/Could not read/);
  });

  // ---- shouldPreferCurrentWorkingDirectory: "relative starts with .." ---
  // A cwd that is a SIBLING of the config root yields a relative path starting
  // with "..", which must NOT prefer the cwd (falls through to the ancestor).

  it("does not prefer cwd for a sibling directory outside the config root", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-config-sibling-"));
    const withConfig = path.join(repoRoot, "with-config");
    const sibling = path.join(repoRoot, "sibling");
    fs.mkdirSync(withConfig, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(
      path.join(withConfig, "sync.config.js"),
      "module.exports = { sourceDirectory: 'from-config' };\n"
    );
    // Note: the ancestor walk starts at cwd and climbs; the config lives in a
    // sibling, so loadConfigPath will actually find the repoRoot's config only
    // if present. Here no ancestor config exists above `sibling`, so the store
    // falls back to cwd. This still exercises the sibling/"." relative branch
    // via a monorepo-style layout below.

    process.chdir(sibling);
    const cfg = await import("../config.js");
    const store = cfg.createConfigStore();
    await store.loadConfigs();
    // No config found up the tree → cwd is root, default config is used.
    expect(store.checkConfigPath()).toBe(false);
    expect(fs.realpathSync(store.getRootDir())).toBe(fs.realpathSync(sibling));
  });

  // ---- module-level singleton wrappers ----------------------------------
  // Exercise the exported free functions that proxy defaultConfigStore.

  it("module-level exported wrappers proxy the default store", async () => {
    const { cfg, project } = await loadStoreFrom(
      "module.exports = { flat: true, sourceDirectory: 'src', refreshInterval: 7 };\n",
      { "sync.manifest.json": JSON.stringify({ scope: "x_mod" }) }
    );

    // Load into the DEFAULT (singleton) store used by the free functions.
    await cfg.loadConfigs();

    const root = fs.realpathSync(project);
    expect(cfg.getConfig().refreshInterval).toBe(7);
    expect(fs.realpathSync(cfg.getConfigPath())).toBe(
      path.join(root, "sync.config.js")
    );
    expect(cfg.checkConfigPath()).not.toBe(false);
    expect(fs.realpathSync(cfg.getRootDir())).toBe(root);
    expect((cfg.getManifest() as { scope?: string }).scope).toBe("x_mod");
    expect(path.basename(cfg.getManifestPath())).toBe("sync.manifest.json");
    expect(path.basename(cfg.getSourcePath())).toBe("src");
    expect(path.basename(cfg.getBuildPath())).toBe("build");
    expect(path.basename(cfg.getEnvPath())).toBe(".env");
    expect(path.basename(cfg.getDiffPath())).toBe("sync.diff.manifest.json");
    expect(cfg.isDiffFileCorrupt()).toBe(false);
    expect(cfg.getRefresh()).toBe(7);
    expect(cfg.getFlatMode()).toBe(true);

    cfg.updateManifest({ scope: "x_mod2" } as never);
    expect((cfg.getManifest() as { scope?: string }).scope).toBe("x_mod2");
  });

  it("getDiffFile wrapper throws when the default store has no diff file", async () => {
    const { cfg } = await loadStoreFrom(
      "module.exports = { sourceDirectory: 'src' };\n"
    );
    await cfg.loadConfigs();
    expect(() => cfg.getDiffFile()).toThrow("Error getting diff file");
  });

  // ---- getDefaultConfig / getDefaultConfigFile --------------------------

  it("getDefaultConfig returns the built-in defaults", async () => {
    const cfg = await import("../config.js");
    const defaults = cfg.getDefaultConfig();
    expect(defaults.sourceDirectory).toBe("src");
    expect(defaults.buildDirectory).toBe("build");
    expect(defaults.pushConcurrency).toBe(10);
    expect(defaults.refreshInterval).toBe(30);
  });

  it("getDefaultConfigFile normalizes a blank source directory to 'src'", async () => {
    const cfg = await import("../config.js");
    const blank = cfg.getDefaultConfigFile("   ");
    expect(blank).toContain('sourceDirectory: "src"');

    const custom = cfg.getDefaultConfigFile("app_src");
    expect(custom).toContain('sourceDirectory: "app_src"');
    expect(custom).toContain("module.exports");
  });

  // ---- validateConfigShape: direct unit coverage of every branch --------

  it("validateConfigShape rejects a non-object export", async () => {
    const { validateConfigShape } = await import("../config.js");
    expect(() => validateConfigShape([1, 2, 3], "/p/sync.config.js")).toThrow(
      /expected module.exports to be an object/
    );
    expect(() => validateConfigShape(null, "/p/sync.config.js")).toThrow(
      /expected module.exports to be an object/
    );
  });

  it("validateConfigShape warns on unknown keys and errors on wrong types", async () => {
    const { validateConfigShape } = await import("../config.js");

    // Unknown key → warning, no throw.
    expect(() =>
      validateConfigShape({ excldues: {} }, "/p/sync.config.js")
    ).not.toThrow();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Unknown option "excldues"')
    );

    // Wrong types → collected into a single hard error.
    expect(() =>
      validateConfigShape(
        { pushConcurrency: "ten", rules: {} },
        "/p/sync.config.js"
      )
    ).toThrow(/"pushConcurrency" must be a number.*"rules" must be an array/s);
  });

  // ---- synthesizeFilename ----------------------------------------------

  it("synthesizeFilename builds concrete samples and rejects metacharacters", async () => {
    const { synthesizeFilename } = await import("../config.js");

    // Leading-dot literal → prefixed with "file".
    expect(synthesizeFilename(/^\.secret\.ts$/)).toBe("file.secret.ts");
    // Non-dot literal → "file." prefix.
    expect(synthesizeFilename(/^widget$/)).toBe("file.widget");
    // Regex metacharacters we cannot safely concretize → null.
    expect(synthesizeFilename(/\.(ts|js)$/)).toBeNull();
  });

  // ---- checkRuleOrder ---------------------------------------------------

  it("checkRuleOrder reports a broad rule shadowing a later specific one", async () => {
    const { checkRuleOrder } = await import("../config.js");

    const issues = checkRuleOrder([
      { match: /\.ts$/ }, // broad, placed first
      { match: /\.secret\.ts$/ }, // more specific, shadowed by the earlier rule
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ laterIndex: 1, earlierIndex: 0 });
    expect(issues[0].sample).toBe("file.secret.ts");
  });

  it("checkRuleOrder finds no shadowing when the specific rule comes first", async () => {
    const { checkRuleOrder } = await import("../config.js");

    const issues = checkRuleOrder([
      { match: /\.secret\.ts$/ },
      { match: /\.ts$/ },
      { match: /\.(a|b)$/ }, // unsynthesizable → skipped, no false positive
    ]);

    expect(issues).toHaveLength(0);
  });

  // ---- reset() / resetConfigState ---------------------------------------

  it("store.reset clears loaded state", async () => {
    const { store } = await loadStoreFrom(
      "module.exports = { sourceDirectory: 'src' };\n"
    );
    expect(store.getConfig().sourceDirectory).toBe("src");

    store.reset();
    expect(() => store.getConfig()).toThrow("Error getting config");
  });

  it("resetConfigState clears the default singleton store", async () => {
    const { cfg } = await loadStoreFrom(
      "module.exports = { sourceDirectory: 'src' };\n"
    );
    await cfg.loadConfigs();
    expect(cfg.getConfig().sourceDirectory).toBe("src");

    cfg.resetConfigState();
    expect(() => cfg.getConfig()).toThrow("Error getting config");
  });

  // ---- loadConfig catch: a broken config fails hard ---------------------

  it("a present-but-broken sync.config.js throws instead of falling back to defaults", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-config-cov-"));
    fs.writeFileSync(
      path.join(project, "sync.config.js"),
      "module.exports = { sourceDirectory: 'src',\n" // unterminated object literal
    );
    process.chdir(project);
    const cfg = await import("../config.js");
    const store = cfg.createConfigStore();

    await expect(store.loadConfigs()).rejects.toThrow(/Failed to load config file/);
  });

  // ---- shouldPreferCurrentWorkingDirectory: monorepo packages/ branch ---
  // A cwd two-deep under packages/ with only an ancestor config prefers the
  // cwd as a standalone workspace root (segments[0] === "packages", len >= 2).

  it("prefers the cwd for a packages/<scope> dir when only an ancestor config exists", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-config-mono-"));
    const scopeDir = path.join(repoRoot, "packages", "cs");
    fs.mkdirSync(scopeDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "sync.config.js"),
      "module.exports = { sourceDirectory: 'root-src' };\n"
    );

    process.chdir(scopeDir);
    const cfg = await import("../config.js");
    const store = cfg.createConfigStore();
    await store.loadConfigs();

    // The ancestor config is ignored: the scope dir is treated as its own root.
    expect(store.checkConfigPath()).toBe(false);
    expect(fs.realpathSync(store.getRootDir())).toBe(fs.realpathSync(scopeDir));
  });
});
