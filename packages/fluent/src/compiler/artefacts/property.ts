// SPDX-License-Identifier: GPL-3.0-or-later
//
// Property() → sys_properties.

import type { FluentValue } from "../evaluate";
import { isSNScope, roleNames, type ArtefactSpec, type BuildContext, type Options } from "./shared";

function rolesString(o: Options, ctx: BuildContext, value: FluentValue | undefined, key: string): string | undefined {
  if (value === undefined || value.kind === "undefined") return undefined;
  if (value.kind !== "array") o.error(`Property(): 'roles.${key}' must be an array.`, value);
  return roleNames(o, ctx, value.items, `roles.${key}`);
}

export const property: ArtefactSpec = {
  properties: ["name", "type", "value", "description", "ignoreCache", "isPrivate", "choices", "roles"],
  build(o, ctx) {
    const name = o.requiredString("name");
    if (!isSNScope(ctx.scope) && ctx.scope !== "global" && !name.startsWith(`${ctx.scope}.`)) {
      ctx.report(
        "warning",
        `Property names should begin with '${ctx.scope}.' to match the app scope and avoid collisions with properties from other scopes`,
        o.get("name")!.loc,
      );
    }
    let roles = {
      read_roles: "" as string | undefined,
      write_roles: "" as string | undefined,
    };
    const rolesValue = o.get("roles");
    if (rolesValue !== undefined) {
      if (rolesValue.kind !== "object") return o.error("Property(): 'roles' must be an object.", rolesValue);
      for (const [key, value] of rolesValue.props) {
        if (key !== "read" && key !== "write") o.error(`Property(): 'roles' has no property '${key}'.`, value);
      }
      roles = {
        read_roles: rolesString(o, ctx, rolesValue.props.get("read"), "read"),
        write_roles: rolesString(o, ctx, rolesValue.props.get("write"), "write"),
      };
    }
    return ctx.factory.createRecord({
      table: "sys_properties",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name,
        suffix: name.replace(new RegExp(`^${ctx.scope}\\.`), ""),
        description: o.string("description"),
        type: o.string("type") ?? "string",
        value: o.scalar("value"),
        is_private: o.boolean("isPrivate") ?? false,
        ignore_cache: o.boolean("ignoreCache") ?? false,
        choices: o.stringArray("choices")?.join(","),
        ...roles,
      },
    });
  },
};
