// SPDX-License-Identifier: GPL-3.0-or-later
//
// ScheduledScript() → sysauto_script.

import type { FluentValue } from "../evaluate";
import { CData, type CompiledRecord } from "../record";
import {
  addDuration,
  DATE_TIME,
  dateTimeToUTC,
  formatDuration,
  formatTime,
  formatTimeOfDay,
  negate,
  type DurationData,
  type TimeData,
} from "../time";
import { lookup, type ArtefactSpec, type BuildContext, type Options } from "./shared";

const DAYS: Record<string, string> = {
  monday: "1",
  tuesday: "2",
  wednesday: "3",
  thursday: "4",
  friday: "5",
  saturday: "6",
  sunday: "7",
};
const OFFSET_TYPES: Record<string, string> = { past: "1", future: "2" };
const FREQUENCIES = [
  "daily",
  "day_and_month_in_year",
  "weekly",
  "monthly",
  "day_week_month_year",
  "periodically",
  "once",
  "on_demand",
  "week_in_month",
  "business_calendar_start",
  "business_calendar_end",
];
/** The days between runs of the fixed-interval frequencies. */
const INTERVAL_DAYS: Record<string, number> = { daily: 1, weekly: 7, day_and_month_in_year: 365, day_week_month_year: 365 };

interface Measure<T> {
  data: T;
  /** Written as `Duration()` / `Time()` rather than as a plain object. */
  helper: boolean;
  timeZone?: string;
  value: FluentValue;
}

/** `Duration({...})` or a plain `{ days, hours, minutes, seconds }` object. */
function duration(o: Options, key: string): Measure<DurationData> | undefined {
  return measure(o, key, "Duration", ["days", "hours", "minutes", "seconds"]);
}

/** `Time({...}, zone?)` or a plain `{ hours, minutes, seconds }` object. */
function time(o: Options, key: string): Measure<TimeData> | undefined {
  return measure(o, key, "Time", ["hours", "minutes", "seconds"]);
}

function measure(o: Options, key: string, helper: "Duration" | "Time", names: readonly string[]): Measure<Record<string, number>> | undefined {
  const value = o.get(key);
  if (value === undefined) return undefined;
  if (value.kind === "helper" && value.name === helper) return { data: value.fields, helper: true, timeZone: value.timeZone, value };
  if (value.kind !== "object") o.error(`ScheduledScript(): '${key}' must be ${helper}() or an object of ${names.join(", ")}.`, value);
  const data: Record<string, number> = {};
  for (const name of names) {
    const field = value.props.get(name);
    if (field === undefined || field.kind === "undefined") continue;
    if (field.kind !== "number") o.error(`fields in ${helper} object can only contain numbers, got ${field.kind}`, field);
    data[name] = field.value;
  }
  return { data, helper: false, value };
}

/** A user or business-calendar reference: a sys_id string, or the record of another API call. */
function reference(o: Options, ctx: BuildContext, key: string): string | CompiledRecord {
  const value = o.get(key);
  if (value === undefined) return "";
  if (value.kind === "string") return value.value;
  if (value.kind === "call") return ctx.recordOf(value);
  return o.error(`ScheduledScript(): '${key}' must be a sys_id or a record.`, value);
}

function oneOf(o: Options, key: string, map: Record<string, string>): string | undefined {
  const value = o.string(key);
  if (value === undefined) return undefined;
  return lookup(map, value) ?? o.error(`ScheduledScript(): '${key}' must be one of ${Object.keys(map).map((k) => `'${k}'`).join(", ")}.`, o.get(key));
}

