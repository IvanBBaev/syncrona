// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `syncrona fluent <action>` — the Fluent tier (R5, R7).
 *
 * Fluent (`.now.ts`) applications are built, packed and installed by the
 * ServiceNow SDK's orchestrator (`@servicenow/sdk`). syncrona does not
 * re-implement that pipeline; it drives it through the optional
 * `@syncrona/fluent` adapter. This module owns only what belongs at the CLI
 * boundary:
 *
 * 1. **Loading the tier lazily.** Neither `@syncrona/fluent` nor the SDK is a
 *    core dependency. The adapter is resolved from the project first, then from
 *    core's own location, on the first non-dry-run action, never at startup.
 *    Loading the SDK costs over a second, and `syncrona --help` must not pay it.
 *    If either package is missing, the command prints one install hint and exits 1.
 *
 * 2. **Credentials.** Core resolves the active profile and hands the adapter
 *    a `SN.FluentCredentialInput`. A Basic profile becomes a UI-session login
 *    inside the adapter. An OAuth profile becomes a token getter, and the token
 *    is minted here with core's token manager. API-key and mutual-TLS profiles
 *    cannot reach the SDK's session-only endpoints, so they are refused up front
 *    for every action that talks to the instance.
 *
 * 3. **Consent and exit codes.** `install` changes an instance, so it asks
 *    first unless `--ci` is given. `--reinstall` uninstalls first and says so.
 *    Exit codes: 0 success; 2 for build errors and for an install that has not
 *    finished; 1 for a thrown failure.
 *
 * `--dry-run` prints the orchestrator call each action would make and stops.
 * It does not load the adapter, resolve credentials or prompt.
 */
import type { SN, Sync } from "@syncrona/types";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { CLIENT_CERT_ENV } from "@syncrona/sn-transport";
import { logger } from "./Logger.js";
import { setLogLevel, logErrorHint, resolveInstanceProfile } from "./commandHelpers.js";
import { resolveCredentials, buildClientAuth } from "./snClient.js";
import { createTokenManager, type OAuthTokenResponse, type TokenPoster } from "./oauth.js";

export const FLUENT_ACTIONS = [
  "init",
  "build",
  "transform",
  "pack",
  "install",
  "types",
  "dependencies",
  "run",
  "status",
] as const;
export type FluentAction = (typeof FLUENT_ACTIONS)[number];

/** The package core loads, and the SDK it drives; both named in the install hint. */
export const FLUENT_PACKAGE = "@syncrona/fluent";
export const FLUENT_SDK_PACKAGE = "@servicenow/sdk";
export const FLUENT_INSTALL_HINT = `Install ${FLUENT_PACKAGE} and ${FLUENT_SDK_PACKAGE} to use \`fluent\` commands (npm install --save-dev ${FLUENT_PACKAGE} ${FLUENT_SDK_PACKAGE}).`;

/** Endpoints only a UI session (or a bearer token) can reach; named in refusals. */
const SESSION_ONLY_ENDPOINTS =
  "sn_appclient_upload_processor.do, xmlhttp.do and fluent_update_set_export.do";

const NOW_CONFIG = "now.config.json";

export type FluentCmdArgs = Sync.SharedCmdArgs & {
  action?: string;
  project?: string;
  json?: boolean;
  // init
  name?: string;
  scope?: string;
  packageName?: string;
  description?: string;
  template?: string;
  from?: string;
  // build
  frozenKeys?: boolean;
  errorOnConflict?: boolean;
  skipClean?: boolean;
  // pack
  out?: string;
  // install
  reinstall?: boolean;
  store?: boolean;
  sync?: boolean;
  demoData?: boolean;
  skipFlowActivation?: boolean;
  // transform / dependencies
  paths?: string;
  table?: string;
  ids?: string;
  updateSet?: string;
  incremental?: boolean;
  force?: boolean;
  // types
  scripts?: boolean;
  fluent?: boolean;
  // run
  script?: string;
};

/** The resolved credential, in the form the adapter accepts. */
export interface FluentCredential {
  instanceUrl: string;
  input: SN.FluentCredentialInput;
}

