// Exact typeMap from SincUtilsMS — maps ServiceNow internal_type → file extension
export const SN_TYPE_MAP: Record<string, string> = {
  css: "css",
  html: "html",
  html_script: "html",
  html_template: "html",
  script: "js",
  script_plain: "js",
  script_server: "js",
  xml: "xml",
};

export const SN_TYPE_QUERY = Object.keys(SN_TYPE_MAP)
  .map((t) => `internal_type=${t}`)
  .join("^OR");

// Display field per table — matches getDisplayValue() server behavior
export const TABLE_DISPLAY_FIELD: Record<string, string> = {
  sys_script_include: "name",
  sys_script: "name",
  sys_script_client: "name",
  sys_ui_script: "name",
  sys_ui_action: "name",
  sys_ui_page: "name",
  sys_ui_policy: "short_description",
  sys_ui_macro: "name",
  sys_security_acl: "name",
  sys_ws_operation: "name",
  sys_trigger: "name",
  content_css: "name",
  sp_widget: "id",
  sp_theme: "name",
  sp_page: "id",
  sys_atf_step: "name",
  sys_app_customization: "name",
  sys_hub_action_type_definition: "name",
  sys_flow_context: "name",
};

export function getDisplayField(tableName: string): string {
  return TABLE_DISPLAY_FIELD[tableName] || "name";
}
