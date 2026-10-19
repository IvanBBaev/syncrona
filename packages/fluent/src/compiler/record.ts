// SPDX-License-Identifier: GPL-3.0-or-later
//
// The record model the compiler builds and the factory that gives each record
// its sys_id through the keys registry, the way the SDK's factory does:
//
// - a table with a coalesce strategy registers its coalesce values as a
//   composite key (an explicit `$id` already in the registry keeps its sys_id);
// - otherwise an explicit `$id` registers an explicit key;
// - a reference resolves lazily, on its first read, so records declared later
//   have registered by then.

import { FluentCompileError, type SourceLocation } from "./diagnostics";
import { isGUID, type CoalesceKeys, type GuidGenerator, type KeyReference, type KeysRegistry } from "./keys";

/** `author_elective_update` holds the records `Now.del()` deletes. */
export type InstallCategory = "update" | "unload" | "unload.demo" | "apply_once" | "author_elective_update";

/** Tables whose records are identified by these field values instead of an `$id`. */
export const COALESCE_STRATEGIES: Record<string, readonly string[]> = {
  sys_user_role: ["name"],
  io_set_item: ["sc_cat_item", "variable_set"],
  catalog_ui_policy_action: ["ui_policy", "catalog_variable"],
  sc_cat_item_catalog: ["sc_cat_item", "sc_catalog"],
  sc_cat_item_category: ["sc_cat_item", "sc_category"],
  sc_cat_item_user_criteria_mtom: ["sc_cat_item", "user_criteria"],
  sc_cat_item_user_criteria_no_mtom: ["sc_cat_item", "user_criteria"],
  m2m_connected_content: ["catalog_item", "topic"],
  sys_user_role_contains: ["role", "contains"],
  sys_security_acl_role: ["sys_security_acl", "sys_user_role"],
  sys_ui_action_role: ["sys_ui_action", "sys_user_role"],
  sys_ui_action_view: ["sys_ui_action", "sys_ui_view"],
  sys_ui_policy: ["table", "short_description"],
  sys_ui_policy_action: ["ui_policy", "field"],
  sys_ui_policy_rl_action: ["ui_policy", "list"],
  sys_dictionary: ["name", "element"],
  sys_documentation: ["name", "element", "language"],
  ua_table_licensing_config: ["name"],
  sys_db_object: ["name"],
  sys_choice_set: ["name", "element"],
  sys_choice: ["name", "element", "value", "language", "dependent_value"],
  par_dashboard_canvas: ["dashboard", "dashboard_tab"],
  par_dashboard_visibility: ["dashboard", "experience"],
  par_dashboard_permission: ["dashboard", "user", "group", "role"],
  m2m_sp_ng_pro_sp_ng_pro: ["required_by", "requires"],
  m2m_sp_dependency_css_include: ["sp_css_include", "sp_dependency"],
  m2m_sp_dependency_js_include: ["sp_js_include", "sp_dependency"],
  m2m_sp_theme_css_include: ["sp_css_include", "sp_theme"],
  m2m_sp_theme_js_include: ["sp_js_include", "sp_theme"],
  sp_page_route_map: ["route_from_page", "portals"],
  sys_pd_process_input: ["element", "model"],
  m2m_sp_widget_dependency: ["sp_widget", "sp_dependency"],
  m2m_sp_ng_pro_sp_widget: ["sp_widget", "sp_angular_provider"],
  sttrm_model_user_criteria_read_mtom: ["sttrm_model", "user_criteria"],
  sttrm_model_user_criteria_write_mtom: ["sttrm_model", "user_criteria"],
  sttrm_model_user_criteria_hide_mtom: ["sttrm_model", "user_criteria"],
  sp_page: ["id"],
  fx_price: ["id", "field"],
  item_option_new: ["cat_item", "variable_set", "name"],
  question_choice: ["question", "value"],
  m2m_sp_portal_search_source: ["sp_portal", "sp_search_source"],
  m2m_sp_portal_knowledge_base: ["sp_portal", "kb_knowledge_base"],
  m2m_sp_portal_catalog: ["sp_portal", "sc_catalog"],
  m2m_sp_portal_taxonomy: ["sp_portal", "taxonomy"],
  sys_db_view: ["name"],
  sys_ui_view: ["name"],
  sys_ui_list: ["name", "view", "sys_domain", "element", "relationship", "parent"],
  sys_ui_list_element: ["list_id", "element"],
  sys_ui_form: ["name", "view", "sys_domain"],
  sys_ui_section: ["name", "caption", "view", "sys_domain"],
  sys_ui_form_section: ["sys_ui_form", "sys_ui_section"],
  sys_ui_element: ["sys_ui_section", "element", "position"],
  sys_wizard: ["name"],
  sys_rest_message_fn: ["rest_message", "function_name"],
  sys_ws_header_map: ["web_service_operation", "web_service_header"],
  sys_ws_query_parameter_map: ["web_service_operation", "web_service_query_parameter"],
  sys_atf_test_suite_test: ["test_suite", "test"],
  sys_variable_value: ["document_key", "variable"],
  sys_element_mapping: ["id", "table", "field"],
  sys_transform_entry: ["map", "target_field"],
  sys_graphql_resolver_mapping: ["schema", "path"],
  asmt_metric_definition: ["metric", "value"],
  sn_nowassist_skill_config: ["skill_id"],
  sn_nowassist_skill_config_status: ["skill_config"],
  sys_one_extend_capability_definition: ["capability", "api"],
  sys_one_extend_definition_config: ["definition", "capability"],
  sys_generative_ai_prompt_config: ["ai_config"],
  sys_gen_ai_feature_mapping: ["feature_name", "document"],
  sys_gen_ai_strategy_mapping: ["strategy", "feature"],
  sys_one_extend_resource_mapping: ["parent_capability", "resource_capability"],
  sys_agent_access_role_configuration: ["agent"],
  sn_aia_agent_config: ["agent"],
  sn_aia_version: ["target_id", "version_name"],
  sn_aia_tool: ["name"],
  sn_aia_agent_tool_m2m: ["agent", "tool", "name"],
  sys_agent_access_role_mapping: ["agent_access_config", "role"],
  sn_aia_trigger_configuration: ["name", "usecase"],
  sn_aia_trigger_agent_usecase_m2m: ["trigger_configuration", "related_resource_record"],
  sn_aia_ltm_category_mapping: ["entity_id", "category"],
};

