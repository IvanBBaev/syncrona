// SPDX-License-Identifier: GPL-3.0-or-later

import { deduplicateNames, slugify } from "../../src/compiler/artefacts/playbook";
import { compile, messages } from "./helpers";

const AUTOMATION = "import { PlaybookDefinition, PlaybookTriggerTypes, ActivityDefinitions, wfa } from '@servicenow/sdk/automation'\n";

const ACTIVITY = "wfa.playbook.activity(ActivityDefinitions.Core.Instruction, { $id: 'a1', label: 'Do it', order: 1, startRule: wfa.playbook.run.Immediately() })";
const ACTIVITIES = `() => { const a = ${ACTIVITY}\n return { a: a } }`;
const LANE = `wfa.playbook.lane({ config: { $id: 'l1', label: 'Main' }, activities: ${ACTIVITIES} })`;
const LANES = `() => { const main = ${LANE}\n return { main: main } }`;
const TRIGGER = "wfa.playbook.trigger(PlaybookTriggerTypes.RecordCreate, { $id: 't1', label: 'On create' }, { table: 'incident' })";

interface Parts {
  config?: string;
  dependent?: string;
  body?: string;
}

/** A playbook source; each part replaces the matching default argument text. */
function playbook({ config, dependent, body }: Parts = {}): string {
  return `${AUTOMATION}PlaybookDefinition(
  ${config ?? "{ $id: 'pb1', label: 'My Playbook', parentTable: 'incident' }"},
  ${dependent ?? `{ triggers: [${TRIGGER}] }`},
  ${body ?? `{ lanes: ${LANES} }`}
)\n`;
}

/** A playbook whose lanes function returns `lanes` (an object literal text) after `locals`. */
function withLanes(locals: string, lanes: string): string {
  return playbook({ body: `{ lanes: () => { ${locals}\n return ${lanes} } }` });
}

/** A playbook whose single lane's activities function returns `activities` after `locals`. */
function withActivities(locals: string, activities: string): string {
  return withLanes(
    `const main = wfa.playbook.lane({ config: { $id: 'l1', label: 'Main' }, activities: () => { ${locals}\n return ${activities} } })`,
    "{ main: main }",
  );
}

function withActivity(args: string): string {
  return withActivities(`const a = wfa.playbook.activity(${args})`, "{ a: a }");
}

function withTrigger(trigger: string, config?: string): string {
  return playbook({ config, dependent: `{ triggers: [${trigger}] }` });
}

