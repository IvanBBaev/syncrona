// SPDX-License-Identifier: GPL-3.0-or-later
//
// SPWidget() → sp_widget and SPHeaderFooter() → sp_header_footer, as SDK 4.13
// writes them: one record with the SDK's script and template defaults, then an
// sp_ng_template per template, an m2m_sp_widget_dependency row per dependency
// and an m2m_sp_ng_pro_sp_widget row per angular provider.

import type { FluentValue } from "../evaluate";
import { isGUID } from "../keys";
import type { CompiledRecord, RecordId } from "../record";
import { isSNScope, type ArtefactSpec, type BuildContext, type Options } from "./shared";

/** The SDK's `WidgetCategories`: option value → record value. */
const CATEGORIES: Record<string, string> = {
  standard: "standard",
  otherApplications: "other",
  custom: "custom",
  sample: "sample",
  knowledgeBase: "kb",
  servicePortal: "sp_platform",
  serviceCatalog: "sc",
};

const defaultClientScript = (controller: string) => `api.controller = function () {
    /* widget controller */
    var ${controller} = this;
};
`;
const DEFAULT_LINK_SCRIPT = `function link(scope, element, attrs, controller) {
}`;
const DEFAULT_SERVER_SCRIPT = `(function () {
    /* populate the 'data' object */
    /* e.g., data.table = $sp.getValue('table'); */
})();`;
const DEFAULT_HTML_TEMPLATE = "<div><!-- your widget template --></div>";

