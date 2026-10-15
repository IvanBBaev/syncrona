// SPDX-License-Identifier: GPL-3.0-or-later
//
// Native `fluent pack`: zip an already-built app directory without the SDK.
//
// The SDK's `Orchestrator.pack` does not derive anything at pack time — its
// build has already written the install layout (`dist/app/{scope,update,…}`).
// Pack only adds `package_inventory.csv` (SHA-256 of every file) and zips the
// directory. This module reproduces that:
//
// - config from `now.config.json`, else the `now` key of `package.json`, with
//   the SDK defaults `appOutputDir = dist/app` and `packOutputDir = target`
//   (and the deprecated `compileOutputDir` honoured as `appOutputDir`);
// - the default archive `<packOutputDir>/<snake_case(name_version)>.zip`;
// - the inventory header (`#build`, `#appVersion`, `#type`, `#version=1.0.0`)
//   then `relpath;sha256` lines in default sort order;
// - zip entry names with a leading `/`, exactly as the SDK writes them (it
//   strips the source directory from an absolute path and keeps the slash).
//   The instance's upload processor has always been fed that shape, so the
//   native archive keeps it rather than discover how it handles another.
//
// One intended difference: the SDK writes `package_inventory.csv` into the
// build directory before zipping it; the native pack puts a fresh inventory
// in the archive only and leaves the build output untouched.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createZip, ZipEntry } from "./zip";

export const INVENTORY_FILE = "package_inventory.csv";

export class FluentNativeError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "FluentNativeError";
    this.code = code;
  }
}

/** The project facts the native pack and install read. */
export interface NativeProject {
  projectDir: string;
  scope: string;
  scopeId: string;
  appOutputDir: string;
  packOutputDir: string;
  /** `hostedPlugins` from the config; any non-empty value makes the install a store app. */
  hostedPlugins: boolean;
  installAs?: string;
  packageName: string;
  packageVersion: string;
}

function readJson(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new FluentNativeError(`Failed to parse ${file}.`, "FLUENT_CONFIG_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FluentNativeError(`${file} must hold a JSON object.`, "FLUENT_CONFIG_INVALID");
  }
  return parsed as Record<string, unknown>;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function hasHostedPlugins(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Read `now.config.json` (or `package.json#now`) and `package.json` the way the SDK does. */
export function readNativeProject(projectDir: string): NativeProject {
  const pkg = readJson(path.join(projectDir, "package.json"));
  const config = readJson(path.join(projectDir, "now.config.json")) ?? (pkg?.now as Record<string, unknown> | undefined);
  if (!config || typeof config !== "object") {
    throw new FluentNativeError(
      `No now.config.json (or "now" key in package.json) in ${projectDir}; is this a Fluent project?`,
      "FLUENT_CONFIG_MISSING",
    );
  }
  const packageName = stringOf(pkg?.name);
  const packageVersion = stringOf(pkg?.version);
  if (!packageName || !packageVersion) {
    throw new FluentNativeError(
      `package.json in ${projectDir} needs a "name" and a "version" to name the package.`,
      "FLUENT_PACKAGE_INVALID",
    );
  }
  return {
    projectDir,
    scope: stringOf(config.scope) ?? "",
    scopeId: stringOf(config.scopeId) ?? "",
    appOutputDir: stringOf(config.appOutputDir) ?? stringOf(config.compileOutputDir) ?? path.join("dist", "app"),
    packOutputDir: stringOf(config.packOutputDir) ?? "target",
    hostedPlugins: hasHostedPlugins(config.hostedPlugins),
    installAs: stringOf(config.installAs),
    packageName,
    packageVersion,
  };
}

const WORDS = /[A-Z]{2,}(?=[A-Z][a-z]|[^A-Za-z]|$)|[A-Z]?[a-z]+|[A-Z]+|\d+/g;

/** lodash `snakeCase` for the ASCII names npm allows: `myApp_1.0.0-beta.2` → `my_app_1_0_0_beta_2`. */
export function snakeCase(value: string): string {
  return (value.match(WORDS) ?? []).map((word) => word.toLowerCase()).join("_");
}

/** The archive path the SDK picks when none is given. */
export function defaultPackagePath(project: NativeProject): string {
  const file = `${snakeCase(`${project.packageName}_${project.packageVersion}`)}.zip`;
  return path.resolve(project.projectDir, project.packOutputDir, file);
}

/** Every file under `dir`, as `/`-separated paths relative to it. */
function listFiles(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(path.join(dir, entry.name), relative));
    else files.push(relative);
  }
  return files;
}

/** Build `package_inventory.csv` for `files` (relative path → content). */
export function packageInventory(project: NativeProject, files: ReadonlyMap<string, Buffer>): string {
  const global = project.scope === "global";
  const build = global ? project.scopeId : project.scope;
  if (!build) {
    throw new FluentNativeError(
      "Cannot generate package_inventory.csv: missing scope or scopeId in config",
      "FLUENT_CONFIG_INVALID",
    );
  }
  const lines = [
    `#build=${build}`,
    `#appVersion=${project.packageVersion}`,
    `#type=${global ? "global" : "scoped"}`,
    "#version=1.0.0",
  ];
  const paths = [...files.keys()].filter((file) => !file.endsWith(INVENTORY_FILE)).sort();
  for (const file of paths) {
    lines.push(`${file};${createHash("sha256").update(files.get(file) as Buffer).digest("hex")}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Read the build output and return the archive entries, inventory included. */
export function packEntries(project: NativeProject): ZipEntry[] {
  const appOutputPath = path.resolve(project.projectDir, project.appOutputDir);
  if (!existsSync(appOutputPath) || readdirSync(appOutputPath).length === 0) {
    throw new FluentNativeError(
      `No files found in ${appOutputPath} directory to create zip. Run \`syncrona fluent build\` first.`,
      "FLUENT_PACK_EMPTY",
    );
  }
  const files = new Map<string, Buffer>();
  for (const file of listFiles(appOutputPath)) {
    if (file !== INVENTORY_FILE) files.set(file, readFileSync(path.join(appOutputPath, file)));
  }
  const inventory = packageInventory(project, files);
  return [
    { name: `/${INVENTORY_FILE}`, data: Buffer.from(inventory, "utf8") },
    ...[...files].map(([name, data]) => ({ name: `/${name}`, data })),
  ];
}

/** Pack the built app into a zip and return the archive's absolute path. */
export function nativePack(projectDir: string, packagePath?: string): string {
  const project = readNativeProject(projectDir);
  const target = packagePath ? path.resolve(projectDir, packagePath) : defaultPackagePath(project);
  const zip = createZip(packEntries(project));
  rmSync(target, { recursive: true, force: true });
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, zip);
  return target;
}
