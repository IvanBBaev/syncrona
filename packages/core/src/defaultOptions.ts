import { Sync } from "@syncrona/types";
let excludes: Sync.TablePropMap = {
  sys_scope_privilege: true,
  sys_dictionary: true,
  sys_impex_entry: true,
  sys_security_acl: true,
  sys_transform_map: true,
  sys_ui_policy: true,
  sys_ui_list_control: true,
  sys_relationship: true,
  sys_report: true,
  item_option_new: true,
  sys_process_flow: true,
  content_block_programmatic: true,
  sp_instance: true,
  sys_transform_script: true,
  sc_category: true,
  sysrule_view: true,
  sc_cat_item: true,
  sysevent_in_email_action: true,
  sys_navigator: true,
  sys_transform_entry: true,
  metric_definition: true,
  content_block_lists: true,
  content_block_detail: true,
  sp_portal: true,
  sc_cat_item_producer: true,
  sys_impex_map: true
};

let includes: Sync.TablePropMap = {
  content_css: {
    style: {
      type: "css"
    }
  }
};

let tableOptions: Sync.ITableOptionsMap = {};

export { includes, excludes, tableOptions };
