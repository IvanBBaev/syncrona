// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const rp = (options: string) => `RetryPolicy({ $id: Now.ID['rp'], ${options} })\n`;
const alias = (options: string) => `Alias({ $id: Now.ID['a'], name: 'A', ${options} })\n`;
const dl = (options = "", tables = "sourceTable: 'x_snc_bprobe_src', matcherTable: 'x_snc_bprobe_matcher'") =>
  `DataLookup({ $id: Now.ID['dl'], name: 'L', ${tables}, ${options} })\n`;

describe("RetryPolicy()", () => {
  it("accepts a condition whose OR terms test the restricted fields", () => {
    const result = compile(rp("condition: 'status_code=429^ORerror=x', restrictTo: ['status_code', '', 'error']"));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_retry_policy")[0]).toMatchObject({ condition: "status_code=429^ORerror=x", restrict_to: "status_code,error" });
  });

  it("checks the condition against the default fields when restrictTo is empty", () => {
    expect(messages(compile(rp("condition: 'error=x', restrictTo: ['']")))).toEqual([]);
  });

  it.each([
    ["connectionType: 'ftp'", "RetryPolicy(): 'connectionType' must be one of http_retry_conditions, jdbc_retry_conditions, basic_retry_conditions."],
    ["retryStrategy: 'never'", "RetryPolicy(): 'retryStrategy' must be one of fixed_time_interval, exponential_backoff, retry_after."],
    ["maxElapsedTime: 86401", "maxElapsedTime must not exceed 86400 seconds (24 hours). Received: 86401."],
    ["count: 1.5", "count must be an integer. Received: 1.5."],
    ["interval: 0.5", "interval must be an integer. Received: 0.5."],
    [
      "condition: 'status_code=1^ORfoo_bar=2^baz=3', restrictTo: ['status_code']",
      "Condition references field 'foo_bar' which is not in restrictTo. Allowed fields: status_code.",
    ],
    ["condition: '42', restrictTo: ['status_code']", "Condition references field '42' which is not in restrictTo. Allowed fields: status_code."],
  ])("rejects %s", (options, message) => {
    expect(messages(compile(rp(options)))).toEqual([message]);
  });
});

describe("Alias()", () => {
  it("writes the id without a scope prefix in the global scope", () => {
    const result = compile(alias(""), {}, { scope: "global" });
    expect(only(result, "sys_alias")[0]).toMatchObject({ id: "A" });
  });

  it.each([
    ["name: '  '", "'name' is required and cannot be empty."],
    ["name: undefined", "'name' is required and cannot be empty."],
    ["type: 'token'", "Alias(): 'type' must be 'connection' or 'credential'."],
    ["connectionType: 'ftpConnection'", "Alias(): 'connectionType' must be one of httpConnection, jdbcConnection, basicConnection, jmsConnection."],
    ["connectionType: 'toString'", "Alias(): 'connectionType' must be one of httpConnection, jdbcConnection, basicConnection, jmsConnection."],
  ])("rejects %s", (options, message) => {
    const source = options.startsWith("name:") ? `Alias({ $id: Now.ID['a'], ${options} })\n` : alias(options);
    expect(messages(compile(source))).toEqual([message]);
  });

  it("rejects a parent record of another table", () => {
    const source = "const r = Role({ name: 'x_snc_bprobe.user' })\n" + alias("parent: r");
    expect(messages(compile(source))).toEqual(["Alias(): 'parent' must be a sys_id or a sys_alias record."]);
  });
});

describe("DataLookup()", () => {
  it("rejects a name over 40 characters", () => {
    expect(messages(compile(dl().replace("name: 'L'", `name: '${"n".repeat(41)}'`)))).toEqual([
      "Data Lookup Definition name must be 40 characters or fewer (got 41).",
    ]);
  });

  it("requires the tables of a scoped application to be in its scope", () => {
    expect(messages(compile(dl("", "sourceTable: 'incident', matcherTable: 'x_snc_bprobe_matcher'")))).toEqual([
      "sourceTable 'incident' must be in the same scope as the data lookup definition. Expected a table starting with 'x_snc_bprobe_'.",
    ]);
  });

  it("allows any table outside a scoped application", () => {
    const result = compile(dl("", "sourceTable: 'incident', matcherTable: 'problem'"), {}, { scope: "global" });
    expect(messages(result)).toEqual([]);
    expect(only(result, "dl_definition")[0]).toMatchObject({ source_table: "incident", matcher_table: "problem" });
  });
});
