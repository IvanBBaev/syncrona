// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const SCHEDULE = "08fcd0830a0a0b2600079f56b1adb9ae";
const RELATIVE = "4b9a6d3a0a0a0b2600e8b3c4d5e6f705";
const sla = (options: string) => `Sla({ $id: Now.ID['sla'], ${options} })\n`;
const persisted = (field: string, reason: string) =>
  `Field '${field}' is restricted ${reason}. If this value came from an existing SLA definition, it will be preserved but cannot be modified. If you're creating a new SLA, remove this field.`;

describe("Sla()", () => {
  it("writes the SDK's defaults", () => {
    const result = compile(sla(`schedule: '${SCHEDULE}', duration: Duration({ minutes: 90 })`));
    expect(messages(result)).toEqual([]);
    expect(messages(result, "hint")).toEqual([]);
    expect(only(result, "contract_sla")).toEqual([
      expect.objectContaining({
        name: "",
        collection: "incident",
        duration: "1970-01-01 01:30:00",
        duration_type: "",
        flow: "828f267973333300e289235f04f6a7a3",
        retroactive: "false",
        retroactive_pause: "true",
        schedule: SCHEDULE,
        timezone_source: "task.caller_id.time_zone",
      }),
    ]);
  });

  it("takes references as records", () => {
    const result = compile(
      "const f = Record({ $id: Now.ID['f'], table: 'sys_hub_flow', data: { name: 'f' } })\n" +
        sla(`schedule: '${SCHEDULE}', duration: Duration({ hours: 1 }), flow: f, durationType: ''`),
    );
    expect(messages(result)).toEqual([]);
    expect(only(result, "contract_sla")[0]!.flow).toBe(only(result, "sys_hub_flow")[0]!.sys_id);
  });

  it("reports the fields a setting requires", () => {
    expect(messages(compile(sla("name: 'x'")))).toEqual([
      "Field 'duration' is required when durationType is empty (user specified duration)",
      "Field 'schedule' is required when scheduleSource is \"sla_definition\"",
    ]);
    expect(messages(compile(sla("scheduleSource: 'task_field', duration: Duration({ hours: 1 })")))).toEqual([
      "Field 'scheduleSourceField' is required when scheduleSource is \"task_field\"",
    ]);
    expect(
      messages(compile(sla(`schedule: '${SCHEDULE}', duration: Duration({ hours: 1 }), retroactive: { start: true }`))),
    ).toEqual(["Field 'retroactive.setStartTo' is required when retroactive.start is true"]);
    expect(messages(compile(sla(`schedule: '${SCHEDULE}', duration: { hours: 1 }`)))).toEqual([
      "SLA 'duration' field must use the Duration() helper function",
    ]);
    // Another schedule source than the SDK's three needs neither a schedule nor a field.
    expect(messages(compile(sla("scheduleSource: 'other', duration: Duration({ hours: 1 })")))).toEqual([]);
  });

  it("hints at fields a relative duration ignores", () => {
    const result = compile(
      sla(
        `durationType: '${RELATIVE}', schedule: '${SCHEDULE}', duration: Duration({ hours: 1 }), conditions: { pause: 'a', resume: 'b' }, whenTo: { resume: 'on_condition' }, retroactive: { start: true, pause: false, setStartTo: 'opened_at' }`,
      ),
    );
    expect(messages(result)).toEqual([]);
    const reason = "when durationType is a relative duration";
    expect(messages(result, "hint")).toEqual([
      persisted("duration", reason),
      persisted("conditions.pause", reason),
      persisted("conditions.resume", reason),
      persisted("whenTo.resume", reason),
      persisted("retroactive.pause", "when retroactive.start is true and durationType is a relative duration"),
    ]);
    expect(only(result, "contract_sla")[0]).toEqual(expect.objectContaining({ duration: "1970-01-01 01:00:00", retroactive_pause: "false" }));
  });

  it("hints at fields the schedule source ignores", () => {
    const none = compile(
      sla(
        `durationType: '${RELATIVE}', scheduleSource: 'no_schedule', schedule: '${SCHEDULE}', timezoneSource: 'sla.timezone', timezone: 'Europe/Sofia', scheduleSourceField: 'x'`,
      ),
    );
    const reason = 'when scheduleSource is "no_schedule"';
    expect(messages(none, "hint")).toEqual([
      `Field 'schedule' cannot be specified ${reason}. The default value '38fa64edc0a8016400f4a5724b0434b8' will be used automatically.`,
      persisted("timezoneSource", reason),
      persisted("timezone", reason),
      persisted("scheduleSourceField", reason),
    ]);
    expect(only(none, "contract_sla")[0]).toEqual(expect.objectContaining({ schedule: "38fa64edc0a8016400f4a5724b0434b8", retroactive_pause: "" }));
    expect(messages(compile(sla(`durationType: '${RELATIVE}', scheduleSource: 'no_schedule', timezoneSource: 'task.caller_id.time_zone'`)), "hint")).toEqual([]);

    const task = compile(sla(`scheduleSource: 'task_field', scheduleSourceField: 'x', schedule: '${SCHEDULE}', duration: Duration({ hours: 1 })`));
    expect(messages(task)).toEqual([]);
    expect(messages(task, "hint")).toEqual([
      persisted("schedule", 'when scheduleSource is "task_field"'),
      persisted("duration", 'when scheduleSource is "task_field"'),
    ]);
    const relative = compile(sla(`durationType: '${RELATIVE}', scheduleSource: 'task_field', scheduleSourceField: 'x'`));
    expect(messages(relative)).toEqual([]);
    expect(messages(relative, "hint")).toEqual([]);
  });

  it("hints at time-zone, condition and retroactive fields their setting ignores", () => {
    const result = compile(
      sla(
        `schedule: '${SCHEDULE}', duration: Duration({ hours: 1 }), timezone: 'Europe/Sofia', conditions: { resume: 'a', cancel: 'b' }, whenTo: { resume: 'no_match', cancel: 'never' }, retroactive: { start: false, pause: true, setStartTo: 'opened_at' }`,
      ),
    );
    expect(messages(result)).toEqual([]);
    expect(messages(result, "hint")).toEqual([
      persisted("timezone", 'unless timezoneSource is "sla.timezone"'),
      persisted("conditions.resume", 'when whenToResume is "no_match"'),
      persisted("conditions.cancel", 'unless whenToCancel is "on_condition"'),
      persisted("retroactive.setStartTo", "unless retroactive.start is true"),
      persisted("retroactive.pause", "unless retroactive.start is true"),
    ]);
  });

  it.each([
    [sla("flow: 1"), "Sla(): 'flow' must be a sys_id or a record."],
    [sla("conditions: { begin: 'x' }"), "Sla() has no property 'conditions.begin'."],
    [sla("retroactive: { start: 'yes' }"), "Sla(): 'retroactive.start' must be a boolean."],
    [sla("severity: 1"), "Sla() has no property 'severity'."],
  ])("rejects %s", (source, message) => {
    const result = compile(source);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain(message);
  });
});
