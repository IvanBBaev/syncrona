// SPDX-License-Identifier: GPL-3.0-or-later
//
// Record() → a record of any table, its `data` written field by field the way
// the SDK's record plugin writes it. Tables whose SDK plugin writes their files
// or identifies their records in ways the native compiler does not know yet are
// refused rather than written wrong.

import { attachmentRecords } from "../attachment";
import { isGUID } from "../keys";
import { CData, type CompiledRecord, type FieldValue } from "../record";
import type { SourceLocation } from "../diagnostics";
import type { FluentObject, FluentValue } from "../evaluate";
import { lookup, type ArtefactSpec, type BuildContext, type Options } from "./shared";

/** The SDK API that owns a table, named in a hint when Record() writes to it. */
const TABLE_OWNERSHIP: Record<string, string> = {
  sys_choice_set: "ChoiceSet",
  sys_alias: "Alias",
  sys_alias_templates: "AliasTemplate",
  contract_sla: "Sla",
  asmt_metric_type: "Assessment",
  asmt_metric_category: "Assessment",
  asmt_metric: "Assessment",
  change_risk_asmt: "RiskAssessment",
  change_risk_asmt_threshold: "RiskAssessment",
  sys_retry_policy: "RetryPolicy",
  sys_security_acl: "Acl",
  sys_security_acl_role: "Acl",
  sys_app_application: "ApplicationMenu",
  sys_script: "BusinessRule",
  sys_script_client: "ClientScript",
  sys_scope_privilege: "CrossScopePrivilege",
  sys_ui_form: "Form",
  sys_ui_section: "Form",
  sys_ui_form_section: "Form",
  sys_ui_element: "Form",
  sys_ui_list_element: "List",
  sys_ui_list: "List",
  sys_properties: "Property",
  sys_user_role: "Role",
  sys_user_role_contains: "Role",
  sys_script_include: "ScriptInclude",
  sp_widget: "SPWidget",
  sp_header_footer: "SPHeaderFooter",
  m2m_sp_widget_dependency: "SPWidget",
  m2m_sp_ng_pro_sp_widget: "SPWidget",
  sp_portal: "ServicePortal",
  sp_ng_template: "SPWidget",
  sp_dependency: "SPWidgetDependency",
  sp_container: "SPPage",
  sp_page: "SPPage",
  sp_row: "SPPage",
  sp_column: "SPPage",
  sp_instance: "SPPage",
  m2m_sp_dependency_css_include: "SPWidgetDependency",
  m2m_sp_dependency_js_include: "SPWidgetDependency",
  sp_css_include: "CssInclude",
  sp_js_include: "JsInclude",
  sp_angular_provider: "SPAngularProvider",
  m2m_sp_ng_pro_sp_ng_pro: "SPAngularProvider",
  sp_instance_menu: "SPMenu",
  sp_rectangle_menu_item: "SPMenu",
  sp_page_route_map: "SPPageRouteMap",
  sys_atf_test: "Test",
  sys_atf_test_suite: "TestSuite",
  sys_ws_header_map: "RestApi",
  sys_ws_query_parameter_map: "RestApi",
  sys_ws_definition: "RestApi",
  sys_ws_operation: "RestApi",
  sys_ws_version: "RestApi",
  sys_ws_header: "RestApi",
  sys_ws_query_parameter: "RestApi",
  sys_graphql_schema: "GraphQLApi",
  sys_graphql_resolver: "GraphQLApi",
  sys_graphql_resolver_mapping: "GraphQLApi",
  sys_graphql_typeresolver: "GraphQLApi",
  sys_rest_message: "RestMessage",
  sys_rest_message_headers: "RestMessage",
  sys_rest_message_fn: "RestMessage",
  sys_rest_message_fn_headers: "RestMessage",
  sys_rest_message_fn_parameters: "RestMessage",
  sys_rest_message_fn_param_defs: "RestMessage",
  sys_user_preference: "UserPreference",
  sys_ui_page: "UiPage",
  sys_ui_action: "UiAction",
  sys_ui_action_role: "UiAction",
  sys_ui_action_view: "UiAction",
  sys_ui_policy: "UiPolicy",
  sys_ui_policy_action: "UiPolicy",
  sys_ui_policy_rl_action: "UiPolicy",
  sys_data_policy2: "DataPolicy",
  sys_data_policy_rule: "DataPolicy",
  sttrm_model: "StateModel",
  chg_model: "StateModel",
  prb_model: "StateModel",
  prb_task_model: "StateModel",
  sysevent_script_action: "ScriptAction",
  sysauto_script: "ScheduledScript",
  sysevent_email_action: "EmailNotification",
  sysevent_in_email_action: "InboundEmailAction",
  sys_db_object: "Table",
  sys_dictionary: "Table",
  sys_db_view: "DatabaseView",
  sys_hub_flow: "Flow",
  sys_hub_trigger_instance_v2: "wfa.trigger",
  sys_hub_action_instance_v2: "wfa.action",
  sys_hub_sub_flow_instance_v2: "wfa.subflow",
  sys_hub_flow_logic_instance_v2: "wfa.flowLogic",
  sys_flow_step_definition: "ActionStepDefinition",
  sys_decision: "DecisionTablePlugin",
  sys_hub_action_type_definition: "Action",
  sys_hub_step_instance: "wfa.actionStep",
  sys_pd_process_definition: "PlaybookDefinitionPlugin",
  sys_pd_activity: "ActivityPlugin",
  sys_pd_lane: "LanePlugin",
  sys_pd_trigger_instance: "PlaybookTriggerInstancePlugin",
  sys_pd_process_variant: "VariantPlugin",
  sp_theme: "SPTheme",
  m2m_sp_theme_css_include: "SPTheme",
  m2m_sp_theme_js_include: "SPTheme",
  sys_transform_map: "ImportSet",
  sys_transform_entry: "ImportSet",
  sys_transform_script: "ImportSet",
  sys_ux_applicability: "Applicability",
  sys_aix_project: "AiuxPlugin",
  sys_aix_widget: "AiuxPlugin",
  sys_aix_widget_instance: "AiuxPlugin",
  sys_aix_entity_widget_mapping: "AiuxPlugin",
  sys_aix_page: "AiuxPlugin",
  sys_aix_page_route_map: "AiuxPlugin",
  sys_aix_experience: "AiuxPlugin",
  sys_aix_experience_properties: "AiuxPlugin",
  sys_aix_experience_page_rel: "AiuxPlugin",
  sys_aix_app_shell: "AiuxPlugin",
  sys_aix_menu: "AiuxPlugin",
  sys_aix_menu_item: "AiuxPlugin",
  sys_aix_menu_item_category: "AiuxPlugin",
  sys_aix_layout: "AiuxPlugin",
  sys_aix_theme: "AiuxPlugin",
  sys_aix_color_swatch: "AiuxPlugin",
  sys_aix_m2m_experience_theme: "AiuxPlugin",
  sys_aix_dashboard: "AiuxPlugin",
  sys_aix_dashboard_item: "AiuxPlugin",
  sys_aix_dashboard_personalization_item: "AiuxPlugin",
  sys_aix_m2m_experience_dashboard: "AiuxPlugin",
  sys_aix_container: "AiuxPlugin",
  sys_aix_dependency: "AiuxPlugin",
  sys_aix_dependency_bundle: "AiuxPlugin",
  sys_aix_m2m_widget_dependency: "AiuxPlugin",
  sys_aix_m2m_widget_dependency_bundle: "AiuxPlugin",
  sys_aix_m2m_bundle_dependency: "AiuxPlugin",
  sys_ux_list_menu_config: "UxListMenuConfig",
  sys_ux_list_category: "UxListMenuConfig",
  sys_ux_list: "UxListMenuConfig",
  sys_ux_applicability_m2m_list: "UxListMenuConfig",
  sys_ux_page_registry: "Workspace",
  sys_ux_app_config: "Workspace",
  par_dashboard: "Dashboard",
  par_dashboard_canvas: "Dashboard",
  par_dashboard_tab: "Dashboard",
  par_dashboard_widget: "Dashboard",
  par_dashboard_permission: "Dashboard",
  par_dashboard_visibility: "Dashboard",
  scan_column_type_check: "ColumnTypeCheck",
  scan_linter_check: "LinterCheck",
  scan_script_only_check: "ScriptOnlyCheck",
  scan_table_check: "TableCheck",
  item_option_new_set: "VariableSet",
  sc_cat_item: "CatalogItem",
  sc_cat_item_producer: "CatalogItemRecordProducer",
  catalog_script_client: "CatalogClientScript",
  catalog_ui_policy: "CatalogUiPolicy",
  catalog_ui_policy_action: "CatalogUiPolicy",
  sn_aia_agent: "AiAgentPlugin",
  sn_aia_agent_config: "AiAgentPlugin",
  sn_aia_version: "AiAgentPlugin",
  sn_aia_tool: "AiAgentPlugin",
  sn_aia_agent_tool_m2m: "AiAgentPlugin",
  sn_aia_ltm_category_mapping: "AiAgentPlugin",
  sn_aia_trigger_configuration: "AiAgentPlugin",
  sn_aia_trigger_agent_usecase_m2m: "AiAgentPlugin",
  sn_aia_usecase: "AiAgenticWorkflowPlugin",
  sn_aia_usecase_config_override: "AiAgenticWorkflowPlugin",
  sn_aia_team: "AiAgenticWorkflowPlugin",
  sn_aia_team_member: "AiAgenticWorkflowPlugin",
  sn_nowassist_skill_config: "NowAssistSkillPlugin",
  sys_one_extend_capability: "NowAssistSkillPlugin",
  dl_definition: "DataLookup",
  sys_wizard: "Interceptor",
  sys_wizard_answer: "Interceptor",
};