export class RecordId implements KeyReference {
  private resolved?: string;
  /** XML attributes rendered before the coalesce key attributes. */
  readonly attributes: Record<string, string> = {};

  constructor(
    readonly table: string,
    private readonly guid: string | (() => string),
    readonly keys?: CoalesceKeys,
  ) {}

  getValue(): string {
    this.resolved ??= typeof this.guid === "string" ? this.guid : this.guid();
    return this.resolved;
  }

  getKeys(): CoalesceKeys | undefined {
    return this.keys;
  }

  withAttribute(name: string, value: string): this {
    this.attributes[name] = value;
    return this;
  }
}

/** A field rendered as a CDATA section. */
export class CData {
  constructor(readonly text: string) {}
}

export type FieldValue = string | number | boolean | undefined | RecordId | CData;

export interface CompiledRecord {
  table: string;
  id: RecordId;
  installCategory: InstallCategory;
  fields: Map<string, FieldValue>;
  /** Records the same API call produced along with this one (m2m rows and the like). */
  children: CompiledRecord[];
  source: SourceLocation;
  /** The `$id` the record was declared with, if any. */
  explicitKey?: string;
  /** Replaces `<table>_<sys_id>` as the sys_update_name and file name. */
  updateName?: string;
  /** Attributes of the record element, rendered between `action` and `apply_defaults`. */
  elementAttributes?: Record<string, string>;
  /** false: the record registers its key but is written by another file (or not at all). */
  emit?: false;
  /** `DELETE`: the record update deletes the record (`Now.del()`). */
  action?: "DELETE";
  /** Records written after this one in its own file (`Now.attach()` attachments); they register no key. */
  associated?: CompiledRecord[];
  /** Replaces the table on the file's `record_update` element (the SDK writes `[object Object]` for some plugins). */
  rootTable?: string;
  /** Fields written once more after the sorted ones, the way the SDK repeats a field it merged in late. */
  trailingFields?: string[];
}

