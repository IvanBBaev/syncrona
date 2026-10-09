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
 * 3. **Consent and exit codes.** `install` and `move-to-app` change an
 *    instance, so they ask first unless `--ci` is given; without a terminal to
 *    ask in, or with `--json` (whose stdout a prompt would corrupt), they refuse
 *    and ask for `--ci`. The adapter and the SDK are loaded before the prompt,
 *    so a missing package fails before the user is asked. `--reinstall`
 *    uninstalls first and says so. Exit codes: 0 success (an `install` exits 0
 *    once the SDK has submitted it); 2 for build errors, for a `status` whose
 *    install has not finished and for a `move-to-app` the instance claimed
 *    nothing for; 1 for a thrown failure and for an `explain` topic that
 *    matches nothing.
 *
 * `fluent run` runs a project script locally, without an instance credential.
 *
 * 4. **Native types.** `fluent types --native` does not use the SDK at all: it
 *    reads `sys_db_object`, `sys_dictionary` and `sys_choice` over the Table API
 *    with core's own client (so every auth method works, API key and mutual TLS
 *    included) and writes one `.d.ts` (see `fluentNativeTypes.ts`). A plain
 *    `fluent types` still prefers the SDK; when the adapter or the SDK is not
 *    installed it falls back to the native generator instead of failing, unless
 *    `--scripts`/`--fluent` asked for definitions only the SDK can download.
 *
 * 5. **`explain`** searches the Markdown docs the SDK ships, offline. It needs
 *    no instance and no Fluent project: the SDK is resolved from the nearest
 *    project when there is one, otherwise from the current directory.
 *
 * `--dry-run` prints the orchestrator call each action would make and stops.
 * It never resolves credentials, reaches the instance or prompts, and it fails
 * wherever the real run's local checks would. Every action but
 * `types --native` loads the adapter and asks it for the SDK version, the same
 * resolution the real run makes: a missing adapter or SDK fails the preview with
 * the install hint, as it fails the run, and a plain `fluent types` reports the
 * native fallback when the real run would take it.
 *
 * `install` and `move-to-app` read the `scope` from `now.config.json`; a file
 * that cannot be parsed, or that sets no scope, is refused with an error naming
 * it, in the real run and `--dry-run` alike.
 */
import type { SN, Sync } from "@syncrona/types";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { CLIENT_CERT_ENV, SYS_ID_RE } from "@syncrona/sn-transport";
import { logger } from "./Logger.js";
import { setLogLevel, logErrorHint, resolveInstanceProfile } from "./commandHelpers.js";
import { resolveCredentials, buildClientAuth, defaultClient } from "./snClient.js";
import type { NativeTypesClient, NativeTypesOptions, NativeTypesResult } from "./fluentNativeTypes.js";
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
  "explain",
  "move-to-app",
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

/** Where `fluent types --native` writes, relative to the project, when `--out` is not given. */
export const NATIVE_TYPES_DEFAULT_OUT = path.join("@types", "syncrona", "tables.d.ts");

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
  // pack, types --native
  out?: string;
  // install
  reinstall?: boolean;
  store?: boolean;
  sync?: boolean;
  demoData?: boolean;
  skipFlowActivation?: boolean;
  // transform / dependencies / move-to-app
  paths?: string;
  table?: string;
  ids?: string;
  updateSet?: string;
  incremental?: boolean;
  force?: boolean;
  // types
  scripts?: boolean;
  fluent?: boolean;
  native?: boolean;
  // run
  script?: string;
  // explain
  topic?: string;
  list?: boolean;
  peek?: boolean;
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
  /** Whether a confirmation prompt can be answered (stdin is a terminal). */
  interactive: () => boolean;
  /** Table API client for `types --native`; resolves the profile's credentials. */
  getClient: (profile?: string) => NativeTypesClient;
  /** Native type generator; loaded on demand so startup does not pay for it. */
  generateTypes: (client: NativeTypesClient, options: NativeTypesOptions) => Promise<NativeTypesResult>;
  /** Writes a whole file, creating its directory. */
  writeFile: (file: string, content: string) => Promise<void>;
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

