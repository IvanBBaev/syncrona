// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Fluent engine: the adapter between the core CLI's port
// (`SN.FluentEngine`) and the ServiceNow SDK's orchestrator.
//
// `@servicenow/sdk` is an optional peer dependency. It is never imported at
// module scope — `require("@servicenow/sdk/api")` costs over a second — but
// loaded on the first engine call through an injectable loader. The loader
// resolves the SDK from the Fluent project first (so the project's pinned SDK
// wins), then from this package's own location.
//
// Only the narrow structural slice of the SDK used here is typed below; the
// SDK's own declarations are not imported, so this package compiles without it.
//
// `explain` is the exception to the orchestrator path: it searches the
// Markdown docs the SDK ships in its package root through the lean
// `@servicenow/sdk-api/docs` module, with its own loader, so it neither loads
// the full API nor needs an instance.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { SN } from "@syncrona/types";

// --- The SDK slice this adapter drives -------------------------------------

interface SdkDiagnostic {
  message?: string;
  level?: number;
  getFormattedText?(colors?: boolean): string;
}

type SdkBuildResult =
  | { success: true; diagnostics?: SdkDiagnostic[] }
  | { success: false; diagnostics?: SdkDiagnostic[] };

export interface SdkOrchestrator {
  build(options?: Record<string, unknown>): Promise<SdkBuildResult>;
  pack(packagePath?: string, options?: Record<string, unknown>): Promise<string>;
  transform(options: Record<string, unknown>): Promise<SdkTransformResult>;
  install(options?: Record<string, unknown>): Promise<{ trackerId?: string; rollbackId?: string } | void>;
  installStatus(): Promise<{ finished: boolean; id?: string }>;
  types(options?: Record<string, unknown>): Promise<unknown>;
  addDependency(options: { table: string; ids: string[]; scope: string }): Promise<unknown>;
  run(options: { script: string; args?: Record<string, unknown> }): Promise<unknown>;
  /** Resolves `undefined` when the instance claimed none of the records. */
  moveToApp(options: { sysIds: string[] }): Promise<SdkTransformResult | undefined>;
}

/** The SDK reports changed files as `ProjectFile` objects; older builds used plain paths. */
type SdkProjectFile = string | { getPath(): string };

interface SdkTransformResult {
  changedFiles?: SdkProjectFile[];
  handledPaths?: string[];
}

function filePath(file: SdkProjectFile): string {
  return typeof file === "string" ? file : file.getPath();
}

export interface SdkApi {
  Project: new (options: { fileSystem: unknown; rootDir: string }) => unknown;
  Orchestrator: new (project: unknown, credential?: unknown) => SdkOrchestrator;
  ProjectFactory: (new (fileSystem: unknown) => {
    createProject(dir: string, options: Record<string, unknown>): Promise<unknown>;
    createProjectFromApp(dir: string, scopeId: string, connector: unknown, options?: Record<string, unknown>): Promise<unknown>;
  }) & { createNpmPackageName?(name: string): string };
  Connector: new (credential: unknown) => unknown;
}

export interface LoadedSdk {
  api: SdkApi;
  /** `new LazyCredential(url, resolver)` from `@servicenow/sdk-api/credentials`. */
  LazyCredential: new (url: URL, resolver: () => Promise<SN.FluentResolvedAuth>) => unknown;
  version?: string;
}

export type SdkLoader = (projectDir: string) => LoadedSdk;

/** One entry of the SDK's docs index (`DocFile` in `@servicenow/sdk-api/docs`). */
export interface SdkDocFile {
  name: string;
  tags: string[];
  summary: string;
  filePath: string;
}

/** The filesystem slice the SDK's docs scanner reads through. */
export interface SdkDocsFs {
  readdirSync(path: string): string[];
  statSync(path: string): { isDirectory(): boolean };
  readFileSync(path: string, encoding: "utf-8"): string;
}

/** The lean `@servicenow/sdk-api/docs` module. */
export interface SdkDocsApi {
  scanDocs(docsDir: string, fs: SdkDocsFs): SdkDocFile[];
  parseFrontmatter(content: string): { tags: string[]; body: string };
  findDocs(topics: SdkDocFile[], term: string): SdkDocFile[];
  filterDocs(topics: SdkDocFile[], term: string): SdkDocFile[];
}

export interface LoadedSdkDocs {
  docs: SdkDocsApi;
  /** The SDK's bundled `docs` directory. */
  docsDir: string;
  fs: SdkDocsFs;
}

export type SdkDocsLoader = (projectDir: string) => LoadedSdkDocs;