/** Every effect the command has on the world, in one injectable object. */
export interface FluentCommandDeps {
  /** Lazily resolves `@syncrona/fluent`; rejects when it is not installed. */
  loadFluent: (cwd: string) => Promise<SN.FluentModule>;
  cwd: string;
  resolveCredential: (profile?: string) => Promise<FluentCredential>;
  confirm: (message: string) => Promise<boolean>;
  exists: (file: string) => Promise<boolean>;
  readFile: (file: string) => Promise<string>;
  write: (line: string) => void;
}

class FluentCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FluentCliError";
  }
}

/** Raised when the adapter or the SDK is absent; mapped to the single install hint. */
export class FluentNotInstalledError extends Error {
  readonly code = "FLUENT_NOT_INSTALLED";
  constructor() {
    super(FLUENT_INSTALL_HINT);
    this.name = "FluentNotInstalledError";
  }
}

function isModuleNotFound(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
}

/**
 * Resolves the Fluent adapter from the project first, then from core itself.
 * `specifier` is a parameter only so tests can point it at a fixture package.
 */
export async function loadFluentModule(cwd: string, specifier: string = FLUENT_PACKAGE): Promise<SN.FluentModule> {
  let mod: { createFluentEngine?: unknown; default?: Partial<SN.FluentModule> };
  try {
    const resolved = createRequire(path.join(cwd, "package.json")).resolve(specifier);
    mod = await import(pathToFileURL(resolved).href);
  } catch (first) {
    if (!isModuleNotFound(first)) throw first;
    try {
      // A variable specifier, so TypeScript does not couple core to the optional package.
      mod = await import(specifier);
    } catch (second) {
      if (isModuleNotFound(second)) throw new FluentNotInstalledError();
      throw second;
    }
  }
  return (typeof mod.createFluentEngine === "function" ? mod : mod.default) as SN.FluentModule;
}

/**
 * Turns the active profile into the adapter's credential input.
 *
 * Mirrors `mirrorCommand`'s OAuth wiring: the token POST happens here, with
 * core's token manager, and the adapter only ever sees a getter. The getter
 * is called each time the SDK re-resolves; the token manager returns its
 * cached token until it expires.
 */
async function nodeResolveCredential(profile?: string): Promise<FluentCredential> {
  const credentials = resolveCredentials(profile);
  if (!credentials.instance) {
    throw new FluentCliError(
      "No ServiceNow instance is configured. Run `syncrona login`, or set SN_INSTANCE in the environment."
    );
  }
  const instanceUrl = `https://${credentials.instance}/`;
  if (process.env[CLIENT_CERT_ENV]) {
    return { instanceUrl, input: { kind: "unsupported", method: "mutual-TLS" } };
  }
  const { oauth, apiKey } = buildClientAuth(credentials);
  if (apiKey) {
    return { instanceUrl, input: { kind: "unsupported", method: "api-key" } };
  }
  if (!oauth) {
    return {
      instanceUrl,
      input: { kind: "basic", username: credentials.user, password: credentials.password },
    };
  }
  const post: TokenPoster = async (tokenPath, body) => {
    const response = await fetch(new URL(tokenPath, instanceUrl), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      throw new FluentCliError(
        `OAuth token request to ${credentials.instance} failed with HTTP ${response.status}. ` +
          `Check the client id/secret and the grant configured for this instance.`
      );
    }
    return (await response.json()) as OAuthTokenResponse;
  };
  const tokens = createTokenManager(
    { username: credentials.user, password: credentials.password },
    oauth,
    post
  );
  return { instanceUrl, input: { kind: "oauth", getToken: () => tokens.getToken() } };
}

async function nodeConfirm(message: string): Promise<boolean> {
  const { default: inquirer } = await import("inquirer");
  const answer = await inquirer.prompt<{ confirmed: boolean }>([
    { type: "confirm", name: "confirmed", message, default: false },
  ]);
  return answer.confirmed;
}

async function nodeExists(file: string): Promise<boolean> {
  try {
    await fsp.stat(file);
    return true;
  } catch {
    return false;
  }
}