/**
 * Whether `e` says `specifier` itself cannot be found. A module-not-found
 * error for one of the adapter's own dependencies names that dependency
 * instead (the adapter appears only in the unquoted require stack), and must
 * surface as itself rather than as "not installed".
 */
function isModuleNotFound(e: unknown, specifier: string): boolean {
  const err = e as { code?: unknown; message?: unknown } | null;
  const code = err?.code;
  if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") return false;
  return typeof err?.message === "string" && err.message.includes(`'${specifier}'`);
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
    if (!isModuleNotFound(first, specifier)) throw first;
    try {
      // A variable specifier, so TypeScript does not couple core to the optional package.
      mod = await import(specifier);
    } catch (second) {
      if (isModuleNotFound(second, specifier)) throw new FluentNotInstalledError();
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
  interactive: () => process.stdin.isTTY === true,
  getClient: (profile) => defaultClient(profile),
  generateTypes: async (client, options) => (await import("./fluentNativeTypes.js")).generateNativeTypes(client, options),
  writeFile: async (file, content) => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content, "utf8");
  },
});

// --- Planning ------------------------------------------------------------------

/** What an action will do: the engine method, its options, and whether it needs the instance. */
export interface FluentPlan {
  /** An engine method, or `nativeTypes` for the SDK-free generator. */
  method: keyof SN.FluentEngine | "nativeTypes";
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

function nativeTypesOptions(args: FluentCmdArgs): Record<string, unknown> {
  const tables = csv(args.table);
  return {
    ...(args.scope ? { scope: args.scope } : {}),
    ...(tables.length > 0 ? { tables } : {}),
    ...(args.out ? { out: args.out } : {}),
  };
}

/** Maps CLI flags to one engine call. Pure, so `--dry-run` and tests share it. */
export function planFluentAction(action: FluentAction, args: FluentCmdArgs): FluentPlan {
  // The `[topic]` positional exists for `explain` only. Accepted and ignored on
  // any other action, `fluent install prod --ci` would install while the caller
  // believed they had named a target.
  const strayTopic = String(args.topic ?? "").trim();
  if (action !== "explain" && strayTopic) {
    throw new FluentCliError(
      `fluent ${action} takes no positional argument (got "${strayTopic}"); only \`fluent explain <topic>\` does.`
    );
  }
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
      if (args.native) {
        if (args.scripts || args.fluent) {
          throw new FluentCliError(
            "fluent types --native cannot combine with --scripts or --fluent: those definitions come from the SDK only."
          );
        }
        return { method: "nativeTypes", options: nativeTypesOptions(args), instance: true };
      }
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
    case "explain":
      return {
        method: "explain",
        options: {
          ...(args.topic?.trim() ? { topic: args.topic.trim() } : {}),
          ...(args.list ? { list: true } : {}),
          ...(args.peek ? { peek: true } : {}),
        },
        instance: false,
      };
    case "move-to-app": {
      // Each id becomes a sys_claim record on the instance, so a typo or a
      // repeat is refused or folded here rather than claimed.
      const sysIds = [...new Set(csv(args.ids).map((id) => id.toLowerCase()))];
      if (sysIds.length === 0) throw new FluentCliError("fluent move-to-app needs --ids <sys_id,...>.");
      const invalid = sysIds.filter((id) => !SYS_ID_RE.test(id));
      if (invalid.length > 0) {
        throw new FluentCliError(
          `fluent move-to-app --ids takes 32-character hexadecimal sys_ids; not one: ${invalid.join(", ")}.`
        );
      }
      return { method: "moveToApp", options: { sysIds }, instance: true };
    }
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
  if (action === "explain") {
    // Only the SDK's location matters; any directory that resolves it will do.
    return explicit ?? (await findProjectDir(deps, deps.cwd)) ?? deps.cwd;
  }
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

/**
 * The `scope` the project's `now.config.json` sets, or `undefined` when it sets
 * none (no key, an empty or non-string value, or a document that is not an
 * object). A file that cannot be read or parsed is an error naming it: the real
 * run and `--dry-run` must not go on as if the project had no scope.
 */
async function configuredScope(deps: FluentCommandDeps, projectDir: string): Promise<string | undefined> {
  const file = path.join(projectDir, NOW_CONFIG);
  let text: string;
  try {
    text = await deps.readFile(file);
  } catch (e) {
    throw new FluentCliError(`Cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch (e) {
    throw new FluentCliError(`${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) return undefined;
  const scope = (config as { scope?: unknown }).scope;
  return typeof scope === "string" && scope ? scope : undefined;
}

/**
 * The scope an action that names the application on the instance needs
 * (`install`, `move-to-app`). A project that sets none is refused, as
 * `types --native` refuses one without `--scope` or `--table`.
 */
async function requiredScope(deps: FluentCommandDeps, projectDir: string, action: FluentAction): Promise<string> {
  const scope = await configuredScope(deps, projectDir);
  if (scope === undefined) {
    throw new FluentCliError(
      `${path.join(projectDir, NOW_CONFIG)} does not set "scope"; fluent ${action} needs it to name the application.`
    );
  }
  return scope;
}

const fluentLogger: SN.FluentLogger = {
  info: (message) => logger.info(message),
  warn: (message) => logger.warn(message),
  debug: (message) => logger.debug(message),
};

function isSdkMissing(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === "FLUENT_SDK_MISSING";
}

function fallBackToNative(deps: FluentCommandDeps, args: FluentCmdArgs, profile: string | undefined): Promise<number> {
  logger.info(
    `${FLUENT_SDK_PACKAGE} is not installed; generating table types natively from sys_dictionary instead.`
  );
  return executeNativeTypes(deps, args, profile, nativeTypesOptions(args));
}

/**
 * `fluent types --native`: reads the schema over the Table API and writes one
 * `.d.ts`. A project is needed only for what it supplies: the default scope
 * (`now.config.json`) and the default output location.
 */
type NativeTypesFlags = { scope?: string; tables?: string[]; out?: string };

/**
 * The local half of `fluent types --native`: the project (when one is needed),
 * the scope and the output file. Shared by the real run and `--dry-run`, so a
 * preview fails exactly where the run would.
 */
async function resolveNativeTypesTarget(
  deps: FluentCommandDeps,
  args: FluentCmdArgs,
  options: NativeTypesFlags
): Promise<{ scope?: string; file: string }> {
  const needsProject = !!args.project || !options.out || (!options.scope && !options.tables);
  const projectDir = needsProject
    ? await resolveProjectDir(deps, "types", args)
    : await findProjectDir(deps, deps.cwd);
  // `--table` names the tables outright, and the generator ignores a scope next
  // to it, so the project's now.config.json is read only when the scope is needed.
  const scope =
    options.scope ?? (projectDir && !options.tables ? await configuredScope(deps, projectDir) : undefined);
  if (!options.tables && !scope) {
    throw new FluentCliError(
      `fluent types --native needs a scope: pass --scope or --table, or set "scope" in ${NOW_CONFIG}.`
    );
  }
  const file = options.out
    ? path.resolve(deps.cwd, options.out)
    : path.join(projectDir as string, NATIVE_TYPES_DEFAULT_OUT);
  return { scope, file };
}

async function executeNativeTypes(
  deps: FluentCommandDeps,
  args: FluentCmdArgs,
  profile: string | undefined,
  options: NativeTypesFlags
): Promise<number> {
  const { scope, file } = await resolveNativeTypesTarget(deps, args, options);

  const result = await deps.generateTypes(deps.getClient(profile), {
    ...(scope ? { scope } : {}),
    ...(options.tables ? { tables: options.tables } : {}),
  });
  await deps.writeFile(file, result.content);

  if (args.json === true) {
    deps.write(
      JSON.stringify(
        {
          command: "fluent types",
          exitCode: 0,
          mode: "native",
          file,
          ...(options.tables ? { tables: options.tables } : { scope }),
          tableCount: result.tableCount,
          fieldCount: result.fieldCount,
        },
        null,
        2
      )
    );
  } else {
    if (result.tableCount === 0) logger.warn(`No tables found for scope ${scope}; wrote an empty type file.`);
    logger.success(`Wrote ${result.tableCount} table type(s) with ${result.fieldCount} field(s) to ${file}.`);
  }
  return 0;
}

/** `fluent types` with no SDK-only flag can be served natively when the SDK is absent. */
function canFallBackToNative(action: FluentAction, args: FluentCmdArgs): boolean {
  return action === "types" && !args.scripts && !args.fluent;
}

/**
 * The local checks a real run makes before it touches credentials or the SDK:
 * the project directory resolves, install and move-to-app read the project's
 * scope (move-to-app needs it global), and an action that asks for consent has a
 * way to get it. `--dry-run` runs them too, so a preview never passes where the
 * run would fail. The credential check is not here: it reads the credential
 * store, which `--dry-run` deliberately leaves alone.
 */
async function checkLocalPreconditions(
  deps: FluentCommandDeps,
  action: FluentAction,
  args: FluentCmdArgs
): Promise<{ projectDir: string; scope?: string }> {
  const projectDir = await resolveProjectDir(deps, action, args);
  let scope: string | undefined;
  if (action === "install" || action === "move-to-app") {
    scope = await requiredScope(deps, projectDir, action);
    if (action === "move-to-app" && scope !== "global") {
      throw new FluentCliError(
        `fluent move-to-app works on global applications only; ${projectDir} is scoped to ${scope}.`
      );
    }
  }
  assertConsentReachable(deps, action, args);
  return scope === undefined ? { projectDir } : { projectDir, scope };
}

/**
 * install and move-to-app ask first; without --ci there must be a terminal to
 * answer. `--dry-run` is refused the same way, so a preview fails where the run
 * would; only its advice differs, since a dry run changes nothing.
 */
function assertConsentReachable(deps: FluentCommandDeps, action: FluentAction, args: FluentCmdArgs): void {
  if (action !== "install" && action !== "move-to-app") return;
  if (args.ci === true) return;
  const json = args.json === true;
  if (!json && deps.interactive()) return;
  const advice =
    args.dryRun === true
      ? `Pass --ci to preview without a prompt; a dry run ${action === "install" ? "installs" : "moves"} nothing.`
      : `Pass --ci to ${action === "install" ? "install" : "move the records"} without asking.`;
  throw new FluentCliError(
    `fluent ${action} asks for confirmation, and ` +
      `${json ? "--json output cannot answer it" : "this session has no terminal to answer it"}. ${advice}`
  );
}

/**
 * Whether the adapter or the SDK is missing, resolved exactly as the real run
 * resolves them; nothing reads the credential store or reaches the instance.
 * `--dry-run` uses it to fail where the real run would (and to report the
 * native fallback of a plain `fluent types`). Any failure other than "not
 * installed" surfaces, as it would in the real run.
 */
async function sdkMissing(deps: FluentCommandDeps, projectDir: string): Promise<boolean> {
  let fluent: SN.FluentModule;
  try {
    fluent = await deps.loadFluent(projectDir);
  } catch (e) {
    if (e instanceof FluentNotInstalledError) return true;
    throw e;
  }
  try {
    await fluent.createFluentEngine({ projectDir, logger: fluentLogger }).sdkVersion();
    return false;
  } catch (e) {
    if (isSdkMissing(e)) return true;
    throw e;
  }
}

const NATIVE_READS = "read sys_db_object, sys_dictionary and sys_choice";

async function dryRun(deps: FluentCommandDeps, action: FluentAction, plan: FluentPlan, args: FluentCmdArgs): Promise<void> {
  if (plan.method === "nativeTypes") {
    await resolveNativeTypesTarget(deps, args, plan.options);
    writeDryRun(
      deps,
      action,
      plan,
      args,
      `[dry-run] fluent types --native → ${NATIVE_READS} (${JSON.stringify(plan.options)}) against the active instance`
    );
    return;
  }
  const { projectDir } = await checkLocalPreconditions(deps, action, args);
  // Every non-native action loads the adapter and the SDK in the real run, which
  // exits 1 with the install hint when either is missing; the preview probes them
  // the same way, so it never passes where the run would fail.
  const missing = await sdkMissing(deps, projectDir);
  if (missing && !canFallBackToNative(action, args)) throw new FluentNotInstalledError();
  if (missing) {
    const native: FluentPlan = { method: "nativeTypes", options: nativeTypesOptions(args), instance: true };
    await resolveNativeTypesTarget(deps, args, native.options);
    writeDryRun(
      deps,
      action,
      native,
      args,
      `[dry-run] fluent types → ${FLUENT_SDK_PACKAGE} is not installed; ${NATIVE_READS} ` +
        `(${JSON.stringify(native.options)}) against the active instance`
    );
    return;
  }
  writeDryRun(
    deps,
    action,
    plan,
    args,
    `[dry-run] fluent ${action} → engine.${String(plan.method)}(${JSON.stringify(plan.options)})` +
      (plan.instance ? " against the active instance" : " (local only)")
  );
}

function writeDryRun(deps: FluentCommandDeps, action: FluentAction, plan: FluentPlan, args: FluentCmdArgs, line: string): void {
  if (args.json === true) {
    deps.write(
      JSON.stringify(
        {
          command: `fluent ${action}`,
          exitCode: 0,
          dryRun: true,
          method: plan.method,
          options: plan.options,
          instance: plan.instance,
        },
        null,
        2
      )
    );
    return;
  }
  deps.write(line);
}

async function execute(
  deps: FluentCommandDeps,
  action: FluentAction,
  plan: FluentPlan,
  args: FluentCmdArgs,
  profile: string | undefined
): Promise<number> {
  if (plan.method === "nativeTypes") {
    return executeNativeTypes(deps, args, profile, plan.options);
  }
  const { projectDir, scope } = await checkLocalPreconditions(deps, action, args);
  const json = args.json === true;

  let credential: FluentCredential | undefined;
  if (plan.instance) {
    credential = await deps.resolveCredential(profile);
    if (credential.input.kind === "unsupported") {
      throw new FluentCliError(
        `fluent ${action} cannot use a ${credential.input.method} profile: the ServiceNow SDK reaches ` +
          `${SESSION_ONLY_ENDPOINTS} with a UI session or a bearer token only. ` +
          `Log in with a Basic or OAuth profile (\`syncrona login --auth-method\`)` +
          (canFallBackToNative(action, args)
            ? ", or pass --native to generate table types without the SDK."
            : ".")
      );
    }
  }

  let fluent: SN.FluentModule;
  try {
    fluent = await deps.loadFluent(projectDir);
  } catch (e) {
    if (e instanceof FluentNotInstalledError && canFallBackToNative(action, args)) {
      return fallBackToNative(deps, args, profile);
    }
    throw e;
  }
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

  if (action === "install") {
    // Load the SDK now, so a missing or broken SDK fails before the user consents.
    await engine.sdkVersion();
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

  if (action === "move-to-app") {
    // Load the SDK now, so a missing or broken SDK fails before the user consents.
    await engine.sdkVersion();
    const count = (plan.options.sysIds as string[]).length;
    const ok =
      args.ci === true ||
      (await deps.confirm(
        `Move ${count} record(s) into ${scope} on ${credential?.instanceUrl}? ` +
          `This creates sys_claim records on the instance and writes the records into the project as Fluent sources.`
      ));
    if (!ok) {
      logger.info("fluent move-to-app cancelled.");
      return 0;
    }
  }

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
      try {
        await engine.types(plan.options);
      } catch (e) {
        if (isSdkMissing(e) && canFallBackToNative(action, args)) return fallBackToNative(deps, args, profile);
        throw e;
      }
      emit({ exitCode: 0, mode: "sdk" }, () => logger.success("Fluent types and dependencies updated."));
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
    case "explain": {
      const options = plan.options as { topic?: string; list?: boolean; peek?: boolean };
      return renderExplain(deps, options, await engine.explain(options), emit);
    }
    case "moveToApp": {
      const options = plan.options as { sysIds: string[] };
      const result = await engine.moveToApp(options);
      const exitCode = result.moved ? 0 : 2;
      emit({ exitCode, requested: options.sysIds.length, ...result }, () => {
        if (!result.moved) {
          logger.warn("The instance moved none of the records; check that the sys_ids name valid records.");
          return;
        }
        for (const file of result.changedFiles) logger.info(`  ${file}`);
        logger.success(
          `Moved records into the application; ${result.changedFiles.length} Fluent file(s) changed.`
        );
      });
      return exitCode;
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

function topicLine(topic: SN.FluentDocTopic): string {
  return topic.tags.length > 0 ? `${topic.name} [${topic.tags.join(", ")}]` : topic.name;
}

function summaryLines(topics: readonly SN.FluentDocTopic[]): string[] {
  return topics.map((topic) => `${topicLine(topic)}\n  ${topic.summary}`);
}

const EXPLAIN_HINT = "Run `syncrona fluent explain <topic>` to read one topic, or `--list` to see them all.";

/**
 * Renders an `explain` result. The document and the topic index go to stdout,
 * so they can be piped; framing lines go through the logger. Exits 1 only when
 * nothing matched, as `now-sdk explain` does.
 */
function renderExplain(
  deps: FluentCommandDeps,
  options: { topic?: string; peek?: boolean },
  result: SN.FluentExplainResult,
  emit: (payload: Record<string, unknown>, human: () => void) => void
): number {
  const exitCode = result.kind === "none" ? 1 : 0;
  emit({ exitCode, ...result }, () => {
    switch (result.kind) {
      case "list": {
        if (result.filter !== undefined) logger.info(`Topics matching "${result.filter}":`);
        // `--peek` adds each topic's summary to the index.
        const lines = (topics: readonly SN.FluentDocTopic[]) =>
          options.peek ? summaryLines(topics) : topics.map(topicLine);
        for (const line of lines(result.topics)) deps.write(line);
        if (result.related.length > 0) {
          logger.info("Related:");
          for (const line of lines(result.related)) deps.write(line);
        }
        if (result.topics.length === 0 && result.related.length === 0) logger.warn("No matching topics.");
        break;
      }
      case "topic":
        deps.write(result.body);
        break;
      case "matches":
        if (result.topics.length > 1) logger.info(`Several topics match "${options.topic}":`);
        for (const line of summaryLines(result.topics)) deps.write(line);
        if (result.topics.length > 1) logger.info(EXPLAIN_HINT);
        break;
      case "suggestions":
        logger.info(`No topic matches "${options.topic}" exactly; these may be related:`);
        for (const line of summaryLines(result.topics)) deps.write(line);
        logger.info(EXPLAIN_HINT);
        break;
      default:
        logger.error(`No topic matches "${options.topic}".`);
        logger.info("Run `syncrona fluent explain --list` to see every topic.");
    }
  });
  return exitCode;
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
      await dryRun(deps, action, plan, args);
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
