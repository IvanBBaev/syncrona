// SPDX-License-Identifier: GPL-3.0-or-later
import { excludes, includes, tableOptions } from "../defaultOptions.js";

// These defaults are merged under every project's sync.config.js, so a silent
// change would alter what every existing project downloads. Pin them exactly.
describe("defaultOptions", () => {
  it("excludes the built-in configuration tables, each with `true`", () => {
    expect(Object.keys(excludes).sort()).toEqual(
      [
        "content_block_detail",
        "content_block_lists",
        "content_block_programmatic",
        "item_option_new",
        "metric_definition",
        "sc_cat_item",
        "sc_cat_item_producer",
        "sc_category",
        "sp_instance",
        "sp_portal",
        "sys_dictionary",
        "sys_impex_entry",
        "sys_impex_map",
        "sys_navigator",
        "sys_process_flow",
        "sys_relationship",
        "sys_report",
        "sys_scope_privilege",
        "sys_security_acl",
        "sys_transform_entry",
        "sys_transform_map",
        "sys_transform_script",
        "sys_ui_list_control",
        "sys_ui_policy",
        "sysevent_in_email_action",
        "sysrule_view",
      ]
    );
    expect(Object.values(excludes).every((value) => value === true)).toBe(true);
  });

  it("includes the content_css stylesheet as CSS", () => {
    expect(includes).toEqual({ content_css: { style: { type: "css" } } });
  });

  it("imposes no table options", () => {
    expect(tableOptions).toEqual({});
  });
});
