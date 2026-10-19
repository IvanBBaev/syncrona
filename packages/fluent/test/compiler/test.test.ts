// SPDX-License-Identifier: GPL-3.0-or-later

import type { CompileFluentResult } from "../../src/compiler/compile";
import { compile, messages, only } from "./helpers";

const test = (steps: string, options = "") => `Test({ $id: Now.ID['t'], name: 'T'${options} }, (atf) => {\n${steps}\n})\n`;

/** The step files of a result, in order of their step's order. */
function stepFiles(result: CompileFluentResult): string[] {
  return result.files.filter((f) => f.path.includes("sys_atf_step_")).map((f) => f.content);
}

describe("Test()", () => {
  it("compiles a test without a steps function with every field defaulted", () => {
    const result = compile("Test({ $id: Now.ID['t'], name: 'T' })\n");
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_atf_test")[0]).toMatchObject({ name: "T", active: "true", description: "", fail_on_server_error: "false" });
    expect(stepFiles(result)).toEqual([]);
  });

  it("writes a step's default timeout, a plain-object timeout and an empty one for Duration()", () => {
    const result = compile(
      test(
        "atf.server.recordQuery({ $id: Now.ID['a'], table: 'incident' })\n" +
          "atf.server.log({ $id: Now.ID['b'], log: 'x', timeout: { hours: 1, seconds: 2 } })\n" +
          "atf.server.log({ $id: Now.ID['c'], log: 'x', timeout: Duration({ seconds: 2 }) })",
      ),
    );
    expect(messages(result)).toEqual([]);
    expect(messages(result, "hint")).toEqual(["The SDK writes a Duration() step timeout as an empty timeout; give it as a plain object ({ minutes: 1 }) to set it."]);
    expect(stepFiles(result).map((f) => /<timeout>(.*?)<\/timeout>|<timeout\/>/.exec(f)?.[1] ?? "")).toEqual(["1970-01-01 00:00:05", "1970-01-01 01:00:02", ""]);
  });

  it("serializes inputs by their variable type", () => {
    const rel = "const rel = Record({ $id: Now.ID['rel'], table: 'sys_relationship', data: { name: 'R' } })\n";
    const result = compile(
      rel +
        test(
          "atf.server.recordInsert({ $id: Now.ID['a'], table: 'incident', enforceSecurity: false, fieldValues: { a: 'x^y', b: 2, c: true } })\n" +
            "atf.rest.sendRestRequest({ $id: Now.ID['b'], headers: { A: 'b' } })\n" +
            "atf.form.fieldStateValidation({ $id: Now.ID['c'], table: 'incident', visible: ['a', 1, true, rel] })\n" +
            "atf.server.log({ $id: Now.ID['d'], log: '' })\n" +
            "atf.applicationNavigator.navigateToModule({ $id: Now.ID['e'], module: rel })\n" +
            "atf.form.setFieldValue({ $id: Now.ID['f'], table: 'incident' })\n" +
            "atf.email.generateRandomString({ $id: Now.ID['g'], length: 4 })",
        ),
    );
    expect(messages(result)).toEqual([]);
    const [relId] = only(result, "sys_relationship").map((r) => r.sys_id);
    const files = stepFiles(result);
    expect(files[0]).toContain("<value>a=x^^y^b=2^c=true^EQ</value>");
    expect(files[0]).toContain("<value>0</value>");
    expect(files[1]).toContain('<value>{"A":"b"}</value>');
    expect(files[2]).toContain(`<value>a,1,true,REL:${relId}</value>`);
    expect(files[3]).not.toContain("<value>");
    expect(files[4]).toContain(`<value>REL:${relId}</value>`);
    expect(files[5]).toMatch(/<value\/>\s*<variable>/);
    expect(files[6]).toContain("<value>4</value>");
  });

  it("maps inputs that refer to earlier steps' outputs", () => {
    const result = compile(
      test(
        "const ins = atf.server.recordInsert({ $id: Now.ID['a'], table: 'incident' })\n" +
          "atf.server.recordUpdate({ $id: Now.ID['b'], table: 'incident', recordId: ins.record_id, fieldValues: { a: `x ${ins.record_id} y`, b: 1 } })",
      ),
    );
    expect(messages(result)).toEqual([]);
    const [first, second] = stepFiles(result);
    const insId = /<sys_id>(.*?)<\/sys_id>/.exec(first)?.[1];
    expect(first).not.toContain("sys_element_mapping");
    expect(second).toContain(`<value>{{step['${insId}'].record_id}}</value>`);
    expect(second).toContain(`<value>a=x {{step['${insId}'].record_id}} y^b=1^EQ</value>`);
    expect(second.match(/<sys_element_mapping action="INSERT_OR_UPDATE"/g)).toHaveLength(2);
    expect(second).not.toContain("sys_policy");
  });

  it("drops invalid steps with the SDK's diagnostics and orders the rest", () => {
    const result = compile(test("atf.log({ $id: Now.ID['a'] })\natf.nope.log({ $id: Now.ID['b'] })\natf.server.nope({ $id: Now.ID['c'] })\natf.server.log({ $id: Now.ID['d'], log: 'x' })"));
    expect(messages(result)).toEqual([]);
    expect(messages(result, "hint")).toEqual(["Invalid ATF step"]);
    expect(messages(result, "warning")).toEqual(["Unknown category: nope", "Unknown step: nope"]);
    expect(stepFiles(result).map((f) => /<order>(.*?)<\/order>/.exec(f)?.[1])).toEqual(["1"]);
  });

  it("uses module bindings inside a step", () => {
    const result = compile("const msg = 'hello'\n" + test("atf.server.log({ $id: Now.ID['a'], log: msg })"));
    expect(messages(result)).toEqual([]);
    expect(stepFiles(result)[0]).toContain("<value>hello</value>");
  });

  it.each([
    ["Test({ $id: Now.ID['t'], name: 'T' }, (atf) => {}, 1)\n", "Test() takes one options object and its steps function."],
    ["Test({ $id: Now.ID['t'], name: 'T' }, 1)\n", "Test(): the second argument must be the steps function, (atf) => { ... }."],
    ["Test({ $id: Now.ID['t'], name: 'T' }, (atf) => atf.server.log({}))\n", "A steps function must have a block body: (atf) => { ... }."],
    [test("atf.server.log({ log: Test({ $id: Now.ID['u'], name: 'U' }, function (a) {}) })"), "A steps function cannot be nested in a step."],
    [test("let a = 1"), "A step's result must be stored as `const name = atf.<category>.<step>({...})`, one per statement."],
    [test("let a"), "A step's result must be stored as `const name = atf.<category>.<step>({...})`, one per statement."],
    [test("const { a } = atf.server.log({})"), "A step's result must be stored as `const name = atf.<category>.<step>({...})`, one per statement."],
    [test("const a = atf.server.log({}), b = atf.server.log({})"), "A step's result must be stored as `const name = atf.<category>.<step>({...})`, one per statement."],
    [test("if (atf) {}"), "Unsupported statement in a steps function: IfStatement; only atf.<category>.<step>() calls are supported."],
    [test("1"), "Unsupported statement in a steps function: ExpressionStatement; only atf.<category>.<step>() calls are supported."],
    [test("atf['server'].log({})"), "A step must be called as atf.<category>.<step>({...})."],
    [test("const a = atf.server.log({ $id: Now.ID['a'] })\natf.server.log({ $id: Now.ID['b'], log: a })"), "'a' is a step; reference one of its outputs instead (a.<output>)."],
    [test("atf.server.log({ $id: Now.ID['a'], log: `x${'y'}` })"), "Invalid expression, expecting a reference to an ATF step"],
    [test("atf.server.log({ $id: Now.ID['a'], log: (atf).x })"), "Invalid expression, expecting a reference to an ATF step"],
    [test("const a = atf.server.nope({ $id: Now.ID['a'] })\natf.server.log({ $id: Now.ID['b'], log: a.x })"), "Invalid expression, expecting a reference to an ATF step"],
    [test("atf.server.log()"), "Test(): step 'server.log' takes one options object."],
    [test("atf.server.log({ $id: Now.ID['a'], extra: 1 })"), "Test() has no property 'server.log.extra'."],
    [test("atf.server.log({ $id: Now.ID['a'], timeout: { minutes: '1' } })"), "fields in Duration object can only contain numbers, got string"],
    [test("atf.server.recordInsert({ $id: Now.ID['a'], fieldValues: 'a=b' })"), "Test(): 'server.recordInsert.fieldValues' must be an object."],
    [test("atf.server.log({ $id: Now.ID['a'], log: {} })"), "Test(): 'server.log.log' must not be an object."],
    [test("atf.server.log({ $id: Now.ID['a'], log: ['x'] })"), "Test(): 'server.log.log' must not be an array."],
    [test("atf.form.fieldStateValidation({ $id: Now.ID['a'], visible: [Duration({ seconds: 1 })] })"), "Test(): 'form.fieldStateValidation.visible' must hold strings, numbers, booleans or records."],
    [test("atf.server.recordInsert({ $id: Now.ID['a'], fieldValues: { a: [1] } })"), "Test(): 'server.recordInsert.fieldValues.a' must be a string, number, boolean or step output."],
    [test("atf.server.log({ $id: Now.ID['a'], log: Duration({ seconds: 1 }) })"), "Test(): 'server.log.log' must be a string, number, boolean, record or step output."],
  ])("rejects %s", (source, message) => {
    expect(messages(compile(source))).toEqual([message]);
  });
});
