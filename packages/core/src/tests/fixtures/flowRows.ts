// SPDX-License-Identifier: GPL-3.0-or-later
//
// A synthetic flow shaped like the rows a Washington-era instance returns for
// sys_hub_flow and its *_instance_v2 / input / variable / stage tables (columns,
// ui_id nesting, gzip payloads). Every identifier, name and value is invented;
// nothing here was copied from a real instance.
import { gzipSync } from "node:zlib";
import type { FlowRows } from "../../flow/flowDocument.js";

export const FLOW_ID = "0123456789abcdef0123456789abcdef";

export const gz = (value: unknown): string => gzipSync(Buffer.from(JSON.stringify(value), "utf8")).toString("base64");

const audit = {
  sys_created_by: "someone",
  sys_created_on: "2026-01-01 00:00:00",
  sys_updated_by: "someone.else",
  sys_updated_on: "2026-02-02 00:00:00",
  sys_mod_count: "7",
  sys_tags: "",
};

export const UI = {
  update: "11111111-1111-4111-8111-111111111111",
  ifBlock: "22222222-2222-4222-8222-222222222222",
  elseBlock: "33333333-3333-4333-8333-333333333333",
  notify: "44444444-4444-4444-8444-444444444444",
  subflow: "55555555-5555-4555-8555-555555555555",
};

export const UPDATE_VALUES = [
  {
    id: "",
    name: "record",
    value: "{{Created or Updated_1.current}}",
    displayValue: "Trigger - Record Created or Updated➛Example Record",
    children: [],
    parameter: { type: "reference", label: "Record", name: "record", order: 1, mandatory: true },
    scriptActive: false,
  },
  {
    id: "",
    name: "values",
    value: "state=3",
    children: [],
    parameter: { type: "template_value", label: "Fields", name: "values", order: 2, mandatory: false },
    scriptActive: true,
    script: { values: { scriptActive: true, script: "return 'state=3';", savedValue: "state=3" } },
  },
];

export const TRIGGER_INPUTS = [{ name: "table", value: "x_example_record", children: [] }];

export function flowRows(): FlowRows {
  return {
    flow: {
      ...audit,
      sys_id: FLOW_ID,
      name: "Example Flow",
      internal_name: "example_flow",
      type: "flow",
      active: "true",
      status: "published",
      sys_scope: { value: "fedcba9876543210fedcba9876543210", link: "https://example.invalid/api/now/table/sys_scope/x" },
      latest_snapshot: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      description: "",
    },
    triggers: [
      {
        ...audit,
        sys_id: "b0000000000000000000000000000001",
        flow: FLOW_ID,
        ui_id: "",
        order: "",
        trigger_type: "record_create_or_update",
        trigger_definition: "c0000000000000000000000000000001",
        trigger_inputs: gz(TRIGGER_INPUTS),
      },
    ],
    actions: [
      // Out of order on purpose: assembly must sort by `order`.
      {
        ...audit,
        sys_id: "a0000000000000000000000000000005",
        flow: FLOW_ID,
        ui_id: UI.notify,
        parent_ui_id: UI.elseBlock,
        order: "5",
        action_type: "d0000000000000000000000000000002",
        values: gz([]),
        comment: "",
      },
      {
        ...audit,
        sys_id: "a0000000000000000000000000000001",
        flow: FLOW_ID,
        ui_id: UI.update,
        parent_ui_id: "",
        order: "1",
        action_type: "d0000000000000000000000000000001",
        values: gz(UPDATE_VALUES),
      },
    ],
    logic: [
      {
        ...audit,
        sys_id: "e0000000000000000000000000000003",
        flow: FLOW_ID,
        ui_id: UI.elseBlock,
        parent_ui_id: "",
        order: "3",
        logic_definition: "f0000000000000000000000000000002",
        connected_to: UI.ifBlock,
        values: gz([]),
      },
      {
        ...audit,
        sys_id: "e0000000000000000000000000000002",
        flow: FLOW_ID,
        ui_id: UI.ifBlock,
        parent_ui_id: "",
        order: "2",
        logic_definition: "f0000000000000000000000000000001",
        values: gz([{ name: "condition", value: "{{Created or Updated_1.current.state}}=3", children: [] }]),
        flow_variables_assigned: "",
      },
    ],
    subflows: [
      {
        ...audit,
        sys_id: "50000000000000000000000000000004",
        flow: FLOW_ID,
        ui_id: UI.subflow,
        parent_ui_id: UI.ifBlock,
        order: "4",
        subflow: "60000000000000000000000000000001",
        wait_for_completion: "false",
        subflow_inputs: gz([{ name: "record_id", value: "{{Created or Updated_1.current.sys_id}}", children: [] }]),
      },
    ],
    inputs: [
      { ...audit, sys_id: "70000000000000000000000000000002", model: FLOW_ID, model_table: "sys_hub_flow", element: "table_name", order: "101", internal_type: "string" },
      { ...audit, sys_id: "70000000000000000000000000000001", model: FLOW_ID, model_table: "sys_hub_flow", element: "current", order: "100", internal_type: "reference" },
      { ...audit, sys_id: "70000000000000000000000000000003", model: FLOW_ID, model_table: "sys_hub_flow", element: "changed_fields", order: "100", internal_type: "glide_list" },
    ],
    outputs: [],
    variables: [
      { ...audit, sys_id: "80000000000000000000000000000001", model: FLOW_ID, model_table: "sys_hub_flow", element: "approval_link", label: "Approval Link", order: "1", internal_type: "string" },
    ],
    stages: [
      { ...audit, sys_id: "90000000000000000000000000000002", flow: FLOW_ID, value: "done", label: "Done", order: "1" },
      { ...audit, sys_id: "90000000000000000000000000000001", flow: FLOW_ID, value: "started", label: "Started", order: "0", states: '{"pending":"Pending"}' },
    ],
  };
}

