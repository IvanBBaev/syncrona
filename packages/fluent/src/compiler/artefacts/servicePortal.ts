// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Service Portal building blocks, as SDK 4.13 writes them:
//
// - SPAngularProvider() → sp_angular_provider, with one m2m_sp_ng_pro_sp_ng_pro
//   row per provider it requires;
// - CssInclude() → sp_css_include and JsInclude() → sp_js_include;
// - SPWidgetDependency() → sp_dependency and SPTheme() → sp_theme, each with
//   its css and js include m2m rows;
// - SPPageRouteMap() → sp_page_route_map.

import type { FluentValue } from "../evaluate";
import type { CompiledRecord, FieldValue, RecordId } from "../record";
import { roleRecord, type ArtefactSpec, type BuildContext, type Options } from "./shared";

/** The SDK's order of an include m2m row that gives none (or 0). */
const DEFAULT_ORDER = 100;

/** A record reference: a sys_id string as given, or the record another API call compiles to. */
export function reference(o: Options, ctx: BuildContext, value: FluentValue, key: string, tables: readonly string[], what: string): string | RecordId {
  if (value.kind === "string") return value.value;
  if (value.kind === "call") {
    const record = ctx.recordOf(value);
    if (tables.length === 0 || tables.includes(record.table)) return record.id;
  }
  return o.error(`${o.call.api}(): '${key}' must be ${what} or a sys_id.`, value);
}

/** `reference` with the SDK's own message for anything else. */
function referenceOr(o: Options, ctx: BuildContext, value: FluentValue, tables: readonly string[], message: string): string | RecordId {
  if (value.kind === "string") return value.value;
  if (value.kind === "call") {
    const record = ctx.recordOf(value);
    if (tables.includes(record.table)) return record.id;
  }
  return o.error(message, value);
}

function optionalReference(o: Options, ctx: BuildContext, key: string, tables: readonly string[], what: string): FieldValue {
  const value = o.get(key);
  return value === undefined ? undefined : reference(o, ctx, value, key, tables, what);
}

/** The sys_id a reference stands for. */
function idOf(ref: string | RecordId): string {
  return typeof ref === "string" ? ref : ref.getValue();
}

/** A comma-separated list of portal sys_ids (unique and non-blank when `unique`). */
function idList(o: Options, ctx: BuildContext, key: string, unique: boolean): string {
  const ids = (o.array(key) ?? []).map((item) => idOf(referenceOr(o, ctx, item, ["sp_portal"], "Must be a sys_id or Record<'sp_portal'>")));
  return (unique ? [...new Set(ids.filter((id) => id !== ""))] : ids).join(",");
}

const INCLUDES = {
  css: { table: "sp_css_include", api: "CssInclude" },
  js: { table: "sp_js_include", api: "JsInclude" },
} as const;

/** The m2m rows of `cssIncludes` / `jsIncludes`: `{ order?, include }` each, in declaration order. */
function includeRows(o: Options, ctx: BuildContext, parent: CompiledRecord, kind: keyof typeof INCLUDES): CompiledRecord[] {
  const { table, api } = INCLUDES[kind];
  const key = `${kind}Includes`;
  return (o.array(key) ?? []).map((item) => {
    const row = o.sub(item, `${key}[].`, ["include", "order"]);
    const include = row.get("include");
    // The SDK's message, stray quote included.
    const message = `include must contain a valid ${api}, Record<'${table}'> or sys_id'`;
    if (include === undefined) return row.error(message);
    return ctx.factory.createRecord({
      table: `m2m_${parent.table}_${kind}_include`,
      source: o.call.loc,
      installCategory: o.installCategory,
      fields: {
        order: row.number("order") || DEFAULT_ORDER,
        [table]: referenceOr(o, ctx, include, [table], message),
        [parent.table]: parent,
      },
    });
  });
}

