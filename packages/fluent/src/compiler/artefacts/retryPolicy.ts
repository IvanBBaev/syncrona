// SPDX-License-Identifier: GPL-3.0-or-later
//
// RetryPolicy() → sys_retry_policy.

import type { ArtefactSpec } from "./shared";

const DEFAULT_RESTRICT_TO = "http_method,status_code,error,response_body,response_headers";
const MAX_ELAPSED_TIME_SECONDS = 86400;
const CONNECTION_TYPES = ["http_retry_conditions", "jdbc_retry_conditions", "basic_retry_conditions"];
const RETRY_STRATEGIES = ["fixed_time_interval", "exponential_backoff", "retry_after"];

export const retryPolicy: ArtefactSpec = {
  properties: ["name", "connectionType", "retryStrategy", "count", "interval", "maxElapsedTime", "condition", "restrictTo"],
  build(o, ctx) {
    const connectionType = o.string("connectionType") ?? "http_retry_conditions";
    if (!CONNECTION_TYPES.includes(connectionType)) {
      o.error(`RetryPolicy(): 'connectionType' must be one of ${CONNECTION_TYPES.join(", ")}.`, o.get("connectionType"));
    }
    const retryStrategy = o.string("retryStrategy") ?? "fixed_time_interval";
    if (!RETRY_STRATEGIES.includes(retryStrategy)) {
      o.error(`RetryPolicy(): 'retryStrategy' must be one of ${RETRY_STRATEGIES.join(", ")}.`, o.get("retryStrategy"));
    }
    const maxElapsedTime = o.number("maxElapsedTime");
    if (maxElapsedTime !== undefined && maxElapsedTime > MAX_ELAPSED_TIME_SECONDS) {
      ctx.report(
        "error",
        `maxElapsedTime must not exceed ${MAX_ELAPSED_TIME_SECONDS} seconds (24 hours). Received: ${maxElapsedTime}.`,
        o.get("maxElapsedTime")!.loc,
      );
    }
    const count = o.number("count");
    if (count !== undefined && !Number.isInteger(count)) {
      ctx.report("error", `count must be an integer. Received: ${count}.`, o.get("count")!.loc);
    }
    const interval = o.number("interval");
    if (interval !== undefined && !Number.isInteger(interval)) {
      ctx.report("error", `interval must be an integer. Received: ${interval}.`, o.get("interval")!.loc);
    }
    const restrictTo = o.stringArray("restrictTo")?.filter(Boolean).join(",") ?? DEFAULT_RESTRICT_TO;
    // The condition may only test the fields the policy is restricted to.
    const allowed = (restrictTo || DEFAULT_RESTRICT_TO).split(",");
    const condition = o.string("condition") ?? "";
    for (const part of condition ? condition.split("^") : []) {
      const field = part.startsWith("OR") ? part.slice(2) : part;
      if (!allowed.some((name) => field.startsWith(name))) {
        ctx.report(
          "error",
          `Condition references field '${/^[a-z_]+/.exec(field)?.[0] ?? field}' which is not in restrictTo. Allowed fields: ${allowed.join(", ")}.`,
          o.get("condition")!.loc,
        );
        break;
      }
    }
    return ctx.factory.createRecord({
      table: "sys_retry_policy",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name: o.string("name") ?? "",
        connection_type: connectionType,
        retry_strategy: retryStrategy,
        count,
        interval,
        max_elapsed_time: maxElapsedTime,
        condition,
        restrict_to: restrictTo,
        sys_policy: o.protectionPolicy() ?? "",
      },
    });
  },
};
