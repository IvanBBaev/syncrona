// SPDX-License-Identifier: GPL-3.0-or-later
//
// The SDK's conversions of durations, times of day and date-times to the
// platform's `YYYY-MM-DD HH:MM:SS` format, reproduced step by step — host-local
// `Date` arithmetic included — so a native build writes the values the SDK
// build writes on the same machine.

export interface DurationData {
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
}

export type TimeData = Omit<DurationData, "days">;

/** The pattern of a platform date-time (`2024-01-01 00:00:00`). */
export const DATE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const pad = (n: number) => String(n).padStart(2, "0");

/** A `Date` as a platform date-time, read in UTC. */
export function formatUTC(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/** A duration as the epoch-relative date-time a glide_duration field stores. */
export function formatDuration(d: DurationData): string {
  const ms = ((((d.days ?? 0) * 24 + (d.hours ?? 0)) * 60 + (d.minutes ?? 0)) * 60 + (d.seconds ?? 0)) * 1000;
  return formatUTC(new Date(Date.UTC(1970, 0, 1) + ms));
}

/** A time of day in `timeZone` (the host zone when absent) as the UTC date-time a glide_time field stores. */
export function formatTime(time: TimeData, timeZone?: string): string {
  const hours = time.hours ?? 0;
  const minutes = time.minutes ?? 0;
  const seconds = time.seconds ?? 0;
  if (!timeZone) return formatUTC(new Date(1970, 0, 1, hours, minutes, seconds));
  const [tzHour, tzMin] = new Date(Date.UTC(1970, 0, 1, 12, 0, 0))
    .toLocaleString("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false })
    .split(":")
    .map(Number);
  const total = hours * 60 + minutes - ((tzHour - 12) * 60 + tzMin);
  return formatUTC(new Date(Date.UTC(1970, 0, 1, Math.floor(total / 60), total % 60, seconds)));
}

/** A time of day as entered, on the epoch date. */
export function formatTimeOfDay(time: TimeData): string {
  return `1970-01-01 ${pad(time.hours || 0)}:${pad(time.minutes || 0)}:${pad(time.seconds || 0)}`;
}

/** A platform date-time in `timeZone` as the UTC date-time the platform stores. */
export function dateTimeToUTC(dateTime: string, timeZone: string): string {
  if (timeZone === "GMT" || timeZone === "UTC") return dateTime;
  const [year, month, day, hours, minutes, seconds] = dateTime.split(/[- :]/).map(Number);
  const utc = new Date(`${dateTime.replace(" ", "T")}Z`);
  const parts: Record<string, number> = {};
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  for (const part of formatter.formatToParts(utc)) parts[part.type] = Number(part.value);
  const wanted = new Date(year, month - 1, day, hours, minutes, seconds).getTime();
  const got = new Date(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second).getTime();
  return formatUTC(new Date(utc.getTime() - (got - wanted)));
}

/** A platform date-time plus a duration, in host-local calendar arithmetic. */
export function addDuration(dateTime: string, d: DurationData): string {
  const [year, month, day, hours, minutes, seconds] = dateTime.split(/[- :]/).map(Number);
  const date = new Date(year, month - 1, day, hours, minutes, seconds);
  if (d.days) date.setDate(date.getDate() + d.days);
  if (d.hours) date.setHours(date.getHours() + d.hours);
  if (d.minutes) date.setMinutes(date.getMinutes() + d.minutes);
  if (d.seconds) date.setSeconds(date.getSeconds() + d.seconds);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** The duration with every field negated. */
export function negate(d: DurationData): DurationData {
  return { days: -(d.days ?? 0), hours: -(d.hours ?? 0), minutes: -(d.minutes ?? 0), seconds: -(d.seconds ?? 0) };
}

/**
 * A glide_duration string (`1970-01-03 04:00:00`) read back into a duration and
 * re-formatted, as the SDK does: the host-local date-time less the host-local
 * epoch, split into days, hours, minutes and seconds. `undefined` when it is not
 * a platform date-time.
 */
export function parseDuration(value: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [year, month, day, hours, minutes, seconds] = match.slice(1).map(Number);
  let rest = new Date(year, month - 1, day, hours, minutes, seconds).getTime() - new Date(1970, 0, 1).getTime();
  const d: DurationData = {};
  for (const [unit, ms] of [
    ["days", 86_400_000],
    ["hours", 3_600_000],
    ["minutes", 60_000],
    ["seconds", 1000],
  ] as const) {
    const n = Math.floor(rest / ms);
    if (n > 0) {
      d[unit] = n;
      rest -= n * ms;
    }
  }
  return formatDuration(d);
}