export class FluentSdkMissingError extends Error {
  readonly code = "FLUENT_SDK_MISSING";
  constructor(message = "The ServiceNow SDK (@servicenow/sdk) is not installed. Install it to use `syncrona fluent`.") {
    super(message);
    this.name = "FluentSdkMissingError";
  }
}

/** The SDK resolves but does not ship what `explain` reads (older than 4.13). */
export class FluentDocsUnavailableError extends Error {
  readonly code = "FLUENT_DOCS_UNAVAILABLE";
  constructor(
    message = "This @servicenow/sdk does not bundle its documentation; `fluent explain` needs an SDK that ships a docs directory and @servicenow/sdk-api/docs (4.13 or newer).",
  ) {
    super(message);
    this.name = "FluentDocsUnavailableError";
  }
}

// --- Default loader ----------------------------------------------------------

function tryResolve(fromFile: string, request: string): string | undefined {
  try {
    return createRequire(fromFile).resolve(request);
  } catch {
    return undefined;
  }
}

/** Walk up from a resolved file to the directory whose `package.json` is named `name`. */
function findPackage(fromFile: string, name: string): { dir: string; version?: string } | undefined {
  let dir = path.dirname(fromFile);
  for (;;) {
    const candidate = path.join(dir, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (pkg.name === name) return { dir, version: pkg.version };
    } catch {
      // not here, or unreadable — keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Walk up from a resolved file to the `package.json` named `name`. */
export function findPackageVersion(fromFile: string, name: string): string | undefined {
  return findPackage(fromFile, name)?.version;
}

/** Resolve `@servicenow/sdk/api` from the project, then from this package. */
function resolveSdkApi(projectDir: string): string {
  const apiPath =
    tryResolve(path.join(projectDir, "package.json"), "@servicenow/sdk/api") ??
    tryResolve(__filename, "@servicenow/sdk/api");
  if (!apiPath) throw new FluentSdkMissingError();
  return apiPath;
}

const SDK_API_PACKAGE = "@servicenow/sdk-api";
const CREDENTIALS_SPECIFIER = `${SDK_API_PACKAGE}/credentials`;

/**
 * Whether `e` says the credentials module itself cannot be found, rather than
 * some module it requires (whose error names that other module).
 *
 * Node names the module two ways. With `@servicenow/sdk-api` absent it quotes
 * the specifier. With the package present but the file its `./credentials`
 * export maps to absent, it quotes that file's absolute path, and with no
 * `requireStack`, since no module required it. A file inside the package that
 * the credentials module itself requires carries a non-empty `requireStack`,
 * and a file in the package's own `node_modules` belongs to a dependency, so
 * both surface as the real error.
 */
function isCredentialsModuleMissing(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown; requireStack?: unknown } | null;
  if (err?.code !== "MODULE_NOT_FOUND" || typeof err.message !== "string") return false;
  if (err.message.includes(`'${CREDENTIALS_SPECIFIER}'`)) return true;
  if ((err.requireStack as readonly unknown[] | undefined)?.length) return false;
  const named = /^Cannot find module '([^']+)'/.exec(err.message)?.[1];
  if (!named || !path.isAbsolute(named)) return false;
  const pkg = findPackage(named, SDK_API_PACKAGE);
  return pkg !== undefined && !path.relative(pkg.dir, named).split(path.sep).includes("node_modules");
}

/**
 * Resolve `@servicenow/sdk/api` from the project, then from this package, and
 * load it with telemetry off. `LazyCredential` is resolved relative to the API
 * file so it always comes from the SDK's own `@servicenow/sdk-api`.
 */
export const defaultSdkLoader: SdkLoader = (projectDir) => {
  const apiPath = resolveSdkApi(projectDir);
  process.env.NO_TELEMETRY = "1";
  const req = createRequire(apiPath);
  const api = req(apiPath) as SdkApi;
  let LazyCredential: LoadedSdk["LazyCredential"];
  try {
    ({ LazyCredential } = req(CREDENTIALS_SPECIFIER) as Pick<LoadedSdk, "LazyCredential">);
  } catch (e) {
    // An SDK whose own @servicenow/sdk-api is missing, or ships without the file
    // its credentials export maps to, is as unusable as no SDK at all; say so with the install hint, not a raw resolver error. Any other
    // not-found module (a missing transitive dependency of the credentials
    // module) is a broken install with its own cause, so it surfaces as is.
    if (!isCredentialsModuleMissing(e)) throw e;
    throw new FluentSdkMissingError(
      "The ServiceNow SDK (@servicenow/sdk) is incomplete: @servicenow/sdk-api/credentials cannot be loaded. " +
        "Reinstall @servicenow/sdk to use `syncrona fluent`.",
    );
  }
  return { api, LazyCredential, version: findPackageVersion(apiPath, "@servicenow/sdk") };
};

