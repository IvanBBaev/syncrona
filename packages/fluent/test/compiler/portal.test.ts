// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

describe("ServicePortal()", () => {
  it("writes the deprecated knowledge base and catalog with a warning each", () => {
    const result = compile("ServicePortal({ $id: Now.ID['p'], title: 'P', knowledgeBase: 'k', catalog: 'c' })\n");
    expect(messages(result, "warning")).toEqual([
      "'knowledgeBase' is deprecated. Use the 'knowledgeBases' array instead.",
      "'catalog' is deprecated. Use the 'catalogs' array instead.",
    ]);
    const [portal] = only(result, "sp_portal");
    expect([portal.kb_knowledge_base, portal.sc_catalog, portal.url_suffix]).toEqual(["k", "c", ""]);
  });

  it("rejects the deprecated knowledge base and catalog next to their arrays", () => {
    const result = compile(
      "ServicePortal({ $id: Now.ID['p'], knowledgeBase: 'k', knowledgeBases: [{ knowledgeBase: 'k2' }], catalog: 'c', catalogs: [{ catalog: 'c2' }] })\n",
    );
    expect(messages(result)).toEqual([
      "Cannot use both 'knowledgeBase' and 'knowledgeBases'. Remove 'knowledgeBase' and use only the 'knowledgeBases' array instead.",
      "Cannot use both 'catalog' and 'catalogs'. Remove 'catalog' and use only the 'catalogs' array instead.",
    ]);
  });

  it("keys its rows by the portal and the referenced record", () => {
    const result = compile(
      "const p = ServicePortal({ $id: Now.ID['p'], embeddableMacroponents: ['a', 'b'], searchSources: [{}], taxonomies: [{ taxonomy: 't', order: 0 }] })\n" +
        "ServicePortal({ $id: Now.ID['q'], alternatePortal: p, urlSuffix: 'a-b_c' })\n",
    );
    expect(messages(result)).toEqual([]);
    const [p, q] = only(result, "sp_portal");
    expect([p.embeddable_macroponents, q.alternate_portal, q.url_suffix]).toEqual(["a,b", p.sys_id, "a-b_c"]);
    expect(only(result, "m2m_sp_portal_search_source").map((r) => [r.sp_search_source, r.order, r.sp_portal])).toEqual([
      [undefined, "100", p.sys_id],
    ]);
    expect(only(result, "m2m_sp_portal_taxonomy").map((r) => [r.taxonomy, r.order, r.active])).toEqual([["t", "0", "true"]]);
  });

  it.each([
    ["urlSuffix: 'My Portal_'", "Invalid url_suffix 'My Portal_'. Use lowercase alphanumeric characters, hyphens, and single underscores, without a leading or trailing underscore (e.g. 'my_portal')"],
    ["urlSuffix: '_a__b'", "Invalid url_suffix '_a__b'. Use lowercase alphanumeric characters, hyphens, and single underscores, without a leading or trailing underscore (e.g. 'a_b')"],
    ["theme: 1", "ServicePortal(): 'theme' must be a theme record or a sys_id."],
    ["homePage: Role({ $id: Now.ID['r'], name: 'x_snc_bprobe.r' })", "ServicePortal(): 'homePage' must be a page record or a sys_id."],
    ["communicationChannels: [1]", "ServicePortal(): 'communicationChannels' must be an array of strings."],
    ["catalogs: [1]", "ServicePortal(): 'catalogs[]' must be an object."],
    ["catalogs: [{ catalog: 1 }]", "ServicePortal(): 'catalogs[].catalog' must be a record or a sys_id."],
    ["knowledgeBase: 1", "ServicePortal(): 'knowledgeBase' must be a record or a sys_id."],
  ])("rejects %s", (options, message) => {
    expect(messages(compile(`ServicePortal({ $id: Now.ID['p'], ${options} })\n`))).toEqual([message]);
  });
});
