// SPDX-License-Identifier: GPL-3.0-or-later
//
// The native Fluent compiler's entry point: it evaluates a project's
// `*.now.ts` files, builds a record per supported API call and returns the
// record updates the SDK build would write, with the keys registry to write
// back. It writes no files itself.

import fs from "node:fs";
import path from "node:path";
import type * as TS from "typescript";
import {
  DiagnosticSink,
  FluentCompileError,
  type FluentDiagnostic,
} from "./diagnostics";
import { reportKeyConflicts } from "./conflicts";
import { FluentEvaluator, type FluentCall } from "./evaluate";
import {
  defaultGuid,
  KeysRegistry,
  type GuidGenerator,
  type KeysData,
} from "./keys";
import {
  KEYS_FILE_NAME,
  KeysFileError,
  parseKeysFile,
  writeKeysFile,
} from "./keysFile";
import {
  RecordFactory,
  toRecordUpdate,
  type CompiledRecord,
  type RecordUpdateModel,
} from "./record";
import { defaultTypeScriptLoader, type TypeScriptLoader } from "./typescript";
import {
  Options,
  type ArtefactSpec,
  type BuildContext,
} from "./artefacts/shared";
import { acl } from "./artefacts/acl";
import { businessRule } from "./artefacts/businessRule";
import { clientScript } from "./artefacts/clientScript";
import { property } from "./artefacts/property";
import { role } from "./artefacts/role";
import { scriptInclude } from "./artefacts/scriptInclude";
import { uiAction } from "./artefacts/uiAction";

/** The SDK core APIs the native compiler builds. */
export const SUPPORTED_APIS: Readonly<Record<string, ArtefactSpec>> = {
  Acl: acl,
  BusinessRule: businessRule,
  ClientScript: clientScript,
  Property: property,
  Role: role,
  ScriptInclude: scriptInclude,
  UiAction: uiAction,
};

/** Names of the SDK core APIs the native compiler builds. */
export const SUPPORTED_FLUENT_APIS: readonly string[] =
  Object.keys(SUPPORTED_APIS);

/** Tables the supported APIs produce; keys of any other table are kept as they are. */
const EMITTED_TABLES = new Set([
  "sys_properties",
  "sys_script",
  "sys_script_client",
  "sys_script_include",
  "sys_security_acl",
  "sys_security_acl_role",
  "sys_ui_action",
  "sys_ui_action_role",
  "sys_ui_action_view",
  "sys_user_role",
  "sys_user_role_contains",
]);

export interface CompileFluentOptions {
  projectDir: string;
  loadTypeScript?: TypeScriptLoader;
  /** Generates the sys_id of a new key (tests pin it). */
  generateGuid?: GuidGenerator;
}

export interface CompileFluentResult {
  /** False when any error diagnostic was reported. */
  ok: boolean;
  /** Record updates ordered by path. */
  records: RecordUpdateModel[];
  /** The keys.ts text to write back; absent when the project could not be read or its keys conflict. */
  keysText?: string;
  keysPath: string;
  diagnostics: FluentDiagnostic[];
}

interface NowConfig {
  scope: string;
  scopeId: string;
  fluentDir: string;
  generatedDir: string;
}

function readConfig(projectDir: string): NowConfig {
  const file = path.join(projectDir, "now.config.json");
  const at = { file, line: 1, column: 1 };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new FluentCompileError(
      `Cannot read now.config.json: ${(e as Error).message}`,
      at,
    );
  }
  const config = (raw ?? {}) as Record<string, unknown>;
  const text = (key: string, fallback?: string): string => {
    const value = config[key] ?? fallback;
    if (typeof value !== "string" || value === "")
      throw new FluentCompileError(
        `now.config.json needs a string '${key}'.`,
        at,
      );
    return value;
  };
  return {
    scope: text("scope"),
    scopeId: text("scopeId"),
    fluentDir: text("fluentDir", "src/fluent"),
    generatedDir: text("generatedDir", "generated"),
  };
}

/** Every `*.now.ts` file under `dir`, sorted, skipping `skipDir` and node_modules. */
function findSources(dir: string, skipDir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (full !== skipDir && entry.name !== "node_modules") walk(full);
      } else if (entry.name.endsWith(".now.ts")) out.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

function flatten(record: CompiledRecord): CompiledRecord[] {
  return [record, ...record.children.flatMap(flatten)];
}

