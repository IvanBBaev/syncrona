// SPDX-License-Identifier: GPL-3.0-or-later
//
// Native `fluent build`: compile a Fluent project into the install layout the
// SDK's `Orchestrator.build` writes (`dist/app/{scope,update,unload,…}`) and
// write keys.ts back, without the SDK. It follows the SDK's build step by step:
//
// - unless `skipClean`, it first removes the app and pack output directories,
//   the static-content build directory and `.now/.output`;
// - the records come from the native compiler (`./compiler`);
// - the build adds the records the SDK derives from the project files: the
//   `sys_app` scope record from now.config.json, and the `sys_module` rows of
//   package.json and of the CycloneDX `bom.json` (skipped, like the SDK, for a
//   `configuration` project);
// - `frozenKeys` fails the build when keys.ts would change.
//
// What the native build cannot produce yet it refuses with an error rather
// than build an incomplete app: server modules, client sources, `metadata/`
// XML records, runtime policy records and a logo file. Those builds need the
// SDK. Where it differs on purpose:
//
// - a build with errors writes nothing, and `frozenKeys` is checked before
//   anything is written (the SDK writes the output, then throws);
// - the SBOM names syncrona as its tool and is not copied to `.now/bom.json`;
// - `errorOnConflict` has nothing to act on: it is about Fluent records that
//   collide with `metadata/` XML records, which the native build refuses.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SN } from "@syncrona/types";
import { compileFluentProject } from "./compiler/compile";
import type { FluentDiagnostic } from "./compiler/diagnostics";
import type { GuidGenerator } from "./compiler/keys";
import type { RecordElementModel, RecordUpdateModel } from "./compiler/record";
import type { TypeScriptLoader } from "./compiler/typescript";
import { readNativeProject, readNowConfig } from "./pack";
import {
  cdataSection,
  escapeXmlAttribute,
  escapeXmlText,
  serializeCompositeRecordUpdate,
  serializeRecordUpdate,
  type RecordXmlRecord,
} from "./recordXml";

export interface NativeBuildOptions {
  frozenKeys?: boolean;
  errorOnConflict?: boolean;
  skipClean?: boolean;
  loadTypeScript?: TypeScriptLoader;
  /** Generates the sys_id of a new key (tests pin it). */
  generateGuid?: GuidGenerator;
  /** The SBOM's timestamp and serial number (tests pin them). */
  now?: () => Date;
  serialNumber?: () => string;
}

/** The out-of-date message the SDK's frozen-keys build gives. */
export const FROZEN_KEYS_ERROR =
  "Keys file is out-of-date. To update it, run the build again without frozen keys.";

const MODULE_SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const REPACK_OUTPUT_DIR = path.join(".now", ".output");
const MODULE_RESOLUTION_V1 = "1.0.0";
const MODULE_RESOLUTION_V2 = "2.0.0";
const ARP_TO_RAT: Record<string, string | undefined> = {
  tracking: "permissive",
  enforcing: "enforcing",
};

type Json = Record<string, unknown>;

