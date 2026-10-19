// SPDX-License-Identifier: GPL-3.0-or-later
import { BENIGN_VALUES, SECRET_VALUES } from "./corpus";
import { SCAN_BUDGET, looksLikeSecretValue } from "../src/index";

/**
 * A filler character that matches nothing in the detector: not hex (so it cannot
 * trip the 256-bit key-material rule at any length), not a URL/auth character.
 * Length is therefore the ONLY variable in the budget tests below.
 */
const FILLER = "x";

describe("looksLikeSecretValue", () => {
  describe("true positives", () => {
    it.each(SECRET_VALUES.map((entry) => [entry.label, entry.value]))(
      "flags %s",
      (_label, value) => {
        expect(looksLikeSecretValue(value)).toBe(true);
      },
    );
  });

  describe("false positives", () => {
    // The half of the corpus that costs the most to get wrong. A match redacts the
    // WHOLE value, so each of these firing would replace a complete audit record —
    // the operator-facing message, not just the secret-shaped fragment inside it.
    it.each(BENIGN_VALUES.map((entry) => [entry.label, entry.value]))(
      "passes %s through",
      (_label, value) => {
        expect(looksLikeSecretValue(value)).toBe(false);
      },
    );
  });

  describe("hex fixtures are the lengths they claim", () => {
    // The 64-char rule is a boundary rule, so a fixture that silently drifted to 63
    // or 65 characters would turn two of the tests above into no-ops that still pass.
    // Assert the shape of the fixtures themselves rather than trusting the labels.
    const hexOf = (label: string): string => {
      const entry = [...SECRET_VALUES, ...BENIGN_VALUES].find((e) => e.label.includes(label));
      if (!entry) {
        throw new Error(`corpus entry missing: ${label}`);
      }
      return entry.value;
    };

    it.each([
      ["raw 256-bit hex key material", 64],
      ["32-char sys_id", 32],
      ["40-char git SHA", 40],
      ["63 hex chars", 63],
    ])("%s is %i hex characters", (label, length) => {
      const value = hexOf(String(label));
      expect(value).toMatch(/^[0-9a-f]+$/);
      expect(value).toHaveLength(Number(length));
    });
  });

  describe("scan budget", () => {
    it("does not treat the empty string as a secret", () => {
      // Not an optimisation: without this guard an empty field would still be run
      // through every pattern, and a caller redacting on the result would replace
      // "nothing" with a redaction marker — noise in every record with a blank field.
      expect(looksLikeSecretValue("")).toBe(false);
    });

    it("scans a benign value of exactly SCAN_BUDGET characters and passes it", () => {
      const value = FILLER.repeat(SCAN_BUDGET);
      expect(value).toHaveLength(SCAN_BUDGET);
      expect(looksLikeSecretValue(value)).toBe(false);
    });

    it("fails CLOSED one character over SCAN_BUDGET (REV-145)", () => {
      // The historical behaviour here was `return false` — fail OPEN. That made the
      // budget an exploit: pad a credential past 8192 characters and it was written
      // to the audit trail in cleartext, because the scanner declined to look. The
      // value below is pure filler and matches no pattern at all, so the ONLY reason
      // it comes back true is that it exceeded the budget. That is the point of the
      // test: over-budget means "unscanned", and unscanned must mean "assume secret".
      const value = FILLER.repeat(SCAN_BUDGET + 1);
      expect(value).toHaveLength(SCAN_BUDGET + 1);
      expect(looksLikeSecretValue(value)).toBe(true);
    });

    it("still flags a secret padded to just under the budget", () => {
      // The complement of the test above: padding is not a bypass on either side of
      // the boundary. Here the value IS scanned and the pattern still has to fire.
      const secret = SECRET_VALUES[0].value;
      const value = `${FILLER.repeat(SCAN_BUDGET - secret.length)}${secret}`;
      expect(value).toHaveLength(SCAN_BUDGET);
      expect(looksLikeSecretValue(value)).toBe(true);
    });

    it("keeps the budget at the documented 8192 characters", () => {
      // Pinned because the constant is a security boundary, not a tuning knob:
      // raising it costs scan time per field on every record of an instance, and
      // lowering it silently converts more benign long values into redactions.
      expect(SCAN_BUDGET).toBe(8192);
    });
  });

  it("is stateless across repeated calls", () => {
    // Same reasoning as the key detector: a `g`/`y` flag anywhere in the pattern
    // list would make the verdict depend on how many times it had been called.
    for (const { value } of [...SECRET_VALUES, ...BENIGN_VALUES]) {
      const first = looksLikeSecretValue(value);
      expect(looksLikeSecretValue(value)).toBe(first);
      expect(looksLikeSecretValue(value)).toBe(first);
    }
  });
});
