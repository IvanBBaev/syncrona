// SPDX-License-Identifier: GPL-3.0-or-later
import { SN, Sync } from "@syncrona/types";
import { escapeQueryValue } from "@syncrona/sn-transport";
import { promises as fsp } from "fs";
import path from "path";
import * as ConfigManager from "./config.js";
import { logger } from "./Logger.js";
import {
  defaultClient,
  resolveCredentials,
  unwrapSNResponse,
  type SNClient,
} from "./snClient.js";

/**
 * `syncrona init --new` — create a new scoped application on the instance
 * (a `sys_app` row through the Table API) and bind the current directory to it,
 * the counterpart of `now-sdk init` for a non-Fluent project.
 */

/**
 * `sys_scope.scope` is a string column with max length 18 (WP-0 spike,
 * sys_dictionary over sys_app → sys_scope). The limit covers the WHOLE scope,
 * `x_<prefix>_` included.
 */
export const SCOPE_MAX_LENGTH = 18;

/** Version the new application starts at, as `now-sdk init` does. */
export const NEW_APP_VERSION = "1.0.0";

/** A vendor prefix (company code) after normalization: `acme`, never `x_acme_`. */
const VENDOR_PREFIX_PATTERN = /^[a-z0-9]+$/;

/** The scope character set; the `x_<prefix>_` start is checked separately. */
const SCOPE_CHARSET_PATTERN = /^[a-z0-9_]+$/;

export type InitCmdArgs = Sync.SharedCmdArgs & {
  /** `--new`: create the application instead of binding to an existing one. */
  new?: boolean;
  /** `--name`: the application's display name. */
  name?: string;
  /** `--scope`: explicit scope; derived from the name and prefix otherwise. */
  scope?: string;
  /** `--vendor-prefix`: skips the instance lookup. */
  vendorPrefix?: string;
};

/** The `sys_app` insert body. */
export type SysAppBody = {
  name: string;
  scope: string;
  version: string;
  vendor_prefix: string;
  active: true;
};

/** Thrown for every input or instance condition `init --new` refuses. */
export class AppCreatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppCreatorError";
  }
}

const VENDOR_PREFIX_HINT =
  "Pass it explicitly with --vendor-prefix <prefix> (the instance's company code: " +
  "System Properties › glide.appcreator.company.code), or pass --scope x_<prefix>_<name>.";

/**
 * Reduces a vendor prefix in any of the forms people and the instance use —
 * `acme`, `x_acme`, `x_acme_`, ` X_ACME_ ` — to the bare company code `acme`.
 * Returns undefined when nothing valid is left.
 */
export function normalizeVendorPrefix(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let value = raw.trim().toLowerCase();
  if (value.startsWith("x_")) value = value.slice(2);
  value = value.replace(/_+$/, "");
  return VENDOR_PREFIX_PATTERN.test(value) ? value : undefined;
}

/**
 * Turns a display name into a scope-safe snake_case fragment: accents are
 * folded to their base letter (`Café` → `cafe`), every other run of characters
 * outside `[a-z0-9]` becomes one underscore, and edge underscores are trimmed.
 * A name with no Latin letters or digits at all yields an empty string.
 */
export function snakeCaseName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Checks a scope against what the instance accepts: lowercase `[a-z0-9_]`, at
 * most {@link SCOPE_MAX_LENGTH} characters, starting with `x_<prefix>_` and
 * with a non-empty name after it. Throws an {@link AppCreatorError} naming the
 * first rule broken.
 */
export function validateScopeName(scope: string, vendorPrefix: string): void {
  const required = `x_${vendorPrefix}_`;
  if (!SCOPE_CHARSET_PATTERN.test(scope)) {
    throw new AppCreatorError(
      `Scope "${scope}" may contain only lowercase letters, digits and underscores.`
    );
  }
  if (scope.length > SCOPE_MAX_LENGTH) {
    throw new AppCreatorError(
      `Scope "${scope}" is ${scope.length} characters long; ServiceNow allows at most ${SCOPE_MAX_LENGTH}, ` +
        `including the "${required}" prefix.`
    );
  }
  if (!scope.startsWith(required) || scope.length === required.length) {
    throw new AppCreatorError(
      `Scope "${scope}" must start with "${required}" (the vendor prefix) followed by a name.`
    );
  }
  if (scope.endsWith("_")) {
    throw new AppCreatorError(`Scope "${scope}" must not end with an underscore.`);
  }
}

/**
 * The scope for a new application: `explicitScope` when given (validated as
 * is, never rewritten), otherwise `x_<prefix>_<snake(name)>`. A derived scope
 * that is too long is truncated to {@link SCOPE_MAX_LENGTH} — App Creator does
 * the same — and the caller prints the result, so nothing changes silently.
 */
