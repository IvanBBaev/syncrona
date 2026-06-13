import { checkRuleOrder } from "../config";

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
});