/** Tables whose SDK plugin has its own file writer or a coalesce strategy the native compiler lacks. */
const UNSUPPORTED_TABLES = new Set([
  "db_image",
  "fx_price",
  "io_set_item",
  "item_option_new",
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
  "par_dashboard_canvas",
  "par_dashboard_permission",
  "par_dashboard_visibility",
  "question_choice",
  "sc_cat_item_catalog",
  "sc_cat_item_category",
  "sc_cat_item_user_criteria_mtom",
  "sc_cat_item_user_criteria_no_mtom",
  "sn_glider_source_artifact",
  "sn_glider_source_artifact_m2m",
  "sp_page",
  "sp_page_route_map",
  "sys_app_resource_limit_template",
  "sys_arp_network_policy",
  "sys_arp_segment_policy",
  "sys_atf_step",
  "sys_atf_test_suite_test",
  "sys_choice",
  "sys_choice_set",
  "sys_claim",
  "sys_db_object",
  "sys_dictionary",
  "sys_dictionary_override",
  "sys_documentation",
  "sys_element_mapping",
  "sys_es_latest_script",
  "sys_graphql_resolver_mapping",
  "sys_graphql_typeresolver",
  "sys_index",
  "sys_module",
  "sys_number",
  "sys_rest_message_fn",
  "sys_transform_entry",
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
  "sys_ux_lib_asset",
  "sys_ux_theme_asset",
  "sys_variable_value",
  "sys_ws_header_map",
  "sys_ws_query_parameter_map",
]);