export const spAngularProvider: ArtefactSpec = {
  properties: ["name", "script", "type", "requires"],
  build(o, ctx) {
    const explicitId = o.explicitId();
    const requires = o.array("requires") ?? [];
    for (const item of requires) {
      if (explicitId !== undefined && item.kind === "string" && item.value === String(explicitId)) {
        o.error("recursive dependency detected", item);
      }
    }
    const provider = ctx.factory.createRecord({
      table: "sp_angular_provider",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId,
      fields: {
        name: o.requiredString("name"),
        type: o.string("type") ?? "directive",
        script: o.string("script") ?? "",
      },
    });
    for (const item of requires) {
      provider.children.push(
        ctx.factory.createRecord({
          table: "m2m_sp_ng_pro_sp_ng_pro",
          source: o.call.loc,
          installCategory: o.installCategory,
          fields: {
            required_by: provider,
            requires: reference(o, ctx, item, "requires", ["sp_angular_provider"], "an SPAngularProvider() record"),
          },
        }),
      );
    }
    return provider;
  },
};

/** CssInclude() and JsInclude() take exactly one of a url and a local source. */
function includeSource(o: Options, local: string): "url" | "local" {
  const url = o.get("url") !== undefined;
  if (url === (o.get(local) !== undefined)) {
    o.error(`${o.call.api} must define either a url or ${local} property, but not both`);
  }
  return url ? "url" : "local";
}

export const cssInclude: ArtefactSpec = {
  properties: ["name", "url", "rtlCssUrl", "spCss", "lazyLoad"],
  build(o, ctx) {
    const source = includeSource(o, "spCss");
    return ctx.factory.createRecord({
      table: "sp_css_include",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        lazy_load: o.boolean("lazyLoad") ?? false,
        name: o.requiredString("name"),
        rtl_css_file_url: o.string("rtlCssUrl") ?? "",
        source,
        sp_css: optionalReference(o, ctx, "spCss", ["sp_css"], "a style sheet record"),
        url: o.string("url") ?? "",
      },
    });
  },
};

export const jsInclude: ArtefactSpec = {
  properties: ["name", "url", "sysUiScript"],
  build(o, ctx) {
    const source = includeSource(o, "sysUiScript");
    return ctx.factory.createRecord({
      table: "sp_js_include",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        display_name: o.requiredString("name"),
        source,
        sys_ui_script: optionalReference(o, ctx, "sysUiScript", ["sys_ui_script"], "a UI script record"),
        url: o.string("url") ?? "",
      },
    });
  },
};

export const spWidgetDependency: ArtefactSpec = {
  properties: ["name", "angularModuleName", "includeOnPageLoad", "portalsForPageLoad", "cssIncludes", "jsIncludes"],
  build(o, ctx) {
    const dependency = ctx.factory.createRecord({
      table: "sp_dependency",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name: o.requiredString("name"),
        module: o.string("angularModuleName") ?? "",
        page_load: o.boolean("includeOnPageLoad") ?? false,
        sp_portals: idList(o, ctx, "portalsForPageLoad", false),
      },
    });
    dependency.children.push(...includeRows(o, ctx, dependency, "css"), ...includeRows(o, ctx, dependency, "js"));
    return dependency;
  },
};

export const spTheme: ArtefactSpec = {
  properties: [
    "name",
    "customCss",
    "header",
    "footer",
    "fixedHeader",
    "fixedFooter",
    "turnOffScssCompilation",
    "matchingNextExperienceTheme",
    "icon",
    "logo",
    "logoAltText",
    "cssIncludes",
    "jsIncludes",
  ],
  build(o, ctx) {
    const theme = ctx.factory.createRecord({
      table: "sp_theme",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name: o.requiredString("name"),
        css_variables: o.string("customCss") ?? "",
        header: optionalReference(o, ctx, "header", ["sp_header_footer"], "a header record"),
        footer: optionalReference(o, ctx, "footer", ["sp_header_footer"], "a footer record"),
        navbar_fixed: o.boolean("fixedHeader") ?? true,
        footer_fixed: o.boolean("fixedFooter") ?? true,
        turn_off_scss_compilation: o.boolean("turnOffScssCompilation") ?? false,
        matching_now_experience_theme: o.string("matchingNextExperienceTheme") ?? "",
        icon: o.string("icon"),
        logo: o.string("logo"),
        logo_alt_text: o.string("logoAltText") ?? "",
      },
    });
    theme.children.push(...includeRows(o, ctx, theme, "css"), ...includeRows(o, ctx, theme, "js"));
    return theme;
  },
};

