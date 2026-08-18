# @syncrona/redaction

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
