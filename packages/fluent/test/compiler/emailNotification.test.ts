// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const GUID = "0c441abbc6112275000025157c651c89";
const notification = (options: string) => `EmailNotification({ $id: Now.ID['n'], table: 'incident', ${options} })\n`;
const insert = "triggerConditions: { onRecordInsert: true }";

describe("EmailNotification()", () => {
  it("writes the SDK's defaults", () => {
    const result = compile("EmailNotification({ $id: Now.ID['n'] })\n");
    expect(messages(result)).toEqual([]);
    expect(messages(result, "warning")).toEqual([]);
    const [record] = only(result, "sysevent_email_action");
    expect(record).toEqual(
      expect.objectContaining({
        name: "",
        collection: "",
        category: "c97d83137f4432005f58108c3ffa917a",
        type: "email",
        active: "true",
        generation_type: "engine",
        item: "event.parm1",
        order: "100",
        weight: "0",
        content_type: "text/html",
        template: "",
        message: "",
        digest_type: "single",
        digest_separator_html: "<p>&nbsp;</p>\n<hr>\n<p>&nbsp;</p>",
        sys_version: "2",
      }),
    );
  });

  it("takes references as records or sys_ids", () => {
    const result = compile(
      "const c = Record({ $id: Now.ID['c'], table: 'sys_notification_category', data: { name: 'c' } })\n" +
        "const s = Record({ $id: Now.ID['s'], table: 'sysevent_email_style', data: { name: 's' } })\n" +
        "const i = Record({ $id: Now.ID['i'], table: 'sys_email_digest_interval', data: { name: 'i' } })\n" +
        "const m = Record({ $id: Now.ID['m'], table: 'sys_push_notif_msg', data: { name: 'm' } })\n" +
        notification(
          `category: c, ${insert}, emailContent: { style: s, template: '${GUID}', pushMessageList: [m, '${GUID}'] }, digest: { defaultInterval: i }`,
        ),
    );
    expect(messages(result)).toEqual([]);
    const id = (table: string) => only(result, table)[0]!.sys_id;
    expect(only(result, "sysevent_email_action")[0]).toEqual(
      expect.objectContaining({
        category: id("sys_notification_category"),
        style: id("sysevent_email_style"),
        template: GUID,
        message_list: `${id("sys_push_notif_msg")},${GUID}`,
        default_interval: id("sys_email_digest_interval"),
      }),
    );
  });

  it("reports invalid references", () => {
    const result = compile(
      notification(
        `category: 'c', ${insert}, recipientDetails: { recipientUsers: ['u'], recipientGroups: ['g'] }, ` +
          "emailContent: { template: 't', style: 's', pushMessageList: ['p'] }, digest: { defaultInterval: 'i', template: 'd' }",
      ),
    );
    expect(messages(result)).toEqual([
      "'recipientDetails.recipientUsers[0]' must be a valid GUID or email address or a Record<'sys_user'>. Received: 'u'",
      "'recipientDetails.recipientGroups[0]' must be a valid GUID or a Record<'sys_user_group'>. Received: 'g'",
      "'emailContent.pushMessageList[0]' must be a valid GUID or a Record<'sys_push_notif_msg'>. Received: 'p'",
      "'emailContent.template' must be a valid GUID or a Record<'sysevent_email_template'>. Received: 't'",
      "'emailContent.style' must be a valid GUID or a Record<'sysevent_email_style'>. Received: 's'",
      "'digest.defaultInterval' must be a valid GUID or a Record<'sys_email_digest_interval'>. Received: 'i'",
      "'digest.template' must be a valid GUID or a Record<'sysevent_email_template'>. Received: 'd'",
      "'category' must be a valid GUID or a Record<'sys_notification_category'>. Received: 'c'",
    ]);
    expect(only(result, "sysevent_email_action")[0]!.category).toBe("c97d83137f4432005f58108c3ffa917a");
  });

  it("reports triggers that never fire", () => {
    expect(messages(compile(notification("triggerConditions: { onRecordInsert: false }")))).toEqual([
      "When triggerConditions.generationType is 'engine', at least one of 'onRecordInsert' or 'onRecordUpdate' must be true.",
    ]);
    expect(messages(compile(notification("triggerConditions: { onRecordUpdate: true }")))).toEqual([]);
    expect(messages(compile(notification("triggerConditions: { generationType: 'event', eventName: ' ' }")))).toEqual([
      "When triggerConditions.generationType is 'event', 'eventName' is required.",
    ]);
    expect(messages(compile(notification("triggerConditions: { generationType: 'event' }")))).toHaveLength(1);
  });

  it("warns about settings the notification ignores", () => {
    const result = compile(
      notification(
        `notificationType: 'vcalendar', ${insert}, recipientDetails: { eventParm2WithRecipient: true }, digest: { allow: true }`,
      ),
    );
    expect(messages(result)).toEqual([]);
    expect(messages(result, "warning")).toEqual([
      "Digest functionality is not supported for notificationType 'vcalendar'. The digest configuration will be ignored.",
      "'eventParm1WithRecipient' and 'eventParm2WithRecipient' only apply when triggerConditions.generationType is 'event'. Current type is 'engine'.",
    ]);
    const quiet = compile(
      notification(`notificationType: 'vcalendar', ${insert}, recipientDetails: { eventParm1WithRecipient: false }, digest: { allow: false }`),
    );
    expect(messages(quiet, "warning")).toEqual([]);
    expect(messages(compile(notification(`${insert}, recipientDetails: { eventParm1WithRecipient: true }`)), "warning")).toHaveLength(1);
  });

  it.each([
    ["{}", ["Content type is 'text/html' but 'messageHtml' is not provided. Please provide 'messageHtml' for HTML content."]],
    ["{ messageHtml: 'h', messageText: 't' }", ["Content type is 'text/html': 'messageText' will be ignored. Only 'messageHtml' will be used."]],
    ["{ contentType: 'text/plain' }", ["Content type is 'text/plain' but 'messageText' is not provided. Please provide 'messageText' for plain text content."]],
    [
      "{ contentType: 'text/plain', messageText: 't', messageHtml: 'h' }",
      ["Content type is 'text/plain': 'messageHtml' will be ignored. Only 'messageText' will be used."],
    ],
    [
      "{ contentType: 'multipart/mixed' }",
      ["Content type is 'multipart/mixed' but neither 'messageHtml' nor 'messageText' is provided. Please provide at least one or both."],
    ],
    ["{ contentType: 'multipart/mixed', messageText: 't' }", []],
    ["{ contentType: 'other' }", []],
    [`{ template: '${GUID}' }`, []],
  ])("checks emailContent %s against its content type", (content, warnings) => {
    const result = compile(notification(`${insert}, emailContent: ${content}`));
    expect(messages(result)).toEqual([]);
    expect(messages(result, "warning")).toEqual(warnings);
  });

  it.each([
    [notification("recipientDetails: { recipientUsers: [1] }"), "EmailNotification(): 'recipientDetails.recipientUsers' must hold sys_ids or records."],
    [notification("recipientDetails: { recipientFields: [1] }"), "EmailNotification(): 'recipientDetails.recipientFields' must be an array of strings."],
    [notification("emailContent: { style: 1 }"), "EmailNotification(): 'emailContent.style' must be a string."],
    [notification("digest: { every: 1 }"), "EmailNotification() has no property 'digest.every'."],
    [notification("severity: 1"), "EmailNotification() has no property 'severity'."],
  ])("rejects %s", (source, message) => {
    const result = compile(source);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain(message);
  });
});
