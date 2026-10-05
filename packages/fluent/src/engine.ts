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
  transform(options: Record<string, unknown>): Promise<{ changedFiles?: string[]; handledPaths?: string[] }>;
  install(options?: Record<string, unknown>): Promise<{ trackerId?: string; rollbackId?: string } | void>;
  installStatus(): Promise<{ finished: boolean; id?: string }>;
  types(options?: Record<string, unknown>): Promise<unknown>;
  addDependency(options: { table: string; ids: string[]; scope: string }): Promise<unknown>;
  run(options: { script: string; args?: Record<string, unknown> }): Promise<unknown>;
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

export class FluentSdkMissingError extends Error {
  readonly code = "FLUENT_SDK_MISSING";
  constructor(message = "The ServiceNow SDK (@servicenow/sdk) is not installed. Install it to use `syncrona fluent`.") {
    super(message);
    this.name = "FluentSdkMissingError";
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

/** Walk up from a resolved file to the `package.json` named `name`. */
export function findPackageVersion(fromFile: string, name: string): string | undefined {
  let dir = path.dirname(fromFile);
  for (;;) {
    const candidate = path.join(dir, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (pkg.name === name) return pkg.version;
    } catch {
      // not here, or unreadable — keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolve `@servicenow/sdk/api` from the project, then from this package, and
 * load it with telemetry off. `LazyCredential` is resolved relative to the API
 * file so it always comes from the SDK's own `@servicenow/sdk-api`.
 */
export const defaultSdkLoader: SdkLoader = (projectDir) => {
  const apiPath =
    tryResolve(path.join(projectDir, "package.json"), "@servicenow/sdk/api") ??
    tryResolve(__filename, "@servicenow/sdk/api");
  if (!apiPath) throw new FluentSdkMissingError();
  process.env.NO_TELEMETRY = "1";
  const req = createRequire(apiPath);
  const api = req(apiPath) as SdkApi;
  const { LazyCredential } = req("@servicenow/sdk-api/credentials") as Pick<LoadedSdk, "LazyCredential">;
  return { api, LazyCredential, version: findPackageVersion(apiPath, "@servicenow/sdk") };
};

// --- Engine --------------------------------------------------------------------

export interface FluentEngineDeps {
  loadSdk?: SdkLoader;
  fileSystem?: unknown;
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
  const fileSystem = deps.fileSystem ?? fs;
  const { projectDir, instanceUrl, auth, logger } = options;
  let sdk: LoadedSdk | undefined;
  let orchestrator: SdkOrchestrator | undefined;
  let credential: unknown;

  const loaded = (): LoadedSdk => {
    if (!sdk) {
      sdk = loadSdk(projectDir);
      logger.debug(`fluent: loaded @servicenow/sdk ${sdk.version ?? "(unknown version)"}`);
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
      return { changedFiles: result.changedFiles ?? [], handledPaths: result.handledPaths ?? [] };
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

    async createProject(opts) {
      const { api } = loaded();
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
        projectVersion: opts.projectVersion,
      });
    },

    async createProjectFromApp(opts) {
      const { api } = loaded();
      const connector = new api.Connector(requireCredential("init --from"));
      const factory = new api.ProjectFactory(fileSystem);
      await factory.createProjectFromApp(
        projectDir,
        opts.scopeId,
        connector,
        opts.packageName ? { packageName: opts.packageName } : {},
      );
    },

    async sdkVersion() {
      return loaded().version;
    },
  };
}