/**
 * Columns the SDK plugins declare as references to sys_user_role or sys_ui_view,
 * the tables whose name-keyed reference fixup the platform honours: a name
 * written there becomes a reference keyed by that name.
 */
const NAME_REFERENCES: Record<string, Record<string, string>> = {
  sys_security_acl_role: { sys_user_role: "sys_user_role" },
  sys_ui_action_role: { sys_user_role: "sys_user_role" },
  sys_ui_action_view: { sys_ui_view: "sys_ui_view" },
  sys_user_role_contains: { role: "sys_user_role", contains: "sys_user_role" },
};

/** The platform's default view, exported as `<view name="NULL">Default view</view>`. */
const DEFAULT_VIEW = "Default view";

type Field = FieldValue | CompiledRecord;

function nameReference(ctx: BuildContext, table: string, name: string): Field {
  if (isGUID(name)) return name;
  return table === "sys_ui_view" && name === DEFAULT_VIEW
    ? ctx.factory.createReference(table, DEFAULT_VIEW, { name: "NULL" })
    : ctx.factory.createReference(table, undefined, { name });
}

/** A `Now.ref()` key value: a scalar or another record. */
function refKey(o: Options, ctx: BuildContext, value: FluentValue): string | CompiledRecord {
  if (value.kind === "string" || value.kind === "number" || value.kind === "boolean") return String(value.value);
  if (value.kind === "call") return ctx.recordOf(value);
  return o.error("Record(): Now.ref() keys must be strings, numbers, booleans or records.", value);
}

