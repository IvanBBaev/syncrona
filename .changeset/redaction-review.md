---
"@syncrona/redaction": patch
---

- `isSensitiveKey` treats a camelCase hump as a word boundary, so `authHeader`, `userPin`, `OTPCode` and `mfaCode` hit the fenced short tokens, and `PHPSESSID` is flagged.
