// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const action = (options: string) => `InboundEmailAction({ $id: Now.ID['iea'], ${options} })\n`;
const USER = "6816f79cc0a8016401c5a33be04be441";

describe("InboundEmailAction()", () => {
  it("writes the SDK's defaults and empty fields", () => {
    const result = compile("InboundEmailAction({ $id: Now.ID['iea'] })\n");
    expect(messages(result)).toEqual([]);
    expect(only(result, "sysevent_in_email_action")).toEqual([
      expect.objectContaining({
        name: "",
        table: "",
        type: "new",
        action: "record_action",
        active: "false",
        order: "100",
        event_name: "email.read",
        stop_processing: "false",
        script: "",
        template: "",
        from: "",
        required_roles: "",
      }),
    ]);
  });

  it("takes a sender by sys_id or as a sys_user Record(), and roles by name or Role()", () => {
    const result = compile(
      "const u = Record({ $id: Now.ID['u'], table: 'sys_user', data: { user_name: 'mailer' } })\n" +
        "const r = Role({ $id: Now.ID['r'], name: 'x_snc_bprobe.mailer' })\n" +
        action(`from: u, requiredRoles: ['admin', r, 'admin'], table: 'incident', fieldAction: 'a=b^EQ', script: 'x()'`) +
        `InboundEmailAction({ $id: Now.ID['iea2'], action: 'reply_email', from: '${USER}', type: 'forward' })\n`,
    );
    expect(messages(result)).toEqual([]);
    const [first, second] = only(result, "sysevent_in_email_action");
    const user = only(result, "sys_user")[0]!;
    expect(first).toEqual(
      expect.objectContaining({ from: user.sys_id, required_roles: "admin,x_snc_bprobe.mailer", template: "a=b^EQ", script: "x()" }),
    );
    expect(second).toEqual(expect.objectContaining({ from: USER, action: "reply_email", type: "forward" }));
  });

  it("reports the SDK's errors", () => {
    expect(messages(compile(action("fieldAction: 'a=b^EQ'")))).toEqual([
      "Field 'fieldAction' can only be used when 'table' is specified.",
    ]);
    expect(messages(compile(action("action: 'reply_email', fieldAction: 'a=b^EQ', from: ''")))).toEqual([]);
    expect(messages(compile(action("from: 'admin'")))).toEqual([
      "'from' must be a valid GUID or a Record<'sys_user'>. Received: 'admin'",
    ]);
  });

  it.each([
    [action("from: Role({ $id: Now.ID['r'], name: 'x_snc_bprobe.r' })"), "InboundEmailAction(): 'from' must be a sys_id or a Record<'sys_user'>."],
    [action("type: 'old'"), "InboundEmailAction(): 'type' must be one of new, reply, forward."],
    [action("action: 'ignore'"), "InboundEmailAction(): 'action' must be one of record_action, reply_email."],
    [action("requiredRoles: 'admin'"), "InboundEmailAction(): 'requiredRoles' must be an array."],
    [action("from: 1"), "InboundEmailAction(): 'from' must be a string."],
    [action("subject: 'x'"), "InboundEmailAction() has no property 'subject'."],
  ])("rejects %s", (source, message) => {
    const result = compile(source);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain(message);
  });
});
