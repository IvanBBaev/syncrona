// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";
import {
  addDuration,
  dateTimeToUTC,
  formatDuration,
  formatTime,
  formatTimeOfDay,
  formatUTC,
  negate,
} from "../../src/compiler/time";

/** `ScheduledScript({ $id, name: 'J', ...options })`. */
const job = (options = "") => `ScheduledScript({ $id: Now.ID['j'], name: 'J', ${options} })\n`;

const local = (h: number, m: number, s: number) => formatUTC(new Date(1970, 0, 1, h, m, s));

describe("time conversions", () => {
  it("formats durations from the epoch", () => {
    expect(formatDuration({})).toBe("1970-01-01 00:00:00");
    expect(formatDuration({ days: 2, hours: 3, minutes: 4, seconds: 5 })).toBe("1970-01-03 03:04:05");
  });

  it("formats a time of day in a zone, or in the host zone without one", () => {
    expect(formatTime({ hours: 9, minutes: 15 }, "Europe/Sofia")).toBe("1970-01-01 07:15:00");
    // The SDK floors the hours but truncates the minutes, so a half-hour zone lands an hour early.
    expect(formatTime({ hours: 2 }, "Asia/Kolkata")).toBe("1969-12-31 19:30:00");
    expect(formatTime({}, "UTC")).toBe("1970-01-01 00:00:00");
    expect(formatTime({ hours: 1, minutes: 2, seconds: 3 })).toBe(local(1, 2, 3));
    expect(formatTime({})).toBe(local(0, 0, 0));
  });

  it("formats a time of day as entered", () => {
    expect(formatTimeOfDay({ hours: 9 })).toBe("1970-01-01 09:00:00");
    expect(formatTimeOfDay({ minutes: 5, seconds: 7 })).toBe("1970-01-01 00:05:07");
  });

  it("converts a zoned date-time to UTC", () => {
    expect(dateTimeToUTC("2024-01-01 10:00:00", "UTC")).toBe("2024-01-01 10:00:00");
    expect(dateTimeToUTC("2024-01-01 10:00:00", "GMT")).toBe("2024-01-01 10:00:00");
    expect(dateTimeToUTC("2024-01-01 00:00:00", "America/New_York")).toBe("2024-01-01 05:00:00");
    expect(dateTimeToUTC("2024-07-01 00:30:00", "Europe/Sofia")).toBe("2024-06-30 21:30:00");
  });

  it("adds and negates durations", () => {
    expect(addDuration("2024-01-10 00:00:00", {})).toBe("2024-01-10 00:00:00");
    expect(addDuration("2024-01-10 00:00:00", { days: 1, hours: 2, minutes: 3, seconds: 4 })).toBe("2024-01-11 02:03:04");
    expect(addDuration("2024-01-10 00:00:00", negate({ hours: 1 }))).toBe("2024-01-09 23:00:00");
    expect(negate({ days: 1, hours: 2, minutes: 3, seconds: 4 })).toEqual({ days: -1, hours: -2, minutes: -3, seconds: -4 });
    expect(negate({})).toEqual({ days: -0, hours: -0, minutes: -0, seconds: -0 });
  });
});