export function compileFluentProject(
  options: CompileFluentOptions,
): CompileFluentResult {
  const projectDir = path.resolve(options.projectDir);
  const ts = (options.loadTypeScript ?? defaultTypeScriptLoader)(
    projectDir,
  ) as typeof TS;
  const guid = options.generateGuid ?? defaultGuid;
  const sink = new DiagnosticSink();
  const fail = (
    e: FluentCompileError,
    keysPath: string,
  ): CompileFluentResult => {
    sink.report("error", e.message, e.location);
    return { ok: false, records: [], keysPath, diagnostics: sink.diagnostics };
  };

  let config: NowConfig;
  try {
    config = readConfig(projectDir);
  } catch (e) {
    return fail(
      e as FluentCompileError,
      path.join(projectDir, "src/fluent/generated", KEYS_FILE_NAME),
    );
  }
  const fluentDir = path.join(projectDir, config.fluentDir);
  const generatedDir = path.join(fluentDir, config.generatedDir);
  const keysPath = path.join(generatedDir, KEYS_FILE_NAME);

  let keys: KeysData | undefined;
  if (fs.existsSync(keysPath)) {
    try {
      keys = parseKeysFile(ts, fs.readFileSync(keysPath, "utf8"), keysPath);
    } catch (e) {
      /* istanbul ignore next -- parseKeysFile throws only KeysFileError; anything else is a bug to surface */
      if (!(e instanceof KeysFileError)) throw e;
      return fail(
        new FluentCompileError(e.message, {
          file: keysPath,
          line: 1,
          column: 1,
        }),
        keysPath,
      );
    }
  }
  const registry = new KeysRegistry(keys, guid);
  const factory = new RecordFactory(
    registry,
    config.scope,
    config.scopeId,
    guid,
  );

  const evaluator = new FluentEvaluator(ts, sink);
  for (const file of findSources(fluentDir, generatedDir))
    evaluator.evaluateFile(file);

  const built = new Map<
    FluentCall,
    { record?: CompiledRecord; error?: unknown }
  >();
  const ctx: BuildContext = {
    ts,
    scope: config.scope,
    scopeId: config.scopeId,
    factory,
    report: (severity, message, location) =>
      sink.report(severity, message, location),
    recordOf(call) {
      const state = built.get(call);
      if (state?.record) return state.record;
      if (state?.error) throw state.error;
      // Argument values are trees built before their call, so a call never
      // reaches itself; the guard stops a builder bug from recursing forever.
      /* istanbul ignore next -- unreachable through Fluent sources, see above */
      if (state)
        throw new FluentCompileError(
          `${call.api}() depends on itself.`,
          call.loc,
        );
      built.set(call, {});
      try {
        const record = build(call);
        built.set(call, { record });
        return record;
      } catch (e) {
        built.set(call, { error: e });
        throw e;
      }
    },
  };
  const build = (call: FluentCall): CompiledRecord => {
    const spec = SUPPORTED_APIS[call.api];
    if (!spec) {
      throw new FluentCompileError(
        `${call.api}() is not supported by the native compiler yet (supported: ${Object.keys(SUPPORTED_APIS).join(", ")}).`,
        call.loc,
      );
    }
    const opts = Options.of(call, spec, ctx);
    const record = spec.build(opts, ctx);
    const policy = opts.protectionPolicy();
    if (policy !== undefined) {
      for (const r of flatten(record)) {
        if (r.fields.get("sys_policy") === undefined)
          r.fields.set("sys_policy", policy);
      }
    }
    return record;
  };

  const roots: CompiledRecord[] = [];
  for (const call of evaluator.calls) {
    try {
      roots.push(ctx.recordOf(call));
    } catch (e) {
      /* istanbul ignore next -- builders throw only FluentCompileError; anything else is a compiler bug to surface */
      if (!(e instanceof FluentCompileError)) throw e;
      sink.report("error", e.message, e.location);
    }
  }

  const all = roots.flatMap(flatten);
  const conflicts = reportKeyConflicts(all, projectDir, (message, location) =>
    sink.report("error", message, location),
  );
  const records = all
    .map(toRecordUpdate)
    .sort((a, b) => a.path.localeCompare(b.path));
  // Like the SDK, keys are committed only once they are conflict-free: the
  // registry would otherwise hand one `$id` to whichever table claimed it last.
  const keysText =
    conflicts > 0
      ? undefined
      : writeKeysFile(registry.commit((table) => !EMITTED_TABLES.has(table)));
  return {
    ok: !sink.hasErrors,
    records,
    ...(keysText === undefined ? {} : { keysText }),
    keysPath,
    diagnostics: sink.diagnostics,
  };
}
