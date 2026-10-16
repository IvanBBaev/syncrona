// SPDX-License-Identifier: GPL-3.0-or-later
//
// UiAction() → sys_ui_action, plus a sys_ui_action_role row per role and a
// sys_ui_action_view row per included or excluded view.

import { CData, type CompiledRecord } from "../record";
import { roleRecord, type ArtefactSpec, type Options } from "./shared";

const FORM_FLAGS = ["showButton", "showLink", "showContextMenu"];
const LIST_FLAGS = ["showButton", "showBannerButton", "showContextMenu", "showListChoice", "showLink", "showSaveWithFormButton"];

interface Display {
  applicable: boolean;
  config?: Options;
}

/** `form` / `list`: `true` makes the action applicable with no display options; an object applies when a flag is set. */
function display(o: Options, key: string, flags: readonly string[]): Display {
  const value = o.get(key);
  if (value === undefined) return { applicable: false };
  if (value.kind === "boolean") return { applicable: value.value };
  const config = o.sub(value, `${key}.`, [...flags, "showIconOnly", "style", "iconName"]);
  return { applicable: flags.some((flag) => config.boolean(flag)), config };
}

export const uiAction: ArtefactSpec = {
  properties: [
    "table",
    "name",
    "actionName",
    "active",
    "form",
    "list",
    "client",
    "workspace",
    "overrides",
    "showInsert",
    "showUpdate",
    "showQuery",
    "showMultipleUpdate",
    "condition",
    "script",
    "comments",
    "messages",
    "hint",
    "order",
    "isolateScript",
    "roles",
    "includeInViews",
    "excludeFromViews",
  ],
  build(o, ctx) {
    const name = o.requiredString("name");
    const form = display(o, "form", FORM_FLAGS);
    const list = display(o, "list", LIST_FLAGS);
    const client = o.nested("client", ["isClient", "isUi11Compatible", "isUi16Compatible", "onClick"]);
    const workspace = o.nested("workspace", ["isConfigurableWorkspace", "showFormButtonV2", "showFormMenuButtonV2", "clientScriptV2"]);
    const configurable = workspace?.boolean("isConfigurableWorkspace") ?? false;
    const formButtonV2 = workspace?.boolean("showFormButtonV2") ?? false;
    const formMenuButtonV2 = workspace?.boolean("showFormMenuButtonV2") ?? false;
    if (configurable && !formButtonV2 && !formMenuButtonV2) {
      ctx.report(
        "error",
        "workspace.showFormButtonV2 or workspace.showFormMenuButtonV2 must be true when workspace.isConfigurableWorkspace is true",
        workspace!.get("isConfigurableWorkspace")!.loc,
      );
    }
    const messages = o.get("messages")?.kind === "array" ? o.stringArray("messages")!.join("\n") : o.string("messages");
    const script = o.string("script");
    const clientScriptV2 = workspace?.string("clientScriptV2");
    const formIcon = form.config?.string("iconName");
    const listIcon = list.config?.string("iconName");
    const record = ctx.factory.createRecord({
      table: "sys_ui_action",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name,
        table: o.requiredString("table"),
        action_name: o.string("actionName"),
        comments: o.string("comments") ?? "",
        active: o.boolean("active") ?? true,
        client: client?.boolean("isClient") ?? false,
        onclick: client?.string("onClick"),
        messages,
        list_style: list.config?.string("style"),
        form_style: form.config?.string("style"),
        condition: o.string("condition") ?? "",
        script: script !== undefined ? new CData(script) : "",
        hint: o.string("hint") ?? "",
        order: o.number("order") ?? 100,
        sys_overrides: o.string("overrides") ?? "",
        form_action: form.applicable,
        list_action: list.applicable,
        form_button: form.config?.boolean("showButton") ?? false,
        list_button: list.config?.boolean("showButton") ?? false,
        form_link: form.config?.boolean("showLink") ?? false,
        list_link: list.config?.boolean("showLink") ?? false,
        show_form_icon_only: form.config?.boolean("showIconOnly") ?? false,
        show_list_icon_only: list.config?.boolean("showIconOnly") ?? false,
        form_context_menu: form.config?.boolean("showContextMenu") ?? false,
        list_context_menu: list.config?.boolean("showContextMenu") ?? false,
        show_query: o.boolean("showQuery") ?? false,
        show_insert: o.boolean("showInsert") ?? true,
        show_multiple_update: o.boolean("showMultipleUpdate") ?? false,
        show_update: o.boolean("showUpdate") ?? true,
        list_choice: list.config?.boolean("showListChoice") ?? false,
        list_banner_button: list.config?.boolean("showBannerButton") ?? false,
        list_save_with_form_button: list.config?.boolean("showSaveWithFormButton") ?? false,
        isolate_script: o.boolean("isolateScript") ?? false,
        ui11_compatible: client?.boolean("isUi11Compatible") ?? false,
        ui16_compatible: client?.boolean("isUi16Compatible") ?? false,
        client_script_v2: clientScriptV2 !== undefined ? new CData(clientScriptV2) : undefined,
        form_button_v2: formButtonV2,
        form_menu_button_v2: formMenuButtonV2,
        format_for_configurable_workspace: configurable,
        sys_name: name,
        ...(formIcon !== undefined ? { form_button_icon: formIcon } : {}),
        ...(listIcon !== undefined ? { list_button_icon: listIcon } : {}),
      },
    });

    const include = o.stringArray("includeInViews") ?? [];
    const exclude = new Set(o.stringArray("excludeFromViews"));
    if (include.some((view) => exclude.has(view))) {
      ctx.report(
        "error",
        "The same view should not appear in both the `excludeFromViews` and `includeInViews`",
        o.get("includeInViews")!.loc,
      );
    }
    const child = (table: string, fields: Record<string, string | CompiledRecord | ReturnType<typeof ctx.factory.createReference>>) =>
      ctx.factory.createRecord({
        table,
        source: o.call.loc,
        installCategory: o.installCategory,
        fields: { sys_ui_action: record, ...fields },
      });
    const views = [...include.map((view) => ["include", view] as const), ...[...exclude].map((view) => ["exclude", view] as const)].map(
      ([visibility, view]) =>
        child("sys_ui_action_view", {
          visibility,
          sys_ui_view: ctx.factory.createReference("sys_ui_view", undefined, {
            name: view,
          }),
        }),
    );
    const roles = (o.array("roles") ?? []).map((value) => {
      if (value.kind === "string")
        return ctx.factory.createReference("sys_user_role", undefined, {
          name: value.value,
        });
      if (value.kind === "call") return roleRecord(o, ctx, value, "roles").role;
      return o.error("UiAction(): 'roles' must hold role names or Role() records.", value);
    });
    record.children.push(...roles.map((role) => child("sys_ui_action_role", { sys_user_role: role })), ...views);
    return record;
  },
};
