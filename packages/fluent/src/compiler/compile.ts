// SPDX-License-Identifier: GPL-3.0-or-later
//
// The native Fluent compiler's entry point: it evaluates a project's
// `*.now.ts` files, builds a record per supported API call and returns the
// record updates (and the other files) the SDK build would write, with the
// keys registry to write back. It writes no files itself.

import fs from "node:fs";
import path from "node:path";
import type * as TS from "typescript";
import {
  DiagnosticSink,
  FluentCompileError,
  type FluentDiagnostic,
} from "./diagnostics";
import { reportKeyConflicts } from "./conflicts";
import { DictionaryChecks, readDictionary } from "./dictionary";
import { FluentEvaluator, type FluentCall, type FluentDeletion } from "./evaluate";
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
  type FieldValue,
  type RecordUpdateModel,
} from "./record";
import { defaultTypeScriptLoader, type TypeScriptLoader } from "./typescript";
import {
  Options,
  type ArtefactSpec,
  type BuildContext,
} from "./artefacts/shared";
import { acl } from "./artefacts/acl";
import { aiAgent } from "./artefacts/aiAgent";
import { alias } from "./artefacts/alias";
import { aliasTemplate } from "./artefacts/aliasTemplate";
import { applicability } from "./artefacts/applicability";
import { applicationMenu } from "./artefacts/applicationMenu";
import { assessment, riskAssessment } from "./artefacts/assessment";
import { businessRule } from "./artefacts/businessRule";
import { catalogClientScript } from "./artefacts/catalogClientScript";
import { catalogItem } from "./artefacts/catalogItem";
import { catalogUiPolicy } from "./artefacts/catalogUiPolicy";
import { columnTypeCheck, linterCheck, scriptOnlyCheck, tableCheck } from "./artefacts/instanceScan";
import { choiceSet } from "./artefacts/choiceSet";
import { clientScript } from "./artefacts/clientScript";
import { crossScopePrivilege } from "./artefacts/crossScopePrivilege";
import { dashboard } from "./artefacts/dashboard/dashboard";
import { databaseView } from "./artefacts/databaseView";
import { dataLookup } from "./artefacts/dataLookup";
import { dataPolicy } from "./artefacts/dataPolicy";
import { emailNotification } from "./artefacts/emailNotification";
import { graphqlApi } from "./artefacts/graphqlApi";
import { importSet } from "./artefacts/importSet";
import { inboundEmailAction } from "./artefacts/inboundEmailAction";
import { interceptor } from "./artefacts/interceptor";
import { recordProducer } from "./artefacts/recordProducer";
import { test } from "./artefacts/test";
import { testSuite } from "./artefacts/testSuite";
import { form } from "./artefacts/form";
import { list } from "./artefacts/list";
import { nowAssistSkillConfig } from "./artefacts/nowAssistSkillConfig";
import { playbookDefinition } from "./artefacts/playbook";
import { property } from "./artefacts/property";
import { record } from "./artefacts/record";
import { restApi } from "./artefacts/restApi";
import { restMessage } from "./artefacts/restMessage";
import { retryPolicy } from "./artefacts/retryPolicy";
import { role } from "./artefacts/role";
import { spMenu, spPage } from "./artefacts/page";
import {
  cssInclude,
  jsInclude,
  servicePortal,
  spAngularProvider,
  spPageRouteMap,
  spTheme,
  spWidgetDependency,
} from "./artefacts/servicePortal";
import { scheduledScript } from "./artefacts/scheduledScript";
import { scriptAction } from "./artefacts/scriptAction";
import { scriptInclude } from "./artefacts/scriptInclude";
import { sla } from "./artefacts/sla";
import { stateModel } from "./artefacts/stateModel";
import { table } from "./artefacts/table";
import { uiAction } from "./artefacts/uiAction";
import { uiPage } from "./artefacts/uiPage";
import { uiPolicy } from "./artefacts/uiPolicy";
import { userPreference } from "./artefacts/userPreference";
import { spHeaderFooter, spWidget } from "./artefacts/widget";
import { uxListMenuConfig } from "./artefacts/uxListMenuConfig";
import { variableSet } from "./artefacts/variableSet";
import { workspace } from "./artefacts/workspace/workspace";
import { COLUMN_APIS } from "./artefacts/column";
import { VARIABLE_APIS } from "./artefacts/variables";

