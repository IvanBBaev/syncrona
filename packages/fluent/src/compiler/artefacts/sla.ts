// SPDX-License-Identifier: GPL-3.0-or-later
//
// Sla() → contract_sla, with the SDK's checks of which fields each duration,
// schedule, time-zone, condition and retroactive setting requires or ignores.

import type { SourceLocation } from "../diagnostics";
import type { FluentValue } from "../evaluate";
import type { CompiledRecord } from "../record";
import { formatDuration } from "../time";
import type { ArtefactSpec, BuildContext, Options } from "./shared";

const DEFAULT_FLOW = "828f267973333300e289235f04f6a7a3";
const NO_SCHEDULE = "38fa64edc0a8016400f4a5724b0434b8";
const DEFAULT_TIMEZONE_SOURCE = "task.caller_id.time_zone";
const CONDITIONS = ["start", "stop", "pause", "resume", "reset", "cancel"];

const required = (field: string, reason: string) => `Field '${field}' is required ${reason}`;
const persisted = (field: string, reason: string) =>
  `Field '${field}' is restricted ${reason}. If this value came from an existing SLA definition, it will be preserved but cannot be modified. If you're creating a new SLA, remove this field.`;

/** A reference: a sys_id string, or the record of another API call. */
function reference(o: Options, ctx: BuildContext, key: string): string | CompiledRecord {
  const value = o.get(key);
  if (value === undefined) return "";
  if (value.kind === "string") return value.value;
  if (value.kind === "call") return ctx.recordOf(value);
  return o.error(`Sla(): '${o.path}${key}' must be a sys_id or a record.`, value);
}