export const spPageRouteMap: ArtefactSpec = {
  properties: ["routeFromPage", "routeToPage", "shortDescription", "portals", "roles", "active", "order"],
  build(o, ctx) {
    const page = (key: string): string | RecordId => {
      const value = o.get(key);
      return value === undefined ? "" : reference(o, ctx, value, key, ["sp_page"], "a page record");
    };
    const from = page("routeFromPage");
    const to = page("routeToPage");
    if (idOf(from) !== "" && idOf(from) === idOf(to)) {
      o.error(`Invalid SPPageRouteMap: "routeToPage" must be different from "routeFromPage".`, o.get("routeToPage"));
    }
    // Role names (from a string or a Role()), unique and non-blank, as the SDK keeps them.
    const roles = (o.array("roles") ?? []).map((item) => {
      if (item.kind === "string") return item.value;
      if (item.kind === "call") return roleRecord(o, ctx, item, "roles").name;
      return o.error("roles must be strings or role records", item);
    });
    return ctx.factory.createRecord({
      table: "sp_page_route_map",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        route_from_page: from,
        route_to_page: to,
        short_description: o.string("shortDescription") ?? "",
        portals: idList(o, ctx, "portals", true),
        roles: [...new Set(roles.filter((r) => r.trim() !== ""))].join(","),
        active: o.boolean("active") ?? true,
        order: o.number("order") ?? 10,
      },
    });
  },
};

/** The reference fields of sp_portal: property, field and the tables a record call may compile to ([]: any). */
const PORTAL_REFERENCES: readonly (readonly [string, string, readonly string[], string])[] = [
  ["theme", "theme", ["sp_theme"], "a theme record"],
  ["darkTheme", "dark_theme", ["sp_theme"], "a theme record"],
  ["mainMenu", "sp_rectangle_menu", ["sp_instance_menu"], "a menu record"],
  ["categoryHomePage", "sc_category_page", ["sp_page"], "a page record"],
  ["homePage", "homepage", ["sp_page"], "a page record"],
  ["searchResultsConfiguration", "search_results_configuration", [], "a record"],
  ["searchApplication", "search_application", [], "a record"],
  ["alternatePortal", "alternate_portal", ["sp_portal"], "a portal record"],
  ["catalogHomePage", "sc_catalog_page", ["sp_page"], "a page record"],
  ["loginPage", "login_page", ["sp_page"], "a page record"],
  ["knowledgeHomePage", "kb_knowledge_page", ["sp_page"], "a page record"],
  ["chatQueue", "sp_chat_queue", [], "a record"],
  ["notFoundPage", "notfound_page", ["sp_page"], "a page record"],
  ["textIndexGroup", "ts_index_group", [], "a record"],
];

const PORTAL_FLAGS: readonly (readonly [string, string])[] = [
  ["enableAiSearch", "enable_ais"],
  ["enableCertificateBasedAuthentication", "enable_certificate_based_authentication"],
  ["defaultPortal", "default"],
  ["enableWebEmbeddables", "enable_embeddables"],
  ["enableFavorites", "enable_favorites"],
  ["inactive", "inactive"],
  ["hidePortalName", "hide_portal_name"],
  ["supportRightToLeftLanguages", "rtl_enabled"],
];

/** The m2m rows of a portal, in the SDK's order: property, row key, table, referenced field, whether it has `active`. */
const PORTAL_ROWS = [
  ["searchSources", "searchSource", "m2m_sp_portal_search_source", "sp_search_source", false],
  ["knowledgeBases", "knowledgeBase", "m2m_sp_portal_knowledge_base", "kb_knowledge_base", true],
  ["catalogs", "catalog", "m2m_sp_portal_catalog", "sc_catalog", true],
  ["taxonomies", "taxonomy", "m2m_sp_portal_taxonomy", "taxonomy", true],
] as const;