/** The SDK range this adapter is built and tested against (the peer dependency). */
export const SUPPORTED_SDK_RANGE = "~4.13";

/** The `version` a new project's package.json gets when the caller names none. */
export const DEFAULT_PROJECT_VERSION = "0.0.1";

/** Whether `version` falls inside {@link SUPPORTED_SDK_RANGE} (4.13.x). */
export function isSupportedSdkVersion(version: string): boolean {
  return /^4\.13\.\d+(?:[-+].*)?$/.test(version.trim());
}

/** Our Node adapter for the docs scanner's filesystem slice. */
const nodeDocsFs: SdkDocsFs = {
  readdirSync: (p) => fs.readdirSync(p),
  statSync: (p) => fs.statSync(p),
  readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
};

/**
 * Locate the docs the same SDK `defaultSdkLoader` would load ships with —
 * `<package root>/docs` — and the lean docs module next to it. Resolving the
 * API path does not evaluate it, so this stays cheap.
 */
export const defaultSdkDocsLoader: SdkDocsLoader = (projectDir) => {
  const apiPath = resolveSdkApi(projectDir);
  const root = findPackage(apiPath, "@servicenow/sdk");
  const docsDir = root ? path.join(root.dir, "docs") : undefined;
  if (!docsDir || !fs.existsSync(docsDir)) throw new FluentDocsUnavailableError();
  let docs: SdkDocsApi;
  try {
    docs = createRequire(apiPath)("@servicenow/sdk-api/docs") as SdkDocsApi;
  } catch {
    throw new FluentDocsUnavailableError();
  }
  return { docs, docsDir, fs: nodeDocsFs };
};

// --- Engine --------------------------------------------------------------------

export interface FluentEngineDeps {
  loadSdk?: SdkLoader;
  loadDocs?: SdkDocsLoader;
  fileSystem?: unknown;
}

function docTopic(doc: SdkDocFile): SN.FluentDocTopic {
  return { name: doc.name, tags: [...doc.tags], summary: doc.summary };
}

/**
 * Classify a docs search the way `now-sdk explain` decides what to print, so
 * the CLI renders the same outcomes: the index, one topic's body, several
 * precise matches, substring suggestions, or nothing.
 */
export function explainDocs(
  loadedDocs: LoadedSdkDocs,
  opts: { topic?: string; list?: boolean; peek?: boolean },
): SN.FluentExplainResult {
  const { docs, docsDir, fs: docsFs } = loadedDocs;
  const all = docs.scanDocs(docsDir, docsFs);
  const topic = opts.topic?.trim() || undefined;
  if (opts.list || !topic) {
    if (!topic) return { kind: "list", topics: all.map(docTopic), related: [] };
    const strong = docs.findDocs(all, topic);
    const related = docs.filterDocs(all, topic).filter((d) => !strong.includes(d));
    return { kind: "list", filter: topic, topics: strong.map(docTopic), related: related.map(docTopic) };
  }
  const matches = docs.findDocs(all, topic);
  if (matches.length === 0) {
    const suggestions = docs.filterDocs(all, topic);
    return suggestions.length > 0 ? { kind: "suggestions", topics: suggestions.map(docTopic) } : { kind: "none", topics: [] };
  }
  if (matches.length > 1 || opts.peek) return { kind: "matches", topics: matches.map(docTopic) };
  const [match] = matches;
  const { body } = docs.parseFrontmatter(docsFs.readFileSync(match.filePath, "utf-8"));
  return { kind: "topic", topic: docTopic(match), body };
}

function diagnosticText(d: SdkDiagnostic): string {
  if (typeof d.getFormattedText === "function") return d.getFormattedText(false);
  return d.message ?? String(d);
}

/** SDK diagnostic levels: Error = 1, Warn = 2, Info = 3, Hint = 4. */
export function splitDiagnostics(diagnostics: readonly SdkDiagnostic[] = []): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const d of diagnostics) {
    if (d.level === 1) errors.push(diagnosticText(d));
    else if (d.level === 2) warnings.push(diagnosticText(d));
  }
  return { errors, warnings };
}

