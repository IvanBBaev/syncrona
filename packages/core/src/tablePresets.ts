// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncrona/types";

/**
 * WP3: named groups of configuration tables whose JSON columns are synced as
 * `.json` field files instead of sidecar strings.
 *
 * Each table maps to the `string` columns that hold a JSON document; every
 * column whose dictionary type is `json` or `json_translations` is added on top
 * of them by discovery, so a column a newer release adds is picked up without a
 * change here. The lists hold configuration only: runtime tables (executions,
 * sessions, history) and generated ones (`sys_uxf_snapshot`) are left out on
 * purpose — their records are not authored, and a pushed snapshot would bypass
 * the regeneration UI Builder does on publish. Per-user records
 * (`sys_ux_user_override`, `sys_ux_diagnostic_rule_dismiss`) and analytics
 * (`sys_uxa_*`) are left out for the same reason.
 *
 * The lists were checked against a live instance's `sys_dictionary` on
 * 2026-10-16: every table exists, extends `sys_metadata` and has at least one
 * JSON column. Tables such as `sys_ux_app_route`, `sys_ux_list` or
 * `sn_aia_agent` hold no JSON and sync through the regular field rules.
 *
 * Opt-in through `tablePresets` in sync.config.js. An empty list (the default)
 * leaves every existing workspace exactly as it was.
 */
export const TABLE_PRESETS = {
  /** UI Builder pages, components and their data. */
  uib: {
    sys_ux_macroponent: [
      "composition",
      "data",
      "layout",
      "props",
      "root_component_config",
      "root_component_definition",
    ],
    sys_ux_screen: [],
    sys_ux_screen_condition: [],
    sys_ux_screen_attrs: [],
    sys_ux_client_script: [],
    sys_ux_client_script_include: [],
    sys_ux_data_broker: [],
    sys_ux_data_broker_transform: [],
    sys_ux_event: [],
    sys_ux_page_property: [],
    sys_ux_component_preset: [],
    sys_ux_controller_preset: [],
    sys_ux_controller: [],
    sys_ux_composite_data_template: [],
    sys_ux_addon_event_mapping: [],
    sys_ux_extension_point: [],
    sys_ux_interface: [],
    sys_ux_type: [],
    sys_ux_widget: [],
    sys_ux_widget_action: [],
    sys_ux_theme: [],
    sys_ux_style: [],
    sys_ux_theme_customization: [],
    sys_ux_theme_m2m_asset: [],
    sys_ux_atf_action: [],
  },
  /** Workspace and app shell configuration. */
  workspace: {
    sys_ux_app: [],
    sys_ux_app_config: [],
    sys_ux_page_registry: [],
    sys_ux_dynamic_route_mapping: [],
    sys_ux_keyboard_shortcut: [],
    sys_ux_keyboard_shortcut_definition: [],
    sys_ux_layout_bounds: [],
    sys_ux_search_result_component: [],
    sys_ux_auto_reflow_rule: [],
    sys_ux_macroponent_rule: [],
    sys_ux_keyboard_shortcut_deny_list: [],
    par_dashboard_widget: [],
    par_component: [],
  },
  /** AI Agent tools, external agent cards and Now Assist skill definitions. */
  ai: {
    sn_aia_tool: [],
    sn_aia_agent_tool_m2m: [],
    sn_aia_external_agent_card: [],
    sn_aia_external_agent_configuration: [],
    sn_aia_external_agent_skill: [],
    sys_gen_ai_feature_mapping: [],
    sys_one_extend_capability: [],
    sys_one_extend_capability_definition: [],
    sys_one_extend_definition_attribute: [],
    sys_one_extend_capability_attribute_resource_lookup: [],
    sys_one_extend_resource_mapping: [],
  },
} as const satisfies Record<string, Record<string, readonly string[]>>;

export type TablePresetName = keyof typeof TABLE_PRESETS;

export const TABLE_PRESET_NAMES = Object.keys(TABLE_PRESETS) as TablePresetName[];

export const isTablePresetName = (value: unknown): value is TablePresetName =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(TABLE_PRESETS, value);

/** The dictionary types a preset table's columns are synced as JSON files for. */
export const JSON_INTERNAL_TYPES: readonly string[] = ["json", "json_translations"];

/**
 * The JSON-file tables of every preset `config` enables: table → the `string`
 * columns known to hold JSON. A table two presets name gets the union. Unknown
 * preset names are ignored here; config validation refuses them earlier.
 */
export const getJsonFileTables = (
  config: Pick<Sync.Config, "tablePresets"> | undefined
): ReadonlyMap<string, readonly string[]> => {
  const result = new Map<string, readonly string[]>();
  const raw = config?.tablePresets;
  if (!Array.isArray(raw)) return result;
  for (const name of raw) {
    if (!isTablePresetName(name)) continue;
    for (const [table, columns] of Object.entries(TABLE_PRESETS[name])) {
      const known = result.get(table) ?? [];
      result.set(table, [...new Set([...known, ...(columns as readonly string[])])]);
    }
  }
  return result;
};
