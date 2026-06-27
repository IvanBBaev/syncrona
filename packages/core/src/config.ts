// SPDX-License-Identifier: GPL-3.0-or-later
import { SN, Sync } from "@syncro-now-ai/types";
import path from "path";
import { promises as fsp } from "fs";
import vm from "vm";
import { createRequire } from "module";
import { logger } from "./Logger";
import { includes, excludes, tableOptions } from "./defaultOptions";

const DEFAULT_CONFIG: Sync.Config = {
  sourceDirectory: "src",
  buildDirectory: "build",
  pushConcurrency: 10,
  rules: [],
  includes,
  excludes,
  tableOptions: {},
  refreshInterval: 30,
};

type ConfigState = {
  root_dir?: string;
  config?: Sync.Config;
  manifest?: SN.AppManifest;
  config_path?: string;
  source_path?: string;
  build_path?: string;
  env_path?: string;
  manifest_path?: string;
  diff_path?: string;
  diff_file?: Sync.DiffFile;
  refresh_interval?: number;
};

function shouldPreferCurrentWorkingDirectory(
  currentPath: string,
  discoveredConfigPath: string | false
): boolean {
  if (!discoveredConfigPath) {
    return false;
  }

  const localConfigPath = path.join(currentPath, "sync.config.js");
  if (path.resolve(discoveredConfigPath) === path.resolve(localConfigPath)) {
    return false;
  }

  const configRoot = path.dirname(discoveredConfigPath);
  const relative = path.relative(configRoot, currentPath);
  if (!relative || relative.startsWith("..")) {
    return false;
  }

  const segments = relative.split(path.sep).filter(Boolean);
  return segments.length >= 2 && segments[0] === "packages";
}

// Shape validation for sync.config.js: typos in option names (e.g.
// "excldues") otherwise pass silently and the option is ignored. Wrong types
// are hard errors; unknown keys are warnings (forward compatibility).
const CONFIG_KEY_TYPES: Record<string, "string" | "number" | "array" | "object" | "boolean"> = {
  sourceDirectory: "string",
  buildDirectory: "string",
  pushConcurrency: "number",
  rules: "array",
  includes: "object",
  excludes: "object",
  tableOptions: "object",
  refreshInterval: "number",
  flat: "boolean",
};

export function validateConfigShape(config: unknown, configPath: string): void {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(
      `Invalid config in ${configPath}: expected module.exports to be an object.`
    );
  }

  const errors: string[] = [];
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    const expected = CONFIG_KEY_TYPES[key];
    if (!expected) {
      logger.warn(
        `Unknown option "${key}" in ${configPath} — it will be ignored (typo?). ` +
          `Known options: ${Object.keys(CONFIG_KEY_TYPES).join(", ")}.`
      );
      continue;
    }
    if (value === undefined || value === null) {
      continue;
    }
    const matches =
      expected === "array"
        ? Array.isArray(value)
        : expected === "object"
          ? typeof value === "object" && !Array.isArray(value)
          : typeof value === expected;
    if (!matches) {
      errors.push(`"${key}" must be ${expected === "array" ? "an array" : `a ${expected}`}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid config in ${configPath}: ${errors.join("; ")}.`);
  }
}

export type RuleOrderIssue = { laterIndex: number; earlierIndex: number; sample: string };

// Build a representative filename from an anchored, literal extension pattern
// (e.g. /\.secret\.ts$/ -> "file.secret.ts"). Returns null for patterns with
// regex metacharacters we can't safely turn into a concrete filename, so the
// shadowing check never guesses.
function synthesizeFilename(pattern: RegExp): string | null {
  const literal = pattern.source.replace(/^\^/, "").replace(/\$$/, "").replace(/\\\./g, ".");
  if (!/^[A-Za-z0-9._-]+$/.test(literal)) {
    return null;
  }
  return literal.startsWith(".") ? `file${literal}` : `file.${literal}`;
}

// DX10: rules are matched first-wins, so a broad rule placed before a more
// specific one (e.g. /\.ts$/ before /\.secret\.ts$/) silently shadows it. For
// each rule we synthesize a representative filename and, if an EARLIER rule
// also matches it, report the shadow — a real file with that name would be
// claimed by the earlier rule. Zero false positives by construction.
export function checkRuleOrder(rules: Array<{ match: RegExp }>): RuleOrderIssue[] {
  const issues: RuleOrderIssue[] = [];
  for (let j = 0; j < rules.length; j++) {
    const sample = synthesizeFilename(rules[j].match);
    if (sample === null || !rules[j].match.test(sample)) {
      continue;
    }
    for (let i = 0; i < j; i++) {
      if (rules[i].match.test(sample)) {
        issues.push({ laterIndex: j, earlierIndex: i, sample });
        break;
      }
    }
  }
  return issues;
}

export class ConfigStore {
  private state: ConfigState = {};

  reset(): void {
    this.state = {};
  }

