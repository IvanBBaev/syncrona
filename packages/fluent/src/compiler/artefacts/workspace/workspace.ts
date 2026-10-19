// SPDX-License-Identifier: GPL-3.0-or-later
//
// Workspace() → sys_ux_page_registry, plus the records SDK 4.13 derives for
// every workspace: its sys_ux_app_config, the unified-nav category row, seven
// sys_ux_page_property rows and four pages (list, record, home, simple-list),
// each a sys_ux_screen_type, sys_ux_app_route and sys_ux_screen; the record
// page also gets its own sys_ux_macroponent. A derived record's `$id` is
// `<workspace $id>_<table>_<suffix>`, as the SDK keys it.

import type { CompiledRecord, FieldValue } from "../../record";
import type { ArtefactSpec, BuildContext, Options } from "../shared";
import { MACROPONENT_CONFIGURATION, RECORD_PAGE } from "./recordPage";

/** The workspace shell every page and route belongs to. */
const ROOT_MACROPONENT = "c276387cc331101080d6d3658940ddd2";
/** The unified navigation's workspace experience category. */
const WORKSPACE_CATEGORY = "afb4e3e173322010f0ca1e666bf6a726";
/** The default UI Builder list configuration. */
const DEFAULT_LIST_CONFIG = "d305c0a873601010a0a79329faf6a7cb";

const CHROME_TOOLBAR = JSON.stringify(
  [
    { id: "home", message: "Home", icon: "home-fill", order: 100 },
    { id: "list", message: "List", icon: "list-fill", order: 200 },
  ].map(({ id, message, icon, order }) => ({
    id,
    label: { translatable: true, message },
    icon,
    routeInfo: { route: id },
    group: "top",
    order,
    badge: {},
    presence: {},
    availability: {},
    viewportInfo: {},
  })),
);

const CHROME_HEADER =
  '{"privatePage":{"userPrefsEnabled":false,"searchEnabled":false,"currentScreenLinkConfiguration":{},"globalTools":{"collapsingMenuId":0,"primaryItems":[],"secondaryItems":[]}},"publicPage":{"menuEnabled":false,"searchEnabled":false,"logoRoute":{},"actionButtons":[]}}';

const CHROME_FOOTER =
  '{"public_page":{"enable_footer_topbar":false,"footer_topbar_options":{},"enable_footer_bar":false,"footer_bar_options":{}}}';

/** chrome_tab: a "New <table>" entry per workspace table. */
function chromeTab(tables: string[]): string {
  return JSON.stringify({
    contextual: ["record"],
    newTabMenu: tables.map((table) => ({
      label: { translatable: true, message: `New ${table}` },
      routeInfo: { route: "record", fields: { table, sysId: "-1" }, multiInstField: "sysId" },
      condition: { tableDescription: { table, canCreate: true } },
    })),
    maxMainTabLimit: 10,
    maxTotalSubTabLimit: 30,
  });
}

interface PageDefaults {
  macroponent: string;
  name: string;
  fields: string;
  optionalParameters: string;
  routeType: string;
}

/** The four pages, in the order the SDK writes them. */
const PAGES: ReadonlyArray<[type: string, defaults: PageDefaults]> = [
  ["list", { macroponent: "2c08111d0fc21010036a83fa68767ef6", name: "List Page", fields: "", optionalParameters: "listId", routeType: "list" }],
  [
    "record",
    {
      macroponent: "e3c63f089db4729086517760a31f5558",
      name: "Record Default",
      fields: "table,sysId",
      optionalParameters: "query,extraParams,views,selectedTab",
      routeType: "record",
    },
  ],
  [
    "home",
    {
      macroponent: "163a913b532c0110aab9ddeeff7b1241",
      name: "Dashboards Default",
      fields: "",
      optionalParameters: "sysId,edit,tabSysId,filter,element",
      routeType: "home",
    },
  ],
  [
    "simple-list",
    {
      macroponent: "8515f3e853031010ffa5ddeeff7b1297",
      name: "Simple List",
      fields: "table",
      optionalParameters: "listTitle,query,disableInlineEditing",
      routeType: "simplelist",
    },
  ],
];

/** The record page's sys_ux_macroponent columns the template leaves empty. */
const EMPTY_MACROPONENT_COLUMNS = [
  "associated_types",
  "bundles",
  "component_dependencies",
  "da_relay_models",
  "description",
];
const EMPTY_MACROPONENT_COLUMNS_AFTER_REFLOW = [
  "dispatched_events",
  "ext_controller_dep",
  "form_factors",
  "interactions",
  "interfaces",
  "macroponent_dependencies",
  "output_prop_mapping",
  "required_translations",
  "root_component",
  "root_component_config",
  "root_component_definition",
  "schema_version",
  "state_persistence_config",
  "state_properties",
  "style_config",
];

const empty = (columns: string[]) => Object.fromEntries(columns.map((column) => [column, ""]));

/** `listConfig`: a UxListMenuConfig() record, or a sys_id string as given. */
function listConfigOf(o: Options, ctx: BuildContext): string | CompiledRecord {
  const value = o.get("listConfig");
  if (value === undefined) return DEFAULT_LIST_CONFIG;
  if (value.kind === "string") return value.value;
  if (value.kind === "call") {
    const record = ctx.recordOf(value);
    if (record.table === "sys_ux_list_menu_config") return record;
  }
  return o.error(`${o.call.api}(): 'listConfig' must be a UxListMenuConfig() record or a sys_id.`, value);
}