/** The earliest end that still lets a recurring job run once, as the SDK computes it. */
function minimumEnd(
  start: string,
  frequency: string,
  interval: Measure<DurationData> | undefined,
  maxDrift: Measure<DurationData> | undefined,
): { end: string; description: string } | undefined {
  // The SDK honours only Duration() helpers here; a plain object is not a DurationShape.
  const drift = maxDrift?.helper ? maxDrift.data : undefined;
  let end: string;
  let description: string;
  if (frequency === "periodically" && interval?.helper) {
    end = addDuration(start, interval.data);
    description = "executionInterval";
  } else if (frequency === "monthly" || frequency === "week_in_month") {
    // Month `month` of a 0-based Date is the next month; its overflow rolls on as in the SDK.
    const [date, clock] = start.split(" ");
    const [year, month, day] = date.split("-").map(Number);
    const next = new Date(year, month, day);
    end = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")} ${clock}`;
    description = "1 month";
  } else {
    const days = lookup(INTERVAL_DAYS, frequency);
    if (days === undefined) return undefined;
    end = addDuration(start, { days });
    description = `${days} day${days > 1 ? "s" : ""}`;
  }
  if (drift) end = addDuration(end, negate(drift));
  return { end, description: `${description}${drift ? " - maxDrift" : ""}` };
}

/** The SDK's schedule checks; each failure is an error diagnostic, not a stop. */
function validate(o: Options, ctx: BuildContext, schedule: Schedule): void {
  const error = (message: string, value: FluentValue | undefined) => ctx.report("error", message, (value ?? o.object).loc);
  const { frequency, start, end, timeZone, executionTime } = schedule;
  if (frequency === "periodically" && schedule.interval === undefined) {
    error("executionInterval must be defined when frequency is 'periodically'", o.get("frequency"));
  }
  if (frequency === "weekly" && o.get("daysOfWeek") === undefined && o.get("dayOfWeek") === undefined) {
    error("dayOfWeek or daysOfWeek must be defined when frequency is 'weekly'", o.get("frequency"));
  }
  if ((frequency === "business_calendar_start" || frequency === "business_calendar_end") && schedule.businessCalendar === "") {
    error(
      `businessCalendar cannot be empty when frequency is '${frequency}'. Provide a valid business calendar reference.`,
      o.get("businessCalendar"),
    );
  }
  if (start && !DATE_TIME.test(start)) {
    error(
      `Invalid datetime format for executionStart: '${start}'. Expected format: 'YYYY-MM-DD HH:MM:SS' (e.g., '2024-01-01 00:00:00')`,
      o.get("executionStart"),
    );
  }
  if (end && !DATE_TIME.test(end)) {
    error(
      `Invalid datetime format for executionEnd: '${end}'. Expected format: 'YYYY-MM-DD HH:MM:SS' (e.g., '2024-12-31 23:59:59')`,
      o.get("executionEnd"),
    );
  } else if (end && start && DATE_TIME.test(start)) {
    if (new Date(end) <= new Date(start)) {
      error(`executionEnd ('${end}') must be after executionStart ('${start}')`, o.get("executionEnd"));
    } else {
      const minimum = minimumEnd(start, frequency ?? "daily", schedule.interval, schedule.maxDrift);
      if (minimum && end < minimum.end) {
        error(
          `executionEnd ('${end}') may not allow any executions for recurring job type '${frequency}'. ` +
            `Minimum executionEnd should be at least '${minimum.end}' (executionStart + ${minimum.description})`,
          o.get("executionEnd"),
        );
      }
    }
  }
  if (timeZone && timeZone !== "floating" && executionTime?.helper) {
    if (!executionTime.timeZone) {
      error(
        `executionTime must include timezone when ScheduledScript timeZone is '${timeZone}'. ` +
          `Use Time({ hours: ..., minutes: ..., }, '${timeZone}' }) instead of Time({ hours: ..., minutes: ... }).`,
        executionTime.value,
      );
    } else if (executionTime.timeZone !== timeZone) {
      error(
        `executionTime timezone '${executionTime.timeZone}' does not match ScheduledScript timeZone '${timeZone}'. They should be the same.`,
        executionTime.value,
      );
    }
  }
}

interface Schedule {
  frequency?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  executionTime?: Measure<TimeData>;
  interval?: Measure<DurationData>;
  maxDrift?: Measure<DurationData>;
  businessCalendar: string | CompiledRecord;
}