export function createFluentEngine(options: SN.FluentEngineOptions, deps: FluentEngineDeps = {}): SN.FluentEngine {
  const loadSdk = deps.loadSdk ?? defaultSdkLoader;
  const loadDocs = deps.loadDocs ?? defaultSdkDocsLoader;
  const fileSystem = deps.fileSystem ?? fs;
  const { projectDir, instanceUrl, auth, logger } = options;
  let sdk: LoadedSdk | undefined;
  let orchestrator: SdkOrchestrator | undefined;
  let credential: unknown;

  const loaded = (): LoadedSdk => {
    if (!sdk) {
      sdk = loadSdk(projectDir);
      logger.debug(`fluent: loaded @servicenow/sdk ${sdk.version ?? "(unknown version)"}`);
      if (sdk.version && !isSupportedSdkVersion(sdk.version)) {
        logger.warn(
          `@servicenow/sdk ${sdk.version} is outside the supported range ${SUPPORTED_SDK_RANGE}; ` +
            "`syncrona fluent` may not drive it correctly.",
        );
      }
    }
    return sdk;
  };

  const lazyCredential = (): unknown => {
    if (credential === undefined && auth && instanceUrl) {
      credential = new (loaded().LazyCredential)(new URL(instanceUrl), auth);
    }
    return credential;
  };

  const requireCredential = (action: string): unknown => {
    const cred = lazyCredential();
    if (cred === undefined) throw new Error(`fluent ${action} needs an instance and credentials.`);
    return cred;
  };

  const orch = (): SdkOrchestrator => {
    if (!orchestrator) {
      const { api } = loaded();
      const project = new api.Project({ fileSystem, rootDir: projectDir });
      const cred = lazyCredential();
      orchestrator = cred === undefined ? new api.Orchestrator(project) : new api.Orchestrator(project, cred);
    }
    return orchestrator;
  };

  return {
    async build(opts) {
      const result = await orch().build({ ...opts });
      const { errors, warnings } = splitDiagnostics(result.diagnostics);
      return { success: result.success && errors.length === 0, errors, warnings };
    },

    async transform(opts) {
      let request: Record<string, unknown>;
      switch (opts.mode) {
        case "paths":
          request = opts.tables?.length
            ? { tables: opts.tables, paths: opts.paths, force: opts.force ?? false }
            : { paths: opts.paths };
          break;
        case "update-set":
          request = { method: "update-set", updateSetId: opts.updateSetId };
          break;
        case "incremental":
          request = { method: "incremental" };
          break;
        default:
          request = { method: "complete" };
      }
      const result = await orch().transform(request);
      return { changedFiles: (result.changedFiles ?? []).map(filePath), handledPaths: result.handledPaths ?? [] };
    },

    async pack(opts) {
      return orch().pack(opts.packagePath);
    },

    async install(opts) {
      const { skipFlowActivation, ...rest } = opts;
      const request: Record<string, unknown> = { ...rest };
      if (skipFlowActivation) request.skipFlags = { skipFlowActivation: true };
      requireCredential("install");
      const result = await orch().install(request);
      return result ?? {};
    },

    async installStatus() {
      requireCredential("status");
      return orch().installStatus();
    },

    async types(opts) {
      requireCredential("types");
      await orch().types({ ...opts });
    },

    async addDependency(opts) {
      requireCredential("dependencies");
      await orch().addDependency(opts);
    },

    async run(opts) {
      await orch().run(opts);
    },
    async explain(opts) {
      return explainDocs(loadDocs(projectDir), opts);
    },

    async moveToApp(opts) {
      requireCredential("move-to-app");
      const result = await orch().moveToApp({ sysIds: [...opts.sysIds] });
      if (!result) return { moved: false, changedFiles: [], handledPaths: [] };
      return {
        moved: true,
        changedFiles: (result.changedFiles ?? []).map(filePath),
        handledPaths: result.handledPaths ?? [],
      };
    },


    async createProject(opts) {
      const { api, version } = loaded();
      const factory = new api.ProjectFactory(fileSystem);
      const packageName =
        opts.packageName ?? api.ProjectFactory.createNpmPackageName?.(opts.name) ?? opts.scope.toLowerCase();
      await factory.createProject(projectDir, {
        name: opts.name,
        scope: opts.scope,
        scopeId: opts.scopeId,
        packageName,
        description: opts.description ?? "",
        templateId: opts.templateId,
        // The SDK renders both straight into package.json; left undefined they
        // become an empty "version" and an empty "@servicenow/sdk" range.
        projectVersion: opts.projectVersion ?? DEFAULT_PROJECT_VERSION,
        sdkVersion: version ?? SUPPORTED_SDK_RANGE,
      });
    },

    async createProjectFromApp(opts) {
      const { api, version } = loaded();
      const connector = new api.Connector(requireCredential("init --from"));
      const factory = new api.ProjectFactory(fileSystem);
      // The SDK takes the project version from the app's sys_app record, but
      // defaults the "@servicenow/sdk" range to "latest" — pin it as init does.
      await factory.createProjectFromApp(projectDir, opts.scopeId, connector, {
        sdkVersion: version ?? SUPPORTED_SDK_RANGE,
        ...(opts.packageName ? { packageName: opts.packageName } : {}),
      });
    },

    async sdkVersion() {
      return loaded().version;
    },
  };
}