  async loadConfigs(): Promise<void> {
    let noConfigPath = false;
    const currentPath = process.cwd();
    const discoveredConfigPath = await this.loadConfigPath();
    const preferCurrentWorkingDirectory = shouldPreferCurrentWorkingDirectory(
      currentPath,
      discoveredConfigPath
    );

    if (discoveredConfigPath && !preferCurrentWorkingDirectory) {
      this.state.config_path = discoveredConfigPath;
    } else {
      this.state.config_path = undefined;
      noConfigPath = true;
    }

    await this.loadRootDir(noConfigPath);

    const cfg = await this.loadConfig(noConfigPath);
    if (cfg) {
      this.state.config = cfg;
      if (cfg.flat === true) {
        // DX17: the flat layout is applied on pull/push (single file per field
        // named <table>/<record>~<field>.<ext>) but is still experimental — note
        // it so the on-disk shape change is never silent.
        logger.info(
          "Config `flat: true` — using the experimental flat " +
            "<table>/<record>~<field> layout for pull/push " +
            "(see the README \"Flat layout\" section)."
        );
      }
    }

    await this.loadEnvPath();
    await this.loadSourcePath();
    await this.loadBuildPath();
    await this.loadManifestPath();
    await this.loadManifest();
    await this.loadDiffPath();
    await this.loadDiffFile();
    await this.loadRefresh();
  }

  getConfig(): Sync.Config {
    if (this.state.config) return this.state.config;
    throw new Error("Error getting config");
  }

  getConfigPath(): string {
    if (this.state.config_path) return this.state.config_path;
    throw new Error("Error getting config path");
  }

  checkConfigPath(): string | false {
    if (this.state.config_path) return this.state.config_path;
    return false;
  }

  getRootDir(): string {
    if (this.state.root_dir) return this.state.root_dir;
    throw new Error("Error getting root directory");
  }

  getManifest(setup = false): SN.AppManifest | undefined {
    if (this.state.manifest) return this.state.manifest;
    if (!setup) throw new Error("Error getting manifest");
    return undefined;
  }

  getManifestPath(): string {
    if (this.state.manifest_path) return this.state.manifest_path;
    throw new Error("Error getting manifest path");
  }

  getSourcePath(): string {
    if (this.state.source_path) return this.state.source_path;
    throw new Error("Error getting source path");
  }

  getBuildPath(): string {
    if (this.state.build_path) return this.state.build_path;
    throw new Error("Error getting build path");
  }

  getEnvPath(): string {
    if (this.state.env_path) return this.state.env_path;
    throw new Error("Error getting env path");
  }

  getDiffPath(): string {
    if (this.state.diff_path) return this.state.diff_path;
    throw new Error("Error getting diff path");
  }

  getDiffFile(): Sync.DiffFile {
    if (this.state.diff_file) return this.state.diff_file;
    throw new Error("Error getting diff file");
  }

  getRefresh(): number {
    if (this.state.refresh_interval !== undefined)
      return this.state.refresh_interval;
    throw new Error("Error getting refresh interval");
  }

  updateManifest(man: SN.AppManifest): void {
    this.state.manifest = man;
  }

  private async loadConfig(skipConfigPath = false): Promise<Sync.Config> {
    if (skipConfigPath) {
      logger.warn("Couldn't find config file. Loading default...");
      return DEFAULT_CONFIG;
    }
    const configPath = this.getConfigPath();
    // NOTE: vm.runInNewContext here is a module LOADER, not a sandbox —
    // sync.config.js is executable code by design and receives the real
    // `process`/`require`/`console` (same trust model as any build config).
    // The vm context only gives us a fresh evaluation per load, so config
    // reloads (per-scope auto-init, watch mode) pick up file changes without
    // fighting the require cache.
    let loaded: unknown;
    try {
      const source = await fsp.readFile(configPath, "utf-8");
      const configRequire = createRequire(configPath);
      const sandbox = {
        module: { exports: {} as unknown },
        exports: {} as unknown,
        require: configRequire,
        __filename: configPath,
        __dirname: path.dirname(configPath),
        process,
        console,
      };
      vm.runInNewContext(source, sandbox, { filename: configPath });
      loaded = (sandbox.module as { exports: unknown }).exports || sandbox.exports;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A present-but-broken config must fail hard: silently falling back to
      // defaults would run commands with the wrong includes/excludes/rules.
      throw new Error(`Failed to load config file ${configPath}: ${message}`);
    }

    const loadedObj = (loaded ?? {}) as { default?: unknown };
    const projectConfig: Sync.Config = (loadedObj.default || loadedObj) as Sync.Config;
    validateConfigShape(projectConfig, configPath);
    const {
      includes: pIncludes = {},
      excludes: pExcludes = {},
      tableOptions: pTableOptions = {},
    } = projectConfig;

    return {
      ...projectConfig,
      includes: Object.assign({}, includes, pIncludes),
      excludes: Object.assign({}, excludes, pExcludes),
      tableOptions: Object.assign({}, tableOptions, pTableOptions),
    };
  }

