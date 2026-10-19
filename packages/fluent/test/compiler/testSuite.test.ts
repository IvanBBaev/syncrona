// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const T1 = "1a1b2c3d4e5f40718293a4b5c6d7e8f9";
const T2 = "2a1b2c3d4e5f40718293a4b5c6d7e8f9";
const T3 = "3a1b2c3d4e5f40718293a4b5c6d7e8f9";
const suite = (options: string) => `TestSuite({ $id: Now.ID['s'], name: 'S', ${options} })\n`;

describe("TestSuite()", () => {
  it("compiles a bare suite with every field defaulted and no memberships", () => {
    const result = compile(suite(""));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_atf_test_suite")[0]).toMatchObject({ name: "S", active: "true", description: "", parent: "", input_filter: "" });
    expect(only(result, "sys_atf_test_suite_test")).toEqual([]);
  });

  it("takes a test given as a record and derives orders after a pinned one", () => {
    const result = compile(
      "const t = Record({ $id: Now.ID['t'], table: 'sys_atf_test', data: { name: 'T' } })\n" +
        suite(`tests: [{ test: '${T1}', order: 5 }, t]`),
    );
    expect(messages(result)).toEqual([]);
    expect(messages(result, "hint")).toEqual(["For a better experience, consider using the Test API"]);
    const [test] = only(result, "sys_atf_test");
    expect(only(result, "sys_atf_test_suite_test").map((r) => [r.test, r.order, r.abort_on_failure])).toEqual([
      [T1, "5", "false"],
      [test.sys_id, "6", "false"],
    ]);
  });

  it.each([
    [`tests: ['${T1}', { test: '${T2}', order: 1 }]`, "Multiple tests in this suite resolve to order '1'. ATF doesn't guarantee run order between ties."],
    [
      `tests: [{ test: '${T1}', order: 5 }, { test: '${T2}', order: 3 }]`,
      "This test's pinned order '3' is not after the preceding entry's order '5' — its position in 'tests' and its pinned 'order' disagree about run order.",
    ],
    [
      `testFilter: 'active=true', tests: ['${T1}']`,
      "This suite also lists explicit 'tests'. ATF's filter-driven membership sync is triggered by a business rule on save, not by this install/build — the next time the suite record is saved on the instance, membership rows may be added or removed to match 'testFilter', which may override the explicit list.",
    ],
  ])("hints for %s", (options, message) => {
    const result = compile(suite(options));
    expect(messages(result)).toEqual([]);
    expect(messages(result, "hint")).toEqual([message]);
  });

  it("does not hint for a filter without explicit tests", () => {
    expect(messages(compile(suite("testFilter: 'active=true', tests: []")), "hint")).toEqual([]);
  });

  it.each([
    ["name: ' '", "'name' must not be empty."],
    ["name: 'S', tests: ['nope']", "'nope' is not a valid sys_id."],
    ["name: 'S', parent: 'nope'", "'nope' is not a valid sys_id."],
    [`name: 'S', tests: ['${T1}', { test: '${T1}', abortOnFailure: true }]`, `Test '${T1}' is listed more than once in this suite's 'tests' array.`],
    ["name: 'S', parent: 1", "TestSuite(): 'parent' must be a sys_id or a record."],
    ["name: 'S', tests: [{ order: 1 }]", "TestSuite(): 'tests[].test' must be a sys_id or a record."],
    [`name: 'S', tests: [{ test: '${T1}', extra: 1 }]`, "TestSuite() has no property 'tests[].extra'."],
  ])("rejects %s", (options, message) => {
    expect(messages(compile(`TestSuite({ $id: Now.ID['s'], ${options} })\n`))).toEqual([message]);
  });

  it("hints at a derived order that ties with an earlier pinned one", () => {
    const result = compile(suite(`tests: [{ test: '${T1}', order: 2 }, { test: '${T2}', order: 1 }, '${T3}']`));
    expect(messages(result, "hint")).toEqual([
      "This test's pinned order '1' is not after the preceding entry's order '2' — its position in 'tests' and its pinned 'order' disagree about run order.",
      "Multiple tests in this suite resolve to order '2'. ATF doesn't guarantee run order between ties.",
    ]);
  });

  it("rejects a suite without a name", () => {
    expect(messages(compile("TestSuite({ $id: Now.ID['s'] })\n"))).toEqual(["'name' must not be empty."]);
  });

  it("skips a membership whose test is not a sys_id", () => {
    const result = compile(suite(`tests: ['nope', '${T1}']`));
    expect(only(result, "sys_atf_test_suite_test").map((r) => [r.test, r.order])).toEqual([[T1, "2"]]);
  });

  it("rejects a suite that is its own parent", () => {
    const id = "c1b2c3d4e5f6407182930a4b5c6d7e8f";
    const result = compile(`TestSuite({ $id: '${id}', name: 'S', parent: '${id}' })\n`);
    expect(messages(result)).toEqual(["A test suite cannot be its own parent."]);
  });
});
