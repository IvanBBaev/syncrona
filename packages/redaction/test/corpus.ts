// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The secret corpus — the versioned asset this package exists to own.
 *
 * Structure: every value-shape rule in `secretValues.ts` appears TWICE, as a
 * `{ label, value }` pair in {@link SECRET_VALUES} and as a deliberately chosen
 * NEAR-MISS in {@link BENIGN_VALUES}. The near-miss is not filler — a detector that
 * only ever sees obvious secrets is untested against the failure mode that actually
 * hurt this codebase twice (REV-147, REV-190): a pattern widened until ordinary
 * forensic prose matched it, and a match redacts the WHOLE value, so the audit record
 * an operator needed became a single redaction marker.
 *
 * EVERY VALUE HERE IS SYNTHETIC and is valid on no system anywhere. Two independent
 * habits keep it that way and keep scanners quiet:
 *
 *  1. `token(...)` assembles each vendor-prefixed fixture from a prefix and a fake
 *     body, so the complete pattern only ever exists at runtime. Push-protection
 *     scanners match on the literal in the file; the detector under test receives
 *     exactly the same string either way. (Same convention as
 *     `packages/mcp-server/test/audit.rev126-secret-detector.test.js`.)
 *  2. Bodies are visibly fake — sequential alphabet runs, `EXAMPLE`, `hunter2` —
 *     never anything with real entropy. `.gitleaks.toml` deliberately does NOT exempt
 *     test directories (a real credential leaked from one once), so any line that
 *     still trips a rule carries an inline `gitleaks:allow` naming why it is inert.
 */

/** Join fragments so a full vendor token never appears as one literal in the source. */
export const token = (...parts: string[]): string => parts.join("");

/** A labelled fixture: the label names the RULE the value is meant to exercise. */
export interface CorpusEntry {
  label: string;
  value: string;
}

/**
 * True positives — one per rule in `looksLikeSecretValue`, in the same order the
 * implementation evaluates them, so a reader can check the corpus against the code
 * line by line and see that nothing is unexercised.
 */
