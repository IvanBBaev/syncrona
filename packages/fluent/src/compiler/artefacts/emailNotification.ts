// SPDX-License-Identifier: GPL-3.0-or-later
//
// EmailNotification() → sysevent_email_action.

import type { FluentValue } from "../evaluate";
import { isGUID } from "../keys";
import { CData, type CompiledRecord } from "../record";
import type { ArtefactSpec, BuildContext, Options } from "./shared";

const DEFAULT_EMAIL_CATEGORY = "c97d83137f4432005f58108c3ffa917a";
const DEFAULT_DIGEST_SEPARATOR_HTML = "<p>&nbsp;</p>\n<hr>\n<p>&nbsp;</p>";
const DEFAULT_DIGEST_SEPARATOR_TEXT = "--------------------------------------------------------------------------------\n";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const TRIGGER_PROPERTIES = [
  "generationType",
  "onRecordInsert",
  "onRecordUpdate",
  "eventName",
  "weight",
  "condition",
  "advancedCondition",
  "itemTable",
  "affectedFieldOnEvent",
  "item",
  "order",
];
const RECIPIENT_PROPERTIES = [
  "recipientUsers",
  "recipientFields",
  "recipientGroups",
  "excludeDelegates",
  "isSubscribableByAllUsers",
  "sendToCreator",
  "eventParm1WithRecipient",
  "eventParm2WithRecipient",
];
const CONTENT_PROPERTIES = [
  "contentType",
  "template",
  "style",
  "subject",
  "message",
  "messageHtml",
  "messageText",
  "smsAlternate",
  "importance",
  "includeAttachments",
  "omitWatermark",
  "from",
  "replyTo",
  "pushMessageOnly",
  "pushMessageList",
  "forceDelivery",
];
const DIGEST_PROPERTIES = [
  "allow",
  "default",
  "defaultInterval",
  "type",
  "template",
  "subject",
  "html",
  "text",
  "separatorHtml",
  "separatorText",
  "from",
  "replyTo",
];

/** A text option as CDATA, or empty when left out. */
function cdata(o: Options | undefined, key: string, fallback?: string): CData | string {
  const value = o?.string(key) ?? fallback;
  return value === undefined ? "" : new CData(value);
}

function guidError(ctx: BuildContext, field: string, table: string, value: string, item: FluentValue): void {
  ctx.report("error", `'${field}' must be a valid GUID or a Record<'${table}'>. Received: '${value}'`, item.loc);
}

/** A single reference: a record or a sys_id string (an invalid string reports the SDK's error). */
function reference(o: Options | undefined, ctx: BuildContext, key: string, field: string, table: string): string | CompiledRecord {
  const v = o?.get(key);
  if (v === undefined) return "";
  if (v.kind === "call") return ctx.recordOf(v);
  const value = o!.string(key)!;
  if (isGUID(value)) return value;
  guidError(ctx, field, table, value, v);
  return "";
}

/** A list of records or sys_id strings (or, with `email`, addresses), comma-separated. */
function referenceList(o: Options | undefined, ctx: BuildContext, key: string, field: string, table: string, email = false): string {
  const ids: string[] = [];
  (o?.array(key) ?? []).forEach((item, index) => {
    if (item.kind === "call") ids.push(ctx.recordOf(item).id.getValue());
    else if (item.kind !== "string") o!.error(`EmailNotification(): '${field}' must hold sys_ids or records.`, item);
    else if (isGUID(item.value) || (email && EMAIL.test(item.value))) ids.push(item.value);
    else if (email) {
      ctx.report("error", `'${field}[${index}]' must be a valid GUID or email address or a Record<'${table}'>. Received: '${item.value}'`, item.loc);
    } else guidError(ctx, `${field}[${index}]`, table, item.value, item);
  });
  return ids.join(",");
}

/** The SDK's warnings when the content type and the message fields disagree (skipped with a template). */
function checkContent(content: Options, ctx: BuildContext): void {
  if (content.get("template") !== undefined) return;
  const type = content.string("contentType") ?? "text/html";
  const html = content.string("messageHtml");
  const text = content.string("messageText");
  const warn = (message: string) => ctx.report("warning", message, content.object.loc);
  if (type === "text/html") {
    if (!html) warn("Content type is 'text/html' but 'messageHtml' is not provided. Please provide 'messageHtml' for HTML content.");
    if (text) warn("Content type is 'text/html': 'messageText' will be ignored. Only 'messageHtml' will be used.");
  } else if (type === "text/plain") {
    if (!text) warn("Content type is 'text/plain' but 'messageText' is not provided. Please provide 'messageText' for plain text content.");
    if (html) warn("Content type is 'text/plain': 'messageHtml' will be ignored. Only 'messageText' will be used.");
  } else if (type === "multipart/mixed" && !html && !text) {
    warn("Content type is 'multipart/mixed' but neither 'messageHtml' nor 'messageText' is provided. Please provide at least one or both.");
  }
}