/** The SDK core APIs the native compiler builds. */
export const SUPPORTED_APIS: Readonly<Record<string, ArtefactSpec>> = {
  Acl: acl,
  AiAgent: aiAgent,
  Alias: alias,
  AliasTemplate: aliasTemplate,
  Applicability: applicability,
  ApplicationMenu: applicationMenu,
  Assessment: assessment,
  BusinessRule: businessRule,
  CatalogClientScript: catalogClientScript,
  CatalogItem: catalogItem,
  CatalogItemRecordProducer: recordProducer,
  CatalogUiPolicy: catalogUiPolicy,
  ChoiceSet: choiceSet,
  ClientScript: clientScript,
  ColumnTypeCheck: columnTypeCheck,
  CrossScopePrivilege: crossScopePrivilege,
  CssInclude: cssInclude,
  Dashboard: dashboard,
  DatabaseView: databaseView,
  DataLookup: dataLookup,
  DataPolicy: dataPolicy,
  EmailNotification: emailNotification,
  Form: form,
  GraphQLApi: graphqlApi,
  ImportSet: importSet,
  InboundEmailAction: inboundEmailAction,
  Interceptor: interceptor,
  JsInclude: jsInclude,
  LinterCheck: linterCheck,
  List: list,
  NowAssistSkillConfig: nowAssistSkillConfig,
  PlaybookDefinition: playbookDefinition,
  Property: property,
  Record: record,
  RestApi: restApi,
  RestMessage: restMessage,
  RetryPolicy: retryPolicy,
  RiskAssessment: riskAssessment,
  Role: role,
  ScheduledScript: scheduledScript,
  ScriptAction: scriptAction,
  ScriptInclude: scriptInclude,
  ScriptOnlyCheck: scriptOnlyCheck,
  ServicePortal: servicePortal,
  Sla: sla,
  SPAngularProvider: spAngularProvider,
  SPHeaderFooter: spHeaderFooter,
  SPMenu: spMenu,
  SPPage: spPage,
  SPPageRouteMap: spPageRouteMap,
  SPTheme: spTheme,
  SPWidget: spWidget,
  SPWidgetDependency: spWidgetDependency,
  StateModel: stateModel,
  Table: table,
  TableCheck: tableCheck,
  Test: test,
  TestSuite: testSuite,
  UiAction: uiAction,
  UiPage: uiPage,
  UiPolicy: uiPolicy,
  UserPreference: userPreference,
  UxListMenuConfig: uxListMenuConfig,
  VariableSet: variableSet,
  Workspace: workspace,
};

/** Names of the SDK core APIs the native compiler builds. */
export const SUPPORTED_FLUENT_APIS: readonly string[] =
  Object.keys(SUPPORTED_APIS);

/**
 * Tables the supported APIs produce, besides the ones Record() writes; keys of
 * any other table are kept as they are.
 */
