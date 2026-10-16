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
      ["Foo({})", "Foo() is not supported by the native compiler yet (supported: Acl, BusinessRule, ClientScript, Property, Role, ScriptInclude, UiAction)."],
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
        expect.arrayContaining([
          ["x_snc_bprobe.base", undefined],
          ["x_snc_bprobe.top", "read"],
        ]),
      );
      expect(only(result, "sys_user_role_contains")[0].sys_policy).toBe("read");
    });
  });

  describe("Role", () => {
    it("hints at deprecated aliases and keeps their values", () => {
      const result = compile("Role({ name: 'x_snc_bprobe.r', can_delegate: false, federatedId: 'fed' })");
      expect(messages(result, "hint")).toEqual(["The property 'can_delegate' is deprecated, use 'canDelegate' instead."]);
      expect(only(result, "sys_user_role")[0]).toMatchObject({
        can_delegate: "false",
        federated_id: "fed",
      });
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
      expect(only(result, "sys_properties")[0]).toMatchObject({
        suffix: "other.p",
        value: "true",
        read_roles: "",
        write_roles: "",
      });
    });

    it("joins roles given as names or Role() records", () => {
      const result = compile(`
const reader = Role({ name: 'x_snc_bprobe.reader' })
Property({ $id: 'p', name: 'x_snc_bprobe.p', roles: { read: [reader, 'admin', reader], write: undefined } })
`);
      expect(only(result, "sys_properties")[0]).toMatchObject({
        read_roles: "x_snc_bprobe.reader,admin",
        write_roles: undefined,
      });
    });

    it.each([
      ["[]", "Property(): 'roles' must be an object."],
      ["{ admin: [] }", "Property(): 'roles' has no property 'admin'."],
      ["{ read: 'admin' }", "Property(): 'roles.read' must be an array."],
      ["{ write: [1] }", "Property(): 'roles.write' must hold role names or Role() records."],
      ["{ read: [ScriptInclude({ $id: 'si', name: 'Si', script: 's' })] }", "Property(): 'roles.read' must hold roles."],
    ])("rejects roles %s", (roles, message) => {
      expect(messages(compile(`Property({ $id: 'p', name: 'x_snc_bprobe.p', roles: ${roles} })`))).toEqual([message]);
    });
  });

  describe("ScriptInclude", () => {
    it("warns about a name that is not an identifier and hints at an ineffective callerAccess", () => {
      const result = compile("ScriptInclude({ $id: 'si', name: 'my-si', script: 's', callerAccess: 'tracking' })");
      expect(messages(result, "warning")).toEqual([expect.stringContaining("'my-si' is not a valid JavaScript identifier")]);
      expect(messages(result, "hint")).toEqual([expect.stringContaining("'callerAccess' is only effective")]);
      expect(only(result, "sys_script_include")[0]).toMatchObject({
        caller_access: "1",
        api_name: "x_snc_bprobe.my-si",
      });
    });

    it("maps callerAccess on a public script include", () => {
      const result = compile(`
ScriptInclude({ $id: 'a', name: 'A', script: 's', accessibleFrom: 'public', callerAccess: 'restriction' })
ScriptInclude({ $id: 'b', name: 'B', script: 's', accessibleFrom: 'public', callerAccess: 'other' })
`);
      expect(messages(result, "hint")).toEqual([]);
      expect(only(result, "sys_script_include").map((r) => [r.name, r.caller_access, r.access])).toEqual(
        expect.arrayContaining([
          ["A", "2", "public"],
          ["B", "", "public"],
        ]),
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

  describe("BusinessRule", () => {
    const br = (props: string) => compile(`BusinessRule({ $id: 'br', name: 'Br', table: 'incident'${props} })`);

    it("maps when, the REST options and a script left at the default", () => {
      const result = br(
        `, when: 'async', rest: { webService: true, method: 'GET' }, script: ${JSON.stringify(
          "(function executeRule(current, previous /*null when async*/) {\n\n\t// Add your code here\n\n})(current, previous);",
        )}`,
      );
      expect(messages(result)).toEqual([]);
      expect(only(result, "sys_script")[0]).toMatchObject({
        when: "async_always",
        is_rest: "true",
        rest_method: "GET",
        advanced: "false",
      });
    });

    it.each([
      [", when: 'never'", "BusinessRule(): 'when' must be one of 'async', 'async_deprecated', 'display', 'before', 'after'."],
      [", action: ['insert', 'upsert']", "BusinessRule(): 'action' must hold 'insert', 'update', 'delete', 'query'."],
      [", rest: 1", "BusinessRule(): 'rest' must be an object."],
      [", rest: { verb: 'GET' }", "BusinessRule() has no property 'rest.verb'."],
      [", rest: { method: 1 }", "BusinessRule(): 'rest.method' must be a string."],
      [", order: '1'", "BusinessRule(): 'order' must be a number."],
      [", toString: 1", "BusinessRule() has no property 'toString'."],
      [
        ", abortAction: true, abort_action: false",
        "Both 'abortAction' and its deprecated alias 'abort_action' are defined. Remove 'abort_action' and keep 'abortAction'.",
      ],
    ])("rejects %s", (props, message) => {
      expect(messages(br(props))).toEqual([message]);
    });
  });

  describe("ClientScript", () => {
    const cs = (props: string) => compile(`ClientScript({ $id: 'cs', name: 'Cs', table: 'incident'${props} })`);

    it("warns about a field outside onChange and onCellEdit", () => {
      expect(messages(cs(", field: 'state'"), "warning")).toEqual(["Field value takes effect only when type is set to onChange or onCellEdit"]);
      expect(messages(cs(", field: 'state', type: 'onLoad'"), "warning")).toHaveLength(1);
      expect(messages(cs(", field: 'state', type: 'onCellEdit'"), "warning")).toEqual([]);
    });

    it.each(["import x from 'y'", "var x = require('y')"])("rejects a script that loads modules: %s", (script) => {
      expect(messages(cs(`, script: ${JSON.stringify(script)}`))).toEqual(["Client side scripts cannot import or require modules."]);
    });

    it("accepts a script calling a require method and maps uiType", () => {
      const result = cs(", script: 'g.require(1)', uiType: 'all'");
      expect(messages(result)).toEqual([]);
      expect(only(result, "sys_script_client")[0]).toMatchObject({
        ui_type: "10",
      });
    });

    it("rejects an unknown uiType", () => {
      expect(messages(cs(", uiType: 'tv'"))).toEqual(["ClientScript(): 'uiType' must be one of 'desktop', 'mobile_or_service_portal', 'all'."]);
    });
  });

  describe("Acl", () => {
    const acl = (props: string) => compile(`Acl({ $id: 'acl', ${props} })`);

    it.each([
      ["type: 'rest_endpoint', name: 'api', operation: 'read', roles: ['admin']", ["ACL must use operation 'execute', because it is of type 'rest_endpoint'"]],
      ["type: 'graphql', name: 'g', operation: 'execute', script: 'answer = true;'", ["ACL does not support scripts, because it is of type graphql"]],
      ["type: 'ui_page', name: 'p', operation: 'read', appliesTo: 'x', roles: ['admin']", ["ACL cannot set applies_to unless its type is 'record'"]],
      [
        "type: 'custom', name: 'n', table: 't', operation: 'read', appliesTo: 'x', roles: ['admin']",
        [
          "ACL cannot set applies_to unless its type is 'record'",
          "'name' and 'table'/'field' are mutually exclusive. Use either 'name' alone or 'table' with an optional 'field', not both.",
          "'appliesTo' can only be used with 'table' and 'field' properties. Remove 'appliesTo' when using 'name'.",
        ],
      ],
      [
        "type: 'ux_data_broker', operation: 'read', roles: ['admin']",
        ["ACL of type 'ux_data_broker' must have either a 'dataBroker' property or 'table' and 'field' properties defined"],
      ],
      [
        "type: 'ux_data_broker', dataBroker: 'broker', field: 'f', operation: 'read', roles: ['admin']",
        [
          "ACL of type 'ux_data_broker' cannot have both 'dataBroker' and 'table'/'field' properties defined",
          "'dataBroker' must be a valid GUID or a Record<'sys_ux_data_broker'>. Received: 'broker'",
        ],
      ],
      ["type: 'record', table: 't', operation: 'add_to_list', script: 's', condition: 'c'", ["ACL cannot have a script due to its 'add_to_list' operation"]],
      ["type: 'record', table: 't', operation: 'add_to_list', condition: 'c'", ["ACL cannot have a condition due to its 'add_to_list' operation"]],
    ])("reports %s", (props, expected) => {
      expect(messages(acl(props))).toEqual(expected);
    });

    it.each([
      ["roles: [{ protectionPolicy: 'read' }]", "Acl(): 'roles[].role' is required."],
      ["roles: [{ role: 'itil', colour: 1 }]", "Acl() has no property 'roles[].colour'."],
      ["roles: [{ role: 'itil', protectionPolicy: 'none' }]", "Acl(): 'roles[].protectionPolicy' must be 'read' or 'protected'."],
      ["roles: [1]", "Acl(): 'roles' must hold role names, sys_ids or Role() records."],
    ])("rejects %s", (roles, message) => {
      expect(messages(acl(`type: 'record', table: 't', operation: 'read', ${roles}`))).toEqual([message]);
    });

    it("warns about deprecated table and field properties on UX ACLs", () => {
      expect(messages(acl("type: 'ux_route', table: 't', operation: 'read', roles: ['admin']"), "warning")).toEqual([
        "The 'table' and 'field' properties are deprecated for 'ux_route' ACLs and will be ignored. Use the 'name' property instead.",
      ]);
      expect(messages(acl("type: 'ux_page', field: 'f', operation: 'read', roles: ['admin']"), "warning")).toHaveLength(1);
    });

    it("accepts an add_to_list ACL without a script or condition", () => {
      expect(messages(acl("type: 'record', table: 't', operation: 'add_to_list', roles: ['admin']"))).toEqual([]);
    });

    it("warns about an ACL that grants access to everyone", () => {
      expect(messages(acl("type: 'record', table: 't', operation: 'read'"), "warning")).toEqual([
        "ACLs must have at least one of the following: roles, security_attribute, condition, or script",
      ]);
    });

    it("names a data broker ACL by its broker and keeps unknown types, operations and attributes", () => {
      const result = compile(`
Acl({ $id: 'broker', type: 'ux_data_broker', dataBroker: '${GUID}', operation: 'read', roles: ['admin'] })
Acl({ $id: 'custom', type: 'custom', name: 'n', operation: 'custom_op', securityAttribute: 'custom_attr', localOrExisting: 'Local' })
Acl({ $id: 'mapped', type: 'record', table: 't', operation: 'query_match', security_attribute: 'has_admin_role' })
`);
      expect(messages(result)).toEqual([]);
      expect(messages(result, "warning")).toEqual([]);
      const acls = only(result, "sys_security_acl");
      expect(acls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: GUID,
            type: "6d9c40e9531210101cb3ddeeff7b12f6",
          }),
          expect.objectContaining({
            name: "n",
            type: "custom",
            operation: "custom_op",
            "operation@display_value": "custom_op",
            security_attribute: "custom_attr",
            local_or_existing: "Local",
          }),
          expect.objectContaining({
            name: "t",
            operation: "521c7497b7300210240b06dd1e11a979",
            security_attribute: "8637f144b732111074f706dd1e11a981",
          }),
        ]),
      );
      expect(acls.find((a) => a.name === "t")).not.toHaveProperty("local_or_existing");
    });

    it("references roles by sys_id without a sys_name", () => {
      const result = acl(`type: 'record', table: 't', operation: 'read', roles: ['${GUID}', { role: 'itil' }]`);
      expect(messages(result, "hint")).toEqual([expect.stringContaining(`sys_id '${GUID}'`)]);
      expect(only(result, "sys_security_acl_role").map((r) => [r.sys_user_role, r.sys_name])).toEqual(
        expect.arrayContaining([
          [GUID, undefined],
          [expect.any(String), "t.itil"],
        ]),
      );
    });
  });

  describe("UiAction", () => {
    const ua = (props: string) => compile(`UiAction({ $id: 'ua', name: 'Ua', table: 'incident'${props} })`);

    it("applies form and list given as booleans or as objects without a flag set", () => {
      const result = ua(", form: true, list: { style: 'primary' }, messages: 'one'");
      expect(messages(result)).toEqual([]);
      expect(only(result, "sys_ui_action")[0]).toMatchObject({
        form_action: "true",
        form_button: "false",
        list_action: "false",
        list_style: "primary",
        messages: "one",
      });
      expect(only(ua(", form: false"), "sys_ui_action")[0]).toMatchObject({
        form_action: "false",
      });
    });

    it.each([
      [
        ", workspace: { isConfigurableWorkspace: true }",
        "workspace.showFormButtonV2 or workspace.showFormMenuButtonV2 must be true when workspace.isConfigurableWorkspace is true",
      ],
      [", includeInViews: ['a', 'b'], excludeFromViews: ['b']", "The same view should not appear in both the `excludeFromViews` and `includeInViews`"],
      [", roles: [1]", "UiAction(): 'roles' must hold role names or Role() records."],
      [", roles: [ScriptInclude({ $id: 'si', name: 'Si', script: 's' })]", "UiAction(): 'roles' must hold roles."],
      [", form: 'yes'", "UiAction(): 'form' must be an object."],
      [", list: { showButton: 1 }", "UiAction(): 'list.showButton' must be a boolean."],
      [", client: { onclick: 'x()' }", "UiAction() has no property 'client.onclick'."],
      [", messages: [1]", "UiAction(): 'messages' must be an array of strings."],
    ])("rejects %s", (props, message) => {
      expect(messages(ua(props))).toEqual([message]);
    });
  });
});
