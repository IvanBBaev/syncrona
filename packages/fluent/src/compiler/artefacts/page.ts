// SPDX-License-Identifier: GPL-3.0-or-later
//
// Service Portal pages and menus, as SDK 4.13 writes them:
//
// - SPPage() → sp_page (keyed by its page id), then each container
//   (sp_container) followed by its rows (sp_row), each row by its columns
//   (sp_column) and each column by its nested rows and then its widget
//   instances (sp_instance);
// - SPMenu() → sp_instance_menu, then its items (sp_rectangle_menu_item),
//   each followed by its child items.

import type { FluentValue } from "../evaluate";
import type { CompiledRecord, FieldValue, RecordId } from "../record";
import { reference } from "./servicePortal";
import type { ArtefactSpec, BuildContext, Options } from "./shared";
import { toJson } from "./widget";

const DEFAULT_DIMENSIONS = `{
\t"mobile": {
\t\t"height": "250px",
\t\t"width": "100%"
\t},
\t"desktop": {
\t\t"height": "250px",
\t\t"width": "100%"
\t},
\t"tablet": {
\t\t"height": "250px",
\t\t"width": "100%"
\t}
}`;
const DEFAULT_DIMENSIONS_SCRIPT = `function evaluateConfig(options) { return ${DEFAULT_DIMENSIONS}; }`;
const DEFAULT_TEMPLATE = `<!--
\tAngularJS template with configurable options.
\tUse the "options" object to control dynamic behavior.
\tExample: Display an element when max row count is 10:
\t<div ng-if="options.maxRowCount === 10"></div>
\tThe "skeleton-container" class is used for loading placeholders.
-->
\t<div class="skeleton-container">
\t<!-- Header Skeleton -->
\t<div class="skeleton-box skeleton-header"></div>
\t<!-- Body Skeleton -->
\t<div class="skeleton-box skeleton-line"></div>
\t<div class="skeleton-box skeleton-line small"></div>
\t<div class="skeleton-box skeleton-line medium"></div>
</div>`;

const INSTANCE_PROPERTIES = [
  "title",
  "id",
  "widget",
  "widgetParameters",
  "css",
  "url",
  "glyph",
  "size",
  "color",
  "cssClass",
  "active",
  "order",
  "roles",
  "shortDescription",
  "column",
  "asyncLoad",
  "preservePlaceholderSize",
  "advancedPlaceholderDimensions",
  "placeholderDimensions",
  "placeholderConfigurationScript",
  "placeholderTemplate",
  "asyncLoadTrigger",
  "asyncLoadDeviceType",
];

/** A reference to any record (a sys_id string or the record another call compiles to), or '' when absent. */
function anyReference(s: Options, ctx: BuildContext, key: string, what: string): string | RecordId {
  const value = s.get(key);
  return value === undefined ? "" : reference(s, ctx, value, `${s.path}${key}`, [], what);
}

/**
 * Role names (strings, or the name of a Role() or other named record),
 * unique and non-blank. The SDK drops anything else from a page, but
 * rejects it in a menu (`strict`).
 */
function rolesString(s: Options, ctx: BuildContext, strict: boolean): string {
  const names = (s.array("roles") ?? []).flatMap((item: FluentValue) => {
    if (item.kind === "string") return [item.value];
    if (item.kind === "call") {
      const name = ctx.recordOf(item).fields.get("name");
      if (typeof name === "string") return [name];
    }
    if (strict) s.error("roles must be strings or role records", item);
    return [];
  });
  return [...new Set(names.filter((r) => r.trim() !== ""))].join(",");
}

function isWrapped(obj: Record<string, unknown>): boolean {
  const values = Object.values(obj);
  return values.length > 0 && values.every((v) => v !== null && typeof v === "object" && "value" in v && "displayValue" in v);
}

/** Parameters as `{ key: { value, displayValue } }`: an instance stores string values, a menu native ones. */
function wrap(obj: Record<string, unknown>, stringify: boolean): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, { value: stringify ? String(v ?? "") : (v ?? null), displayValue: String(v ?? "") }]),
    ),
  );
}