/** The sys_id the test GUID counter gives the `n`th `$id` key. */
function id(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function fileOf(source: string): string {
  const result = compile(source);
  expect(messages(result)).toEqual([]);
  expect(result.files).toHaveLength(1);
  return result.files[0].content;
}

function errorsOf(source: string): string {
  return messages(compile(source)).join("\n");
}

describe("PlaybookDefinition()", () => {
  it("writes one composite file with the playbook, lanes, activities, triggers and process input", () => {
    const result = compile(playbook());
    expect(messages(result)).toEqual([]);
    expect(result.records.filter((r) => r.table.startsWith("sys_pd"))).toEqual([]);
    expect(result.files.map((f) => f.path)).toEqual([`update/sys_pd_process_definition_${id(1)}.xml`]);
    const file = result.files[0].content;
    expect(file).toContain(`<sys_pd_lane action="delete_multiple" query="process_definition=${id(1)}^sys_idNOT IN${id(2)}"/>`);
    expect(file).toContain(`<sys_pd_activity action="delete_multiple" query="process_definition=${id(1)}^sys_idNOT IN${id(3)}"/>`);
    expect(file).toContain(`<sys_pd_process_variant action="delete_multiple" query="process_definition=${id(1)}"/>`);
    expect(file).toContain("<name>my_playbook</name>");
    expect(file).toContain("<restartable>RESTARTABLE_FALSE</restartable>");
    expect(file).toContain("<sys_pd_process_input ");
    expect(file).toContain("<reference>incident</reference>");
    expect(file).toContain("<value>{{triggerRecord}}</value>");
    expect(file).toContain("<name>on_create</name>");
    expect(file).toContain("<start_rule_name>immediate</start_rule_name>");
    expect(file).toContain(`<value>{{act.${id(3)}.description}}</value>`);
  });

  it("writes no process input without a parentTable", () => {
    const file = fileOf(withTrigger(TRIGGER, "{ $id: 'pb1', label: 'P', name: '' }"));
    expect(file).not.toContain("sys_pd_process_input");
    expect(file).not.toContain("{{triggerRecord}}");
    expect(file).toContain("<name>p</name>");
  });

  it("compiles a playbook without triggers", () => {
    const file = fileOf(playbook({ dependent: "{}" }));
    expect(file).not.toContain("sys_pd_trigger_instance");
  });

  it("names unnamed lanes and activities after their labels, deduplicated after explicit names", () => {
    const file = fileOf(
      withLanes(
        `const one = wfa.playbook.lane({ config: { $id: 'l1', label: 'Main', order: 1 }, activities: () => {
          const a = wfa.playbook.activity(ActivityDefinitions.Core.Instruction, { $id: 'a1', label: 'Step', order: 1, startRule: wfa.playbook.run.Immediately() })
          const b = wfa.playbook.activity(ActivityDefinitions.Core.Instruction, { $id: 'a2', label: 'Other', name: 'step', order: 2, startRule: wfa.playbook.run.Immediately() })
          return { a: a, b: b } } })
        const two = wfa.playbook.lane({ config: { $id: 'l2', label: 'Second', name: 'main', order: 2, startRule: wfa.playbook.run.After(one) }, activities: () => ({}) })`,
        "{ one: one, two: two }",
      ),
    );
    expect(file).toContain("<name>step_1</name>");
    expect(file).toContain("<name>step</name>");
    expect(file).toContain("<name>main_1</name>");
    expect(file).toContain("<label>Second</label>");
    expect(file).toContain(`<starts_after_lanes>${id(2)}</starts_after_lanes>`);
    expect(file).toContain("<start_rule>after_items</start_rule>");
  });

  it("skips trigger inputs given as undefined and names an unlabelled trigger ''", () => {
    const file = fileOf(withTrigger("wfa.playbook.trigger(PlaybookTriggerTypes.RecordUpdate, { $id: 't1' }, { table: 'incident', condition: undefined })"));
    expect(file).toContain("<variable>82be38d1ff2200108c8733af793bf1a7</variable>");
    expect(file).not.toContain("52ce78d1ff2200108c8733af793bf1b3");
  });

  it.each([
    ["the wrong argument count", `${AUTOMATION}PlaybookDefinition({ $id: 'pb1', label: 'P' }, { triggers: [] })\n`, "takes one options object, its triggers object and its lanes object"],
    ["an unsupported option", playbook({ config: "{ $id: 'pb1', label: 'P', access: 'public' }" }), "config 'access' is not supported"],
    ["$override", playbook({ config: "{ $id: 'pb1', label: 'P', $override: {} }" }), "'$override' is not supported"],
    ["an invalid restartable", playbook({ config: "{ $id: 'pb1', label: 'P', restartable: 'YES' }" }), "'restartable' must be 'RESTARTABLE_TRUE' or 'RESTARTABLE_FALSE'"],
    ["a non-object triggers argument", playbook({ dependent: "1" }), "the triggers argument must be an object"],
    ["an unsupported dependent option", playbook({ dependent: "{ triggers: [], variants: [] }" }), "dependent config 'variants' is not supported"],
    ["a non-object lanes argument", playbook({ body: "1" }), "the lanes argument must be an object"],
    ["lanes that are not a function", playbook({ body: "{ lanes: 1 }" }), "'lanes' must be a function returning an object"],
    ["lanes that return no object", playbook({ body: "{ lanes: () => 1 }" }), "'lanes' must return an object literal"],
    ["a lane that is not a lane call", withLanes("", "{ x: 1 }"), "a lane must be a wfa.playbook.lane() call"],
    ["a lane with two arguments", withLanes("const l = wfa.playbook.lane({}, {})", "{ l: l }"), "wfa.playbook.lane() takes one object"],
    ["a lane without config", withLanes("const l = wfa.playbook.lane({ activities: () => ({}) })", "{ l: l }"), "'lanes[0].config' is required"],
    ["a non-object lane", withLanes("const l = wfa.playbook.lane(1)", "{ l: l }"), "'lanes[0]' must be an object"],
    ["an unsupported lane option", withLanes("const l = wfa.playbook.lane({ config: { $id: 'l1', label: 'L', conditionToRun: 'x' }, activities: () => ({}) })", "{ l: l }"), "lane 'conditionToRun' is not supported"],
    [
      "a duplicate lane order",
      withLanes("const a = wfa.playbook.lane({ config: { $id: 'l1', label: 'A' }, activities: () => ({}) })\n const b = wfa.playbook.lane({ config: { $id: 'l2', label: 'B' }, activities: () => ({}) })", "{ a: a, b: b }"),
      "Duplicate order 1: 'B' and 'A' share order 1",
    ],
    ["a start rule that is not a run call", withLanes("const l = wfa.playbook.lane({ config: { $id: 'l1', label: 'L', startRule: 'now' }, activities: () => ({}) })", "{ l: l }"), "'lanes[0].config.startRule' must be wfa.playbook.run.Immediately() or wfa.playbook.run.After(...)"],
    ["Run.Manually()", withLanes("const l = wfa.playbook.lane({ config: { $id: 'l1', label: 'L', startRule: wfa.playbook.run.Manually() }, activities: () => ({}) })", "{ l: l }"), "wfa.playbook.run.Manually() is not supported"],
    ["an empty After()", withLanes("const l = wfa.playbook.lane({ config: { $id: 'l1', label: 'L', startRule: wfa.playbook.run.After() }, activities: () => ({}) })", "{ l: l }"), "After() needs at least one lane or activity"],
    ["an After() of a value", withLanes("const l = wfa.playbook.lane({ config: { $id: 'l1', label: 'L', startRule: wfa.playbook.run.After(1) }, activities: () => ({}) })", "{ l: l }"), "After() takes lanes and activities"],
    [
      "an activity After() of a lane",
      withLanes(
        `const one = wfa.playbook.lane({ config: { $id: 'l1', label: 'One', order: 1 }, activities: () => ({}) })
         const two = wfa.playbook.lane({ config: { $id: 'l2', label: 'Two', order: 2 }, activities: () => {
           const a = wfa.playbook.activity(ActivityDefinitions.Core.Instruction, { $id: 'a1', label: 'A', order: 1, startRule: wfa.playbook.run.After(one) })
           return { a: a } } })`,
        "{ one: one, two: two }",
      ),
      "After() must reference activities of the same lane",
    ],
    ["an invalid restart rule", withLanes("const l = wfa.playbook.lane({ config: { $id: 'l1', label: 'L', restartRule: 'SOMETIMES' }, activities: () => ({}) })", "{ l: l }"), "'lanes[0].config.restartRule' must be 'RUN_ALWAYS', 'RUN_ONLY_ONCE', 'RUN_ONLY_ON_RESTART'"],
    ["an activity that is not an activity call", withActivities("", "{ a: 1 }"), "'lanes[0].activities' entries must be a wfa.playbook.activity() call"],
    ["an activity with five arguments", withActivity("ActivityDefinitions.Core.Instruction, { $id: 'a1', label: 'A', order: 1, startRule: wfa.playbook.run.Immediately() }, {}, {}, {}"), "wfa.playbook.activity() takes a definition, a config, inputs and experience properties"],
    ["an activity without a definition", withActivity(""), "an activity's definition must be an ActivityDefinitions.* entry"],
    ["a definition that is not an ActivityDefinitions entry", withActivity("'x', { $id: 'a1', label: 'A', order: 1, startRule: wfa.playbook.run.Immediately() }"), "an activity's definition must be an ActivityDefinitions.* entry"],
    ["an unknown definition", withActivity("ActivityDefinitions.Core.Approval, { $id: 'a1', label: 'A', order: 1, startRule: wfa.playbook.run.Immediately() }"), "ActivityDefinitions.Core.Approval is not supported"],
    ["a non-object activity config", withActivity("ActivityDefinitions.Core.Instruction, 1"), "'lanes[0].activities[0]' must be an object"],
    ["an unsupported activity option", withActivity("ActivityDefinitions.Core.Instruction, { $id: 'a1', label: 'A', order: 1, startRule: wfa.playbook.run.Immediately(), variant: 'x' }"), "activity 'variant' is not supported"],
    ["an activity without order", withActivity("ActivityDefinitions.Core.Instruction, { $id: 'a1', label: 'A' }"), "'lanes[0].activities[0].order' is required"],
    [
      "a duplicate activity order",
      withActivities(`const a = ${ACTIVITY}\n const b = wfa.playbook.activity(ActivityDefinitions.Core.Instruction, { $id: 'a2', label: 'Again', order: 1, startRule: wfa.playbook.run.Immediately() })`, "{ a: a, b: b }"),
      "Duplicate order 1: 'Again' and 'Do it' share order 1",
    ],
    ["non-object inputs", withActivity("ActivityDefinitions.Core.Instruction, { $id: 'a1', label: 'A', order: 1, startRule: wfa.playbook.run.Immediately() }, 1"), "'lanes[0].activities[0].inputs' must be an object"],
    ["a non-string input", withActivity("ActivityDefinitions.Core.Instruction, { $id: 'a1', label: 'A', order: 1, startRule: wfa.playbook.run.Immediately() }, { message: 1 }"), "'lanes[0].activities[0].inputs.message' must be a string"],
    ["a data pill input", withActivity("ActivityDefinitions.Core.Instruction, { $id: 'a1', label: 'A', order: 1, startRule: wfa.playbook.run.Immediately() }, { message: '{{pd.x}}' }"), "data pills in 'lanes[0].activities[0].inputs.message' are not supported"],
    ["a data pill experience property", withActivity("ActivityDefinitions.Core.Instruction, { $id: 'a1', label: 'A', order: 1, startRule: wfa.playbook.run.Immediately() }, {}, { title: '{{pd.x}}' }"), "data pills in 'lanes[0].activities[0].experienceProperties.title' are not supported"],
    ["a trigger that is not a trigger call", withTrigger("1"), "'triggers[0]' must be a wfa.playbook.trigger() call"],
    ["a trigger with four arguments", withTrigger("wfa.playbook.trigger(PlaybookTriggerTypes.RecordCreate, { $id: 't1' }, { table: 'incident' }, {})"), "wfa.playbook.trigger() takes a trigger type, a config and inputs"],
    ["a trigger type that is not a PlaybookTriggerTypes entry", withTrigger("wfa.playbook.trigger('x', { $id: 't1' }, { table: 'incident' })"), "a trigger's type must be a PlaybookTriggerTypes.* entry"],
    ["a trigger without arguments", withTrigger("wfa.playbook.trigger()"), "a trigger's type must be a PlaybookTriggerTypes.* entry"],
    ["an unknown trigger type", withTrigger("wfa.playbook.trigger(PlaybookTriggerTypes.Daily, { $id: 't1' }, { table: 'incident' })"), "PlaybookTriggerTypes.Daily is not supported"],
    ["a trigger on another table", withTrigger("wfa.playbook.trigger(PlaybookTriggerTypes.RecordCreate, { $id: 't1' }, { table: 'problem' })"), "a trigger on a table other than 'parentTable' needs a mapper"],
    ["a destructured parameter", playbook({ body: "{ lanes: ({ a }) => ({}) }" }), "Destructured parameters are not supported in Fluent functions."],
    ["a parameter reference", playbook({ body: "{ lanes: (x) => x }" }), "Referencing the parameter 'x' is not supported by the native compiler yet."],
    ["a let local", playbook({ body: "{ lanes: () => { let x = 1\n return {} } }" }), "A Fluent function may only declare `const` locals and end with `return <value>`."],
    ["a destructured local", playbook({ body: "{ lanes: () => { const { x } = { x: 1 }\n return {} } }" }), "A Fluent function local must be `const name = <value>`."],
    ["a function without return", playbook({ body: "{ lanes: () => { const x = 1 } }" }), "A Fluent function must end with `return <value>`."],
    ["a call of a non-wfa namespace", withActivity("ActivityDefinitions.Core.Instruction(), { $id: 'a1', label: 'A', order: 1, startRule: wfa.playbook.run.Immediately() }"), "'ActivityDefinitions' is not a function."],
  ])("rejects %s", (_name, source, expected) => {
    expect(errorsOf(source)).toContain(expected);
  });
});

describe("slugify()", () => {
  it.each([
    ["Simple Playbook", "simple_playbook"],
    ["  Crème  brûlée! ", "creme_brulee"],
    ["1st step", "_1st_step"],
    ["--a--b--", "a_b"],
  ])("slugifies %j as %j", (value, expected) => {
    expect(slugify(value)).toBe(expected);
  });
});

describe("deduplicateNames()", () => {
  it("lets explicit names claim theirs first and numbers the rest", () => {
    expect(
      deduplicateNames([
        { name: "a", isExplicit: false },
        { name: "a", isExplicit: true },
        { name: "a", isExplicit: false },
        { name: "a_1", isExplicit: true },
      ]),
    ).toEqual(["a_2", "a", "a_3", "a_1"]);
  });
});
