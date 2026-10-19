// SPDX-License-Identifier: GPL-3.0-or-later
//
// UxListMenuConfig() → sys_ux_list_menu_config, plus a sys_ux_list_category per
// category, a sys_ux_list per list and a sys_ux_applicability_m2m_list per list
// applicability, in declaration order.

import type { CompiledRecord, FieldValue } from "../record";
import type { ArtefactSpec, BuildContext, Options } from "./shared";

/** The list's `hide*` flags; each one is the `hide_*` column, false unless set. */
const HIDE_FLAGS = [
  "hideCellFilter",
  "hideCheckboxHover",
  "hideColumnFiltering",
  "hideColumnGrouping",
  "hideColumnResizing",
  "hideColumnSorting",
  "hideDragAndDrop",
  "hideEmptyStateImage",
  "hideFirstPage",
  "hideHeader",
  "hideHighlightContent",
  "hideHighlightedValues",
  "hideInlineEditing",
  "hideLastPage",
  "hideLastRefreshedText",
  "hideLinks",
  "hideListActions",
  "hideMenuButton",
  "hideNextPage",
  "hideOptionToSaveAs",
  "hidePages",
  "hidePagination",
  "hidePanelAdvanced",
  "hidePanelButton",
  "hidePanelConditionDelete",
  "hidePanelFooter",
  "hidePanelRestore",
  "hidePersonalization",
  "hidePreviousPage",
  "hideQuickEdit",
  "hideRange",
  "hideRecordCountBadge",
  "hideReferenceLinks",
  "hideRefreshButton",
  "hideRowCount",
  "hideRowSelector",
  "hideRowsPerPageSelector",
  "hideSelectAll",
  "hideSharingButton",
  "hideTitle",
];

/** List string options the SDK writes as given (an empty element when unset). */
const LIST_STRINGS: Record<string, string> = {
  columns: "columns",
  condition: "condition",
  fixedQuery: "fixed_query",
  groupByColumn: "group_by_column",
  groups: "groups",
  highlightContentColor: "highlight_content_color",
  highlightContentPattern: "highlight_content_pattern",
  listAttributes: "list_attributes",
  roles: "roles",
  view: "view",
};

const LIST_PROPERTIES = [
  "$id",
  "active",
  "applicabilities",
  "table",
  "title",
  "enableInfiniteScroll",
  "liveUpdates",
  "maxCharacters",
  "order",
  "overrideWordWrapUserPref",
  "wordWrap",
  ...Object.keys(LIST_STRINGS),
  ...HIDE_FLAGS,
];

const snakeCase = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function child(o: Options, ctx: BuildContext, table: string, item: Options, fields: Record<string, FieldValue | CompiledRecord>) {
  return ctx.factory.createRecord({
    table,
    source: o.call.loc,
    installCategory: o.installCategory,
    explicitId: item.explicitId(),
    fields,
  });
}

/** An m2m row's `applicability`: an Applicability() record, or a sys_id string as given. */
function applicabilityOf(o: Options, ctx: BuildContext, a: Options): string | CompiledRecord {
  const target = a.get("applicability");
  if (target?.kind === "string") return target.value;
  if (target?.kind === "call") {
    const record = ctx.recordOf(target);
    if (record.table === "sys_ux_applicability") return record;
  }
  return a.error(`${o.call.api}(): '${a.path}applicability' must be an Applicability() record or a sys_id.`, target);
}

export const uxListMenuConfig: ArtefactSpec = {
  properties: ["name", "description", "active", "categories"],
  build(o, ctx) {
    const config = ctx.factory.createRecord({
      table: "sys_ux_list_menu_config",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name: o.requiredString("name"),
        description: o.string("description") ?? "",
        active: o.boolean("active") ?? true,
      },
    });

    for (const value of o.array("categories") ?? []) {
      const c = o.sub(value, "categories[].", ["$id", "title", "active", "order", "description", "lists"]);
      const category = child(o, ctx, "sys_ux_list_category", c, {
        active: c.boolean("active") ?? true,
        configuration: config,
        description: c.string("description") ?? "",
        title: c.requiredString("title"),
        order: c.number("order") ?? 100,
      });
      config.children.push(category);

      for (const listValue of c.array("lists") ?? []) {
        const l = c.sub(listValue, "lists[].", LIST_PROPERTIES);
        const list = child(o, ctx, "sys_ux_list", l, {
          active: l.boolean("active") ?? true,
          category,
          configuration: config,
          enable_infinite_scroll: l.boolean("enableInfiniteScroll") ?? false,
          live_updates: l.string("liveUpdates") ?? "off",
          max_characters: l.number("maxCharacters") ?? 4000,
          order: l.number("order") ?? 100,
          override_word_wrap_user_pref: l.boolean("overrideWordWrapUserPref") ?? false,
          table: l.requiredString("table"),
          title: l.requiredString("title"),
          word_wrap: l.boolean("wordWrap") ?? false,
          ...Object.fromEntries(Object.entries(LIST_STRINGS).map(([key, column]) => [column, l.string(key)])),
          ...Object.fromEntries(HIDE_FLAGS.map((key) => [snakeCase(key), l.boolean(key) ?? false])),
        });
        config.children.push(list);

        for (const m2mValue of l.array("applicabilities") ?? []) {
          const a = l.sub(m2mValue, "applicabilities[].", ["$id", "active", "applicability", "order"]);
          const applicability = applicabilityOf(o, ctx, a);
          config.children.push(
            child(o, ctx, "sys_ux_applicability_m2m_list", a, {
              active: a.boolean("active") ?? true,
              applicability,
              list,
              order: a.number("order") ?? 0,
            }),
          );
        }
      }
    }
    return config;
  },
};
