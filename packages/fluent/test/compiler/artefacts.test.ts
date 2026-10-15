// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const GUID = "0123456789abcdef0123456789abcdef";

describe("artefact builders", () => {
  describe("shared options", () => {
    it.each([
      ["Role({ name: 'x_snc_bprobe.r', $override: {} })", "Role(): '$override' is not supported by the native compiler yet."],
      ["Role({ name: 'x_snc_bprobe.r', colour: 'red' })", "Role() has no property 'colour'."],
      ["Role()", "Role() takes one options object."],
      ["Role('x', {})", "Role() takes one options object."],
      ["Role({ name: 'x_snc_bprobe.r', $id: true })", "Role(): '$id' must be Now.ID[...], a string or a number."],
      ["Role({ name: 'x_snc_bprobe.r', $meta: 1 })", "Role(): '$meta' must be an object."],
      ["Role({ name: 'x_snc_bprobe.r', $meta: { useEsLatest: true } })", "Role(): '$meta.useEsLatest' is not supported by the native compiler yet."],
      ["Role({ name: 'x_snc_bprobe.r', $meta: { other: 1 } })", "Role(): '$meta' has no property 'other'."],
      ["Role({ name: 'x_snc_bprobe.r', $meta: { installMethod: 'always' } })", "Role(): '$meta.installMethod' must be 'demo', 'first install' or 'once'."],
      ["Role({ name: 'x_snc_bprobe.r', $meta: { installMethod: 1 } })", "Role(): '$meta.installMethod' must be 'demo', 'first install' or 'once'."],
      ["Role({ name: 'x_snc_bprobe.r', protectionPolicy: 'none' })", "Role(): 'protectionPolicy' must be 'read' or 'protected'."],
      ["Role({ name: 1 })", "Role(): 'name' must be a string."],
      ["Role({})", "Role(): 'name' is required."],
      ["Role({ name: 'x_snc_bprobe.r', grantable: 'yes' })", "Role(): 'grantable' must be a boolean."],
      ["Role({ name: 'x_snc_bprobe.r', containsRoles: 'admin' })", "Role(): 'containsRoles' must be an array."],
      ["Property({ $id: 'p', name: 'x_snc_bprobe.p', value: null })", "Property(): 'value' must be a string, number or boolean."],
      ["Property({ $id: 'p', name: 'x_snc_bprobe.p', choices: [1] })", "Property(): 'choices' must be an array of strings."],
      ["Property({ name: 'x_snc_bprobe.p' })", "Cannot determine the sys_id of this sys_properties record: give it a $id."],
      ["Foo({})", "Foo() is not supported by the native compiler yet (supported: Property, Role, ScriptInclude)."],
    ])("rejects %s", (call, message) => {
      const result = compile(`import { Foo } from '@servicenow/sdk/core'\n${call}\n`);
      expect(messages(result)).toEqual([message]);
      expect(result.ok).toBe(false);
    });

    it("maps install methods to install categories", () => {
      const result = compile(`
Role({ name: 'x_snc_bprobe.a', $meta: { installMethod: 'demo' } })
Role({ name: 'x_snc_bprobe.b', $meta: { installMethod: 'first install' } })
Role({ name: 'x_snc_bprobe.c', $meta: { installMethod: 'once' } })
Role({ name: 'x_snc_bprobe.d', $meta: {} })
`);
      expect(messages(result)).toEqual([]);
      expect(result.records.map((r) => r.installCategory).sort()).toEqual(["apply_once", "unload", "unload.demo", "update"]);
    });

    it("applies the protection policy to the record and its children", () => {
      const result = compile(`
const base = Role({ name: 'x_snc_bprobe.base' })
Role({ name: 'x_snc_bprobe.top', protectionPolicy: 'read', containsRoles: [base] })
`);
      expect(only(result, "sys_user_role").map((r) => [r.name, r.sys_policy])).toEqual(
        expect.arrayContaining([["x_snc_bprobe.base", undefined], ["x_snc_bprobe.top", "read"]]),
      );
      expect(only(result, "sys_user_role_contains")[0].sys_policy).toBe("read");
    });
  });

  describe("Role", () => {
    it("hints at deprecated aliases and keeps their values", () => {
      const result = compile("Role({ name: 'x_snc_bprobe.r', can_delegate: false, federatedId: 'fed' })");
      expect(messages(result, "hint")).toEqual(["The property 'can_delegate' is deprecated, use 'canDelegate' instead."]);
      expect(only(result, "sys_user_role")[0]).toMatchObject({ can_delegate: "false", federated_id: "fed" });
    });

    it("requires the scope prefix in an x_ scope", () => {
      const result = compile("Role({ name: 'other.r' })");
      expect(messages(result)).toEqual(["Role name must begin with 'x_snc_bprobe.'"]);
    });

    it("references contained roles by sys_id, name or record", () => {
      const result = compile(`
const base = Role({ name: 'x_snc_bprobe.base' })
Role({ $id: Now.ID['top'], name: 'x_snc_bprobe.top', containsRoles: ['${GUID}', 'itil', base] })
`);
      expect(messages(result, "hint")).toEqual([expect.stringContaining(`sys_id '${GUID}'`)]);
      const contains = only(result, "sys_user_role_contains");
      expect(contains.map((c) => c.contains).sort()).toContain(GUID);
      expect(contains.map((c) => c.sys_name).sort()).toEqual([undefined, "itil.x_snc_bprobe.top", "x_snc_bprobe.base.x_snc_bprobe.top"].sort());
      expect(contains.find((c) => c.sys_name === "itil.x_snc_bprobe.top")).toMatchObject({ "contains@name": "itil" });
    });

    it.each([
      ["[ScriptInclude({ $id: 'si', name: 'Si', script: 's' })]", "Role(): 'containsRoles' must hold roles."],
      ["[1]", "Role(): 'containsRoles' must hold role names, sys_ids or Role() records."],
    ])("rejects containsRoles %s", (roles, message) => {
      expect(messages(compile(`Role({ name: 'x_snc_bprobe.r', containsRoles: ${roles} })`))).toEqual([message]);
    });

    it("rejects a role that contains itself", () => {
      const result = compile("const a = Role({ name: 'x_snc_bprobe.a', containsRoles: [a] })");
      expect(messages(result)).toEqual(["'a' refers to itself."]);
    });

    it("reuses a failed dependency's error instead of rebuilding it", () => {
      const result = compile(`
const bad = Role({ name: 1 })
Role({ name: 'x_snc_bprobe.a', containsRoles: [bad] })
Role({ name: 'x_snc_bprobe.b', containsRoles: [bad] })
`);
      expect(messages(result)).toEqual(["Role(): 'name' must be a string."]);
      expect(only(result, "sys_user_role")).toEqual([]);
    });
  });

  describe("Property", () => {
    it("warns about a name outside the scope", () => {
      const result = compile("Property({ $id: 'p', name: 'other.p', value: true })");
      expect(messages(result, "warning")).toEqual([expect.stringContaining("Property names should begin with 'x_snc_bprobe.'")]);
      expect(only(result, "sys_properties")[0]).toMatchObject({ suffix: "other.p", value: "true", read_roles: "", write_roles: "" });
    });

    it("joins roles given as names or Role() records", () => {
      const result = compile(`
const reader = Role({ name: 'x_snc_bprobe.reader' })
Property({ $id: 'p', name: 'x_snc_bprobe.p', roles: { read: [reader, 'admin', reader], write: undefined } })
`);
      expect(only(result, "sys_properties")[0]).toMatchObject({ read_roles: "x_snc_bprobe.reader,admin", write_roles: undefined });
    });

    it.each([
      ["[]", "Property(): 'roles' must be an object."],
      ["{ admin: [] }", "Property(): 'roles' has no property 'admin'."],
      ["{ read: 'admin' }", "Property(): 'roles.read' must be an array."],
      ["{ write: [1] }", "Property(): 'roles.write' must hold role names or Role() records."],
    ])("rejects roles %s", (roles, message) => {
      expect(messages(compile(`Property({ $id: 'p', name: 'x_snc_bprobe.p', roles: ${roles} })`))).toEqual([message]);
    });
  });

  describe("ScriptInclude", () => {
    it("warns about a name that is not an identifier and hints at an ineffective callerAccess", () => {
      const result = compile("ScriptInclude({ $id: 'si', name: 'my-si', script: 's', callerAccess: 'tracking' })");
      expect(messages(result, "warning")).toEqual([expect.stringContaining("'my-si' is not a valid JavaScript identifier")]);
      expect(messages(result, "hint")).toEqual([expect.stringContaining("'callerAccess' is only effective")]);
      expect(only(result, "sys_script_include")[0]).toMatchObject({ caller_access: "1", api_name: "x_snc_bprobe.my-si" });
    });

    it("maps callerAccess on a public script include", () => {
      const result = compile(`
ScriptInclude({ $id: 'a', name: 'A', script: 's', accessibleFrom: 'public', callerAccess: 'restriction' })
ScriptInclude({ $id: 'b', name: 'B', script: 's', accessibleFrom: 'public', callerAccess: 'other' })
`);
      expect(messages(result, "hint")).toEqual([]);
      expect(only(result, "sys_script_include").map((r) => [r.name, r.caller_access, r.access])).toEqual(
        expect.arrayContaining([["A", "2", "public"], ["B", "", "public"]]),
      );
    });

    it("requires the scope prefix on apiName", () => {
      const result = compile("ScriptInclude({ $id: 'si', name: 'Si', script: 's', apiName: 'other.Si' })");
      expect(messages(result)).toEqual(["apiName must begin with 'x_snc_bprobe.'"]);
    });

    it("accepts any apiName in a ServiceNow scope", () => {
      const result = compile("ScriptInclude({ $id: 'si', name: 'Si', script: 's', apiName: 'other.Si' })", {}, { scope: "sn_app" });
      expect(messages(result)).toEqual([]);
      expect(only(result, "sys_script_include")[0].api_name).toBe("other.Si");
    });
  });
});