export const SECRET_VALUES: CorpusEntry[] = [
  {
    label: "scheme://user:pass@host connection string",
    value: "https://admin:hunter2@dev12345.service-now.com/api/now/table/incident",
  },
  {
    label: "bare user:pass@fqdn",
    value: "admin:hunter2@db.internal.example.com refused the connection",
  },
  {
    label: "bare user:pass@localhost",
    value: "proxy user:hunter2@localhost rejected",
  },
  {
    label: "bare user:pass@ipv4",
    value: "svc:hunter2@10.0.0.5 rejected",
  },
  {
    // Header + payload + signature, each a short fake segment. A real JWT this
    // short would not verify anywhere; the detector only looks at the shape.
    label: "JWT embedded in prose",
    value: `login failed for ${token("eyJ", "hbGciOiJIUzI1NiJ9", ".eyJzdWIiOiIxIn0", ".abcdefgh")}`,
  },
  {
    label: "PEM private key header",
    value: "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
  },
  {
    label: "inline Authorization header assignment",
    value: `Authorization: ${token("Bearer ", "AbCdEfGh12345678")}`,
  },
  {
    // Digit-carrying token after a bare scheme keyword — the REV-147 "looks like
    // credential material" half of the rule.
    label: "bare Bearer + digit-carrying token",
    value: token("Bearer ", "AbCd1234EfGh5678Ijkl"),
  },
  {
    // Symbol-carrying token with NO digits — the other half of the same check.
    label: "bare Bearer + base64-symbol token",
    value: token("Bearer ", "AbCdEfGhIjKlMnOp="),
  },
  {
    label: "AWS access key id",
    value: token("AKIA", "ABCDEFGHIJKLMNOP"),
  },
  {
    label: "Stripe-style live secret key",
    value: token("sk", "_live_", "51ABCdefGHIjklMNOpqr"),
  },
  {
    label: "Stripe-style test publishable key",
    value: token("pk", "_test_", "51ABCdefGHIjklMNOpqr"),
  },
  {
    label: "OpenAI-style API key",
    value: token("sk", "-", "ABCDEFGHIJKLMNOPQRSTuvwx0123456789"),
  },
  {
    label: "GitHub personal access token",
    value: token("ghp", "_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
  },
  {
    label: "GitHub fine-grained PAT",
    value: token("github", "_pat_", "ABCDEFGHIJKLMNOPQRSTUV1234567890"),
  },
  {
    label: "Slack bot token",
    value: token("xoxb", "-1234567890-", "ABCDEFGHIJKLMNOP"),
  },
  {
    label: "GitLab personal access token",
    value: token("glpat", "-", "ABCDEFGHIJKLMNOPqrst"),
  },
  {
    label: "Google API key",
    value: token("AIza", "ABCDEFGHIJKLMNOPQRSTUVWX01234567890"),
  },
  {
    label: "labelled AWS secret access key",
    value: token("aws_secret_access_key=", "wJalrXUtnFEMIabcdEXAMPLEKEY"),
  },
  {
    // 64 hex characters: raw 256-bit key material. Sequential nibble runs, so it is
    // structurally a key and cryptographically nothing.
    label: "raw 256-bit hex key material",
    value: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
  },
];

/**
 * False positives — values that look secret-ish and MUST pass through verbatim.
 *
 * Each entry names the rule it sits just outside of. Several are the exact strings
 * that a widened pattern once swallowed in production audit records; they are
 * regression fixtures, not decoration.
 */
export const BENIGN_VALUES: CorpusEntry[] = [
  { label: "ordinary prose", value: "all systems ok" },
  { label: "ordinary prose with a table name", value: "updated the business rule ordering on sys_script" },
  { label: "plain URL", value: "https://example.com/api/now/table/incident?sysparm_limit=50" },
  {
    // Userinfo WITHOUT a password: the `//user:pass@` rule needs the colon.
    label: "URL with userinfo but no password",
    value: "https://admin@dev12345.service-now.com/api/now/table/incident",
  },
  { label: "instance hostname", value: "dev12345.service-now.com" },
  // REV-190 regressions: `name:value@thing` prose that a bare user:pass@host rule ate.
  { label: "npm package spec (REV-190)", value: "npm:lodash@4.17.21 installed" },
  { label: "record reference (REV-190)", value: "update on incident:INC0010001@dev12345 failed" },
  { label: "script include reference (REV-190)", value: "sys_script_include:AbcUtil@dev408269 skipped" },
  // REV-147 regressions: auth-failure prose that a bare scheme-keyword rule ate.
  { label: "Basic-auth failure prose (REV-147)", value: "Basic authentication failed for user admin" },
  { label: "basic-config prose (REV-147)", value: "basic configuration is incomplete" },
  { label: "Bearer prose under the token length floor (REV-147)", value: "Bearer credentials rejected" },
  { label: "auth-method advice prose (REV-147)", value: "switch to basic auth before retrying" },
  { label: "Authorization mentioned without a value", value: "Authorization header missing from the response" },
  // Shape near-misses, one per rule.
  { label: "JWT-ish string with segments below the floor", value: "eyJab.eyJcd.ef" },
  { label: "PUBLIC certificate, not a private key", value: "-----BEGIN CERTIFICATE-----\nMIIabc\n-----END CERTIFICATE-----" },
  { label: "AWS-key prefix too short", value: token("AKIA", "SHORT") },
  { label: "AWS region assignment, not a secret", value: "aws_region=eu-west-1" },
  { label: "Stripe prefix with no body", value: token("sk", "_live_") },
  { label: "OpenAI prefix below the length floor", value: token("sk", "-", "short") },
  { label: "GitHub prefix below the length floor", value: token("ghp", "_", "short") },
  { label: "GitHub PAT prefix below the length floor", value: token("github", "_pat_", "short") },
  { label: "Slack prefix below the length floor", value: token("xoxb", "-", "short") },
  { label: "GitLab prefix below the length floor", value: token("glpat", "-", "short") },
  { label: "Google prefix below the length floor", value: token("AIza", "short") },
  // Hex near-misses. A ServiceNow sys_id is 32 hex chars and appears in virtually
  // every audit record; a 64-char rule that caught it would redact the whole trail.
  { label: "32-char sys_id", value: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6" },
  { label: "40-char git SHA", value: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0" },
  { label: "63 hex chars, one short of the rule", value: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b" },
  { label: "UUID", value: "550e8400-e29b-41d4-a716-446655440000" },
];

/**
 * Key names that MUST be treated as credential carriers.
 *
 * The list walks every pattern in `sensitiveKeys.ts`, including the fenced short
 * tokens (`auth`, `sid`, `otp`, `mfa`, `pin`) in a realistic header/field spelling.
 */
export const SENSITIVE_KEYS = [
  "password",
  "user_password",
  "passwd",
  "pwd",
  "token",
  "refresh_token",
  "Authorization",
  "auth",
  "x-auth-header",
  "secret",
  "client_secret",
  "api_key",
  "apiKey",
  "apikey",
  "key",
  "privateKey",
  "signingKey",
  "credential",
  "jwt",
  "assertion",
  "bearer",
  "cert",
  "certificate",
  "cookie",
  "session",
  "sid",
  "php_sid",
  "passphrase",
  "otp",
  "otp_code",
  "mfa",
  "x-mfa-code",
  "pin",
  "nonce",
];

/**
 * Key names that MUST pass through — chosen to sit one letter outside a fenced
 * pattern, which is exactly where a careless widening of the fence would break them.
 * `author` vs `auth`, `inside` vs `sid`, `pinned` vs `pin`.
 */
export const BENIGN_KEYS = [
  "name",
  "sys_id",
  "short_description",
  "description",
  "active",
  "category",
  "number",
  "state",
  "author",
  "authored_by",
  "inside",
  "pinned",
  "assignment_group",
  "sys_updated_on",
];