function widgetParameters(s: Options, stringify: boolean): string {
  const value = s.get("widgetParameters");
  if (value === undefined) return "";
  if (value.kind === "object") {
    const obj = toJson(s, value, `${s.path}widgetParameters`) as Record<string, unknown>;
    return isWrapped(obj) ? JSON.stringify(obj) : wrap(obj, stringify);
  }
  if (value.kind !== "string") return s.error(`${s.call.api}(): '${s.path}widgetParameters' must be an object or a JSON string.`, value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.value);
  } catch {
    return value.value;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return value.value;
  const obj = parsed as Record<string, unknown>;
  return isWrapped(obj) ? value.value : wrap(obj, stringify);
}

function placeholderDimensions(s: Options): string {
  const value = s.get("placeholderDimensions");
  if (value === undefined) return DEFAULT_DIMENSIONS;
  return value.kind === "string" ? value.value : JSON.stringify(toJson(s, value, `${s.path}placeholderDimensions`));
}

/** The widget instance fields an sp_instance and an sp_instance_menu share. */
function instanceFields(s: Options, ctx: BuildContext, stringify: boolean, strictRoles: boolean): Record<string, FieldValue | CompiledRecord> {
  return {
    sp_widget: anyReference(s, ctx, "widget", "a widget record"),
    widget_parameters: widgetParameters(s, stringify),
    short_description: s.string("shortDescription") ?? "",
    css: s.string("css") ?? "",
    url: s.string("url") ?? "",
    glyph: s.string("glyph") ?? "",
    size: s.string("size") ?? "md",
    color: s.string("color") ?? "default",
    class_name: s.string("cssClass") ?? "",
    active: s.boolean("active") ?? true,
    roles: rolesString(s, ctx, strictRoles),
    async_load: s.boolean("asyncLoad") ?? false,
    async_load_trigger: s.string("asyncLoadTrigger") ?? "viewport",
    async_load_device_type: s.string("asyncLoadDeviceType") ?? "desktop,tablet,mobile",
    preserve_placeholder_size: s.boolean("preservePlaceholderSize") ?? false,
    placeholder_dimensions: placeholderDimensions(s),
    advanced_placeholder_dimensions: s.boolean("advancedPlaceholderDimensions") ?? false,
    placeholder_dimensions_script: s.string("placeholderConfigurationScript") ?? DEFAULT_DIMENSIONS_SCRIPT,
    placeholder_template: s.string("placeholderTemplate") ?? DEFAULT_TEMPLATE,
  };
}

/** The objects of the array at `key`, each read with `properties`. */
function items(s: Options, key: string, properties: readonly string[]): Options[] {
  return (s.array(key) ?? []).map((item) => s.sub(item, `${key}[].`, ["$id", ...properties]));
}

function create(o: Options, ctx: BuildContext, table: string, s: Options, fields: Record<string, FieldValue | CompiledRecord>): CompiledRecord {
  return ctx.factory.createRecord({ table, source: o.call.loc, installCategory: o.installCategory, explicitId: s.explicitId(), fields });
}

function rowRecords(o: Options, ctx: BuildContext, parent: Options, key: string, container?: CompiledRecord, column?: CompiledRecord): CompiledRecord[] {
  return items(parent, key, ["cssClass", "semanticTag", "order", "columns"]).flatMap((row, index) => {
    const record = create(o, ctx, "sp_row", row, {
      sp_container: container,
      class_name: row.string("cssClass") ?? "",
      semantic_tag: row.string("semanticTag") ?? "",
      order: row.number("order") ?? index + 1,
      sp_column: column,
    });
    return [record, ...columnRecords(o, ctx, row, record)];
  });
}