const CLIENT_SCRIPT_PATTERN = /^(function|api\.controller\s?=\s?function)\s?([$a-z_][$0-9a-z_]*)?\s?\(.*\)\s?\n?{/i;

const PROPERTIES = [
  "name",
  "category",
  "clientScript",
  "serverScript",
  "controllerAs",
  "htmlTemplate",
  "customCss",
  "dataTable",
  "demoData",
  "description",
  "docs",
  "fields",
  "hasPreview",
  "id",
  "internal",
  "linkScript",
  "roles",
  "optionSchema",
  "public",
  "servicenow",
  "dependencies",
  "angularProviders",
  "templates",
];

/** A literal as the plain JSON value the SDK serializes. */
export function toJson(o: Options, value: FluentValue, key: string): unknown {
  switch (value.kind) {
    case "string":
    case "number":
    case "boolean":
      return value.value;
    case "null":
      return null;
    case "array":
      return value.items.map((item) => toJson(o, item, key));
    case "object":
      return Object.fromEntries(
        [...value.props].filter(([, v]) => v.kind !== "undefined").map(([k, v]) => [k, toJson(o, v, key)]),
      );
    default:
      return o.error(`${o.call.api}(): '${key}' must be JSON data.`, value);
  }
}

/** The sys_ids of an array of sys_id strings and records, blanks dropped. */
function recordIds(o: Options, ctx: BuildContext, key: string): (string | RecordId)[] {
  return (o.array(key) ?? []).flatMap((item): (string | RecordId)[] => {
    if (item.kind === "string") return item.value === "" ? [] : [item.value];
    if (item.kind === "call") return [ctx.recordOf(item).id];
    return o.error(`${o.call.api}(): '${key}' must hold sys_ids or records.`, item);
  });
}

/** Role names, in order and with repeats, as the SDK keeps them; sys_ids are an error. */
function roleList(o: Options, ctx: BuildContext): string {
  const names = (o.array("roles") ?? []).flatMap((item) => {
    if (item.kind === "string") {
      if (isGUID(item.value)) o.error("expecting role names or role records created by the Role or Record plugins, not sys_ids", item);
      return [item.value];
    }
    // A Role() or a Record() of any table gives its name, as in the SDK.
    if (item.kind === "call") return [String(ctx.recordOf(item).fields.get("name"))];
    return o.error(`${o.call.api}(): 'roles' must hold role names or role records.`, item);
  });
  return names.join(",");
}

function buildWidget(o: Options, ctx: BuildContext, table: "sp_widget" | "sp_header_footer"): CompiledRecord {
  const id = o.string("id");
  if (id !== undefined && !/^[a-zA-Z0-9_-]+$/.test(id)) {
    o.error("Invalid value: must contain only alphanumeric, -, or _ characters", o.get("id"));
  }
  const clientScript = o.string("clientScript");
  if (clientScript && clientScript.trim().length > 0 && !CLIENT_SCRIPT_PATTERN.test(clientScript.trim())) {
    o.error("Client controller must contain a JavaScript function. Example: api.controller = function($scope) { ... }", o.get("clientScript"));
  }
  const htmlTemplate = o.string("htmlTemplate");
  if (htmlTemplate && htmlTemplate.indexOf('href="#"') > 0) {
    o.error('Do not use href="#" in the Service Portal, use href="javascript:void(0)" instead', o.get("htmlTemplate"));
  }
  const controller = o.string("controllerAs");
  const category = o.string("category");
  const demoData = o.get("demoData");
  const docs = o.get("docs");
  const widget = ctx.factory.createRecord({
    table,
    source: o.call.loc,
    installCategory: o.installCategory,
    explicitId: o.explicitId(),
    fields: {
      name: o.requiredString("name"),
      category: (category === undefined ? undefined : CATEGORIES[category]) ?? "custom",
      client_script: clientScript ?? defaultClientScript(controller || "c"),
      script: o.string("serverScript") ?? DEFAULT_SERVER_SCRIPT,
      controller_as: controller ?? "c",
      template: htmlTemplate ?? DEFAULT_HTML_TEMPLATE,
      css: o.string("customCss") ?? "",
      data_table: o.string("dataTable") ?? "sp_instance",
      demo_data:
        demoData === undefined ? "" : demoData.kind === "string" ? demoData.value : JSON.stringify(toJson(o, demoData, "demoData")),
      description: o.string("description") ?? "",
      docs: docs === undefined ? undefined : docs.kind === "call" ? ctx.recordOf(docs).id : o.string("docs"),
      field_list: (o.stringArray("fields") ?? []).join(","),
      has_preview: o.boolean("hasPreview") ?? false,
      id: id ?? "",
      internal: o.boolean("internal") ?? false,
      servicenow: (o.boolean("servicenow") ?? false) && isSNScope(ctx.scope),
      link: o.string("linkScript") ?? DEFAULT_LINK_SCRIPT,
      roles: roleList(o, ctx),
      option_schema: optionSchemaJson(o),
      public: o.boolean("public") ?? false,
      ...(table === "sp_header_footer" ? { static: o.boolean("static") ?? false } : {}),
    },
  });
  for (const item of o.array("templates") ?? []) {
    const template = o.sub(item, "templates[].", ["$id", "id", "htmlTemplate"]);
    widget.children.push(
      ctx.factory.createRecord({
        table: "sp_ng_template",
        source: o.call.loc,
        installCategory: o.installCategory,
        explicitId: template.explicitId(),
        fields: { id: template.string("id"), sp_widget: widget, template: template.string("htmlTemplate") },
      }),
    );
  }
  const m2m = (m2mTable: string, field: string, key: string) =>
    recordIds(o, ctx, key).map((ref) =>
      ctx.factory.createRecord({
        table: m2mTable,
        source: o.call.loc,
        installCategory: o.installCategory,
        fields: { [field]: ref, sp_widget: widget },
      }),
    );
  widget.children.push(
    ...m2m("m2m_sp_widget_dependency", "sp_dependency", "dependencies"),
    ...m2m("m2m_sp_ng_pro_sp_widget", "sp_angular_provider", "angularProviders"),
  );
  return widget;
}

/** The SDK writes each option's own keys in snake_case (`defaultValue` → `default_value`). */
function optionSchemaJson(o: Options): string {
  const options = o.array("optionSchema");
  if (options === undefined) return "";
  return JSON.stringify(
    options.map((option) => {
      if (option.kind !== "object") return o.error(`${o.call.api}(): 'optionSchema' must hold option objects.`, option);
      const json = toJson(o, option, "optionSchema") as Record<string, unknown>;
      return Object.fromEntries(Object.entries(json).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]));
    }),
  );
}

export const spWidget: ArtefactSpec = {
  properties: PROPERTIES,
  build: (o, ctx) => buildWidget(o, ctx, "sp_widget"),
};

export const spHeaderFooter: ArtefactSpec = {
  properties: [...PROPERTIES, "static"],
  build: (o, ctx) => buildWidget(o, ctx, "sp_header_footer"),
};
