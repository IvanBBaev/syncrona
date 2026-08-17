// SPDX-License-Identifier: GPL-3.0-or-later
import { BENIGN_KEYS, SENSITIVE_KEYS } from "./corpus";
import { isSensitiveKey } from "../src/index";

describe("isSensitiveKey", () => {
  describe("true positives", () => {
    it.each(SENSITIVE_KEYS)("flags %p", (key) => {
      expect(isSensitiveKey(key)).toBe(true);
    });

    it.each(["PASSWORD", "Api_Key", "X-AUTH-TOKEN", "Cookie"])(
      "is case-insensitive for %p",
      (key) => {
        // Header names arrive in whatever case the client sent them and ServiceNow
        // column names arrive lowercase; both must land on the same rule.
        expect(isSensitiveKey(key)).toBe(true);
      },
    );
  });

  describe("false positives", () => {
    it.each(BENIGN_KEYS)("passes %p through", (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    });

    it.each([
      ["author", "auth"],
      ["inside", "sid"],
      ["pinned", "pin"],
      ["mfarm", "mfa"],
      ["footprint", "otp"],
    ])("does not let %p match the fenced token %p", (key) => {
      // The `(^|[^a-z])…([^a-z]|$)` fences around the short tokens exist purely for
      // these. `author` is a real column on sys_update_xml; if `auth` matched inside
      // it, every update-set record would come out redacted.
      expect(isSensitiveKey(key)).toBe(false);
    });
  });

  describe("documented over-eagerness", () => {
    // The bare /key/ pattern has no fence, so it matches inside words. That is a
    // deliberate trade (see the comment on SENSITIVE_KEY_PATTERNS), but leaving it
    // untested would make it indistinguishable from an accident. Pinning it means a
    // future narrowing has to be a decision, with this test as the receipt.
    it.each(["keyword", "monkey", "keyboard_layout"])("still flags %p", (key) => {
      expect(isSensitiveKey(key)).toBe(true);
    });
  });

  it("treats the empty key as non-sensitive", () => {
    expect(isSensitiveKey("")).toBe(false);
  });

  it("is stateless across repeated calls", () => {
    // A `g` or `y` flag on any pattern would make the list stateful: `lastIndex`
    // survives between calls, so the same key would alternate true/false. This
    // detector runs once per field of every record on an instance, so a stateful
    // pattern would make redaction depend on call ORDER — the kind of bug that
    // never reproduces in a single-assertion test.
    for (const key of [...SENSITIVE_KEYS, ...BENIGN_KEYS]) {
      const first = isSensitiveKey(key);
      expect(isSensitiveKey(key)).toBe(first);
      expect(isSensitiveKey(key)).toBe(first);
    }
  });
});