export const LEGACY_FLOW_ID = "fedcba9876543210fedcba9876543210";

export const LEGACY_UI = {
  root: "66666666-6666-4666-8666-666666666666",
  lookup: "77777777-7777-4777-8777-777777777777",
};

/**
 * The same kind of flow in the older step model: steps in sys_hub_action_instance
 * / sys_hub_flow_logic / sys_hub_trigger_instance, each input a sys_variable_value
 * row with the dot-walked name and type of the input it fills.
 */
export function legacyFlowRows(): Required<FlowRows> {
  const value = (n: number, document: string, key: string, element: string, internalType: string, val: string, order: string) => ({
    ...audit,
    sys_id: `c${String(n).padStart(31, "0")}`,
    document,
    document_key: key,
    order,
    value: val,
    variable: `d${String(n).padStart(31, "0")}`,
    "variable.element": element,
    "variable.internal_type": internalType,
  });
  return {
    flow: { ...audit, sys_id: LEGACY_FLOW_ID, name: "Legacy Flow", internal_name: "legacy_flow", type: "flow" },
    triggers: [
      {
        ...audit,
        sys_id: "b1000000000000000000000000000001",
        sys_class_name: "sys_hub_trigger_instance",
        flow: LEGACY_FLOW_ID,
        name: "Created or Updated",
        trigger_type: "record_create_or_update",
        trigger_definition: "c1000000000000000000000000000001",
        trigger_inputs: "",
      },
    ],
    actions: [
      {
        ...audit,
        sys_id: "a1000000000000000000000000000002",
        sys_class_name: "sys_hub_action_instance",
        flow: LEGACY_FLOW_ID,
        ui_id: LEGACY_UI.lookup,
        parent_ui_id: LEGACY_UI.root,
        order: "2",
        action_type: "d1000000000000000000000000000001",
        action_inputs: "",
      },
    ],
    logic: [
      {
        ...audit,
        sys_id: "e1000000000000000000000000000001",
        sys_class_name: "sys_hub_flow_logic",
        flow: LEGACY_FLOW_ID,
        ui_id: LEGACY_UI.root,
        parent_ui_id: "",
        order: "1",
        logic_definition: "f1000000000000000000000000000001",
        inputs: "",
        outputs_assigned: "",
      },
    ],
    subflows: [],
    inputs: [],
    outputs: [],
    variables: [],
    stages: [],
    // Out of order on purpose: assembly must sort each owner's values by `order`.
    variableValues: [
      value(3, "sys_hub_action_instance", "a1000000000000000000000000000002", "conditions", "conditions", "state=0", "3"),
      value(2, "sys_hub_action_instance", "a1000000000000000000000000000002", "table_name", "table_name", "x_example_record", "2"),
      value(1, "sys_hub_trigger_instance", "b1000000000000000000000000000001", "table", "table_name", "x_example_record", "1"),
    ],
  };
}
