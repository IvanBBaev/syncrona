// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Key-name based secret detection.
 *
 * This is the cheapest and highest-precision of the three signals the redactors
 * use: a field literally named `password` / `apiKey` / `x-auth-token` is a secret
 * carrier regardless of what its value happens to look like. Value scanning
 * (`looksLikeSecretValue`) is the fallback for secrets smuggled under a benign
 * key; field-TYPE deny (the caller's job — the mirror reads `internal_type` from
 * `sys_dictionary`) is the third and is load-bearing, not hygiene: measured on a
 * real instance, a `password2` column returns a 106-character ciphertext string
 * over the Table API, so the wire genuinely carries encrypted secret material
 * (mirror-architecture §5.7 / D19).
 */

// SEC-8 (REV-96): broaden the key allow-list. The old `/(^|[_-])key($|[_-])/` required a
// separator, so camelCase creds (`apiKey`, `privateKey`, `signingKey`, `clientKey`) slipped
// through unredacted. We drop the separator and add explicit credential-ish tokens.
//
// The bare `/key/` entry is what makes this list deliberately over-eager: it also matches
// `keyword`, `monkey` and `keyboard`. That trade is intentional and must not be "fixed" by
// narrowing it — a redacted key name costs a reviewer one lookup, while a leaked credential
// costs a rotation. Callers that need a specific benign key preserved say so explicitly
// (the mirror's `redaction.propertyAllowlist` for `sys_properties`), rather than weakening
// the pattern for everyone.
const SENSITIVE_KEY_PATTERNS = [
  /password/,
  /passwd/,
  /pwd/,
  /token/,
  /authorization/,
  // The short tokens below are fenced with `(^|[^a-z])…([^a-z]|$)` so they match a WORD,
  // not a substring: `auth` must not fire on "author", `sid` must not fire on "inside",
  // `pin` must not fire on "pinned". Digits and separators are word boundaries here on
  // purpose, so `auth2`, `otp_1` and `x-mfa-code` still match.
  /(^|[^a-z])auth([^a-z]|$)/,
  /secret/,
  /api[_-]?key/,
  /key/,
  /credential/,
  /jwt/,
  /assertion/,
  /bearer/,
  /cert/,
  /cookie/,
  /session/,
  /(^|[^a-z])sid([^a-z]|$)/,
  /passphrase/,
  /(^|[^a-z])otp([^a-z]|$)/,
  /(^|[^a-z])mfa([^a-z]|$)/,
  /(^|[^a-z])pin([^a-z]|$)/,
  /nonce/,
];

/**
 * True when a property/field NAME suggests its value is credential material.
 *
 * Case-insensitive by normalization rather than by the `i` flag, so the patterns
 * above can be read as plain lowercase and a future entry cannot forget the flag.
 */
export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(normalized));
}
