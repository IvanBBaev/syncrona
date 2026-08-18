// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * INV-1's ordering half.
 *
 * Two things are checked here and they are different in kind. The first is that
 * `compareBytewise` computes code-unit order, which is an ordinary unit test. The
 * second is that no module in this package sorts by a locale, which no unit test can
 * establish — a locale-sensitive sort produces the RIGHT answer on the machine that
 * runs the suite and a different one somewhere else, so the defect is invisible to
 * any assertion about behaviour. It is visible in the source, so that is where it is
 * checked.
 *
 * The source scan is deliberately narrow. It does not require every sort to name a
 * comparator — `["b", "a"].sort()` is specified to compare UTF-16 code units and is
 * already deterministic — it bans the two constructs that are not: `localeCompare`
 * and `Intl.Collator`. Both are silently locale- and ICU-version-dependent, and the
 * ICU data ships with the Node binary rather than with this repository, so the same
 * commit can produce two different trees on two machines that both pass CI.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { compareBytewise } from "../src/order";

const SRC_DIR = join(__dirname, "..", "src");

/** Every `.ts` file under `src/`, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return sourceFiles(full);
    }
    return name.endsWith(".ts") ? [full] : [];
  });
}

describe("compareBytewise", () => {
  it("orders by code unit, in both directions and at equality", () => {
    expect(compareBytewise("a", "b")).toBe(-1);
    expect(compareBytewise("b", "a")).toBe(1);
    expect(compareBytewise("a", "a")).toBe(0);
  });

  it("agrees with the comparator-less sort it is allowed to stand in for", () => {
    // The pair that separates the two orderings: `_` is U+005F and `a` is U+0061, so
    // code-unit order puts `sys_ui_action` first. Several ICU locales treat `_` as
    // ignorable punctuation and put it second. If this expectation ever flips, the
    // implementation has acquired a locale.
    const names = ["sys_uiaction", "sys_ui_action", "sys_user"];
    expect([...names].sort(compareBytewise)).toEqual([
      "sys_ui_action",
      "sys_uiaction",
      "sys_user",
    ]);
    expect([...names].sort(compareBytewise)).toEqual([...names].sort());
  });

  it("is a total order, so a sort using it is stable across input permutations", () => {
    // Antisymmetry and transitivity are what make `sort` deterministic; a comparator
    // that fails either one lets V8's sort return different results for different
    // input orders, which is INV-1 lost to a comparator rather than to a locale.
    const sample = ["", "a", "A", "a_", "ab", "b", "sys_", "sys_a", "é", "☃"];
    for (const left of sample) {
      for (const right of sample) {
        // Summed rather than negated: `-0` and `0` are distinct under `Object.is`,
        // which `toBe` uses, and the negation of the equal case is `-0`.
        expect(compareBytewise(left, right) + compareBytewise(right, left)).toBe(0);
      }
    }
    const forward = [...sample].sort(compareBytewise);
    const backward = [...sample].reverse().sort(compareBytewise);
    expect(backward).toEqual(forward);
  });
});

describe("INV-1: no locale reaches the tree", () => {
  it("finds the sources it claims to be scanning", () => {
    // Non-vacuity. A scan that silently walked an empty directory would pass the
    // test below forever, including on the day someone moves `src/`.
    const files = sourceFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((file) => file.endsWith("order.ts"))).toBe(true);
  });

  it("uses no locale-sensitive comparison anywhere under src/", () => {
    // The pattern is call-shaped for `localeCompare` so that a docblock explaining
    // why the method is banned does not itself trip the ban — `serialize/serializer`
    // and `order` both name it in prose, and a rule that cannot be documented gets
    // deleted by the next person who hits it. `Intl.Collator` is matched broadly
    // because there is no legitimate reason for the identifier to appear at all, and
    // `order.ts` is excluded for the single mention in its own docblock.
    const banned = /\.localeCompare\s*\(|Intl\s*\.\s*Collator/;
    const offenders = sourceFiles(SRC_DIR)
      .filter((file) => !file.endsWith("order.ts"))
      .filter((file) => banned.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(SRC_DIR.length + 1));
    expect(offenders).toEqual([]);
  });
});