const EMITTED_TABLES = new Set([
  "asmt_metric",
  "asmt_metric_category",
  "asmt_metric_definition",
  "asmt_metric_type",
  "catalog_script_client",
  "catalog_ui_policy",
  "catalog_ui_policy_action",
  "change_risk_asmt",
  "change_risk_asmt_threshold",
  "chg_model",
  "contract_sla",
  "dl_definition",
  "dl_definition_rel_match",
  "dl_definition_rel_set",
  "fx_price",
  "io_set_item",
  "item_option_new",
  "item_option_new_set",
  "m2m_connected_content",
  "m2m_sp_dependency_css_include",
  "m2m_sp_dependency_js_include",
  "m2m_sp_ng_pro_sp_ng_pro",
  "m2m_sp_ng_pro_sp_widget",
  "m2m_sp_portal_catalog",
  "m2m_sp_portal_knowledge_base",
  "m2m_sp_portal_search_source",
  "m2m_sp_portal_taxonomy",
  "m2m_sp_theme_css_include",
  "m2m_sp_theme_js_include",
  "m2m_sp_widget_dependency",
  "par_dashboard",
  "par_dashboard_canvas",
  "par_dashboard_permission",
  "par_dashboard_tab",
  "par_dashboard_visibility",
  "par_dashboard_widget",
  "prb_model",
  "prb_task_model",
  "question_choice",
  "sc_cat_item",
  "sc_cat_item_catalog",
  "sc_cat_item_category",
  "sc_cat_item_producer",
  "sc_cat_item_user_criteria_mtom",
  "sc_cat_item_user_criteria_no_mtom",
  "scan_column_type_check",
  "scan_linter_check",
  "scan_script_only_check",
  "scan_table_check",
  "sn_aia_agent",
  "sn_aia_agent_config",
  "sn_aia_agent_tool_m2m",
  "sn_aia_ltm_category_mapping",
  "sn_aia_tool",
  "sn_aia_trigger_agent_usecase_m2m",
  "sn_aia_trigger_configuration",
  "sn_aia_version",
  "sn_nowassist_skill_config",
  "sn_nowassist_skill_config_status",
  "sp_angular_provider",
  "sp_column",
  "sp_container",
  "sp_css_include",
  "sp_dependency",
  "sp_header_footer",
  "sp_instance",
  "sp_instance_menu",
  "sp_js_include",
  "sp_ng_template",
  "sp_page",
  "sp_page_route_map",
  "sp_portal",
  "sp_rectangle_menu_item",
  "sp_row",
  "sp_theme",
  "sp_widget",
  "sttrm_model",
  "sttrm_model_user_criteria_hide_mtom",
  "sttrm_model_user_criteria_read_mtom",
  "sttrm_model_user_criteria_write_mtom",
  "sttrm_state",
  "sttrm_state_attribute",
  "sttrm_state_transition",
  "sttrm_transition_condition",
  "sttrm_transition_condition_field",
  "sys_agent_access_role_configuration",
  "sys_agent_access_role_mapping",
  "sys_alias",
  "sys_alias_templates",
  "sys_app_application",
  "sys_atf_step",
  "sys_atf_test",
  "sys_atf_test_suite",
  "sys_atf_test_suite_test",
  "sys_choice",
  "sys_choice_set",
  "sys_data_policy2",
  "sys_data_policy_rule",
  "sys_db_object",
  "sys_db_view",
  "sys_db_view_table",
  "sys_db_view_table_field",
  "sys_dictionary",
  "sys_documentation",
  "sys_element_mapping",
  "sys_gen_ai_feature_mapping",
  "sys_gen_ai_strategy_mapping",
  "sys_generative_ai_config",
  "sys_generative_ai_prompt_config",
  "sys_graphql_resolver",
  "sys_graphql_resolver_mapping",
  "sys_graphql_schema",
  "sys_graphql_typeresolver",
  "sys_one_extend_capability",
  "sys_one_extend_capability_definition",
  "sys_one_extend_definition_attribute",
  "sys_one_extend_definition_config",
  "sys_one_extend_resource_mapping",
  "sys_pd_activity",
  "sys_pd_lane",
  "sys_pd_process_definition",
  "sys_pd_process_input",
  "sys_pd_trigger_instance",
  "sys_properties",
  "sys_rest_message",
  "sys_rest_message_fn",
  "sys_rest_message_fn_headers",
  "sys_rest_message_fn_param_defs",
  "sys_rest_message_fn_parameters",
  "sys_rest_message_headers",
  "sys_retry_policy",
  "sys_scope_privilege",
  "sys_script",
  "sys_script_client",
  "sys_script_include",
  "sys_security_acl",
  "sys_security_acl_role",
  "sys_transform_entry",
  "sys_transform_map",
  "sys_transform_script",
  "sys_trigger",
  "sys_ui_action",
  "sys_ui_action_role",
  "sys_ui_action_view",
  "sys_ui_annotation",
  "sys_ui_element",
  "sys_ui_form",
  "sys_ui_form_section",
  "sys_ui_list",
  "sys_ui_list_element",
  "sys_ui_page",
  "sys_ui_policy",
  "sys_ui_policy_action",
  "sys_ui_policy_rl_action",
  "sys_ui_section",
  "sys_user_preference",
  "sys_user_role",
  "sys_user_role_contains",
  "sys_ux_app_config",
  "sys_ux_app_route",
  "sys_ux_applicability",
  "sys_ux_applicability_m2m_list",
  "sys_ux_list",
  "sys_ux_list_category",
  "sys_ux_list_menu_config",
  "sys_ux_macroponent",
  "sys_ux_page_property",
  "sys_ux_page_registry",
  "sys_ux_registry_m2m_category",
  "sys_ux_screen",
  "sys_ux_screen_type",
  "sys_variable_value",
  "sys_wizard",
  "sys_wizard_answer",
  "sys_ws_definition",
  "sys_ws_header",
  "sys_ws_header_map",
  "sys_ws_operation",
  "sys_ws_query_parameter",
  "sys_ws_query_parameter_map",
  "sys_ws_version",
  "sysauto_script",
  "sysevent_email_action",
  "sysevent_in_email_action",
  "sysevent_script_action",
  "ua_table_licensing_config",
]);