export function deriveScopeName(
  name: string,
  vendorPrefix: string,
  explicitScope?: string
): string {
  if (explicitScope !== undefined) {
    const scope = explicitScope.trim();
    validateScopeName(scope, vendorPrefix);
    return scope;
  }
  const prefix = `x_${vendorPrefix}_`;
  const room = SCOPE_MAX_LENGTH - prefix.length;
  if (room < 1) {
    throw new AppCreatorError(
      `Vendor prefix "${vendorPrefix}" leaves no room for a name within the ${SCOPE_MAX_LENGTH}-character scope limit.`
    );
  }
  const fragment = snakeCaseName(name).slice(0, room).replace(/_+$/, "");
  if (fragment === "") {
    throw new AppCreatorError(
      `Cannot derive a scope from the name "${name}": it has no Latin letters or digits. ` +
        `Pass the scope explicitly with --scope ${prefix}<name>.`
    );
  }
  const scope = `${prefix}${fragment}`;
  validateScopeName(scope, vendorPrefix);
  return scope;
}

/** The vendor prefix encoded in `x_<prefix>_<name>`, when the scope has that shape. */
function prefixFromScope(scope: string | undefined): string | undefined {
  const match = /^x_([a-z0-9]+)_[a-z0-9_]+$/.exec((scope ?? "").trim());
  return match ? match[1] : undefined;
}

export type VendorPrefixSource = "flag" | "instance" | "scope";

/**
 * Resolves the vendor prefix: the `--vendor-prefix` flag, then the instance's
 * App Creator resource, then the prefix inside an explicit `--scope`. Throws an
 * actionable {@link AppCreatorError} when none of them yields one.
 */
export async function resolveVendorPrefix(
  client: Pick<SNClient, "getVendorPrefix">,
  options: { vendorPrefix?: string; scope?: string } = {}
): Promise<{ prefix: string; source: VendorPrefixSource }> {
  if (options.vendorPrefix !== undefined) {
    const prefix = normalizeVendorPrefix(options.vendorPrefix);
    if (!prefix) {
      throw new AppCreatorError(
        `--vendor-prefix "${options.vendorPrefix}" is not a valid vendor prefix: use letters and digits only (e.g. acme or x_acme_).`
      );
    }
    return { prefix, source: "flag" };
  }

  let lookupProblem: string;
  try {
    const raw = await unwrapSNResponse<string>(client.getVendorPrefix());
    const prefix = normalizeVendorPrefix(raw);
    if (prefix) return { prefix, source: "instance" };
    lookupProblem = `the instance returned ${JSON.stringify(raw ?? null)}`;
  } catch (e) {
    lookupProblem = e instanceof Error ? e.message : String(e);
  }

  const fromScope = prefixFromScope(options.scope);
  if (fromScope) {
    logger.warn(
      `Could not read the vendor prefix from the instance (${lookupProblem}); using "${fromScope}" from --scope.`
    );
    return { prefix: fromScope, source: "scope" };
  }
  throw new AppCreatorError(
    `Could not determine the instance's vendor prefix: GET /api/now/appcreator/app/vendorprefix failed (${lookupProblem}). ` +
      VENDOR_PREFIX_HINT
  );
}

/** The exact `sys_app` insert body for a new application. */
export function buildSysAppBody(name: string, scope: string, vendorPrefix: string): SysAppBody {
  return {
    name,
    scope,
    version: NEW_APP_VERSION,
    vendor_prefix: vendorPrefix,
    active: true,
  };
}

/** Inserts the `sys_app` row and returns the new application's sys_id. */
export async function createScopedApp(
  client: Pick<SNClient, "createRecord">,
  body: SysAppBody
): Promise<string> {
  const { sys_id } = await client.createRecord("sys_app", body);
  return sys_id;
}

/** sys_id of an existing application with this scope, if there is one. */
export async function findExistingApp(
  client: Pick<SNClient, "tableAPIGet">,
  scope: string
): Promise<string | undefined> {
  const rows = await unwrapSNResponse<Array<{ sys_id?: unknown }>>(
    client.tableAPIGet("sys_app", `scope=${escapeQueryValue(scope)}`, "sys_id", 1)
  );
  const sysId = Array.isArray(rows) ? rows[0]?.sys_id : undefined;
  return typeof sysId === "string" && sysId !== "" ? sysId : undefined;
}

export type InitNewDeps = {
  getClient: (profile?: string) => SNClient;
  /** The instance the credentials resolve to; empty when none is configured. */
  resolveInstance: (profile?: string) => string;
  /** `wizard.ts` `downloadApp`, loaded lazily so `init` without `--new` never imports it. */
  downloadApp: (
    scope: string,
    client: SNClient,
    options: { scopeId?: string }
  ) => Promise<SN.AppManifest>;
  /** Makes sure sync.config.js and the source directory exist, then reloads the config. */
  prepareWorkspace: () => Promise<void>;
  /** The manifest the current directory is already bound to, if any. */
  currentManifest: () => SN.AppManifest | undefined;
};