export const emailNotification: ArtefactSpec = {
  properties: [
    "name",
    "description",
    "table",
    "category",
    "active",
    "mandatory",
    "notificationType",
    "triggerConditions",
    "recipientDetails",
    "emailContent",
    "digest",
    "enableDynamicTranslation",
  ],
  build(o, ctx) {
    const trigger = o.nested("triggerConditions", TRIGGER_PROPERTIES);
    const recipients = o.nested("recipientDetails", RECIPIENT_PROPERTIES);
    const content = o.nested("emailContent", CONTENT_PROPERTIES);
    const digest = o.nested("digest", DIGEST_PROPERTIES);

    const recipientUsers = referenceList(recipients, ctx, "recipientUsers", "recipientDetails.recipientUsers", "sys_user", true);
    const recipientGroups = referenceList(recipients, ctx, "recipientGroups", "recipientDetails.recipientGroups", "sys_user_group");
    const pushMessages = referenceList(content, ctx, "pushMessageList", "emailContent.pushMessageList", "sys_push_notif_msg");
    const template = reference(content, ctx, "template", "emailContent.template", "sysevent_email_template");
    const style = reference(content, ctx, "style", "emailContent.style", "sysevent_email_style");
    const interval = reference(digest, ctx, "defaultInterval", "digest.defaultInterval", "sys_email_digest_interval");
    const digestTemplate = reference(digest, ctx, "template", "digest.template", "sysevent_email_template");

    const notificationType = o.string("notificationType") ?? "email";
    const generationType = trigger?.string("generationType") ?? "engine";
    if (trigger && generationType === "engine" && !trigger.boolean("onRecordInsert") && !trigger.boolean("onRecordUpdate")) {
      ctx.report(
        "error",
        "When triggerConditions.generationType is 'engine', at least one of 'onRecordInsert' or 'onRecordUpdate' must be true.",
        trigger.object.loc,
      );
    }
    if (trigger && generationType === "event" && !trigger.string("eventName")?.trim()) {
      ctx.report("error", "When triggerConditions.generationType is 'event', 'eventName' is required.", trigger.object.loc);
    }
    if (digest && notificationType === "vcalendar" && digest.boolean("allow") === true) {
      ctx.report(
        "warning",
        "Digest functionality is not supported for notificationType 'vcalendar'. The digest configuration will be ignored.",
        digest.object.loc,
      );
    }
    if (
      recipients &&
      generationType !== "event" &&
      (recipients.boolean("eventParm1WithRecipient") === true || recipients.boolean("eventParm2WithRecipient") === true)
    ) {
      ctx.report(
        "warning",
        `'eventParm1WithRecipient' and 'eventParm2WithRecipient' only apply when triggerConditions.generationType is 'event'. Current type is '${generationType}'.`,
        recipients.object.loc,
      );
    }
    if (content) checkContent(content, ctx);

    const category = reference(o, ctx, "category", "category", "sys_notification_category");
    return ctx.factory.createRecord({
      table: "sysevent_email_action",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name: o.string("name") ?? "",
        description: o.string("description") ?? "",
        collection: o.string("table") ?? "",
        category: category === "" ? DEFAULT_EMAIL_CATEGORY : category,
        type: notificationType,
        active: o.boolean("active") ?? true,
        mandatory: o.boolean("mandatory") ?? false,
        enable_dynamic_translation: o.boolean("enableDynamicTranslation") ?? false,
        generation_type: generationType,
        action_insert: trigger?.boolean("onRecordInsert") ?? false,
        action_update: trigger?.boolean("onRecordUpdate") ?? false,
        event_name: trigger?.string("eventName") ?? "",
        condition: trigger?.string("condition") ?? "",
        advanced_condition: trigger?.string("advancedCondition") ?? "",
        item_table: trigger?.string("itemTable") ?? "",
        affected_field_on_event: trigger?.string("affectedFieldOnEvent") ?? "",
        item: trigger?.string("item") ?? "event.parm1",
        order: trigger?.number("order") ?? 100,
        weight: trigger?.number("weight") ?? 0,
        recipient_users: recipientUsers,
        recipient_fields: (recipients?.stringArray("recipientFields") ?? []).join(","),
        recipient_groups: recipientGroups,
        exclude_delegates: recipients?.boolean("excludeDelegates") ?? false,
        subscribable: recipients?.boolean("isSubscribableByAllUsers") ?? false,
        send_self: recipients?.boolean("sendToCreator") ?? false,
        event_parm_1: recipients?.boolean("eventParm1WithRecipient") ?? false,
        event_parm_2: recipients?.boolean("eventParm2WithRecipient") ?? false,
        content_type: content?.string("contentType") ?? "text/html",
        template,
        style,
        subject: content?.string("subject") ?? "",
        message: cdata(content, "message"),
        message_html: cdata(content, "messageHtml"),
        message_text: cdata(content, "messageText"),
        sms_alternate: cdata(content, "smsAlternate"),
        importance: content?.string("importance") ?? "",
        include_attachments: content?.boolean("includeAttachments") ?? false,
        omit_watermark: content?.boolean("omitWatermark") ?? false,
        from: content?.string("from") ?? "",
        reply_to: content?.string("replyTo") ?? "",
        push_message_only: content?.boolean("pushMessageOnly") ?? false,
        message_list: pushMessages,
        force_delivery: content?.boolean("forceDelivery") ?? false,
        digestable: digest?.boolean("allow") ?? false,
        default_digest: digest?.boolean("default") ?? false,
        default_interval: interval,
        digest_type: digest?.string("type") ?? "single",
        digest_template: digestTemplate,
        digest_subject: digest?.string("subject") ?? "",
        digest_html: cdata(digest, "html"),
        digest_text: cdata(digest, "text"),
        digest_separator_html: cdata(digest, "separatorHtml", DEFAULT_DIGEST_SEPARATOR_HTML),
        digest_separator_text: cdata(digest, "separatorText", DEFAULT_DIGEST_SEPARATOR_TEXT),
        digest_from: digest?.string("from") ?? "",
        digest_reply_to: digest?.string("replyTo") ?? "",
        sys_version: "2",
      },
    });
  },
};