function objectOf(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The SDK's `toBoolean().def(…)`: a boolean or `"true"`/`"false"`, else the default. */
function flag(value: unknown, fallback: boolean): string {
  if (typeof value === "boolean") return String(value);
  if (value === "true" || value === "false") return value;
  return String(fallback);
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function diagnosticText(projectDir: string, d: FluentDiagnostic): string {
  return `${path.relative(projectDir, d.file)}:${d.line}:${d.column} - ${d.message}`;
}

/** Files under `dir` (relative, `/`-separated) that `keep` accepts; none when it does not exist. */
function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  return (
    fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[]
  )
    .filter((entry) => entry.isFile() && keep(entry.name))
    .map((entry) =>
      path
        .relative(dir, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    )
    .sort();
}

function isServerModule(name: string): boolean {
  return (
    MODULE_SOURCE.test(name) &&
    !name.endsWith(".d.ts") &&
    !/\.test\.[jt]s$/.test(name)
  );
}

interface AppFacts {
  projectDir: string;
  config: Json;
  scope: string;
  scopeId: string;
  packageName: string;
  packageVersion: string;
  pkg: Json;
}

/** `NowConfig.moduleResolutionPath` for the app's own files, `/`-separated. */
export function moduleResolutionPath(
  config: { scope: string; packageResolverVersion?: string },
  pkg: { name: string; version: string },
  ...segments: string[]
): string {
  const { scope, packageResolverVersion } = config;
  if (scope === "global" && packageResolverVersion === MODULE_RESOLUTION_V1) {
    throw new Error(
      `Global modules must use packageResolverVersion: '${MODULE_RESOLUTION_V2}' or higher`,
    );
  }
  const legacy = packageResolverVersion
    ? packageResolverVersion === MODULE_RESOLUTION_V1
    : scope !== "global";
  return `${legacy ? "" : scope === "global" ? "/" : ""}${[scope, pkg.name, pkg.version, ...segments].join("/")}`;
}

/** Errors for project content the native build cannot produce. */
function unsupportedContent(app: AppFacts): string[] {
  const { projectDir, config } = app;
  const dir = (key: string, fallback: string) =>
    path.join(projectDir, text(config[key], fallback));
  const errors: string[] = [];
  const refuse = (what: string) =>
    errors.push(
      `${what} is not built by syncrona's native engine yet; install @servicenow/sdk to build this project.`,
    );
  const modules = filesUnder(
    dir("serverModulesDir", path.join("src", "server")),
    isServerModule,
  );
  if (modules.length > 0)
    refuse(
      `The server module ${modules[0]}${modules.length > 1 ? ` (and ${modules.length - 1} more)` : ""}`,
    );
  if (
    filesUnder(dir("clientDir", path.join("src", "client")), () => true)
      .length > 0
  )
    refuse("Client content (clientDir)");
  if (
    filesUnder(dir("metadataDir", "metadata"), (name) => name.endsWith(".xml"))
      .length > 0
  ) {
    refuse("XML metadata (metadataDir)");
  }
  const policies = [
    "networkPolicies",
    "wildcardPolicy",
    "performancePolicy",
  ].filter((key) =>
    Array.isArray(config[key])
      ? (config[key] as unknown[]).length > 0
      : config[key] !== undefined,
  );
  if (policies.length > 0)
    refuse(`The runtime policy configuration (${policies.join(", ")})`);
  const logo = stringOf(config.logo);
  if (logo && !/^[0-9a-f]{32}$/.test(logo)) refuse(`A logo file (${logo})`);
  return errors;
}

type Fields = Record<string, string | undefined>;

/** A record model with the SDK's field order: sys_id, sys_scope, sys_update_name, then by name. */
function recordModel(
  app: AppFacts,
  table: string,
  sysId: string,
  installCategory: string,
  fields: Fields,
  cdata: readonly string[] = [],
): { path: string; xml: string } {
  const rest = Object.keys(fields).sort((a, b) => a.localeCompare(b));
  const xml = serializeRecordUpdate({
    table,
    applyDefaults: true,
    fields: [
      { name: "sys_id", value: sysId },
      {
        name: "sys_scope",
        value: app.scopeId,
        attributes: { display_value: app.scope },
      },
      { name: "sys_update_name", value: `${table}_${sysId}` },
      ...rest.map((name) => ({
        name,
        value: fields[name],
        cdata: cdata.includes(name),
      })),
    ],
  });
  return { path: `${installCategory}/${table}_${sysId}.xml`, xml };
}

/** The `sys_app` scope record, as the SDK's NowConfigPlugin derives it. */
function sysAppRecord(
  app: AppFacts,
  errors: string[],
): { path: string; xml: string } | undefined {
  const { config, scope } = app;
  const access = objectOf(config.accessControls) ?? {};
  const licensing = objectOf(config.licensing) ?? {};
  const arp = text(config.applicationRuntimePolicy, "none");
  const userRat = stringOf(access.runtimeAccessTracking);
  const requiredRat = ARP_TO_RAT[arp];
  if (userRat && requiredRat && userRat !== requiredRat) {
    errors.push(
      `Runtime Access Tracking is set to '${userRat}' but Application Runtime Policy '${arp}' requires '${requiredRat}'. ` +
        `Set runtimeAccessTracking to '${requiredRat}' to match the Application Runtime Policy.`,
    );
  }
  const rat = requiredRat ?? userRat ?? "permissive";
  const packageResolverVersion = stringOf(config.packageResolverVersion);
  let packageJson: string;
  try {
    packageJson = moduleResolutionPath(
      { scope, packageResolverVersion },
      { name: app.packageName, version: app.packageVersion },
      "package.json",
    );
  } catch (e) {
    errors.push((e as Error).message);
    return undefined;
  }
  const fields: Fields = {
    active: flag(config.active, true),
    ...(arp !== "none" ? { application_runtime_policy: arp } : {}),
    scoped_administration: flag(access.scopedAdministration, false),
    can_edit_in_studio: flag(access.canEditInStudio, true),
    js_level: text(config.jsLevel, "es_latest"),
    restrict_table_access: flag(access.restrictTableAccess, false),
    runtime_access_tracking: rat === "none" ? undefined : rat,
    licensable: flag(licensing.licensable, true),
    enforce_license: text(licensing.enforceLicense, "log"),
    license_model: text(licensing.licenseModel, "none"),
    menu: text(config.menu, ""),
    user_role: text(access.userRole, ""),
    short_description: text(config.description, ""),
    logo: text(config.logo, ""),
    guided_setup_guid: text(config.guidedSetupGuid, ""),
    subscription_entitlement: text(licensing.subscriptionEntitlement, ""),
    private: flag(access.private, false),
    trackable: flag(access.trackable, true),
    uninstall_blocked: flag(access.uninstallBlocked, false),
    hide_on_ui: flag(access.hideOnUI, false),
    installed_as_dependency: flag(config.installedAsDependency, false),
    license_category: text(licensing.licenseCategory, "none"),
    scope,
    package_json: packageJson,
    name: text(config.name, app.packageName),
    source: scope,
    version: app.packageVersion,
    package_resolver_version:
      packageResolverVersion ??
      (scope === "global" ? MODULE_RESOLUTION_V2 : MODULE_RESOLUTION_V1),
    sys_code: stringOf(config.sysCode),
    ide_created: stringOf(config.ideCreated),
  };
  return recordModel(app, "sys_app", app.scopeId, "scope", fields);
}

/** package.json as the SDK stores it: dependencies pinned to their installed versions. */
function packageJsonContent(app: AppFacts, errors: string[]): string {
  const deps = objectOf(app.pkg.dependencies);
  if (!deps)
    return JSON.stringify({ ...app.pkg, version: app.packageVersion }, null, 2);
  const resolved: Record<string, string> = {};
  for (const dep of Object.keys(deps)) {
    const installed = path.join(
      app.projectDir,
      "node_modules",
      dep,
      "package.json",
    );
    const meta = fs.existsSync(installed)
      ? objectOf(JSON.parse(fs.readFileSync(installed, "utf8")))
      : undefined;
    const name = stringOf(meta?.name);
    const version = stringOf(meta?.version);
    if (!name || !version) {
      errors.push(
        `The dependency ${dep} is not installed; run npm install before building.`,
      );
      continue;
    }
    resolved[name] = version;
  }
  return JSON.stringify(
    { ...app.pkg, dependencies: resolved, version: app.packageVersion },
    null,
    2,
  );
}

function toolVersion(): string {
  const own = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  return own.version;
}

/** `name` and `group` the way CycloneDX splits an npm package name. */
function npmComponentName(packageName: string): {
  name: string;
  group?: string;
} {
  const slash = packageName.indexOf("/");
  return packageName.startsWith("@") && slash > 0
    ? { group: packageName.slice(0, slash), name: packageName.slice(slash + 1) }
    : { name: packageName };
}

/** The CycloneDX 1.6 SBOM of an app without external modules. */
export function sbomContent(
  app: {
    packageName: string;
    packageVersion: string;
    scopeId: string;
    license?: string;
  },
  stamp: { timestamp: Date; serialNumber: string },
): string {
  const purl =
    `pkg:servicenow/${encodeURIComponent(app.packageName)}@${encodeURIComponent(app.packageVersion)}` +
    (app.scopeId ? `?sys_scope_id=${encodeURIComponent(app.scopeId)}` : "");
  const bom = {
    $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    serialNumber: `urn:uuid:${stamp.serialNumber}`,
    metadata: {
      timestamp: stamp.timestamp.toISOString(),
      tools: {
        components: [
          {
            type: "library",
            name: "fluent",
            group: "@syncrona",
            version: toolVersion(),
            author: "syncrona",
          },
        ],
      },
      component: {
        type: "application",
        ...npmComponentName(app.packageName),
        version: app.packageVersion,
        "bom-ref": purl,
        ...(app.license
          ? { licenses: [{ license: { name: app.license } }] }
          : {}),
        purl,
      },
    },
    components: [],
    dependencies: [{ ref: purl }],
  };
  return JSON.stringify(bom, null, 2);
}

/** The bom.json module record: the SDK writes it without a table attribute or sys_update_name. */
function bomRecord(
  app: AppFacts,
  sysId: string,
  modulePath: string,
  content: string,
): { path: string; xml: string } {
  const xml = [
    '<?xml version="1.0"?>',
    "<record_update>",
    '  <sys_module action="INSERT_OR_UPDATE" apply_defaults="true">',
    `    <sys_id>${sysId}</sys_id>`,
    `    <sys_scope display_value="${escapeXmlAttribute(app.scope)}">${app.scopeId}</sys_scope>`,
    `    <path>${escapeXmlText(modulePath)}</path>`,
    "    <external_source>false</external_source>",
    `    <content>${cdataSection(content)}</content>`,
    "  </sys_module>",
    "</record_update>",
  ].join("\n");
  return { path: `update/sys_module_${sysId}.xml`, xml };
}

function recordElementXml(record: RecordElementModel): RecordXmlRecord {
  return {
    table: record.table,
    action: record.action,
    applyDefaults: true,
    ...(record.attributes ? { attributes: record.attributes } : {}),
    fields: record.fields.map((f) => ({
      name: f.name,
      value: f.value,
      cdata: f.cdata,
      attributes: f.attributes,
    })),
  };
}

function compiledRecordXml(record: RecordUpdateModel): string {
  // A record with attachments shares its file with them, under a table-less record_update.
  return record.associated
    ? serializeCompositeRecordUpdate(null, [record, ...record.associated].map(recordElementXml))
    : serializeRecordUpdate(recordElementXml(record), record.rootTable);
}

function clean(
  projectDir: string,
  config: Json,
  appOutputDir: string,
  packOutputDir: string,
): void {
  const staticContent = objectOf(config.staticContent);
  const staticDir = text(staticContent?.buildDir, path.join("dist", "static"));
  for (const dir of [
    REPACK_OUTPUT_DIR,
    appOutputDir,
    packOutputDir,
    staticDir,
  ]) {
    fs.rmSync(path.resolve(projectDir, dir), { recursive: true, force: true });
  }
}

/** Build the project into its app output directory and write keys.ts back. */
export function nativeBuild(
  projectDir: string,
  options: NativeBuildOptions = {},
): SN.FluentBuildResult {
  const project = readNativeProject(projectDir);
  const { config, pkg } = readNowConfig(projectDir);
  if (!options.skipClean)
    clean(projectDir, config, project.appOutputDir, project.packOutputDir);

  const app: AppFacts = {
    projectDir,
    config,
    scope: project.scope,
    scopeId: project.scopeId,
    packageName: project.packageName,
    packageVersion: project.packageVersion,
    pkg: pkg as Json,
  };
  const errors = unsupportedContent(app);
  if (errors.length > 0) return { success: false, errors, warnings: [] };

  const application = config.type !== "configuration";
  const result = compileFluentProject({
    projectDir,
    loadTypeScript: options.loadTypeScript,
    generateGuid: options.generateGuid,
    explicitKeys: application
      ? [
          { table: "sys_module", key: "package_json" },
          { table: "sys_module", key: "bom_json" },
        ]
      : [],
  });
  const reported = (severity: FluentDiagnostic["severity"]) =>
    result.diagnostics
      .filter((d) => d.severity === severity)
      .map((d) => diagnosticText(projectDir, d));
  errors.push(...reported("error"));
  const warnings = reported("warning");

  const files = result.records.map((r) => ({
    path: r.path,
    xml: compiledRecordXml(r),
  }));
  files.push(...result.files.map((f) => ({ path: f.path, xml: f.content })));
  if (application) {
    const scopeRecord = sysAppRecord(app, errors);
    if (scopeRecord) {
      files.push(scopeRecord);
      const pkgPath = moduleResolutionPath(
        {
          scope: app.scope,
          packageResolverVersion: stringOf(config.packageResolverVersion),
        },
        { name: app.packageName, version: app.packageVersion },
        "package.json",
      );
      files.push(
        recordModel(
          app,
          "sys_module",
          result.explicitIds.package_json,
          "update",
          {
            content: packageJsonContent(app, errors),
            external_source: "false",
            path: pkgPath,
            sys_name: pkgPath,
          },
          ["content"],
        ),
      );
      const bom = sbomContent(
        { ...app, license: stringOf(app.pkg.license) },
        {
          timestamp: (options.now ?? (() => new Date()))(),
          serialNumber: (options.serialNumber ?? randomUUID)(),
        },
      );
      files.push(
        bomRecord(
          app,
          result.explicitIds.bom_json,
          pkgPath.replace(/package\.json$/, "bom.json"),
          bom,
        ),
      );
    }
  }
  if (errors.length > 0 || result.keysText === undefined)
    return { success: false, errors, warnings };

  const keysBefore = fs.existsSync(result.keysPath)
    ? fs.readFileSync(result.keysPath, "utf8")
    : undefined;
  if (options.frozenKeys && keysBefore !== result.keysText) {
    return { success: false, errors: [FROZEN_KEYS_ERROR], warnings };
  }

  const appOutput = path.resolve(projectDir, project.appOutputDir);
  for (const file of files) {
    const target = path.join(appOutput, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.xml);
  }
  if (keysBefore !== result.keysText) {
    fs.mkdirSync(path.dirname(result.keysPath), { recursive: true });
    fs.writeFileSync(result.keysPath, result.keysText);
  }
  return { success: true, errors: [], warnings };
}
