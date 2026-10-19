// SPDX-License-Identifier: GPL-3.0-or-later
//
// ScriptInclude() → sys_script_include.

import { CData } from "../record";
import { isSNScope, type ArtefactSpec } from "./shared";

const NAME = /^[a-zA-Z_$][0-9a-zA-Z_$]+$/;
const CALLER_ACCESS: Record<string, number> = { tracking: 1, restriction: 2 };

export const scriptInclude: ArtefactSpec = {
  properties: [
    "name",
    "apiName",
    "description",
    "script",
    "accessibleFrom",
    "callerAccess",
    "sandboxCallable",
    "clientCallable",
    "mobileCallable",
    "active",
  ],
  build(o, ctx) {
    const name = o.requiredString("name");
    if (!NAME.test(name)) {
      ctx.report(
        "warning",
        `Script include name '${name}' is not a valid JavaScript identifier. This may cause issues when invoking the script include on the platform.`,
        o.get("name")!.loc,
      );
    }
    const callerAccess = o.string("callerAccess");
    const accessibleFrom = o.string("accessibleFrom");
    if (callerAccess !== undefined && accessibleFrom !== "public") {
      ctx.report(
        "hint",
        "'callerAccess' is only effective when 'accessibleFrom' is set to 'public'. It is ignored by the platform otherwise.",
        o.get("callerAccess")!.loc,
      );
    }
    const apiName = o.string("apiName");
    if (apiName !== undefined && !isSNScope(ctx.scope) && !apiName.startsWith(`${ctx.scope}.`)) {
      ctx.report("error", `apiName must begin with '${ctx.scope}.'`, o.get("apiName")!.loc);
    }
    return ctx.factory.createRecord({
      table: "sys_script_include",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name,
        script: new CData(o.requiredString("script")),
        description: o.string("description"),
        api_name: apiName ?? `${ctx.scope}.${name}`,
        caller_access: (callerAccess !== undefined ? CALLER_ACCESS[callerAccess] : undefined) ?? "",
        client_callable: o.boolean("clientCallable") ?? false,
        mobile_callable: o.boolean("mobileCallable") ?? false,
        sandbox_callable: o.boolean("sandboxCallable") ?? false,
        access: accessibleFrom ?? "package_private",
        active: o.boolean("active") ?? true,
        sys_name: name,
      },
    });
  },
};
