// SPDX-License-Identifier: GPL-3.0-or-later

import { parseDuration } from "../../src/compiler/time";
import { compile, messages, only } from "./helpers";

const GUID = "6816f79cc0a8016401c5a33be04be441";
const metric = (options = "", id = "m") => `{ $id: Now.ID['${id}'], name: 'M', question: 'Q?', ${options} }`;
const category = (metrics = metric(), options = "") => `{ $id: Now.ID['c'], name: 'C', metrics: [${metrics}], ${options} }`;
const assessment = (options: string) => `Assessment({ $id: Now.ID['a'], name: 'A', table: 'incident', scaleFactor: 1, ${options} })\n`;
const risk = (options: string) => `RiskAssessment({ $id: Now.ID['r'], name: 'R', ${options} })\n`;

describe("parseDuration()", () => {
  it("reads a glide_duration date-time as days, hours, minutes and seconds", () => {
    expect(parseDuration("1970-01-03 04:05:06")).toBe("1970-01-03 04:05:06");
    expect(parseDuration("1970-01-01 00:00:00")).toBe("1970-01-01 00:00:00");
  });

  it("rejects anything else", () => {
    expect(parseDuration("3 days")).toBeUndefined();
  });
});

describe("Assessment()", () => {
  it("writes the defaults of a bare assessment", () => {
    const result = compile(assessment(""));
    expect(messages(result)).toEqual([]);
    expect(only(result, "asmt_metric_type")[0]).toMatchObject({
      condition: "",
      duration: "1970-01-15 00:00:00",
      job: "",
      schedule_type: "on_demand",
      scoring_type: "percent",
      survey_owners: "",
      user_field_business_rule: "",
    });
    expect(only(result, "sys_script").map((r) => r.collection)).toEqual(["incident", "incident"]);
    expect(only(result, "sys_trigger")).toEqual([]);
  });

  it("reads durations, mapped values and records", () => {
    const result = compile(
      "const owner = Record({ $id: Now.ID['u'], table: 'sys_user', data: { name: 'Owner' } })\n" +
        "const rule = Role({ $id: Now.ID['role'], name: 'x_snc_bprobe.rule' })\n" +
        assessment(
          "assessmentDuration: '1970-01-02 03:00:00', scheduleType: 'onDemand', scoringType: '', condition: '', owners: [owner, 'x', 7], roles: 'admin' as any, signature: owner, sampleMetric: 'abc', returnUrl: rule as any",
        ),
    );
    expect(messages(result)).toEqual([]);
    const type = only(result, "asmt_metric_type")[0];
    expect(type).toMatchObject({ duration: "1970-01-02 03:00:00", schedule_type: "on_demand", scoring_type: "percent", condition: "", roles: "", sample_metric: "abc" });
    expect(type.survey_owners).toMatch(/^[0-9a-f]{32},x,7$/);
    expect(type.signature).toMatch(/^[0-9a-f]{32}$/);
    expect(type.url).toMatch(/^[0-9a-f]{32}$/);
  });

  it.each([
    ["assessmentDuration: { days: undefined, hours: 2 }", "1970-01-01 02:00:00"],
    ["assessmentDuration: Duration({ minutes: 3 })", "1970-01-01 00:03:00"],
  ])("formats %s", (option, duration) => {
    expect(only(compile(assessment(option)), "asmt_metric_type")[0]).toMatchObject({ duration });
  });

  it("escapes the condition in the trigger rule's script", () => {
    const result = compile(assessment("condition: \"a='b\\\\\\\\c'^EQ\""));
    expect(only(result, "asmt_metric_type")[0]).toMatchObject({ condition: "a='b\\\\c'^EQ" });
    expect(only(result, "sys_script")[0].script).toContain("conditionCheck(current, 'a=\\'b\\\\\\\\c\\'^EQ')");
  });

  it("names the generated rules after an empty name when the assessment has none", () => {
    const result = compile("Assessment({ $id: Now.ID['a'], table: 'incident', scaleFactor: 1 } as any)\n");
    expect(only(result, "sys_script").map((r) => r.name)).toEqual([" Assessment Trigger", " Assessment Delete"]);
  });

  it("omits the rules' collection without a table", () => {
    const result = compile("Assessment({ $id: Now.ID['a'], name: 'A', scaleFactor: 1 } as any)\n");
    expect(messages(result)).toEqual(["'table' is required when 'evaluationMethod' is 'assessment' (the default)."]);
    expect(only(result, "sys_script")[0].collection).toBeUndefined();
  });

  it("generates the schedule job and user-field rule of a scheduled, published assessment", () => {
    const result = compile(assessment(`scheduleType: 'scheduled', userField: "o'wner", state: 'published', categories: [${category()}]`));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_trigger")).toHaveLength(1);
    const rule = only(result, "sys_script")[2];
    expect(rule).toMatchObject({ name: "A Assessment User Field Update", order: "300", action_update: "true" });
    expect(rule.condition).toBe("(new global.AssessmentUtils().conditionCheck(current, 'o\\'wnerVALCHANGES^EQ'))");
  });

  it("skips the user-field rule of an unpublished assessment", () => {
    const result = compile(assessment("scheduleType: 'scheduled', userField: 'u'"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_script")).toHaveLength(2);
  });

  it("defaults an empty category scoring type", () => {
    const result = compile(assessment(`categories: [${category(metric(), "scoringType: '' as any")}]`));
    expect(only(result, "asmt_metric_category")[0]).toMatchObject({ scoring_type: "percent" });
  });

  it("references an existing schedule job and user-field rule instead of generating them", () => {
    const result = compile(
      assessment(`scheduleType: 'scheduled', scheduleJob: '${GUID}', userField: 'u', userFieldBusinessRule: '${GUID}', state: 'published', categories: [${category()}]`),
    );
    expect(messages(result)).toEqual([]);
    expect(only(result, "asmt_metric_type")[0]).toMatchObject({ job: GUID, user_field_business_rule: GUID });
    expect(only(result, "sys_trigger")).toEqual([]);
    expect(only(result, "sys_script")).toHaveLength(2);
  });

  it("generates the schedule job when 'scheduleJob' is empty", () => {
    const result = compile(assessment("scheduleType: 'scheduled', scheduleJob: ''"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_trigger")).toHaveLength(1);
  });

  it("reports a 'scheduleJob' that is not a GUID and generates the job", () => {
    const result = compile(assessment("scheduleType: 'scheduled', scheduleJob: 'nope'"));
    expect(messages(result)).toEqual(["'scheduleJob' must be a valid GUID or a Record<'sys_trigger'>. Received: 'nope'"]);
    expect(only(result, "sys_trigger")).toHaveLength(1);
  });

  it("scopes a survey to its own type record and tables its categories by the type", () => {
    const result = compile(`Assessment({ $id: Now.ID['s'], name: 'S', evaluationMethod: 'survey', categories: [${category()}] })\n`);
    expect(messages(result)).toEqual([]);
    const type = only(result, "asmt_metric_type")[0];
    expect(type.table).toBe("asmt_metric_type");
    expect(type.condition).toBe(`sys_id=${type.sys_id}^EQ`);
    expect(only(result, "asmt_metric_category")[0]).toMatchObject({ table: "asmt_metric_type", filter: "" });
    expect(only(result, "sys_script")).toEqual([]);
  });

  it("writes category and metric options", () => {
    const result = compile(
      assessment(
        `categories: [${category(metric("dataType: 'numericScale', min: 2, max: 3, definitions: { '1': 'One', '2': 2 as any, '3': { order: 9 } }"), "filter: 'a=b', details: 'D'")}]`,
      ),
    );
    expect(messages(result)).toEqual([]);
    expect(only(result, "asmt_metric_category")[0]).toMatchObject({ filter: "a=b^EQ", details: "D", total_metrics: "1" });
    expect(only(result, "asmt_metric_definition").map((d) => [d.value, d.display, d.order])).toEqual([
      ["1", "One", "100"],
      ["2", "2", "200"],
      ["3", "", "9"],
    ]);
  });

  it("generates the definitions of a numeric scale from its default range", () => {
    const result = compile(assessment(`categories: [${category(metric("dataType: 'numericScale'"))}]`));
    expect(only(result, "asmt_metric_definition").map((d) => d.value)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  });

  it("reports a definition key that is not an integer and still writes it", () => {
    const result = compile(assessment(`categories: [${category(metric("definitions: { x: 'X' }"))}]`));
    expect(messages(result)).toEqual([
      "Definition key 'x' is not a valid integer. The platform stores definition values in a numeric column, so keys must be integers.",
    ]);
    expect(only(result, "asmt_metric_definition")).toHaveLength(1);
  });

  it.each([
    ["dependsOn: Now.ID['other']", /^[0-9a-f]{32}$/],
    ["dependsOn: 'other'", /^[0-9a-f]{32}$/],
    ["dependsOn: ''", /^$/],
    [`dependsOn: Now.ref('asmt_metric', '${GUID}')`, new RegExp(`^${GUID}$`)],
  ])("reads %s", (option, dependsOn) => {
    const result = compile(assessment(`categories: [${category(`${metric("", "other")}, ${metric(option)}`)}]`));
    expect(messages(result)).toEqual([]);
    expect(only(result, "asmt_metric")[1].depends_on).toMatch(dependsOn);
  });

  it("reads a metric record as 'dependsOn'", () => {
    const result = compile(
      "const other = Assessment({ $id: Now.ID['b'], name: 'B', table: 'task', scaleFactor: 1 })\n" + assessment(`categories: [${category(metric("dependsOn: other as any"))}]`),
    );
    expect(messages(result)).toEqual([]);
    expect(only(result, "asmt_metric")[0].depends_on).toBe(only(result, "asmt_metric_type")[0].sys_id);
  });

  it.each([
    ["table: '', scaleFactor: 1", "'table' is required when 'evaluationMethod' is 'assessment' (the default)."],
    ["table: 't', scaleFactor: '1' as any", "'scaleFactor' is required when 'evaluationMethod' is 'assessment' (the default)."],
    ["table: 't'", "'scaleFactor' is required when 'evaluationMethod' is 'assessment' (the default)."],
    ["table: 't', scaleFactor: 1.5", "'scaleFactor' must be an integer."],
    ["table: 't', scaleFactor: 1, state: 'published'", "An assessment must have at least one category before it can be published."],
    [
      `table: 't', scaleFactor: 1, state: 'published', categories: [{ $id: Now.ID['c1'], name: 'C1', metrics: [] }, { $id: Now.ID['c2'], name: 'C2' } as any]`,
      "Each category must have at least one metric before the assessment can be published.",
    ],
    [`table: 't', scaleFactor: 1, categories: [${category(metric("method: 'defaultAnswerFromScript'"))}]`, "A metric with method 'condscript' must also set 'dependentPlugin'."],
  ])("reports %s", (options, error) => {
    const result = compile(`Assessment({ $id: Now.ID['a'], name: 'A', ${options} })\n`);
    expect(messages(result)[0]).toBe(error);
    expect(result.ok).toBe(false);
  });

  it("reports both missing pieces of a condscript metric", () => {
    const result = compile(assessment(`categories: [${category(metric("method: 'defaultAnswerFromScript', dependentPlugin: '', script: ''"))}]`));
    expect(messages(result)).toEqual([
      "A metric with method 'condscript' must also set 'dependentPlugin'.",
      "A metric with method 'condscript' must also set 'script'.",
    ]);
  });

  it("reports both categories without metrics of a published assessment", () => {
    const result = compile(
      assessment("state: 'published', categories: [{ $id: Now.ID['c1'], name: 'C1', metrics: [] }, { $id: Now.ID['c2'], name: 'C2' } as any]"),
    );
    expect(messages(result)).toHaveLength(2);
  });

  it("hints at a script its method ignores", () => {
    const result = compile(assessment(`categories: [${category(`${metric("script: 'x', method: 'defaultAnswerFromField'")}, ${metric("script: 'y'", "n")}`)}]`));
    expect(messages(result)).toEqual([]);
    expect(messages(result, "hint")).toEqual(["'script' is only evaluated when 'method' is 'script' or 'condscript'; it will be ignored otherwise."]);
  });

  it.each([
    ["name: [1] as any", "Assessment(): 'name' must be a string, number, boolean or record."],
    ["roles: [{} as any]", "Assessment(): 'roles' must hold strings or records."],
    ["signature: 1 as any", "Assessment(): 'signature' must be a sys_id or a record."],
    ["assessmentDuration: 'soon'", "Invalid duration value: soon"],
    ["assessmentDuration: ''", "Invalid duration value: "],
    ["assessmentDuration: 1 as any", "Assessment(): 'assessmentDuration' must be Duration(), an object or a string."],
    ["assessmentDuration: Time({ hours: 1 }) as any", "Assessment(): 'assessmentDuration' must be Duration(), an object or a string."],
    ["assessmentDuration: { days: '1' as any }", "fields in Duration object can only contain numbers, got string"],
    [`categories: [${category(metric("dependsOn: 1 as any"))}]`, "Assessment(): 'categories[0].metrics[0].dependsOn' must be Now.ID[...], a sys_id or a metric record."],
    [
      `categories: [${category(metric("dependsOn: Now.ref('asmt_metric', { name: 'x' })"))}]`,
      "Assessment(): 'categories[0].metrics[0].dependsOn' must be Now.ID[...], a sys_id or a metric record.",
    ],
    [`categories: [${category(metric("definitions: [] as any"))}]`, "Assessment(): 'categories[0].metrics[0].definitions' must be an object."],
    [`categories: [${category(metric("definitions: { '1': [] as any }"))}]`, "Assessment(): 'categories[0].metrics[0].definitions.1' must be a label or an object."],
  ])("rejects %s", (option, error) => {
    expect(messages(compile(assessment(option)))).toEqual([error]);
  });
});

describe("RiskAssessment()", () => {
  it("writes thresholds, rule references and change_request categories", () => {
    const result = compile(
      "const rule = BusinessRule({ $id: Now.ID['br'], name: 'BR', table: 'change_request', when: 'after', script: '' })\n" +
        risk(
          `businessRule: rule as any, deleteBusinessRule: '${GUID}', thresholds: [{ $id: Now.ID['t1'], risk: 'moderate' }, { $id: Now.ID['t2'], risk: 'custom' as any, scoreGreaterThan: 5 }, { $id: Now.ID['t3'] } as any], categories: [${category()}]`,
        ),
    );
    expect(messages(result)).toEqual([]);
    const type = only(result, "change_risk_asmt")[0];
    expect(type).toMatchObject({ table: "change_request", evaluation_method: "risk_assessment", delete_business_rule: GUID, duration: "1970-01-15 00:00:00" });
    expect(type.business_rule).toBe(only(result, "sys_script")[0].sys_id);
    expect(only(result, "change_risk_asmt_threshold").map((t) => [t.risk, t.score_greater_than])).toEqual([
      ["3", "0"],
      ["custom", "5"],
      ["", "0"],
    ]);
    expect(only(result, "asmt_metric_category")[0]).toMatchObject({ table: "change_request" });
  });

  it("checks only the publish state", () => {
    expect(messages(compile(risk("state: 'published'")))).toEqual(["An assessment must have at least one category before it can be published."]);
  });
});
