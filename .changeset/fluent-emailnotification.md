---
"@syncrona/fluent": minor
---

- The native Fluent compiler supports `EmailNotification()`: one `sysevent_email_action` record from its trigger, recipient, content and digest groups, byte for byte with SDK 4.13.6. Template, style, category, digest interval, recipient and push-message references take sys_ids or records (recipient users also take email addresses). Like the SDK, it reports invalid references, an `engine` trigger that fires on neither insert nor update and an `event` trigger without `eventName`, and warns about a digest on a `vcalendar` notification, event-parameter recipients on a non-event trigger and message fields that disagree with the content type.