async function nodePrepareWorkspace(): Promise<void> {
  if (!ConfigManager.checkConfigPath()) {
    const configPath = path.join(process.cwd(), "sync.config.js");
    await fsp.writeFile(configPath, ConfigManager.getDefaultConfigFile("src"), "utf8");
    logger.info(`Wrote ${configPath}`);
  }
  await ConfigManager.loadConfigs();
  await fsp.mkdir(ConfigManager.getSourcePath(), { recursive: true });
}

export const defaultInitNewDeps = (): InitNewDeps => ({
  getClient: (profile) => defaultClient(profile),
  resolveInstance: (profile) => resolveCredentials(profile).instance,
  downloadApp: async (scope, client, options) =>
    (await import("./wizard.js")).downloadApp(scope, client, options),
  prepareWorkspace: nodePrepareWorkspace,
  currentManifest: () => ConfigManager.getManifest(true),
});

/** True when any `init --new` flag is present, so `init` routes here and can refuse a stray one. */
export function wantsInitNew(args: InitCmdArgs): boolean {
  return (
    args.new === true ||
    args.name !== undefined ||
    args.scope !== undefined ||
    args.vendorPrefix !== undefined
  );
}

/**
 * Runs `init --new`. Resolves `true` when an application was created and the
 * directory bound to it, `false` for a dry run. Every refusal throws an
 * {@link AppCreatorError} BEFORE any write: input problems first, then the
 * vendor prefix and the existing-scope check (GETs only), and only then the
 * single POST. A dry run stops after the GETs and prints the body it would send.
 */
export async function initNewApp(
  args: InitCmdArgs,
  overrides: Partial<InitNewDeps> = {}
): Promise<boolean> {
  const deps: InitNewDeps = { ...defaultInitNewDeps(), ...overrides };

  if (args.new !== true) {
    throw new AppCreatorError(
      "--name, --scope and --vendor-prefix only apply to `syncrona init --new`."
    );
  }
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (name === "") {
    throw new AppCreatorError(
      'init --new needs the application name: syncrona init --new --name "My App".'
    );
  }
  const existing = deps.currentManifest();
  if (existing) {
    throw new AppCreatorError(
      `This directory is already bound to scope "${existing.scope}" (sync.manifest.json). ` +
        "Run init --new in an empty directory."
    );
  }
  const instance = deps.resolveInstance(args.instanceProfile);
  if (!instance) {
    throw new AppCreatorError(
      "No ServiceNow instance is configured. Run `syncrona login`, or add a .env with SN_INSTANCE/SN_USER/SN_PASSWORD."
    );
  }

  const client = deps.getClient(args.instanceProfile);
  const { prefix, source } = await resolveVendorPrefix(client, {
    vendorPrefix: args.vendorPrefix,
    scope: args.scope,
  });
  const scope = deriveScopeName(name, prefix, args.scope);
  logger.info(
    `Vendor prefix "${prefix}" (${source === "flag" ? "--vendor-prefix" : source === "instance" ? "from the instance" : "from --scope"}); scope ${scope}.`
  );

  const existingSysId = await findExistingApp(client, scope);
  if (existingSysId) {
    throw new AppCreatorError(
      `An application with scope "${scope}" already exists on ${instance} (sys_id ${existingSysId}). ` +
        `Bind to it with \`syncrona download ${scope}\` or \`syncrona init\`, or choose another --scope.`
    );
  }

  const body = buildSysAppBody(name, scope, prefix);
  if (args.dryRun === true) {
    logger.info(`Dry run: would create the application on ${instance}:`);
    logger.info(`POST /api/now/table/sys_app ${JSON.stringify(body)}`);
    logger.info(
      `Then bind this directory to ${scope}: write sync.config.js (if missing) and sync.manifest.json with its scopeId.`
    );
    logger.info("Nothing was created.");
    return false;
  }

  const scopeId = await createScopedApp(client, body);
  logger.success(`Created application "${name}" (${scope}, sys_id ${scopeId}) on ${instance}.`);
  logger.info(
    "ServiceNow switched your current application to it (sys_app insert rule `Set Current Application`)."
  );

  try {
    await deps.prepareWorkspace();
    await deps.downloadApp(scope, client, { scopeId });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new AppCreatorError(
      `The application ${scope} was created (sys_id ${scopeId}), but binding this directory failed: ${message} ` +
        `Re-run the binding with \`syncrona download ${scope}\` — do not re-run init --new, the scope now exists.`
    );
  }
  logger.success(`This directory is bound to ${scope}. Add files and run \`syncrona push --create\`.`);
  return true;
}
