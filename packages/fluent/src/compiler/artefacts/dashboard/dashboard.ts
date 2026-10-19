// SPDX-License-Identifier: GPL-3.0-or-later
//
// Dashboard() → par_dashboard, plus, in the SDK's order: the top layout's
// par_dashboard_canvas and its widgets, each tab's par_dashboard_tab, canvas
// and widgets, a par_dashboard_visibility per visibility (the default
// experience when there is none) and a par_dashboard_permission per permission.

import type { FluentValue } from "../../evaluate";
import type { CompiledRecord, FieldValue } from "../../record";
import type { ArtefactSpec, BuildContext, Options } from "../shared";
import { COMPONENT_NAME_TO_SYSID, DEFAULT_PROPERTY_VALUES } from "./components";

/** The experience a dashboard without visibilities is visible in. */
const DEFAULT_EXPERIENCE = "08c73d60537101100834ddeeff7b1287";

const WIDGET = [
  "$id",
  "component",
  "componentProps",
  "height",
  "width",
  "position",
];
const TAB = ["$id", "name", "active", "widgets"];
const VISIBILITY = ["$id", "experience"];
const PERMISSION = [
  "$id",
  "user",
  "group",
  "role",
  "canRead",
  "canWrite",
  "canShare",
  "owner",
];

/** A sys_id stays as given; a known component name (any case) resolves to its sys_id. */
function componentSysId(component: string): string {
  if (/^[0-9a-f]{32}$/i.test(component)) return component;
  return COMPONENT_NAME_TO_SYSID[component.toLowerCase()] ?? component;
}

/** `componentProps` as the plain JSON value it is serialised to. */
function plain(o: Options, value: FluentValue, path: string): unknown {
  switch (value.kind) {
    case "string":
    case "number":
    case "boolean":
      return value.value;
    case "null":
      return null;
    case "array":
      return value.items.map((item, i) => plain(o, item, `${path}[${i}]`));
    case "object":
      return Object.fromEntries(
        [...value.props].map(([key, prop]) => [
          key,
          plain(o, prop, `${path}.${key}`),
        ]),
      );
    default:
      return o.error(`${o.call.api}(): '${path}' must be a JSON value.`, value);
  }
}

function requiredNumber(o: Options, key: string): number {
  const value = o.number(key);
  if (value === undefined)
    return o.error(`${o.call.api}(): '${o.path}${key}' is required.`);
  return value;
}

export const dashboard: ArtefactSpec = {
  properties: [
    "name",
    "active",
    "description",
    "certified",
    "topLayout",
    "tabs",
    "visibilities",
    "permissions",
  ],
  build(o, ctx) {
    const create = (
      table: string,
      source: Options,
      fields: Record<string, FieldValue | CompiledRecord>,
    ) =>
      ctx.factory.createRecord({
        table,
        source: source.object.loc,
        installCategory: o.installCategory,
        explicitId: source.explicitId(),
        fields,
      });

    const record = ctx.factory.createRecord({
      table: "par_dashboard",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name: o.requiredString("name"),
        active: o.boolean("active") ?? true,
        description: o.string("description") ?? "",
        certified: o.boolean("certified") ?? false,
      },
    });
    const children = record.children;

    const canvas = (fields: Record<string, CompiledRecord>, source: Options) =>
      ctx.factory.createRecord({
        table: "par_dashboard_canvas",
        source: source.object.loc,
        installCategory: o.installCategory,
        fields: { dashboard: record, ...fields },
      });

    const widgets = (layout: Options, path: string, on: CompiledRecord) => {
      for (const item of layout.array("widgets") ?? []) {
        const w = layout.sub(item, path, WIDGET);
        const props = w.get("componentProps");
        const position =
          w.nested("position", ["x", "y"]) ??
          w.error(`${o.call.api}(): '${w.path}position' is required.`);
        children.push(
          create("par_dashboard_widget", w, {
            canvas: on,
            component: componentSysId(w.requiredString("component")),
            component_props: JSON.stringify({
              ...DEFAULT_PROPERTY_VALUES,
              ...(props === undefined
                ? {}
                : (plain(w, props, `${w.path}componentProps`) as object)),
            }),
            h: requiredNumber(w, "height"),
            w: requiredNumber(w, "width"),
            x: requiredNumber(position, "x"),
            y: requiredNumber(position, "y"),
          }),
        );
      }
    };

    const topLayout = o.nested("topLayout", ["widgets"]);
    if (topLayout !== undefined) {
      const top = canvas({}, topLayout);
      children.push(top);
      widgets(topLayout, "topLayout.widgets[].", top);
    }

    for (const [index, item] of (o.array("tabs") ?? []).entries()) {
      const t = o.sub(item, "tabs[].", TAB);
      const tab = create("par_dashboard_tab", t, {
        dashboard: record,
        name: t.requiredString("name"),
        order: index,
        active: t.boolean("active") ?? true,
      });
      const tabCanvas = canvas({ dashboard_tab: tab }, t);
      children.push(tab, tabCanvas);
      widgets(t, "widgets[].", tabCanvas);
    }

    const visibilities = o.array("visibilities") ?? [];
    if (visibilities.length === 0) {
      children.push(
        ctx.factory.createRecord({
          table: "par_dashboard_visibility",
          source: o.call.loc,
          installCategory: o.installCategory,
          fields: { dashboard: record, experience: DEFAULT_EXPERIENCE },
        }),
      );
    }
    for (const item of visibilities) {
      const v = o.sub(item, "visibilities[].", VISIBILITY);
      children.push(
        create("par_dashboard_visibility", v, {
          dashboard: record,
          experience: experienceOf(v, ctx),
        }),
      );
    }

    for (const item of o.array("permissions") ?? []) {
      const p = o.sub(item, "permissions[].", PERMISSION);
      const subjects = Object.fromEntries(
        ["user", "group", "role"].flatMap((key) => {
          const value = p.string(key);
          return value === undefined ? [] : [[key, value]];
        }),
      );
      children.push(
        create("par_dashboard_permission", p, {
          dashboard: record,
          can_read: p.boolean("canRead") ?? true,
          can_write: p.boolean("canWrite") ?? false,
          can_share: p.boolean("canShare") ?? false,
          owner: p.boolean("owner") ?? false,
          ...subjects,
        }),
      );
    }
    return record;
  },
};

/** `experience`: a Workspace() record, or an experience sys_id as given. */
function experienceOf(v: Options, ctx: BuildContext): string | CompiledRecord {
  const value = v.get("experience");
  if (value?.kind === "string") return value.value;
  if (value?.kind === "call") {
    const workspace = ctx.recordOf(value);
    if (workspace.table === "sys_ux_page_registry") return workspace;
  }
  return v.error(
    `${v.call.api}(): '${v.path}experience' must be a Workspace() record or a sys_id.`,
    value,
  );
}