export const sla: ArtefactSpec = {
  properties: [
    "name",
    "table",
    "type",
    "active",
    "overrides",
    "workflow",
    "flow",
    "vendor",
    "timezone",
    "target",
    "domainPath",
    "duration",
    "durationType",
    "relativeDurationWorksOn",
    "schedule",
    "scheduleSource",
    "scheduleSourceField",
    "advancedConditionType",
    "conditionType",
    "conditions",
    "resetAction",
    "whenTo",
    "retroactive",
    "timezoneSource",
    "enableLogging",
  ],
  build(o, ctx) {
    const hint = (field: string, reason: string, value: FluentValue) => ctx.report("hint", persisted(field, reason), value.loc);
    const fail = (message: string, loc: SourceLocation) => ctx.report("error", message, loc);

    const durationType = reference(o, ctx, "durationType");
    const userDuration = durationType === "";
    const schedule = reference(o, ctx, "schedule");
    const scheduleSource = o.string("scheduleSource") || "sla_definition";
    const scheduleSourceField = o.string("scheduleSourceField");
    const timezone = o.string("timezone");
    const timezoneSource = o.string("timezoneSource");
    const conditions = o.nested("conditions", CONDITIONS);
    const condition = (key: string) => conditions?.string(key);
    const whenTo = o.nested("whenTo", ["resume", "cancel"]);
    const whenToResume = whenTo?.string("resume");
    const whenToCancel = whenTo?.string("cancel");
    const retroactive = o.nested("retroactive", ["start", "pause", "setStartTo"]);
    const retroactiveStart = retroactive?.boolean("start") ?? false;
    const retroactivePause = retroactive?.boolean("pause");
    const setStartTo = retroactive?.string("setStartTo");

    const durationValue = o.get("duration");
    let duration = "";
    if (durationValue !== undefined) {
      if (durationValue.kind !== "helper" || durationValue.name !== "Duration") {
        return o.error("SLA 'duration' field must use the Duration() helper function", durationValue);
      }
      duration = formatDuration(durationValue.fields);
    }

    if (userDuration) {
      if (durationValue === undefined) fail(required("duration", "when durationType is empty (user specified duration)"), o.object.loc);
    } else {
      const reason = "when durationType is a relative duration";
      if (durationValue) hint("duration", reason, durationValue);
      if (condition("pause") !== undefined) hint("conditions.pause", reason, conditions!.get("pause")!);
      if (condition("resume") !== undefined) hint("conditions.resume", reason, conditions!.get("resume")!);
      if (whenToResume !== undefined) hint("whenTo.resume", reason, whenTo!.get("resume")!);
    }

    if (scheduleSource === "no_schedule") {
      const reason = 'when scheduleSource is "no_schedule"';
      if (schedule !== "") {
        ctx.report(
          "hint",
          `Field 'schedule' cannot be specified ${reason}. The default value '${NO_SCHEDULE}' will be used automatically.`,
          o.get("schedule")!.loc,
        );
      }
      if (timezoneSource && timezoneSource !== DEFAULT_TIMEZONE_SOURCE) hint("timezoneSource", reason, o.get("timezoneSource")!);
      if (timezone) hint("timezone", reason, o.get("timezone")!);
      if (scheduleSourceField) hint("scheduleSourceField", reason, o.get("scheduleSourceField")!);
    } else if (scheduleSource === "task_field") {
      const reason = 'when scheduleSource is "task_field"';
      if (schedule !== "") hint("schedule", reason, o.get("schedule")!);
      if (durationValue) hint("duration", reason, durationValue);
      if (scheduleSourceField === undefined) fail(required("scheduleSourceField", reason), o.object.loc);
    } else if (scheduleSource === "sla_definition" && schedule === "") {
      fail(required("schedule", 'when scheduleSource is "sla_definition"'), o.object.loc);
    }

    if ((timezoneSource || DEFAULT_TIMEZONE_SOURCE) !== "sla.timezone" && timezone) {
      hint("timezone", 'unless timezoneSource is "sla.timezone"', o.get("timezone")!);
    }
    if ((whenToResume || "on_condition") === "no_match" && condition("resume")) {
      hint("conditions.resume", 'when whenToResume is "no_match"', conditions!.get("resume")!);
    }
    if ((whenToCancel || "on_condition") !== "on_condition" && condition("cancel")) {
      hint("conditions.cancel", 'unless whenToCancel is "on_condition"', conditions!.get("cancel")!);
    }

    if (retroactive && retroactiveStart) {
      if (!setStartTo) fail(required("retroactive.setStartTo", "when retroactive.start is true"), retroactive.object.loc);
      if (!userDuration && retroactivePause !== undefined) {
        hint("retroactive.pause", "when retroactive.start is true and durationType is a relative duration", retroactive.get("pause")!);
      }
    } else if (retroactive) {
      if (setStartTo) hint("retroactive.setStartTo", "unless retroactive.start is true", retroactive.get("setStartTo")!);
      if (retroactivePause !== undefined) hint("retroactive.pause", "unless retroactive.start is true", retroactive.get("pause")!);
    }

    return ctx.factory.createRecord({
      table: "contract_sla",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name: o.string("name") ?? "",
        collection: o.string("table") ?? "incident",
        type: o.string("type") ?? "SLA",
        active: o.boolean("active") ?? true,
        adv_condition_type: o.string("advancedConditionType") ?? "none",
        duration,
        duration_type: durationType,
        schedule: scheduleSource === "no_schedule" ? NO_SCHEDULE : schedule,
        schedule_source: o.string("scheduleSource") ?? "sla_definition",
        schedule_source_field: scheduleSourceField ?? "",
        relative_duration_works_on: o.string("relativeDurationWorksOn") ?? "Task record",
        start_condition: condition("start") ?? "",
        reset_condition: condition("reset") ?? "",
        stop_condition: condition("stop") ?? "",
        cancel_condition: condition("cancel") ?? "",
        pause_condition: condition("pause") ?? "",
        resume_condition: condition("resume") ?? "",
        condition_class: reference(o, ctx, "conditionType"),
        reset_action: o.string("resetAction") ?? "cancel",
        when_to_resume: whenToResume ?? "on_condition",
        when_to_cancel: whenToCancel ?? "on_condition",
        retroactive: retroactiveStart,
        retroactive_pause: retroactivePause ?? (userDuration ? true : ""),
        set_start_to: setStartTo ?? "",
        sys_overrides: reference(o, ctx, "overrides"),
        workflow: reference(o, ctx, "workflow"),
        flow: o.get("flow") === undefined ? DEFAULT_FLOW : reference(o, ctx, "flow"),
        vendor: reference(o, ctx, "vendor"),
        timezone: timezone ?? "",
        timezone_source: timezoneSource ?? DEFAULT_TIMEZONE_SOURCE,
        enable_logging: o.boolean("enableLogging") ?? false,
        target: o.string("target") ?? "",
        sys_domain_path: o.string("domainPath") ?? "/",
      },
    });
  },
};