export const workspace: ArtefactSpec = {
  properties: ["title", "path", "landingPath", "order", "active", "listConfig", "tables", "defaultRecordOverrides"],
  build(o, ctx) {
    const $id = o.explicitId();
    if ($id === undefined) return o.error(`${o.call.api}(): '$id' is required.`);
    if (o.get("defaultRecordOverrides") !== undefined) {
      o.error(`${o.call.api}(): 'defaultRecordOverrides' is not supported by the native compiler yet.`, o.get("defaultRecordOverrides"));
    }
    const title = o.requiredString("title");
    const path = o.requiredString("path");
    const tables = o.stringArray("tables");
    // The SDK reads `tables` unconditionally and drops a workspace without it.
    if (tables === undefined) return o.error(`${o.call.api}(): 'tables' is required.`);

    const create = (table: string, suffix: string, fields: Record<string, FieldValue | CompiledRecord>) =>
      ctx.factory.createRecord({
        table,
        source: o.call.loc,
        installCategory: o.installCategory,
        explicitId: `${$id}_${table}_${suffix}`,
        fields,
      });

    const appConfig = create("sys_ux_app_config", "workspace", {
      name: title,
      landing_path: o.string("landingPath") ?? "home",
      active: true,
      description: "Workspace created by Fluent",
      custom_icon: "",
      icon: "",
      disable_auto_reflow: false,
      encode_query_string: false,
    });
    const listConfig = listConfigOf(o, ctx);
    const pageRegistry = ctx.factory.createRecord({
      table: "sys_ux_page_registry",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: $id,
      fields: {
        admin_panel: appConfig,
        admin_panel_table: "sys_ux_app_config",
        root_macroponent: ROOT_MACROPONENT,
        parent_app: "c86a62e2c7022010099a308dc7c26022",
        title,
        path,
        active: o.boolean("active") ?? true,
        page: "",
        auth_routes: "",
      },
    });
    const children = pageRegistry.children;
    children.push(
      appConfig,
      create("sys_ux_registry_m2m_category", "unifiedNav", {
        experience_category: WORKSPACE_CATEGORY,
        order: o.number("order") ?? 1000,
        page_registry: pageRegistry,
      }),
    );

    const appConfigId = appConfig.id.getValue();
    const pageProperties: Array<[name: string, type: string, value: string | CompiledRecord]> = [
      ["chrome_toolbar", "json", CHROME_TOOLBAR],
      ["view", "string", `workspace-${appConfigId}`],
      ["wbApplicabilityConfigId", "string", appConfigId],
      ["chrome_tab", "json", chromeTab(tables)],
      ["listConfigId", "string", listConfig],
      ["chrome_header", "json", CHROME_HEADER],
      ["chrome_footer", "json", CHROME_FOOTER],
    ];
    for (const [name, type, value] of pageProperties) {
      children.push(
        create("sys_ux_page_property", name, { name, suffix: name, description: "", route: "", page: pageRegistry, type, value }),
      );
    }

    for (const [type, page] of PAGES) {
      const screenType = create("sys_ux_screen_type", type, { name: page.name, description: "" });
      const route = create("sys_ux_app_route", type, {
        name: page.name,
        description: "",
        order: 0,
        fields: page.fields,
        optional_parameters: page.optionalParameters,
        route_type: page.routeType,
        parent_macroponent: ROOT_MACROPONENT,
        app_config: appConfig,
        screen_type: screenType,
        parent_macroponent_composition_element_id: "",
        extension_point: "",
        interoperable: false,
        icon: "",
      });
      children.push(screenType, route);

      let macroponent: string | CompiledRecord = page.macroponent;
      if (type === "record") {
        macroponent = create("sys_ux_macroponent", type, {
          name: page.name,
          extends: RECORD_PAGE.extendedFrom,
          category: RECORD_PAGE.category,
          layout: RECORD_PAGE.layoutModel,
          props: RECORD_PAGE.properties,
          internal_event_mappings: RECORD_PAGE.internalEventMappings,
          handled_events: RECORD_PAGE.handledEvents,
          data: RECORD_PAGE.data,
          composition: RECORD_PAGE.composition,
          ...empty(EMPTY_MACROPONENT_COLUMNS),
          disable_auto_reflow: false,
          ...empty(EMPTY_MACROPONENT_COLUMNS_AFTER_REFLOW),
        });
        children.push(macroponent);
      }

      children.push(
        create("sys_ux_screen", type, {
          active: true,
          name: page.name,
          description: "",
          order: 0,
          macroponent,
          parent_macroponent: ROOT_MACROPONENT,
          screen_condition: "",
          screen_type: screenType,
          app_config: appConfig,
          macroponent_config: MACROPONENT_CONFIGURATION,
          disable_auto_reflow: false,
          disable_interoperable: false,
          event_mappings: "",
          required_translations: "",
          rollback_screen: "",
        }),
      );
    }
    return pageRegistry;
  },
};