describe("Duration() and Time()", () => {
  it.each([
    [job("executionTime: Time()"), "Time() takes an object of hours, minutes and seconds, and an optional time zone."],
    [job("executionTime: Time({ hours: 1 }, 'UTC', 1)"), "Time() takes an object of hours, minutes and seconds, and an optional time zone."],
    [job("maxDrift: Duration(1)"), "Duration() takes an object of days, hours, minutes and seconds."],
    [job("maxDrift: Duration({ hours: 1 }, 'UTC')"), "Duration() takes an object of days, hours, minutes and seconds."],
    [job("maxDrift: Duration({ hours: undefined })"), "Duration must have at least one field defined (days, hours, minutes, or seconds)"],
    [job("executionTime: Time({ days: 1 })"), "Time must have at least one field defined (hours, minutes, or seconds)"],
    [job("maxDrift: Duration({ hours: -1, minutes: 2, seconds: -3 })"), "Invalid duration values: hours must be >= 0, got -1, seconds must be >= 0, got -3"],
    [job("executionTime: Time({ hours: -2 })"), "Invalid time values: hours must be >= 0, got -2"],
    [job("maxDrift: Duration({ hours: '1' })"), "fields in Duration object can only contain numbers, got string"],
    [job("executionTime: Time({ hours: 1 }, 1)"), "Second argument (timezone) must be a string literal"],
    [job("executionTime: Time({ hours: 1 }, 'Mars/Base')"), "Invalid IANA timezone: 'Mars/Base'. Use a valid timezone like 'America/New_York', 'Europe/London', or 'UTC'."],
    ["const Time = 1\nTime({ hours: 1 })\n", "Only calls of @servicenow/sdk/core APIs, Now.include(), Now.ref(), Now.attach() and Now.del() are supported in Fluent sources."],
  ])("rejects %j", (source, message) => {
    expect(messages(compile(source))).toEqual([message]);
  });

  it("treats an imported SDK API of the same name as an API call", () => {
    const result = compile("import { Duration } from '@servicenow/sdk/core'\nDuration({ hours: 1 })\n");
    expect(messages(result)).toEqual([expect.stringMatching(/^Duration\(\) is not supported by the native compiler yet/)]);
  });

  it("accepts an undefined time zone", () => {
    const result = compile(job("executionTime: Time({ hours: 1 }, undefined)"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sysauto_script")[0]).toMatchObject({ run_time: local(1, 0, 0), entered_time: "1970-01-01 01:00:00" });
  });
});

describe("ScheduledScript()", () => {
  it("writes the defaults", () => {
    const result = compile(job());
    expect(messages(result)).toEqual([]);
    expect(only(result, "sysauto_script")[0]).toMatchObject({
      name: "J",
      active: "true",
      conditional: "false",
      offset_type: "0",
      run_as: "",
      run_type: "daily",
      run_dayofweek: "1",
      run_dayofmonth: "1",
      run_time: "1970-01-01 00:00:00",
      business_calendar: "",
      advanced: "false",
      upgrade_safe: "false",
      sys_name: "J",
    });
  });

  it("writes references, day lists and plain-object durations", () => {
    const result = compile(
      `const r = Role({ name: 'x_snc_bprobe.r' })\n` +
        job(
          "runAs: r, frequency: 'weekly', daysOfWeek: ['tuesday', 'saturday'], executionInterval: { days: 1, hours: undefined }, " +
            "maxDrift: Duration({ seconds: 5 }), offset: { minutes: 1 }, executionStart: '', businessCalendar: 'c'",
        ),
    );
    expect(messages(result)).toEqual([]);
    const [role] = only(result, "sys_user_role");
    expect(only(result, "sysauto_script")[0]).toMatchObject({
      run_as: role.sys_id,
      run_daysofweek: "26",
      run_period: "1970-01-02 00:00:00",
      max_drift: "1970-01-01 00:00:05",
      offset: "1970-01-01 00:01:00",
      run_start: undefined,
      entered_run_start: undefined,
      business_calendar: "c",
    });
  });

  it("leaves an empty day list unset", () => {
    expect(only(compile(job("daysOfWeek: []")), "sysauto_script")[0].run_daysofweek).toBeUndefined();
  });

  it.each([
    [job("frequency: 'hourly'"), "ScheduledScript(): 'frequency' must be one of 'daily', 'day_and_month_in_year', 'weekly', 'monthly', 'day_week_month_year', 'periodically', 'once', 'on_demand', 'week_in_month', 'business_calendar_start', 'business_calendar_end'."],
    [job("offsetType: 'later'"), "ScheduledScript(): 'offsetType' must be one of 'past', 'future'."],
    [job("dayOfWeek: 'funday'"), "ScheduledScript(): 'dayOfWeek' must be one of 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'."],
    [job("daysOfWeek: ['funday']"), "ScheduledScript(): 'daysOfWeek' must hold day names."],
    [job("runAs: 1"), "ScheduledScript(): 'runAs' must be a sys_id or a record."],
    [job("executionTime: 'noon'"), "ScheduledScript(): 'executionTime' must be Time() or an object of hours, minutes, seconds."],
    [job("executionTime: Duration({ hours: 1 })"), "ScheduledScript(): 'executionTime' must be Time() or an object of hours, minutes, seconds."],
    [job("maxDrift: { hours: 'x' }"), "fields in Duration object can only contain numbers, got string"],
  ])("rejects %j", (source, message) => {
    expect(messages(compile(source))).toEqual([message]);
  });

  it.each([
    ["frequency: 'periodically'", "executionInterval must be defined when frequency is 'periodically'"],
    ["frequency: 'weekly'", "dayOfWeek or daysOfWeek must be defined when frequency is 'weekly'"],
    ["frequency: 'business_calendar_end'", "businessCalendar cannot be empty when frequency is 'business_calendar_end'. Provide a valid business calendar reference."],
    [
      "executionStart: '2024-01-01', executionEnd: '2024-02-01 00:00:00'",
      "Invalid datetime format for executionStart: '2024-01-01'. Expected format: 'YYYY-MM-DD HH:MM:SS' (e.g., '2024-01-01 00:00:00')",
    ],
    [
      "executionStart: '2024-01-01 00:00:00', executionEnd: 'later'",
      "Invalid datetime format for executionEnd: 'later'. Expected format: 'YYYY-MM-DD HH:MM:SS' (e.g., '2024-12-31 23:59:59')",
    ],
    [
      "executionStart: '2024-01-02 00:00:00', executionEnd: '2024-01-02 00:00:00'",
      "executionEnd ('2024-01-02 00:00:00') must be after executionStart ('2024-01-02 00:00:00')",
    ],
    [
      "executionStart: '2024-01-10 00:00:00', executionEnd: '2024-01-10 12:00:00'",
      "executionEnd ('2024-01-10 12:00:00') may not allow any executions for recurring job type 'undefined'. Minimum executionEnd should be at least '2024-01-11 00:00:00' (executionStart + 1 day)",
    ],
    [
      "frequency: 'weekly', dayOfWeek: 'monday', maxDrift: { hours: 1 }, executionStart: '2024-01-10 00:00:00', executionEnd: '2024-01-12 00:00:00'",
      "executionEnd ('2024-01-12 00:00:00') may not allow any executions for recurring job type 'weekly'. Minimum executionEnd should be at least '2024-01-17 00:00:00' (executionStart + 7 days)",
    ],
    [
      "frequency: 'monthly', executionStart: '2024-01-31 10:00:00', executionEnd: '2024-02-15 00:00:00'",
      "executionEnd ('2024-02-15 00:00:00') may not allow any executions for recurring job type 'monthly'. Minimum executionEnd should be at least '2024-03-02 10:00:00' (executionStart + 1 month)",
    ],
    [
      "frequency: 'week_in_month', executionStart: '2024-11-05 10:00:00', executionEnd: '2024-11-06 00:00:00'",
      "executionEnd ('2024-11-06 00:00:00') may not allow any executions for recurring job type 'week_in_month'. Minimum executionEnd should be at least '2024-12-05 10:00:00' (executionStart + 1 month)",
    ],
    [
      "frequency: 'periodically', executionInterval: Duration({ hours: 4 }), maxDrift: Duration({ hours: 1 }), executionStart: '2024-01-10 00:00:00', executionEnd: '2024-01-10 02:00:00'",
      "executionEnd ('2024-01-10 02:00:00') may not allow any executions for recurring job type 'periodically'. Minimum executionEnd should be at least '2024-01-10 03:00:00' (executionStart + executionInterval - maxDrift)",
    ],
    [
      "timeZone: 'Europe/Sofia', executionTime: Time({ hours: 1 })",
      "executionTime must include timezone when ScheduledScript timeZone is 'Europe/Sofia'. Use Time({ hours: ..., minutes: ..., }, 'Europe/Sofia' }) instead of Time({ hours: ..., minutes: ... }).",
    ],
    [
      "timeZone: 'Europe/Sofia', executionTime: Time({ hours: 1 }, 'UTC')",
      "executionTime timezone 'UTC' does not match ScheduledScript timeZone 'Europe/Sofia'. They should be the same.",
    ],
  ])("reports %s", (options, message) => {
    const result = compile(job(options));
    expect(result.ok).toBe(false);
    expect(messages(result)).toEqual([message]);
  });

  it.each([
    "frequency: 'periodically', executionInterval: { hours: 4 }, executionStart: '2024-01-10 00:00:00', executionEnd: '2024-01-10 01:00:00'",
    "frequency: 'once', executionStart: '2024-01-10 00:00:00', executionEnd: '2024-01-10 01:00:00'",
    "frequency: 'daily', executionStart: '2024-01-10 00:00:00', executionEnd: '2024-01-11 00:00:00'",
    "executionEnd: '2024-01-11 00:00:00'",
    "timeZone: 'floating', executionTime: Time({ hours: 1 })",
    "timeZone: 'Europe/Sofia', executionTime: { hours: 1 }",
  ])("accepts %s", (options) => {
    expect(messages(compile(job(options)))).toEqual([]);
  });

  it("converts the run window and time from the job's zone", () => {
    const result = compile(job("timeZone: 'America/New_York', executionTime: { hours: 1 }, executionStart: '2024-01-01 00:00:00', executionEnd: 'x'"));
    expect(only(result, "sysauto_script")[0]).toMatchObject({
      run_time: "1970-01-01 06:00:00",
      run_start: "2024-01-01 05:00:00",
      run_end: undefined,
      entered_run_end: "x",
      time_zone: "America/New_York",
    });
  });
});

describe("ScriptAction()", () => {
  it("writes the defaults", () => {
    const result = compile("ScriptAction({ $id: Now.ID['a'], name: 'A', eventName: 'e', script: 's' })\n");
    expect(messages(result)).toEqual([]);
    expect(only(result, "sysevent_script_action")[0]).toMatchObject({
      name: "A",
      description: "",
      event_name: "e",
      active: "false",
      condition_script: undefined,
      script: "s",
      order: "100",
      sys_name: "A",
    });
  });

  it("requires a script", () => {
    expect(messages(compile("ScriptAction({ $id: Now.ID['a'], name: 'A', eventName: 'e' })\n"))).toEqual(["ScriptAction(): 'script' is required."]);
  });
});