/** The SDK's url_suffix normalization: lowercase, `_` for anything else, single underscores, none at the ends. */
function normalizeUrlSuffix(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/** A comma-joined string list (`embeddableMacroponents`, `communicationChannels`). */
function joined(o: Options, key: string): string | undefined {
  return o.stringArray(key)?.join(",");
}

/**
 * A deprecated single `knowledgeBase` / `catalog` reference: an error next to
 * its array, a warning on its own; written only while the array is empty.
 */
function deprecated(o: Options, ctx: BuildContext, key: string, list: string, rows: number): FieldValue {
  const value = o.get(key);
  if (value === undefined) return undefined;
  if (rows > 0) {
    ctx.report("error", `Cannot use both '${key}' and '${list}'. Remove '${key}' and use only the '${list}' array instead.`, value.loc);
    return undefined;
  }
  ctx.report("warning", `'${key}' is deprecated. Use the '${list}' array instead.`, value.loc);
  return reference(o, ctx, value, key, [], "a record");
}

export const servicePortal: ArtefactSpec = {
  properties: [
    "title",
    "urlSuffix",
    "icon",
    "logo",
    "logoAltText",
    "quickStartConfig",
    "embeddableMacroponents",
    "communicationChannels",
    "cssVariables",
    ...PORTAL_REFERENCES.map(([key]) => key),
    "knowledgeBase",
    "catalog",
    ...PORTAL_FLAGS.map(([key]) => key),
    ...PORTAL_ROWS.map(([key]) => key),
  ],
  build(o, ctx) {
    const urlSuffix = o.string("urlSuffix");
    if (urlSuffix !== undefined && urlSuffix !== normalizeUrlSuffix(urlSuffix)) {
      o.error(
        `Invalid url_suffix '${urlSuffix}'. Use lowercase alphanumeric characters, hyphens, and single underscores, without a leading or trailing underscore (e.g. '${normalizeUrlSuffix(urlSuffix)}')`,
        o.get("urlSuffix"),
      );
    }
    const rows = Object.fromEntries(PORTAL_ROWS.map(([key]) => [key, o.array(key) ?? []]));
    const fields: Record<string, FieldValue> = {
      title: o.string("title"),
      url_suffix: urlSuffix ?? "",
      icon: o.string("icon"),
      logo: o.string("logo"),
      logo_alt_text: o.string("logoAltText"),
      quick_start_config: o.string("quickStartConfig"),
      embeddable_macroponents: joined(o, "embeddableMacroponents"),
      communication_channels: joined(o, "communicationChannels"),
      css_variables: o.string("cssVariables"),
    };
    for (const [key, field, tables, what] of PORTAL_REFERENCES) fields[field] = optionalReference(o, ctx, key, tables, what);
    const knowledgeBase = deprecated(o, ctx, "knowledgeBase", "knowledgeBases", rows.knowledgeBases.length);
    const catalog = deprecated(o, ctx, "catalog", "catalogs", rows.catalogs.length);
    if (rows.knowledgeBases.length === 0) fields.kb_knowledge_base = knowledgeBase;
    if (rows.catalogs.length === 0) fields.sc_catalog = catalog;
    for (const [key, field] of PORTAL_FLAGS) fields[field] = o.boolean(key) ?? false;
    const portal = ctx.factory.createRecord({
      table: "sp_portal",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields,
    });
    for (const [key, rowKey, table, field, active] of PORTAL_ROWS) {
      for (const item of rows[key]) {
        const row = o.sub(item, `${key}[].`, active ? [rowKey, "order", "active"] : [rowKey, "order"]);
        const target = row.get(rowKey);
        portal.children.push(
          ctx.factory.createRecord({
            table,
            source: o.call.loc,
            installCategory: o.installCategory,
            fields: {
              sp_portal: portal,
              [field]: target === undefined ? undefined : reference(row, ctx, target, `${key}[].${rowKey}`, [], "a record"),
              order: row.number("order") ?? DEFAULT_ORDER,
              ...(active ? { active: row.boolean("active") ?? true } : {}),
            },
          }),
        );
      }
    }
    return portal;
  },
};
