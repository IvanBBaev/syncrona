// SPDX-License-Identifier: GPL-3.0-or-later
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

/** Fallback extension for an internal_type this map does not name. */
export const DEFAULT_FILE_EXTENSION = "txt";

/**
 * Own properties only.
 *
 * Both lookups are keyed by a name that comes from outside the process — a table
 * name from a `sys_db_object`/`sys_metadata` row or from the project config, an
 * `internal_type` from a `sys_dictionary` row — and both are declared as returning
 * a string. A bare `MAP[key]` also resolves inherited `Object.prototype` members,
 * so `getDisplayField("constructor")` returned the Object *function* and
 * `getDisplayField("__proto__")` returned `Object.prototype`, each typed `string`
 * and each truthy enough to pass the `||` default. The display field is then sent
 * as a `sysparm_fields` entry and used to index a response row, and the extension
 * is interpolated into a filename — so a non-string here is a malformed query or a
 * garbage path, not a caught error. Same guard as `normalizeAuthMethod` in
 * @syncrona/sn-transport and the MCP tool-schema lookup, which had the same hole.
 */
function ownLookup(map: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

export function getDisplayField(tableName: string): string {
  return ownLookup(TABLE_DISPLAY_FIELD, tableName) || "name";
}

/** Maps a `sys_dictionary` internal_type to the extension its field is stored under. */
export function getFileTypeForInternalType(internalType: string): string {
  return ownLookup(SN_TYPE_MAP, internalType) || DEFAULT_FILE_EXTENSION;
}