export interface CreateRecordOptions {
  table: string;
  source: SourceLocation;
  installCategory: InstallCategory;
  explicitId?: string | number;
  fields: Record<string, FieldValue | CompiledRecord>;
  updateName?: string;
  elementAttributes?: Record<string, string>;
  emit?: false;
  /** The fields that identify the record, when they depend on its values (overrides COALESCE_STRATEGIES). */
  coalesce?: readonly string[];
}

function isCompiledRecord(v: unknown): v is CompiledRecord {
  return typeof v === "object" && v !== null && "fields" in v;
}

export class RecordFactory {
  constructor(
    private readonly registry: KeysRegistry,
    private readonly scope: string,
    private readonly scopeId: string,
    private readonly guid: GuidGenerator,
  ) {}

  createRecord(options: CreateRecordOptions): CompiledRecord {
    const { table, explicitId } = options;
    const fields = new Map<string, FieldValue>(
      Object.entries(options.fields).map(([k, v]) => [k, isCompiledRecord(v) ? v.id : v]),
    );
    // An explicit id that is a GUID is the sys_id.
    const guidOverride = typeof explicitId === "string" && isGUID(explicitId) ? explicitId : undefined;
    const strategy = options.coalesce ?? COALESCE_STRATEGIES[table];
    let id: RecordId;
    if (strategy) {
      const keys: CoalesceKeys = Object.fromEntries(
        strategy.map((k) => {
          const v = fields.get(k);
          return [k, v instanceof RecordId ? v : (v === undefined ? "" : String(v)) || "NULL"];
        }),
      );
      const override = explicitId ? (this.registry.queryExplicitId(table, explicitId) ?? guidOverride) : guidOverride;
      id = new RecordId(table, this.registry.registerCompositeId(table, keys, override), keys);
    } else if (explicitId) {
      id = new RecordId(table, this.registry.registerExplicitId(table, explicitId, guidOverride));
    } else {
      throw new FluentCompileError(`Cannot determine the sys_id of this ${table} record: give it a $id.`, options.source);
    }
    fields.set("sys_scope", new RecordId("sys_scope", this.scopeId).withAttribute("display_value", this.scope));
    fields.set("sys_update_name", options.updateName ?? `${table}_${id.getValue()}`);
    const explicitKey = explicitId === undefined || explicitId === "" ? {} : { explicitKey: String(explicitId) };
    return {
      table,
      id,
      installCategory: options.installCategory,
      fields,
      children: [],
      source: options.source,
      ...explicitKey,
      ...(options.updateName === undefined ? {} : { updateName: options.updateName }),
      ...(options.elementAttributes === undefined ? {} : { elementAttributes: options.elementAttributes }),
      ...(options.emit === false ? { emit: false as const } : {}),
    };
  }

  /**
   * The record `Now.del(table, sysIdOrKeys)` deletes. Like the SDK, it does not
   * register a key: a record deleted by its coalesce keys gets a fresh sys_id.
   */
  createDeletion(table: string, sysId: string | undefined, fields: Record<string, FieldValue>, source: SourceLocation): CompiledRecord {
    const id = new RecordId(table, sysId ?? this.guid());
    return { ...this.unregistered(table, id, "author_elective_update", fields, source), action: "DELETE" };
  }

  /** A record written inside another record's file under a sys_id of its own; it registers no key. */
  createAssociated(table: string, sysId: string, source: SourceLocation, fields: Record<string, FieldValue>): CompiledRecord {
    // The install category is that of the file the record lands in, never its own.
    return this.unregistered(table, new RecordId(table, sysId), "update", fields, source);
  }

