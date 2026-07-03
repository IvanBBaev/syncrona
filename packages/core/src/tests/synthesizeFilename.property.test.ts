// SPDX-License-Identifier: GPL-3.0-or-later
// #20 — property-based invariants for the rule-shadowing shadow detector.
//
// checkRuleOrder() warns when an earlier plugin rule would swallow a later one.
// It proves that by synthesising a concrete filename from the later rule's suffix
// pattern and testing it against the earlier rule. These properties pin the two
// guarantees that make that reasoning sound: a synthesised sample always matches
// the pattern it came from, the helper never throws / never emits a malformed
// name, and every reported issue is a real double-match (soundness).
import fc from "fast-check";
import { synthesizeFilename, checkRuleOrder } from "../config.js";

const LIT_CHARS = "abAB01._-".split("");
// A literal safe to embed in a suffix-anchored pattern, matching the shape
// checkRuleOrder actually feeds synthesizeFilename.
const literal = fc.stringOf(fc.constantFrom(...LIT_CHARS), { minLength: 1, maxLength: 10 });
const suffixRule = literal.map((lit) => ({ match: new RegExp(`${lit.replace(/\./g, "\\.")}$`) }));

describe("synthesizeFilename (property, #20)", () => {
  it("a suffix-anchored literal pattern always yields a sample matching itself", () => {
    fc.assert(
      fc.property(literal, (lit) => {
        const pattern = new RegExp(`${lit.replace(/\./g, "\\.")}$`);
        const sample = synthesizeFilename(pattern);
        expect(sample).not.toBeNull();
        expect(pattern.test(sample as string)).toBe(true);
      })
    );
  });

  it("never throws and every non-null sample is a well-formed filename", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        let pattern: RegExp;
        try {
          pattern = new RegExp(raw);
        } catch {
          return; // skip inputs that are not valid regex source
        }
        const sample = synthesizeFilename(pattern);
        if (sample !== null) {
          expect(sample.startsWith("file")).toBe(true);
          expect(/^[A-Za-z0-9._-]+$/.test(sample)).toBe(true);
        }
      })
    );
  });

  it("checkRuleOrder only reports samples matched by BOTH the earlier and later rule", () => {
    fc.assert(
      fc.property(fc.array(suffixRule, { maxLength: 6 }), (rules) => {
        for (const issue of checkRuleOrder(rules)) {
          expect(issue.earlierIndex).toBeLessThan(issue.laterIndex);
          expect(rules[issue.laterIndex].match.test(issue.sample)).toBe(true);
          expect(rules[issue.earlierIndex].match.test(issue.sample)).toBe(true);
        }
      })
    );
  });
});