  private async loadManifest(): Promise<void> {
    try {
      const manifestString = await fsp.readFile(this.getManifestPath(), "utf-8");
      this.state.manifest = JSON.parse(manifestString);
    } catch (_) {
      this.state.manifest = undefined;
    }
  }

  private async loadConfigPath(pth?: string): Promise<string | false> {
    const currentPath = pth || process.cwd();
    const files = await fsp.readdir(currentPath);
    if (files.includes("sync.config.js")) {
      return path.join(currentPath, "sync.config.js");
    }

    if (path.parse(currentPath).root === currentPath) {
      return false;
    }

    return this.loadConfigPath(path.dirname(currentPath));
  }

  private async loadRefresh(): Promise<void> {
    const { refreshInterval = 30 } = this.getConfig();
    this.state.refresh_interval = refreshInterval;
  }

  private async loadSourcePath(): Promise<void> {
    const rootDir = this.getRootDir();
    const { sourceDirectory } = this.getConfig();
    // A default only triggers on `undefined`; an empty/whitespace string would
    // collapse source_path onto the project root (path.join(root, "") === root),
    // so coerce blank values back to the default the same way defaults are written.
    const dir = String(sourceDirectory || "src").trim() || "src";
    this.state.source_path = path.join(rootDir, dir);
  }

  private async loadBuildPath(): Promise<void> {
    const rootDir = this.getRootDir();
    const { buildDirectory } = this.getConfig();
    const dir = String(buildDirectory || "build").trim() || "build";
    this.state.build_path = path.join(rootDir, dir);
  }

  private async loadEnvPath(): Promise<void> {
    const rootDir = this.getRootDir();
    this.state.env_path = path.join(rootDir, ".env");
  }

  private async loadManifestPath(): Promise<void> {
    const rootDir = this.getRootDir();
    this.state.manifest_path = path.join(rootDir, "sync.manifest.json");
  }

  private async loadDiffPath(): Promise<void> {
    const rootDir = this.getRootDir();
    this.state.diff_path = path.join(rootDir, "sync.diff.manifest.json");
  }

  private async loadDiffFile(): Promise<void> {
    try {
      const diffString = await fsp.readFile(this.getDiffPath(), "utf-8");
      this.state.diff_file = JSON.parse(diffString);
    } catch (_) {
      this.state.diff_file = undefined;
    }
  }

  private async loadRootDir(skip?: boolean): Promise<void> {
    if (skip) {
      this.state.root_dir = process.cwd();
      return;
    }
    const configPath = this.getConfigPath();
    this.state.root_dir = configPath ? path.dirname(configPath) : process.cwd();
  }
}

export function createConfigStore(): ConfigStore {
  return new ConfigStore();
}

const defaultConfigStore = createConfigStore();

export const loadConfigs = async () => defaultConfigStore.loadConfigs();

export function resetConfigState() {
  defaultConfigStore.reset();
}

export function getConfig() {
  return defaultConfigStore.getConfig();
}

export function getConfigPath() {
  return defaultConfigStore.getConfigPath();
}

export function checkConfigPath() {
  return defaultConfigStore.checkConfigPath();
}

export function getRootDir() {
  return defaultConfigStore.getRootDir();
}

export function getManifest(setup = false) {
  return defaultConfigStore.getManifest(setup);
}

export function getManifestPath() {
  return defaultConfigStore.getManifestPath();
}

export function getSourcePath() {
  return defaultConfigStore.getSourcePath();
}

export function getBuildPath() {
  return defaultConfigStore.getBuildPath();
}

export function getEnvPath() {
  return defaultConfigStore.getEnvPath();
}

export function getDiffPath() {
  return defaultConfigStore.getDiffPath();
}

export function getDiffFile() {
  return defaultConfigStore.getDiffFile();
}

export function getRefresh() {
  return defaultConfigStore.getRefresh();
}

// DX17: whether the workspace uses the flat <table>/<record>~<field>.<ext>
// layout instead of per-record folders. Off unless `flat: true` in sync.config.js.
export function getFlatMode(): boolean {
  return getConfig().flat === true;
}

// The built-in defaults applied before a project's sync.config.js overrides.
// Exposed read-only for `syncro-now-ai config show-defaults` (DX9).
export function getDefaultConfig(): Sync.Config {
  return DEFAULT_CONFIG;
}

export function getDefaultConfigFile(sourceDirectory = "src"): string {
  const normalizedSourceDirectory = String(sourceDirectory || "src").trim() || "src";
  return `
    module.exports = {
      sourceDirectory: "${normalizedSourceDirectory}",
      buildDirectory: "build",
      pushConcurrency: 10,
      rules: [],
      excludes:{},
      includes:{},
      tableOptions:{},
      refreshInterval:30
    };
    `.trim();
}

export function updateManifest(man: SN.AppManifest) {
  defaultConfigStore.updateManifest(man);
}