function columnRecords(o: Options, ctx: BuildContext, row: Options, rowRecord: CompiledRecord): CompiledRecord[] {
  const properties = ["size", "sizeSm", "sizeLg", "sizeXs", "cssClass", "semanticTag", "order", "instances", "nestedRows"];
  return items(row, "columns", properties).flatMap((column, index) => {
    const record = create(o, ctx, "sp_column", column, {
      sp_row: rowRecord,
      size: column.number("size") ?? 12,
      size_sm: column.number("sizeSm"),
      size_lg: column.number("sizeLg"),
      size_xs: column.number("sizeXs"),
      class_name: column.string("cssClass") ?? "",
      semantic_tag: column.string("semanticTag") ?? "",
      order: column.number("order") ?? index + 1,
    });
    const instances = items(column, "instances", INSTANCE_PROPERTIES).map((instance, i) =>
      create(o, ctx, "sp_instance", instance, {
        sp_column: record,
        title: instance.string("title") ?? "",
        id: instance.string("id") ?? "",
        order: instance.number("order") ?? i + 1,
        ...instanceFields(instance, ctx, true, false),
      }),
    );
    return [record, ...rowRecords(o, ctx, column, "nestedRows", undefined, record), ...instances];
  });
}

/** Checks `humanReadableUrlStructure` the way the SDK does: `%variables` aside, only `[a-zA-Z0-9/-]` and one `/`. */
function checkUrlStructure(o: Options): void {
  const structure = o.string("humanReadableUrlStructure");
  if (!structure) return;
  const fixed = structure
    .split(/[/-]|(?=%)/)
    .filter((segment) => !(segment.length > 1 && segment.startsWith("%")))
    .join("");
  if (!/^[a-zA-Z0-9/-]*$/.test(fixed)) {
    o.error("Only alphanumeric characters, - and / are allowed in humanReadableUrlStructure.", o.get("humanReadableUrlStructure"));
  }
  if (structure.indexOf("/") !== structure.lastIndexOf("/")) {
    o.error('No more than one "/" character is allowed in humanReadableUrlStructure.', o.get("humanReadableUrlStructure"));
  }
}

export const spPage: ArtefactSpec = {
  properties: [
    "pageId",
    "title",
    "category",
    "css",
    "draft",
    "internal",
    "omitWatcher",
    "public",
    "useSeoScript",
    "shortDescription",
    "seoScript",
    "dynamicTitleStructure",
    "humanReadableUrlStructure",
    "roles",
    "containers",
  ],
  build(o, ctx) {
    const seoScript = anyReference(o, ctx, "seoScript", "a script include record");
    const useSeoScript = o.boolean("useSeoScript") ?? false;
    if (useSeoScript && (typeof seoScript === "string" ? seoScript : seoScript.getValue()).trim() === "") {
      o.error('Invalid SPPage configuration: when "useSeoScript" is true, "seoScript" must be added.', o.get("useSeoScript"));
    }
    const pageId = o.requiredString("pageId");
    if (pageId.trim() === "") o.error('Invalid SPPage configuration: "pageId" must be a non-empty string.', o.get("pageId"));
    checkUrlStructure(o);
    const title = o.string("title") || pageId;
    const page = ctx.factory.createRecord({
      table: "sp_page",
      source: o.call.loc,
      installCategory: o.installCategory,
      fields: {
        id: pageId,
        title,
        category: o.string("category") ?? "custom",
        css: o.string("css") ?? "",
        draft: o.boolean("draft") ?? false,
        dynamic_title_structure: o.string("dynamicTitleStructure") ?? "",
        human_readable_url_structure: o.string("humanReadableUrlStructure") ?? "",
        internal: o.boolean("internal") ?? false,
        omit_watcher: o.boolean("omitWatcher") ?? false,
        public: o.boolean("public") ?? false,
        roles: rolesString(o, ctx, false),
        seo_script: seoScript,
        short_description: o.string("shortDescription") ?? "",
        use_seo_script: useSeoScript,
      },
    });
    const containerProperties = [
      "name",
      "width",
      "backgroundStyle",
      "backgroundColor",
      "backgroundImage",
      "cssClass",
      "parentClass",
      "subheader",
      "bootstrapAlt",
      "semanticTag",
      "title",
      "order",
      "rows",
    ];
    for (const [index, container] of items(o, "containers", containerProperties).entries()) {
      const order = container.number("order");
      const record = create(o, ctx, "sp_container", container, {
        name: container.string("name") || `${title} - Container ${order || index + 1}`,
        sp_page: page,
        width: container.string("width") ?? "container",
        background_style: container.string("backgroundStyle") ?? "default",
        background_color: container.string("backgroundColor") ?? "",
        background_image: container.string("backgroundImage") ?? "",
        class_name: container.string("cssClass") ?? "",
        container_class_name: container.string("parentClass") ?? "",
        subheader: container.boolean("subheader") ?? false,
        bootstrap_alt: container.boolean("bootstrapAlt") ?? false,
        semantic_tag: container.string("semanticTag") ?? "",
        title: container.string("title") ?? "",
        order: order ?? index + 1,
      });
      page.children.push(record, ...rowRecords(o, ctx, container, "rows", record));
    }
    return page;
  },
};

