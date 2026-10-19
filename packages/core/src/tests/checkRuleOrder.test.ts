// SPDX-License-Identifier: GPL-3.0-or-later
import { checkRuleOrder } from "../config.js";

export {};

// DX10: detect rules shadowed by an earlier, broader rule (first-match-wins).
describe("checkRuleOrder", () => {
  it("reports nothing when rules are ordered most-specific-first", () => {
    const issues = checkRuleOrder([
      { match: /\.secret\.ts$/ },
      { match: /\.ts$/ },
    ]);
    expect(issues).toEqual([]);
  });

  it("flags a specific rule shadowed by an earlier broad rule", () => {
    const issues = checkRuleOrder([
      { match: /\.ts$/ }, // broad, first
      { match: /\.secret\.ts$/ }, // never reached
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ earlierIndex: 0, laterIndex: 1 });
    expect(issues[0].sample).toContain(".secret.ts");
  });

  it("skips patterns it cannot safely synthesize (regex metacharacters)", () => {
    const issues = checkRuleOrder([
      { match: /.*/ },
      { match: /(foo|bar)\.[jt]s$/ },
    ]);
    expect(issues).toEqual([]);
  });

  it("handles an empty rule list", () => {
    expect(checkRuleOrder([])).toEqual([]);
  });

  // #18: sync.config.js is hand-written JS that nothing type-checks, so a rule
  // can arrive without a `match`, or with a string where a RegExp belongs.
  // PluginManager.determinePlugins already survives exactly that — it warns and
  // skips the rule — but the checker crashed on `pattern.source` of a
  // non-RegExp. `build --check-config` is the one command whose entire job is
  // to report what is wrong with these rules, so it died with
  // "Cannot read properties of undefined (reading 'source')" precisely on the
  // configs it exists to diagnose, and reported nothing about the real
  // shadowing further down the list.
  it("survives malformed rules the build itself tolerates, and still reports the real shadow", () => {
    const rules = [
      null,
      { match: "\\.ts$" }, // a string, not a RegExp
      { match: /\.ts$/ }, // broad, valid
      { match: /\.secret\.ts$/ }, // shadowed by the rule above
    ] as unknown as Array<{ match: RegExp }>;

    const issues = checkRuleOrder(rules);

    expect(issues).toEqual([{ laterIndex: 3, earlierIndex: 2, sample: "file.secret.ts" }]);
  });
});
