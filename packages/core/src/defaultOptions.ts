// SPDX-License-Identifier: GPL-3.0-or-later
// Built-in defaults that a project's sync.config.js `includes`, `excludes` and
// `tableOptions` are merged over (see config.ts).
import { Sync } from "@syncrona/types";

// Tables left out of a scope by default: their records are configuration
// (security, forms, catalog and portal layout, import maps, reporting) rather
// than source a developer edits as files.
const EXCLUDED_BY_DEFAULT = [
  // Application and data model
  "sys_scope_privilege",
  "sys_dictionary",
  "sys_relationship",
  "sys_security_acl",
  // Forms, lists and navigation
  "sys_ui_policy",
  "sys_ui_list_control",
  "sysrule_view",
  "sys_navigator",
  "sys_process_flow",
  // Import sets and transforms
  "sys_impex_entry",
  "sys_impex_map",
  "sys_transform_map",
  "sys_transform_script",
  "sys_transform_entry",
  // Service catalog
  "sc_cat_item",
  "sc_cat_item_producer",
  "sc_category",
  "item_option_new",
  // Portal and content
  "sp_portal",
  "sp_instance",
  "content_block_programmatic",
  "content_block_lists",
  "content_block_detail",
  // Reporting, metrics and inbound email
  "sys_report",
  "metric_definition",
  "sysevent_in_email_action",
] as const;

const excludes: Sync.TablePropMap = Object.fromEntries(
  EXCLUDED_BY_DEFAULT.map((table) => [table, true])
);

// Fields pulled in by default beyond what the instance reports for a table:
// a theme's stylesheet lives in `content_css.style` and is edited as CSS.
const includes: Sync.TablePropMap = {
  content_css: { style: { type: "css" } },
};

// No per-table query options are imposed by default.
const tableOptions: Sync.ITableOptionsMap = {};

export { includes, excludes, tableOptions };