export interface CompileFluentOptions {
  projectDir: string;
  loadTypeScript?: TypeScriptLoader;
  /** Generates the sys_id of a new key (tests pin it). */
  generateGuid?: GuidGenerator;
  /**
   * Explicit keys of records the caller builds itself (the build's
   * `sys_module` rows), registered so keys.ts keeps their sys_ids.
   */
  explicitKeys?: readonly { table: string; key: string }[];
}

export interface CompileFluentResult {
  /** False when any error diagnostic was reported. */
  ok: boolean;
  /** Record updates ordered by path. */
  records: RecordUpdateModel[];
  /** The keys.ts text to write back; absent when the project could not be read or its keys conflict. */
  keysText?: string;
  keysPath: string;
  /** The sys_id of each `explicitKeys` entry, by key; empty when the project could not be read. */
  explicitIds: Record<string, string>;
  /** Files other than record updates (a table's dictionary and choice files), ordered by path. */
  files: { path: string; content: string }[];
  diagnostics: FluentDiagnostic[];
}

interface NowConfig {
  scope: string;
  scopeId: string;
  fluentDir: string;
  generatedDir: string;
  defaultLanguage: string;
  tableConfigError?: string;
  choiceSetConfigError?: string;
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
  // Table() writes what the SDK writes with these settings at their defaults.
  const tableDefaults: [string, unknown][] = [
    ["emitDictionary", true],
    ["legacyChoices", true],
    ["tableOutputFormat", "bootstrap"],
  ];
  const changed = tableDefaults.filter(
    ([key, value]) => config[key] !== undefined && config[key] !== value,
  );
  return {
    scope: text("scope"),
    scopeId: text("scopeId"),
    fluentDir: text("fluentDir", "src/fluent"),
    generatedDir: text("generatedDir", "generated"),
    defaultLanguage: text(
      "defaultLanguage",
      (config.tableDefaultLanguage as string | undefined) ?? "en",
    ),
    ...(changed.length === 0
      ? {}
      : {
          tableConfigError: `Table(): now.config.json ${changed
            .map(([key, value]) => `'${key}' other than ${JSON.stringify(value)}`)
            .join(", ")} is not supported by the native compiler yet.`,
        }),
    ...(config.legacyChoices === undefined || config.legacyChoices === true
      ? {}
      : {
          choiceSetConfigError:
            "ChoiceSet(): now.config.json 'legacyChoices' other than true is not supported by the native compiler yet.",
        }),
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

/**
 * The record a `Now.del()` statement deletes. A key value is a string, a
 * record of the app or a `Now.ref()` by GUID; like the SDK, it is written as
 * the sys_id, without the reference's attributes.
 */
function compileDeletion(deletion: FluentDeletion, ctx: BuildContext): CompiledRecord {
  const { table, target, loc } = deletion;
  if (typeof target === "string") return ctx.factory.createDeletion(table, target, {}, loc);
  const fields: Record<string, FieldValue> = {};
  for (const [key, value] of target) {
    if (value.kind === "string") fields[key] = value.value;
    else if (value.kind === "call") fields[key] = ctx.recordOf(value).id;
    else if (value.kind === "ref" && value.guid !== undefined && value.keys === undefined) {
      fields[key] = ctx.factory.createReference(value.table, value.guid);
    } else {
      throw new FluentCompileError(
        `Now.del(): the key '${key}' must be a string, a record or a Now.ref() by sys_id.`,
        value.loc,
      );
    }
  }
  return ctx.factory.createDeletion(table, undefined, fields, loc);
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
    return {
      ok: false,
      records: [],
      keysPath,
      explicitIds: {},
      files: [],
      diagnostics: sink.diagnostics,
    };
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
  const explicitIds: Record<string, string> = {};
  for (const { table, key } of options.explicitKeys ?? [])
    explicitIds[key] = registry.registerExplicitId(table, key);
  const factory = new RecordFactory(
    registry,
    config.scope,
    config.scopeId,
    guid,
  );

  const evaluator = new FluentEvaluator(ts, sink, projectDir);
  for (const file of findSources(fluentDir, generatedDir))
    evaluator.evaluateFile(file);

  const files: { path: string; content: string }[] = [];
  const inspections: ((records: readonly CompiledRecord[]) => void)[] = [];
  const built = new Map<
    FluentCall,
    { record?: CompiledRecord; error?: unknown }
  >();
  const ctx: BuildContext = {
    ts,
    scope: config.scope,
    scopeId: config.scopeId,
    factory,
    defaultLanguage: config.defaultLanguage,
    ...(config.tableConfigError === undefined
      ? {}
      : { tableConfigError: config.tableConfigError }),
    ...(config.choiceSetConfigError === undefined
      ? {}
      : { choiceSetConfigError: config.choiceSetConfigError }),
    emitFile: (filePath, content) => files.push({ path: filePath, content }),
    dictionary: new DictionaryChecks(),
    inspect: (check) => inspections.push(check),
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
    // The SDK leaves the policy to the builder when it writes the root's sys_policy itself.
    const policy = opts.protectionPolicy();
    if (policy !== undefined && record.fields.get("sys_policy") === undefined) {
      for (const r of flatten(record)) {
        if (r.fields.get("sys_policy") === undefined)
          r.fields.set("sys_policy", policy);
      }
    }
    opts.applyOverride(record);
    return record;
  };

  const roots: CompiledRecord[] = [];
  for (const call of evaluator.calls) {
    // Columns compile as part of their Table().
    if (COLUMN_APIS.includes(call.api)) continue;
    if (VARIABLE_APIS.includes(call.api)) continue;
    try {
      roots.push(ctx.recordOf(call));
    } catch (e) {
      /* istanbul ignore next -- builders throw only FluentCompileError; anything else is a compiler bug to surface */
      if (!(e instanceof FluentCompileError)) throw e;
      sink.report("error", e.message, e.location);
    }
  }

  for (const deletion of evaluator.deletions) {
    try {
      roots.push(compileDeletion(deletion, ctx));
    } catch (e) {
      /* istanbul ignore next -- compileDeletion throws only FluentCompileError; anything else is a compiler bug to surface */
      if (!(e instanceof FluentCompileError)) throw e;
      sink.report("error", e.message, e.location);
    }
  }
  ctx.dictionary.check(readDictionary(ts, projectDir, ctx.report), ctx.report);

  const all = roots.flatMap(flatten);
  for (const check of inspections) check(all);
  const conflicts = reportKeyConflicts(all, projectDir, (message, location) =>
    sink.report("error", message, location),
  );
  const records = all
    .filter((r) => r.emit !== false)
    .map(toRecordUpdate)
    .sort((a, b) => a.path.localeCompare(b.path));
  // Like the SDK, keys are committed only once they are conflict-free: the
  // registry would otherwise hand one `$id` to whichever table claimed it last.
  const keysText =
    conflicts > 0
      ? undefined
      : writeKeysFile(
          registry.commit(
            (table) => !EMITTED_TABLES.has(table) && !all.some((r) => r.table === table),
          ),
        );
  return {
    ok: !sink.hasErrors,
    records,
    ...(keysText === undefined ? {} : { keysText }),
    keysPath,
    explicitIds,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    diagnostics: sink.diagnostics,
  };
}