  private unregistered(
    table: string,
    id: RecordId,
    installCategory: InstallCategory,
    fields: Record<string, FieldValue>,
    source: SourceLocation,
  ): CompiledRecord {
    const all = new Map<string, FieldValue>(Object.entries(fields));
    all.set("sys_scope", new RecordId("sys_scope", this.scopeId).withAttribute("display_value", this.scope));
    all.set("sys_update_name", `${table}_${id.getValue()}`);
    return { table, id, installCategory, fields: all, children: [], source };
  }

  /** A reference to a record by GUID, `$id` key or coalesce keys, resolved on first read. */
  createReference(table: string, guid?: string, keys?: Record<string, string | RecordId | CompiledRecord>): RecordId {
    const coalesce: CoalesceKeys | undefined = keys
      ? Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, typeof v === "string" ? v : isCompiledRecord(v) ? v.id : v]))
      : undefined;
    return new RecordId(
      table,
      () => {
        // The fallback is computed only when needed, so a resolved key never consumes a fresh GUID.
        const fallback = () => (guid ? (isGUID(guid) ? guid : (this.registry.queryExplicitId(table, guid) ?? guid)) : this.guid());
        return (coalesce && this.registry.queryCompositeId(table, coalesce)) || fallback();
      },
      coalesce,
    );
  }
}

// --- Output model ---------------------------------------------------------------

export interface RecordUpdateField {
  name: string;
  /** Absent or empty renders as an empty element. */
  value?: string;
  cdata?: boolean;
  attributes?: Record<string, string>;
}

/** One record element of a `<record_update>` file. */
export interface RecordElementModel {
  table: string;
  sysId: string;
  action: "INSERT_OR_UPDATE" | "DELETE";
  /** Extra attributes of the record element, between `action` and `apply_defaults`. */
  attributes?: Record<string, string>;
  /** In output order: sys_id, sys_scope, sys_update_name, then the rest by name. */
  fields: RecordUpdateField[];
}

/** One `<record_update>` file: `<installCategory>/<table>_<sysId>.xml` under the app's dist directory. */
export interface RecordUpdateModel extends RecordElementModel {
  installCategory: InstallCategory;
  path: string;
  /**
   * Records written after this one in the same file. Like the SDK, such a
   * file's `record_update` element carries no `table` attribute.
   */
  associated?: RecordElementModel[];
  /** Replaces the table on the `record_update` element. */
  rootTable?: string;
}

const LEADING_FIELDS = ["sys_scope", "sys_update_name"];

function toField(name: string, value: FieldValue): RecordUpdateField {
  if (value instanceof CData) return { name, value: value.text, cdata: true };
  if (value instanceof RecordId) {
    const attributes: Record<string, string> = { ...value.attributes };
    for (const [k, v] of Object.entries(value.keys ?? {})) attributes[k] = typeof v === "string" ? v : v.getValue();
    return { name, value: value.getValue(), ...(Object.keys(attributes).length > 0 ? { attributes } : {}) };
  }
  return value === undefined ? { name } : { name, value: String(value) };
}

function toElement(record: CompiledRecord): RecordElementModel {
  const sysId = record.id.getValue();
  const rest = [...record.fields.keys()].filter((k) => !LEADING_FIELDS.includes(k)).sort((a, b) => a.localeCompare(b));
  return {
    table: record.table,
    sysId,
    action: record.action ?? "INSERT_OR_UPDATE",
    ...(record.elementAttributes ? { attributes: record.elementAttributes } : {}),
    fields: [
      { name: "sys_id", value: sysId },
      ...[...LEADING_FIELDS, ...rest, ...(record.trailingFields ?? [])].map((k) => toField(k, record.fields.get(k))),
    ],
  };
}

export function toRecordUpdate(record: CompiledRecord): RecordUpdateModel {
  const element = toElement(record);
  return {
    ...element,
    installCategory: record.installCategory,
    path: `${record.installCategory}/${record.updateName ?? `${record.table}_${element.sysId}`}.xml`,
    ...(record.associated?.length ? { associated: record.associated.map(toElement) } : {}),
    ...(record.rootTable === undefined ? {} : { rootTable: record.rootTable }),
  };
}