function field(o: Options, ctx: BuildContext, name: string, value: FluentValue, refTable: string | undefined): Field {
  switch (value.kind) {
    case "string":
      if (value.include) return new CData(value.value);
      return refTable ? nameReference(ctx, refTable, value.value) : value.value;
    case "number":
    case "boolean":
      return value.value;
    case "null":
    case "undefined":
      return undefined;
    case "array":
      return value.items
        .map((item) => {
          if (item.kind !== "string" && item.kind !== "number" && item.kind !== "boolean") {
            o.error(`Record(): 'data.${name}' must be an array of strings, numbers or booleans.`, item);
          }
          return String(item.value);
        })
        .join(",");
    case "call":
      return ctx.recordOf(value);
    case "attach":
      // Set once the record has its sys_id, which the attachment's id derives from.
      return undefined;
    case "ref":
      return ctx.factory.createReference(
        value.table,
        value.guid,
        value.keys && Object.fromEntries([...value.keys].map(([k, v]) => [k, refKey(o, ctx, v)])),
      );
    default:
      return o.error(`Record(): 'data.${name}' must be a string, number, boolean, array, record, Now.ref() or Now.attach().`, value);
  }
}

/** The SDK's ViewPlugin check: a view other than the default one has an alphanumeric name. */
function checkViewName(data: FluentObject, loc: SourceLocation, ctx: BuildContext): void {
  const title = data.props.get("title");
  if (title?.kind === "string" && title.value === DEFAULT_VIEW) return;
  const name = data.props.get("name");
  if (name?.kind !== "string" || !/^[a-zA-Z0-9_,]+$/.test(name.value)) {
    ctx.report("error", "View name can only contain alphanumeric characters", name?.loc ?? loc);
  }
}

export const record: ArtefactSpec = {
  properties: ["table", "data"],
  build(o, ctx) {
    const table = o.requiredString("table");
    if (UNSUPPORTED_TABLES.has(table)) o.error(`Record() on ${table} is not supported by the native compiler yet.`, o.get("table"));
    const owner = lookup(TABLE_OWNERSHIP, table);
    if (owner) ctx.report("hint", `For a better experience, consider using the ${owner} API`, o.call.loc);
    const data = o.get("data");
    if (data?.kind !== "object") {
      return o.error(data === undefined ? "Record(): 'data' is required." : "Record(): 'data' must be an object.", data);
    }
    const tableLoc = o.get("table")!.loc;
    ctx.dictionary.refer("Record", table, tableLoc);
    for (const [name, value] of data.props) ctx.dictionary.refer("Record", table, tableLoc, { name, location: value.loc });
    if (table === "sys_ui_view") checkViewName(data, o.call.loc, ctx);
    const references = lookup(NAME_REFERENCES, table) ?? {};
    const created = ctx.factory.createRecord({
      table,
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: Object.fromEntries([...data.props].map(([k, v]) => [k, field(o, ctx, k, v, lookup(references, k))])),
    });
    // Each attachment follows the record in its file, in property order.
    for (const [name, value] of data.props) {
      if (value.kind !== "attach") continue;
      const attached = attachmentRecords(ctx.factory, created, name, value.file, o.call.loc);
      created.fields.set(name, attached[0].id.getValue());
      (created.associated ??= []).push(...attached);
    }
    return created;
  },
};
