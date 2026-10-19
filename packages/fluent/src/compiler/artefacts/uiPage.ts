// SPDX-License-Identifier: GPL-3.0-or-later
//
// UiPage() → sys_ui_page: a Jelly page served at `<endpoint>`. The html is
// normalised the way the SDK's parse/build round trip prints it (uiPageHtml.ts).

import { CData } from "../record";
import { compileUiPageHtml, UnsupportedHtml } from "./uiPageHtml";
import { isSNScope, type ArtefactSpec } from "./shared";

/** The comment the SDK's html-import plugin puts before the content of an imported `.html` file. */
const HTML_IMPORT_PREFIX = "<!-- @fluent-import-html";

export const uiPage: ArtefactSpec = {
  properties: ["endpoint", "description", "direct", "category", "html", "clientScript", "processingScript"],
  build(o, ctx) {
    const api = o.call.api;
    const endpoint = o.requiredString("endpoint");
    const endpointValue = o.get("endpoint");
    const global = ctx.scope === "global";
    if (!global && !isSNScope(ctx.scope) && !endpoint.startsWith(`${ctx.scope}_`)) {
      o.error(`endpoint must begin with '${ctx.scope}_'`, endpointValue);
    }
    const name = (global ? endpoint : endpoint.replace(`${ctx.scope}_`, "")).replace(/\.do$/, "");
    if (!name) o.error("endpoint must include a page name before .do", endpointValue);

    const htmlValue = o.get("html");
    let html = o.string("html") ?? "";
    // An included .html file also pulls in its translation messages, which are not ported.
    if (htmlValue?.kind === "string" && htmlValue.include) {
      o.error(`${api}(): a Now.include() 'html' is not supported by the native compiler yet.`, htmlValue);
    }
    if (html.trimStart().startsWith(HTML_IMPORT_PREFIX)) {
      o.error(`${api}(): an imported .html 'html' is not supported by the native compiler yet.`, htmlValue);
    }
    if (html) {
      try {
        html = compileUiPageHtml(html);
      } catch (error) {
        if (error instanceof UnsupportedHtml) {
          o.error(`${api}(): 'html' with ${error.message} is not supported by the native compiler yet.`, htmlValue);
        }
        o.error((error as Error).message, htmlValue);
      }
    }

    return ctx.factory.createRecord({
      table: "sys_ui_page",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      // Scoped pages are identified by their endpoint; a global page's endpoint is empty.
      coalesce: global ? ["name"] : ["endpoint"],
      fields: {
        name,
        endpoint: global ? "" : endpoint,
        description: o.string("description"),
        direct: o.boolean("direct") ?? false,
        category: o.string("category"),
        html: new CData(html),
        client_script: new CData(o.string("clientScript") ?? ""),
        processing_script: new CData(o.string("processingScript") ?? ""),
        sys_name: name,
      },
    });
  },
};
