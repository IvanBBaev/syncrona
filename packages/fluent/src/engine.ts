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
//
// `pack`, `install` and `installStatus` also have a native engine (`./pack`,
// `./install`) that needs no SDK. The `engine` option picks it: `sdk` and
// `native` force one, and `auto` (the default) uses the SDK when it loads and
// falls back to the native engine, with one notice, when it is not installed.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { SN } from "@syncrona/types";
import { InstallFetch, nativeInstall, nativeInstallStatus } from "./install";
import { FluentNativeError, nativePack } from "./pack";

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
  Project: new (options: { fileSystem: unknown; rootDir: string; logger?: unknown }) => unknown;
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

// --- TLS dispatcher --------------------------------------------------------------
//
// The SDK calls the global `fetch` without a dispatcher, and the UI-session
// login does too, so a mutual-TLS client certificate can only reach them
// through the global dispatcher. Node's bundled undici reads it from this
// symbol on every request. Each engine call that may talk to the instance
// installs a dispatcher carrying the TLS settings for its own duration and
// restores the previous one afterwards, so nothing outside the call sees it.

/** Where Node's bundled undici keeps the dispatcher its global `fetch` uses. */
export const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

/** The slice of an undici dispatcher the engine handles. */
export interface FluentDispatcher {
  close?(): Promise<unknown>;
}

export type FluentDispatcherFactory = (tls: SN.FluentTlsOptions) => FluentDispatcher;

export class FluentTlsUnavailableError extends Error {
  readonly code = "FLUENT_TLS_UNAVAILABLE";
  constructor(found: string) {
    super(
      `Cannot attach the TLS settings to the ServiceNow SDK's requests: Node's default fetch dispatcher is ${found}, not an undici Agent.`,
    );
    this.name = "FluentTlsUnavailableError";
  }
}

/**
 * An undici `Agent` that carries `tls` on every connection. Node does not
 * export its bundled undici, and this package adds no undici dependency, so the
 * `Agent` class is taken from the default dispatcher Node installs when it
 * loads undici; touching a fetch global (`Response`) loads it. `host` is a
 * parameter only so tests can stand in for the global object.
 */
export function createTlsDispatcher(tls: SN.FluentTlsOptions, host: object = globalThis): FluentDispatcher {
  void (host as { Response?: unknown }).Response;
  const current = (host as Record<symbol, unknown>)[GLOBAL_DISPATCHER];
  const Agent = (current as { constructor?: unknown } | undefined)?.constructor;
  if (typeof Agent !== "function" || Agent.name !== "Agent") {
    throw new FluentTlsUnavailableError(typeof Agent === "function" ? `a ${Agent.name}` : "missing");
  }
  const { cert, key, passphrase, ca, rejectUnauthorized } = tls;
  return new (Agent as new (options: unknown) => FluentDispatcher)({
    connect: { cert, key, passphrase, ca, rejectUnauthorized },
  });
}

// --- Engine --------------------------------------------------------------------

export interface FluentEngineDeps {
  loadSdk?: SdkLoader;
  loadDocs?: SdkDocsLoader;
  fileSystem?: unknown;
  /** Builds the dispatcher an engine call installs when `tls` is set. */
  createDispatcher?: FluentDispatcherFactory;
  /** The native engine's `fetch` and poll wait; injectable so tests make no network calls. */
  fetch?: InstallFetch;
  sleep?: (ms: number) => Promise<void>;
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

// Matches CSI colour/cursor sequences such as `\u001b[31m`.
const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;

function loggedText(data: readonly unknown[]): string {
  return data
    .map((d) => (d instanceof Error ? d.message : typeof d === "string" ? d : String(d)))
    .join(" ")
    .replace(ANSI_PATTERN, "");
}

interface SdkLogCapture {
  errors: string[];
  warnings: string[];
  /** The captured calls, to hand back to the console when they are not reported. */
  calls: Array<{ level: "error" | "warn"; data: unknown[] }>;
}

/**
 * The SDK's default project logger is `console`, and its build reports
 * compile errors only there: `Project.getRecords` logs each diagnostic and
 * throws, and `Orchestrator.build` swallows the throw into
 * `{ success: false, diagnostics: [] }`. This logger forwards to `console`
 * (resolved per call, so a caller's console redirect still applies), except
 * that error and warn calls are held in `capture` while it is set, so the
 * build can report them instead of the console showing them twice.
 */
function createSdkLogger(): { logger: unknown; capture?: SdkLogCapture } {
  const state: { logger: unknown; capture?: SdkLogCapture } = { logger: undefined };
  const host = console as unknown as Record<PropertyKey, unknown>;
  state.logger = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "error" || prop === "warn") {
          return (...data: unknown[]) => {
            const capture = state.capture;
            if (!capture) return console[prop](...data);
            (prop === "error" ? capture.errors : capture.warnings).push(loggedText(data));
            capture.calls.push({ level: prop, data });
          };
        }
        const value = host[prop];
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(console) : value;
      },
    },
  );
  return state;
}

function replay(capture: SdkLogCapture): void {
  for (const call of capture.calls) console[call.level](...call.data);
}

/** The message of the error `Project.getRecords` throws after logging each diagnostic. */
const DIAGNOSTIC_SUMMARY = /^Found \d+ diagnostic error\(s\)/;

