# @syncrona/redaction

## 1.1.0

### Patch Changes

- 6d7ec9b: - `isSensitiveKey` treats a camelCase hump as a word boundary, so `authHeader`, `userPin`, `OTPCode` and `mfaCode` hit the fenced short tokens, and `PHPSESSID` is flagged.
  - `looksLikeSecretValue` also flags URL userinfo with an empty user or a colon in the password, a PGP private key block, an `Authorization` header with another scheme whose token carries a digit or base64 symbol, a `password=…` form pair or `"client_secret": "…"` JSON member (the assignment syntax is required, so prose naming the field is untouched), and 64+ hex key material behind a `0x` or `key_` prefix or longer than 64 characters.

## 1.0.0

## 0.9.4

## 0.9.3

### Minor Changes

- First published release. The credential-detection primitive is extracted here out of the MCP server, so "is this a credential?" has one answer every package shares.

## 0.9.1

### Minor Changes

- Initial release. Secret detection and redaction extracted verbatim from
  `packages/mcp-server/src/audit.ts` (`isSensitiveAuditKey`,
  `looksLikeSecretValue`, `SECRET_SCAN_BUDGET`) so the MCP server audit trail and
  the instance mirror share one corpus instead of two that drift. Behaviour of the
  extracted detectors is unchanged — the mcp-server audit suite passes unmodified.
  New in this package: `redactValue`, the stable
  `__SYNCRONA_REDACTED__<sha256-12>` marker the mirror needs so a rotated secret
  still produces a diff.