const defaultDeps = (): FluentCommandDeps => ({
  loadFluent: (cwd) => loadFluentModule(cwd),
  cwd: process.cwd(),
  resolveCredential: nodeResolveCredential,
  confirm: nodeConfirm,
  exists: nodeExists,
  readFile: (file) => fsp.readFile(file, "utf8"),
  write: (line: string) => process.stdout.write(`${line}\n`),
});

// --- Planning ------------------------------------------------------------------

/** What an action will do: the engine method, its options, and whether it needs the instance. */
export interface FluentPlan {
  method: keyof SN.FluentEngine;
  options: Record<string, unknown>;
  instance: boolean;
}

function csv(value: string | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function required(value: string | undefined, flag: string, action: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new FluentCliError(`fluent ${action} needs ${flag}.`);
  return trimmed;
}

/** Maps CLI flags to one engine call. Pure, so `--dry-run` and tests share it. */
export function planFluentAction(action: FluentAction, args: FluentCmdArgs): FluentPlan {
  switch (action) {
    case "init":
      if (args.from) {
        return {
          method: "createProjectFromApp",
          options: { scopeId: args.from, ...(args.packageName ? { packageName: args.packageName } : {}) },
          instance: true,
        };
      }
      return {
        method: "createProject",
        options: {
          name: required(args.name, "--name (or --from <scope sys_id>)", "init"),
          scope: required(args.scope, "--scope", "init"),
          ...(args.packageName ? { packageName: args.packageName } : {}),
          ...(args.description ? { description: args.description } : {}),
          ...(args.template ? { templateId: args.template } : {}),
        },
        instance: false,
      };
    case "build":
      return {
        method: "build",
        options: {
          ...(args.frozenKeys ? { frozenKeys: true } : {}),
          ...(args.errorOnConflict ? { errorOnConflict: true } : {}),
          ...(args.skipClean ? { skipClean: true } : {}),
        },
        instance: false,
      };
    case "transform": {
      const paths = csv(args.paths);
      if (paths.length > 0) {
        const tables = csv(args.table);
        return {
          method: "transform",
          options: {
            mode: "paths",
            paths,
            ...(tables.length > 0 ? { tables } : {}),
            ...(args.force ? { force: true } : {}),
          },
          instance: false,
        };
      }
      if (args.updateSet) {
        return {
          method: "transform",
          options: { mode: "update-set", updateSetId: args.updateSet },
          instance: true,
        };
      }
      return {
        method: "transform",
        options: { mode: args.incremental ? "incremental" : "complete" },
        instance: true,
      };
    }
    case "pack":
      return { method: "pack", options: args.out ? { packagePath: args.out } : {}, instance: false };
    case "install":
      return {
        method: "install",
        options: {
          ...(args.reinstall ? { clean: true } : {}),
          ...(args.store ? { installAsStoreApp: true } : {}),
          ...(args.sync ? { installAsync: false } : {}),
          ...(args.demoData === false ? { demoData: false } : {}),
          ...(args.skipFlowActivation ? { skipFlowActivation: true } : {}),
        },
        instance: true,
      };
    case "types": {
      const options =
        args.scripts || args.fluent
          ? { downloadScripts: args.scripts === true, downloadFluent: args.fluent === true }
          : {};
      return { method: "types", options, instance: true };
    }
    case "dependencies":
      if (args.table) {
        return {
          method: "addDependency",
          options: {
            table: args.table,
            ids: csv(args.ids),
            scope: required(args.scope, "--scope", "dependencies --table"),
          },
          instance: true,
        };
      }
      return { method: "types", options: {}, instance: true };
    case "run":
      return {
        method: "run",
        options: { script: required(args.script, "--script", "run") },
        instance: false,
      };
    case "status":
      return { method: "installStatus", options: {}, instance: true };
  }
}

// --- Execution -----------------------------------------------------------------

/** Walks up from `start` to the directory holding `now.config.json`. */
async function findProjectDir(deps: FluentCommandDeps, start: string): Promise<string | undefined> {
  let dir = start;
  for (;;) {
    if (await deps.exists(path.join(dir, NOW_CONFIG))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function resolveProjectDir(
  deps: FluentCommandDeps,
  action: FluentAction,
  args: FluentCmdArgs
): Promise<string> {
  const explicit = args.project ? path.resolve(deps.cwd, args.project) : undefined;
  if (action === "init") {
    const dir = explicit ?? deps.cwd;
    if (await deps.exists(path.join(dir, NOW_CONFIG))) {
      throw new FluentCliError(`${dir} already holds a Fluent project (${NOW_CONFIG}); refusing to overwrite it.`);
    }
    return dir;
  }
  if (explicit) {
    if (!(await deps.exists(path.join(explicit, NOW_CONFIG)))) {
      throw new FluentCliError(`No ${NOW_CONFIG} in ${explicit}; it is not a Fluent project.`);
    }
    return explicit;
  }
  const found = await findProjectDir(deps, deps.cwd);
  if (!found) {
    throw new FluentCliError(
      `No ${NOW_CONFIG} found in ${deps.cwd} or any parent. Run \`syncrona fluent init\` first, or pass --project.`
    );
  }
  return found;
}

async function projectScope(deps: FluentCommandDeps, projectDir: string): Promise<string> {
  try {
    const config = JSON.parse(await deps.readFile(path.join(projectDir, NOW_CONFIG))) as { scope?: unknown };
    return typeof config.scope === "string" && config.scope ? config.scope : "(unknown scope)";
  } catch {
    return "(unknown scope)";
  }
}

const fluentLogger: SN.FluentLogger = {
  info: (message) => logger.info(message),
  warn: (message) => logger.warn(message),
  debug: (message) => logger.debug(message),
};

function isSdkMissing(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === "FLUENT_SDK_MISSING";
}

async function execute(
  deps: FluentCommandDeps,
  action: FluentAction,
  plan: FluentPlan,
  args: FluentCmdArgs,
  profile: string | undefined
): Promise<number> {
  const projectDir = await resolveProjectDir(deps, action, args);
  const json = args.json === true;

  let credential: FluentCredential | undefined;
  if (plan.instance) {
    credential = await deps.resolveCredential(profile);
    if (credential.input.kind === "unsupported") {
      throw new FluentCliError(
        `fluent ${action} cannot use a ${credential.input.method} profile: the ServiceNow SDK reaches ` +
          `${SESSION_ONLY_ENDPOINTS} with a UI session or a bearer token only. ` +
          `Log in with a Basic or OAuth profile (\`syncrona login --auth-method\`).`
      );
    }
  }

  if (action === "install") {
    const scope = await projectScope(deps, projectDir);
    if (args.reinstall) {
      logger.warn(`--reinstall uninstalls ${scope} from the instance before installing it again.`);
    }
    const ok =
      args.ci === true ||
      (await deps.confirm(`${args.reinstall ? "Reinstall" : "Install"} ${scope} to ${credential?.instanceUrl}?`));
    if (!ok) {
      logger.info("fluent install cancelled.");
      return 0;
    }
  }

  const fluent = await deps.loadFluent(projectDir);
  const engine = fluent.createFluentEngine({
    projectDir,
    logger: fluentLogger,
    ...(credential
      ? {
          instanceUrl: credential.instanceUrl,
          auth: fluent.createFluentAuthResolver(credential.instanceUrl, credential.input),
        }
      : {}),
  });

  const emit = (payload: Record<string, unknown>, human: () => void) => {
    if (json) deps.write(JSON.stringify({ command: `fluent ${action}`, ...payload }, null, 2));
    else human();
  };

  switch (plan.method) {
    case "build": {
      const result = await engine.build(plan.options);
      const exitCode = result.success ? 0 : 2;
      emit({ exitCode, ...result }, () => {
        for (const warning of result.warnings) logger.warn(warning);
        for (const error of result.errors) logger.error(error);
        if (result.success) logger.success("Fluent build complete.");
        else logger.error(`Fluent build failed with ${result.errors.length} error(s).`);
      });
      return exitCode;
    }
    case "transform": {
      const result = await engine.transform(plan.options as unknown as SN.FluentTransformOptions);
      emit({ exitCode: 0, ...result }, () => {
        for (const file of result.changedFiles) logger.info(`  ${file}`);
        logger.success(
          `Transformed ${result.handledPaths.length} source(s); ${result.changedFiles.length} file(s) changed.`
        );
      });
      return 0;
    }
    case "pack": {
      const zip = await engine.pack(plan.options);
      emit({ exitCode: 0, package: zip }, () => logger.success(`Packed ${zip}`));
      return 0;
    }
    case "install": {
      const result = await engine.install(plan.options);
      emit({ exitCode: 0, ...result }, () => {
        if (result.trackerId) logger.info(`Tracker: ${result.trackerId}`);
        if (result.rollbackId) logger.info(`Rollback context: ${result.rollbackId}`);
        logger.success("Fluent install submitted. Check progress with `syncrona fluent status`.");
      });
      return 0;
    }
    case "installStatus": {
      const version = await engine.sdkVersion();
      const status = await engine.installStatus();
      const exitCode = status.finished ? 0 : 2;
      emit({ exitCode, sdkVersion: version ?? null, ...status }, () => {
        logger.info(`@servicenow/sdk ${version ?? "(unknown version)"}`);
        logger.info(
          status.finished
            ? `Last install finished${status.id ? ` (${status.id})` : ""}.`
            : `Install still running${status.id ? ` (${status.id})` : ""}.`
        );
      });
      return exitCode;
    }
    case "types":
      await engine.types(plan.options);
      emit({ exitCode: 0 }, () => logger.success("Fluent types and dependencies updated."));
      return 0;
    case "addDependency": {
      const options = plan.options as { table: string; ids: string[]; scope: string };
      await engine.addDependency(options);
      emit({ exitCode: 0, ...options }, () =>
        logger.success(`Added ${options.ids.length} ${options.table} dependency record(s).`)
      );
      return 0;
    }
    case "run": {
      const options = plan.options as { script: string };
      await engine.run(options);
      emit({ exitCode: 0, script: options.script }, () => logger.success(`Ran ${options.script}.`));
      return 0;
    }
    case "createProject":
      await engine.createProject(plan.options as Parameters<SN.FluentEngine["createProject"]>[0]);
      emit({ exitCode: 0, projectDir }, () => logger.success(`Fluent project created in ${projectDir}.`));
      return 0;
    default:
      await engine.createProjectFromApp(plan.options as { scopeId: string; packageName?: string });
      emit({ exitCode: 0, projectDir }, () =>
        logger.success(`Fluent project created in ${projectDir} from the instance application.`)
      );
      return 0;
  }
}

/**
 * `syncrona fluent <action>`. Sets `process.exitCode` rather than calling
 * `process.exit()`, so buffered stdout is flushed before the process ends.
 */
export async function fluentCommand(
  args: FluentCmdArgs,
  overrides: Partial<FluentCommandDeps> = {}
): Promise<void> {
  setLogLevel(args);
  const deps: FluentCommandDeps = { ...defaultDeps(), ...overrides };
  const profile = resolveInstanceProfile(args);
  const action = String(args.action ?? "").trim() as FluentAction;

  if (!(FLUENT_ACTIONS as readonly string[]).includes(action)) {
    logger.error(
      `Unknown fluent action "${args.action ?? ""}". Expected one of: ${FLUENT_ACTIONS.join(" | ")}.`
    );
    process.exitCode = 1;
    return;
  }

  try {
    const plan = planFluentAction(action, args);
    if (args.dryRun === true) {
      deps.write(
        `[dry-run] fluent ${action} → engine.${String(plan.method)}(${JSON.stringify(plan.options)})` +
          (plan.instance ? " against the active instance" : " (local only)")
      );
      process.exitCode = 0;
      return;
    }
    process.exitCode = await execute(deps, action, plan, args, profile);
  } catch (e) {
    if (e instanceof FluentNotInstalledError || isSdkMissing(e)) {
      logger.error(FLUENT_INSTALL_HINT);
      process.exitCode = 1;
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    logger.error(message || "Fluent command failed with an unknown error.");
    logErrorHint(e);
    process.exitCode = 1;
  }
}