export function createFluentEngine(options: SN.FluentEngineOptions, deps: FluentEngineDeps = {}): SN.FluentEngine {
  const loadSdk = deps.loadSdk ?? defaultSdkLoader;
  const loadDocs = deps.loadDocs ?? defaultSdkDocsLoader;
  const fileSystem = deps.fileSystem ?? fs;
  const createDispatcher = deps.createDispatcher ?? createTlsDispatcher;
  const { projectDir, instanceUrl, auth, tls, logger } = options;
  const choice = options.engine ?? "auto";
  let sdk: LoadedSdk | undefined;
  let fellBack = false;
  let orchestrator: SdkOrchestrator | undefined;
  let credential: unknown;
  const sdkLogger = createSdkLogger();

  const loaded = (): LoadedSdk => {
    if (choice === "native") {
      throw new FluentNativeError(
        "The native Fluent engine covers pack, install and status only; this action needs @servicenow/sdk.",
        "FLUENT_NATIVE_UNSUPPORTED",
      );
    }
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
      const project = new api.Project({ fileSystem, rootDir: projectDir, logger: sdkLogger.logger });
      const cred = lazyCredential();
      orchestrator = cred === undefined ? new api.Orchestrator(project) : new api.Orchestrator(project, cred);
    }
    return orchestrator;
  };

  /**
   * Runs `call` with a dispatcher carrying `tls` installed as the global one,
   * so the UI-session login and every SDK request inside it present the client
   * certificate; the previous dispatcher is back once `call` settles.
   */
  const withTls = async <T>(call: () => Promise<T>): Promise<T> => {
    if (!tls) return call();
    const host = globalThis as Record<symbol, unknown>;
    const dispatcher = createDispatcher(tls);
    const previous = host[GLOBAL_DISPATCHER];
    host[GLOBAL_DISPATCHER] = dispatcher;
    try {
      return await call();
    } finally {
      host[GLOBAL_DISPATCHER] = previous;
      // Lets idle keep-alive sockets go; nothing waits on it.
      dispatcher.close?.().catch(() => undefined);
    }
  };

  /**
   * Runs `onSdk` or `onNative` as `choice` says; under `auto` a missing SDK
   * selects the native engine, announced once per engine.
   */
  const pick = async <T>(action: string, onSdk: () => Promise<T>, onNative: () => Promise<T>): Promise<T> => {
    if (choice === "native") return onNative();
    if (choice === "auto") {
      try {
        loaded();
      } catch (error) {
        if (!(error instanceof FluentSdkMissingError)) throw error;
        if (!fellBack) {
          fellBack = true;
          logger.info(`@servicenow/sdk is not installed; fluent ${action} runs on syncrona's native engine.`);
        }
        return onNative();
      }
    }
    return onSdk();
  };

  const nativeDeps = (action: string) => {
    if (!auth || !instanceUrl) throw new Error(`fluent ${action} needs an instance and credentials.`);
    return { instanceUrl, auth, logger, fetch: deps.fetch, sleep: deps.sleep };
  };

  return {
    async build(opts) {
      const logged: SdkLogCapture = { errors: [], warnings: [], calls: [] };
      sdkLogger.capture = logged;
      let result: SdkBuildResult;
      try {
        result = await withTls(() => orch().build({ ...opts }));
      } catch (error) {
        replay(logged);
        throw error;
      } finally {
        sdkLogger.capture = undefined;
      }
      const reported = splitDiagnostics(result.diagnostics);
      if (reported.errors.length || reported.warnings.length) {
        // The structured diagnostics are the report; the log goes to the console as before.
        replay(logged);
        return { success: result.success && reported.errors.length === 0, ...reported };
      }
      // The SDK's summary only counts the diagnostics already listed.
      const listed = logged.errors.filter((e) => !DIAGNOSTIC_SUMMARY.test(e));
      const errors = listed.length ? listed : logged.errors;
      const { warnings } = logged;
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
      const result = await withTls(() => orch().transform(request));
      return { changedFiles: (result.changedFiles ?? []).map(filePath), handledPaths: result.handledPaths ?? [] };
    },

    async pack(opts) {
      return pick(
        "pack",
        () => withTls(() => orch().pack(opts.packagePath)),
        async () => nativePack(projectDir, opts.packagePath),
      );
    },

    async install(opts) {
      return pick(
        "install",
        async () => {
          const { skipFlowActivation, ...rest } = opts;
          const request: Record<string, unknown> = { ...rest };
          if (skipFlowActivation) request.skipFlags = { skipFlowActivation: true };
          requireCredential("install");
          const result = await withTls(() => orch().install(request));
          return result ?? {};
        },
        () => {
          const native = nativeDeps("install");
          return withTls(() => nativeInstall(projectDir, opts, native));
        },
      );
    },

    async installStatus() {
      return pick(
        "status",
        () => {
          requireCredential("status");
          return withTls(() => orch().installStatus());
        },
        () => {
          const native = nativeDeps("status");
          return withTls(() => nativeInstallStatus(projectDir, native));
        },
      );
    },

    async types(opts) {
      requireCredential("types");
      await withTls(() => orch().types({ ...opts }));
    },

    async addDependency(opts) {
      requireCredential("dependencies");
      await withTls(() => orch().addDependency(opts));
    },

    async run(opts) {
      await withTls(() => orch().run(opts));
    },
    async explain(opts) {
      return explainDocs(loadDocs(projectDir), opts);
    },

    async moveToApp(opts) {
      requireCredential("move-to-app");
      const result = await withTls(() => orch().moveToApp({ sysIds: [...opts.sysIds] }));
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
      await withTls(() =>
        factory.createProjectFromApp(projectDir, opts.scopeId, connector, {
          sdkVersion: version ?? SUPPORTED_SDK_RANGE,
          ...(opts.packageName ? { packageName: opts.packageName } : {}),
        }),
      );
    },

    async sdkVersion() {
      return choice === "native" ? undefined : loaded().version;
    },
  };
}