export const scheduledScript: ArtefactSpec = {
  properties: [
    "name",
    "script",
    "active",
    "conditional",
    "condition",
    "offset",
    "offsetType",
    "runAs",
    "userTimeZone",
    "frequency",
    "dayOfWeek",
    "daysOfWeek",
    "dayOfMonth",
    "weekInMonth",
    "month",
    "executionTime",
    "executionInterval",
    "executionStart",
    "executionEnd",
    "maxDrift",
    "repeatEvery",
    "upgradeSafe",
    "timeZone",
    "businessCalendar",
    "advanced",
  ],
  build(o, ctx) {
    const name = o.string("name");
    const script = o.string("script");
    const condition = o.string("condition");
    const frequency = o.string("frequency");
    if (frequency !== undefined && !FREQUENCIES.includes(frequency)) {
      o.error(`ScheduledScript(): 'frequency' must be one of ${FREQUENCIES.map((f) => `'${f}'`).join(", ")}.`, o.get("frequency"));
    }
    const schedule: Schedule = {
      frequency,
      start: o.string("executionStart"),
      end: o.string("executionEnd"),
      timeZone: o.string("timeZone"),
      executionTime: time(o, "executionTime"),
      interval: duration(o, "executionInterval"),
      maxDrift: duration(o, "maxDrift"),
      businessCalendar: reference(o, ctx, "businessCalendar"),
    };
    validate(o, ctx, schedule);
    // The SDK treats an unset or floating zone as UTC everywhere but `time_zone` itself.
    const zone = !schedule.timeZone || schedule.timeZone === "floating" ? "UTC" : schedule.timeZone;
    const toUTC = (value?: string) => (value && DATE_TIME.test(value) ? dateTimeToUTC(value, zone) : undefined);
    const executionTime = schedule.executionTime;
    const offset = duration(o, "offset");
    const daysOfWeek = o.stringArray("daysOfWeek")?.map((day) => lookup(DAYS, day) ?? o.error(`ScheduledScript(): 'daysOfWeek' must hold day names.`, o.get("daysOfWeek")));
    return ctx.factory.createRecord({
      table: "sysauto_script",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name,
        active: o.boolean("active") ?? true,
        conditional: o.boolean("conditional") ?? false,
        condition: condition === undefined ? undefined : new CData(condition),
        offset: offset && formatDuration(offset.data),
        offset_type: oneOf(o, "offsetType", OFFSET_TYPES) ?? "0",
        run_as: reference(o, ctx, "runAs"),
        run_as_tz: o.string("userTimeZone"),
        run_type: frequency ?? "daily",
        run_dayofweek: oneOf(o, "dayOfWeek", DAYS) ?? "1",
        run_daysofweek: daysOfWeek?.length ? daysOfWeek.join("") : undefined,
        run_dayofmonth: o.number("dayOfMonth") ?? 1,
        run_weekinmonth: o.number("weekInMonth"),
        run_month: o.number("month"),
        run_time: formatTime(executionTime?.data ?? {}, executionTime ? (executionTime.helper ? executionTime.timeZone : zone) : zone),
        entered_time: executionTime && formatTimeOfDay(executionTime.data),
        run_period: schedule.interval && formatDuration(schedule.interval.data),
        run_start: toUTC(schedule.start),
        run_end: toUTC(schedule.end),
        entered_run_start: schedule.start || undefined,
        entered_run_end: schedule.end || undefined,
        max_drift: schedule.maxDrift && formatDuration(schedule.maxDrift.data),
        repeat_every: o.number("repeatEvery"),
        upgrade_safe: o.boolean("upgradeSafe") ?? false,
        time_zone: schedule.timeZone,
        business_calendar: schedule.businessCalendar,
        advanced: o.boolean("advanced") ?? false,
        sys_policy: o.protectionPolicy(),
        script: script === undefined ? undefined : new CData(script),
        sys_name: name,
      },
    });
  },
};