const MENU_ITEM_PROPERTIES = [
  "label",
  "type",
  "order",
  "active",
  "roles",
  "glyph",
  "color",
  "hint",
  "shortDescription",
  "condition",
  "page",
  "url",
  "urlTarget",
  "scCategory",
  "catItem",
  "kbTopic",
  "kbArticle",
  "kbCategory",
  "table",
  "filter",
  "display1",
  "display2",
  "displayDate",
  "script",
  "childItems",
];

function menuItems(o: Options, ctx: BuildContext, parent: Options, key: string, menu?: CompiledRecord, parentItem?: CompiledRecord): CompiledRecord[] {
  return items(parent, key, MENU_ITEM_PROPERTIES).flatMap((item) => {
    const record = create(o, ctx, "sp_rectangle_menu_item", item, {
      label: item.string("label") ?? "",
      order: item.number("order") ?? 100,
      active: item.boolean("active") ?? true,
      glyph: item.string("glyph") ?? "empty",
      color: item.string("color") ?? "default",
      hint: item.string("hint") ?? "",
      short_description: item.string("shortDescription") ?? "",
      condition: item.string("condition") ?? "",
      type: item.requiredString("type"),
      sp_rectangle_menu: menu ?? "",
      sp_rectangle_menu_item: parentItem ?? "",
      sp_page: anyReference(item, ctx, "page", "a page record"),
      url: item.string("url") ?? "",
      url_target: item.string("urlTarget") ?? "",
      sc_category: anyReference(item, ctx, "scCategory", "a catalog category record"),
      sc_cat_item: anyReference(item, ctx, "catItem", "a catalog item record"),
      kb_topic: item.string("kbTopic") ?? "",
      kb_article: anyReference(item, ctx, "kbArticle", "a knowledge article record"),
      kb_category: anyReference(item, ctx, "kbCategory", "a knowledge category record"),
      table: item.string("table") ?? "",
      filter: item.string("filter") ?? "",
      display_1: item.string("display1") ?? "",
      display_2: item.string("display2") ?? "",
      display_date: item.string("displayDate") ?? "",
      record_script: item.string("script") ?? "",
      roles: rolesString(item, ctx, true),
    });
    return [record, ...menuItems(o, ctx, item, "childItems", undefined, record)];
  });
}

export const spMenu: ArtefactSpec = {
  properties: [...INSTANCE_PROPERTIES, "items"],
  build(o, ctx) {
    const menu = create(o, ctx, "sp_instance_menu", o, {
      title: o.string("title"),
      id: o.string("id"),
      sp_column: anyReference(o, ctx, "column", "a column record"),
      order: o.number("order") ?? 1,
      ...instanceFields(o, ctx, false, true),
    });
    menu.children.push(...menuItems(o, ctx, o, "items", menu));
    return menu;
  },
};
