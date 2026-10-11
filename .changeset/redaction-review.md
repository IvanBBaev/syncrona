---
"@syncrona/redaction": patch
---

- `isSensitiveKey` treats a camelCase hump as a word boundary, so `authHeader`, `userPin`, `OTPCode` and `mfaCode` hit the fenced short tokens, and `PHPSESSID` is flagged.
- `looksLikeSecretValue` also flags URL userinfo with an empty user or a colon in the password, a PGP private key block, an `Authorization` header with another scheme whose token carries a digit or base64 symbol, a `password=…` form pair or `"client_secret": "…"` JSON member (the assignment syntax is required, so prose naming the field is untouched), and 64+ hex key material behind a `0x` or `key_` prefix or longer than 64 characters.
