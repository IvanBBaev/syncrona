// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

describe("$override", () => {
  it("merges fields the builder left unset and warns about the ones it set", () => {
    const result = compile(`Role({ name: 'x_snc_bprobe.r', $override: { grantable: false, u_text: 'a', u_count: 0, u_flag: true, u_skip: undefined } })\n`);
    expect(messages(result)).toEqual([]);
    expect(messages(result, "warning")).toEqual([
      "$override: 'grantable' is already set by the plugin and will be ignored — use the corresponding API property instead.",
    ]);
    const [role] = only(result, "sys_user_role");
    expect(role).toMatchObject({ grantable: "true", u_text: "a", u_count: "0", u_flag: "true" });
    expect(role).not.toHaveProperty("u_skip");
  });

  it("applies a column override to its sys_dictionary record", () => {
    const result = compile(
      `export const x_snc_bprobe_t = Table({ name: 'x_snc_bprobe_t', schema: { title: StringColumn({ label: 'Title', $override: { u_hint: 'h' } }) } })\n`,
    );
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_dictionary").find((r) => r.element === "title")).toMatchObject({ u_hint: "h" });
  });

  it.each([
    ["sys_id"],
    ["sys_scope"],
    ["sys_update_name"],
    ["sys_domainpath"],
  ])("rejects the framework-managed field %s", (key) => {
    const result = compile(`Role({ name: 'x_snc_bprobe.r', $override: { ${key}: 'x' } })\n`);
    expect(messages(result)).toEqual([
      `$override: '${key}' is managed by the framework and cannot be overridden — remove it or use a supported API property instead.`,
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects a value that is not a scalar", () => {
    const result = compile(`Role({ name: 'x_snc_bprobe.r', $override: { u_list: ['a'] } })\n`);
    expect(messages(result)).toEqual(["Role(): '$override.u_list' must be a string, number or boolean."]);
  });
});

describe("Now.del()", () => {
  it("deletes a record by sys_id", () => {
    const result = compile(`Now.del('sys_script', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')\n`);
    expect(messages(result)).toEqual([]);
    const [update] = result.records;
    expect(update).toMatchObject({
      path: "author_elective_update/sys_script_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.xml",
      action: "DELETE",
    });
    expect(only(result, "sys_script")).toEqual([
      expect.objectContaining({ sys_id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", sys_update_name: "sys_script_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6" }),
    ]);
  });

  it("deletes a record by coalesce keys of strings, records and references", () => {
    const result = compile(`const r = Role({ $id: Now.ID['r'], name: 'x_snc_bprobe.r' })
Now.del('sys_user_role_contains', { role: r, contains: Now.ref('sys_user_role', 'b1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'), note: 'n' })
`);
    expect(messages(result)).toEqual([]);
    const [del] = only(result, "sys_user_role_contains");
    const [role] = only(result, "sys_user_role");
    expect(del).toMatchObject({ role: role.sys_id, contains: "b1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", note: "n" });
  });

  it.each([
    ["Now.del(1, 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')", "The first argument to Now.del() must be a table name."],
    ["Now.del('sys_script')", "The second argument to Now.del() must be a sys_id GUID or a coalesce keys object."],
    ["Now.del('sys_script', 1)", "The second argument to Now.del() must be a sys_id GUID or a coalesce keys object."],
    ["Now.del('sys_script', { name: 1 })", "Now.del(): the key 'name' must be a string, a record or a Now.ref() by sys_id."],
    ["Now.del('sys_script', { name: Now.ref('sys_user', { user_name: 'a' }) })", "Now.del(): the key 'name' must be a string, a record or a Now.ref() by sys_id."],
    ["Role({ name: 'x_snc_bprobe.r', description: Now.del('sys_script', 'a') })", "Now.del() is a top-level statement; it cannot be used inside another definition."],
  ])("rejects %s", (call, message) => {
    const result = compile(`${call}\n`);
    expect(messages(result)).toEqual([message]);
    expect(result.ok).toBe(false);
  });
});
