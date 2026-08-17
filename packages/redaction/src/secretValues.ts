// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Value-shape based secret detection.
 *
 * SEC-8 (REV-96): inspect VALUES, not just keys. A secret smuggled under a benign key
 * (a connection string with `user:pass@host`, a JWT, a PEM private key, an inline
 * `Authorization` value, an AWS access key id) must still be redacted.
 *
 * The governing trade-off for everything in this module: a match redacts the WHOLE
 * value. That makes a false positive expensive — it destroys the forensic detail of
 * the very record an operator is reading — so every pattern here is anchored on
 * something that ordinary prose, URLs, table paths, 32-char sys_ids and 40-char git
 * SHAs do not contain. Widening a pattern "just in case" has twice been measured as a
 * net loss (REV-147, REV-190) and both regressions are documented inline below, with
 * the honest limit each one accepts.
 */

import { SCAN_BUDGET } from "./constants";

// SEC-8 follow-up (REV-147): the inline-Authorization pattern was the scheme keyword plus
// 8 characters of a charset that contains every letter, so ordinary PROSE matched — "Basic
// authentication failed for user admin" was classified as a secret and, because a match
// redacts the WHOLE value, the entire message became a redaction. That silently destroys
// the forensic detail of exactly the auth-failure records an operator needs. The keyword
// alone is not evidence: either the value carries the header/assignment context, or the
// token itself has to look like credential material (base64/hex carries digits or base64
// symbols; an English word following "Basic" carries neither).
//
// Honest limit: a digit-free, symbol-free base64 token in bare prose is not caught by the
// second form. The header-context form, the sensitive-key allow-list and the JWT pattern
// cover the realistic carriers, and widening this one back out costs more (whole-value
// redaction of benign prose) than it buys.
const AUTH_HEADER_SECRET =
  /\bauthorization["']?\s*[:=]\s*["']?\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i;
const AUTH_SCHEME_TOKEN = /\b(?:bearer|basic)\s+([A-Za-z0-9._~+/=-]{12,})/i;

// SEC-8 follow-up (REV-190): the same whole-value over-redaction hit the bare
// `user:pass@host` form, which accepted ANY `[\w.-]+` as the host. Ordinary forensic values
// shaped `name:value@thing` therefore matched — a package spec ("npm:lodash@4.17.21
// installed") or a record reference ("incident:INC0010001@dev12345 failed") was classified
// as a credential and the whole message was replaced, losing exactly the detail an operator
// needs. Require the host to actually look like a host: an FQDN with an alphabetic TLD,
// `localhost`, or a dotted-quad IPv4.
//
// Honest limit: credentials against a single-label internal hostname (`admin:pw@snprod`)
// are no longer caught by THIS form. The `scheme://user:pass@host` pattern below, the
// sensitive-key allow-list and the vendor-token patterns cover the realistic carriers, and
// widening it back out costs whole-value redaction of benign prose.
const BARE_USERPASS_HOST =
  /(^|\s)[\w.-]+:[^\s:@/]+@(?:(?:[\w-]+\.)+[A-Za-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})\b/i;

/**
 * The two accepted forms of an inline `Authorization` credential (see REV-147 above).
 *
 * The second form's digit/symbol check is what separates "Bearer AbCd1234EfGh5678Ijkl"
 * from "Bearer credentials rejected": real base64/hex token material carries digits or
 * base64 punctuation, an English word does not.
 */
function looksLikeInlineAuthorization(value: string): boolean {
  if (AUTH_HEADER_SECRET.test(value)) {
    return true;
  }
  const match = AUTH_SCHEME_TOKEN.exec(value);
  return match ? /[0-9]/.test(match[1]) || /[+/=]/.test(match[1]) : false;
}

/**
 * True when a string VALUE looks like credential material and must not be stored
 * verbatim.
 *
 * Fails CLOSED on size: a value longer than {@link SCAN_BUDGET} is reported as a
 * secret without being scanned, because the alternative — the historical
 * `return false` — meant padding a secret past the budget was enough to launder it
 * (REV-145). An empty string is never a secret; that early return is not an
 * optimisation but a correctness guard, since several patterns below would otherwise
 * be evaluated against a value no consumer would ever want redacted into a marker.
 */
export function looksLikeSecretValue(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  if (value.length > SCAN_BUDGET) {
    return true;
  }
  return (
    /\/\/[^/\s:@]+:[^/\s:@]+@/.test(value) || // scheme://user:pass@host
    BARE_USERPASS_HOST.test(value) || // user:pass@host (REV-190)
    /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/.test(value) || // JWT (embedded)
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) || // PEM private key
    looksLikeInlineAuthorization(value) || // inline Authorization
    /\bAKIA[0-9A-Z]{16}\b/.test(value) || // AWS access key id
    // REV-126: vendor-prefixed API keys / tokens (Stripe, OpenAI, GitHub, Slack,
    // GitLab, Google). Each prefix is a high-signal marker, so a broad trailing
    // charset does not over-match ordinary text.
    /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/i.test(value) || // Stripe-style
    /\bsk-[A-Za-z0-9]{20,}/.test(value) || // OpenAI-style
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/.test(value) || // GitHub token
    /\bgithub_pat_[A-Za-z0-9_]{20,}/.test(value) || // GitHub fine-grained PAT
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/.test(value) || // Slack token
    /\bglpat-[A-Za-z0-9_-]{16,}/.test(value) || // GitLab PAT
    /\bAIza[A-Za-z0-9_-]{20,}/.test(value) || // Google API key
    /\baws_?secret_?access_?key\b/i.test(value) || // labelled AWS secret key
    /\b[A-Fa-f0-9]{64}\b/.test(value) // raw 256-bit hex secret / key material
  );
}
