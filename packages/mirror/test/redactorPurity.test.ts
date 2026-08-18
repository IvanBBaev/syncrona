// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * INV-7 for the redaction half of the pipeline: `serializeAndRedact` is a pure
 * function of (row, options).
 *
 * `serializerPurity.test.ts` makes the same argument for the serializer and is left
 * exactly as it was — its closure walk starts at `serializer.ts`, which reaches
 * neither of the modules added here, so nothing about it is relaxed by this file's
 * existence. This one starts at `pipeline.ts` and therefore covers the serializer's
 * closure PLUS `redactor.ts` and `pipeline.ts`.
 *
 * Why it matters even more here than there. A serializer that stamped a clock into
 * a record produces a diff someone would eventually notice. A redactor with a
 * hidden input produces a tree that LOOKS right: same fields, same shape, and a
 * different set of things redacted depending on an ambient value nobody passed. The
 * output of this stage is the one output no reader can audit by inspection, because
 * the whole point is that the plaintext is gone.
 *
 * THE CARVE-OUT, and why it is narrower than it looks. The serializer's closure may
 * name a foreign package only in `export … from` position — a name passing through,
 * never a value the logic can call. The redactor cannot work under that rule: it
 * exists to APPLY `@syncrona/redaction`'s detectors, and §11 gives those detectors
 * exactly one home, so calling them is the whole design. The carve-out is therefore
 * one package, in one file, and every other (file, package) pair in the closure
 * stays forbidden — including `pipeline.ts`, which composes the two stages and
 * needs nothing foreign at all.
 *
 * What makes that safe rather than merely necessary is the compensating assertion
 * below: the borrowed package's OWN import closure is walked here too, and it
 * reaches nothing but `node:crypto`. There is no configuration, no clock and no
 * filesystem behind the seam, so a call into it cannot be a hidden input — which is
 * a stronger statement than "we reviewed it once", because it fails the day that
 * stops being true.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import {
  SCAN_BUDGET,
  isSensitiveKey,
  looksLikeSecretValue,
  redactValue,
} from "@syncrona/redaction";

const SRC_ROOT = resolve(__dirname, "..", "src");
const ENTRY = join(SRC_ROOT, "pipeline.ts");
const REDACTION_SRC = resolve(__dirname, "..", "..", "redaction", "src");

/** Every `from "…"`, bare `import "…"` and `require("…")` specifier in a source. */
const SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*|\brequire\s*\()\s*["']([^"']+)["']/g;

const readSource = (path: string): string => readFileSync(path, "utf8");

/** Blank out comments while preserving every character position. */
const blankComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (line) => " ".repeat(line.length));

const resolveRelative = (fromFile: string, specifier: string): string => {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    join(base, "index.ts"),
    base.replace(/\.js$/, ".ts"),
  ]) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // Try the next shape.
    }
  }
  throw new Error(`Cannot resolve "${specifier}" from ${fromFile}`);
};

interface Closure {
  /** Paths relative to the walk's root, POSIX-separated, sorted. */
  files: string[];
  /** Absolute paths, in the same set. */
  absolute: string[];
  /** Every non-relative specifier seen, as `file` → specifier pairs. */
  bare: Array<{ file: string; specifier: string }>;
}

const collectClosure = (entry: string, root: string): Closure => {
  const absolute: string[] = [];
  const bare: Array<{ file: string; specifier: string }> = [];
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    absolute.push(file);

    const source = readSource(file);
    const name = relative(root, file).split("\\").join("/");
    for (const match of source.matchAll(SPECIFIER_RE)) {
      const specifier = match[1];
      if (specifier.startsWith(".")) {
        queue.push(resolveRelative(file, specifier));
      } else if (!/\s/.test(specifier)) {
        // The scan is textual and reads comments too, which is deliberate — a
        // specifier must not be hideable by wrapping it in a comment. The cost is
        // that prose quoting a phrase after the word "from" looks like one. A
        // package name cannot contain whitespace (npm forbids it, and Node could
        // not resolve it), so this discards the prose without being able to
        // discard a real dependency.
        bare.push({ file: name, specifier });
      }
    }
  }

  return {
    files: absolute
      .map((file) => relative(root, file).split("\\").join("/"))
      .sort(),
    absolute: absolute.sort(),
    bare,
  };
};

const closure = collectClosure(ENTRY, SRC_ROOT);
const redactionClosure = collectClosure(join(REDACTION_SRC, "index.ts"), REDACTION_SRC);

/**
 * The complete list of foreign names this closure may mention, as (file,
 * specifier) pairs. Anything not on it is a violation; adding to it is a
 * deliberate, visible edit, which is the point.
 *
 *  - `constants.ts` passes two §11 names through. That it does so ONLY in
 *    `export … from` position is asserted in `serializerPurity.test.ts`, which
 *    walks the same file; re-implementing that classifier here would be a second
 *    copy of a subtle piece of parsing, free to drift from the first.
 *  - `serialize/redactor.ts` calls the detectors. This is the carve-out.
 */
const ALLOWED_BARE = new Set([
  "constants.ts::@syncrona/redaction",
  "constants.ts::@syncrona/sn-transport",
  "serialize/redactor.ts::@syncrona/redaction",
]);

describe("INV-7: the redaction pipeline is a pure function of its arguments", () => {
  it("reaches the modules it is supposed to reach", () => {
    // Non-vacuity. A silently truncated closure would satisfy every assertion
    // below while checking nothing.
    expect(closure.files).toEqual([
      "constants.ts",
      "contracts.ts",
      "pipeline.ts",
      "serialize/redactor.ts",
      "serialize/serializer.ts",
    ]);
  });

  it("names no foreign package outside the one documented carve-out", () => {
    const violations = closure.bare.filter(
      (use) => !ALLOWED_BARE.has(`${use.file}::${use.specifier}`)
    );

    expect(violations).toEqual([]);
  });

  it("keeps the carve-out to one package in one file", () => {
    // The other three modules in the closure get no carve-out at all. In
    // particular `pipeline.ts` composes two stages and needs nothing foreign —
    // if it grew an import, that would be the natural place for configuration or
    // a clock to enter the chain.
    const byFile = new Map<string, string[]>();
    for (const use of closure.bare) {
      byFile.set(use.file, [...(byFile.get(use.file) ?? []), use.specifier]);
    }

    expect(byFile.get("pipeline.ts")).toBeUndefined();
    expect(byFile.get("contracts.ts")).toBeUndefined();
    expect(byFile.get("serialize/serializer.ts")).toBeUndefined();
    expect(byFile.get("serialize/redactor.ts")).toEqual(["@syncrona/redaction"]);
  });

  it("borrows from a package that itself reaches nothing but a hash function", () => {
    // This is what makes the carve-out safe rather than merely necessary: there
    // is no configuration, no clock and no filesystem behind the seam, so the
    // detectors cannot be a per-call hidden input.
    expect(redactionClosure.files).toEqual([
      "constants.ts",
      "index.ts",
      "redactValue.ts",
      "secretValues.ts",
      "sensitiveKeys.ts",
    ]);
    expect([...new Set(redactionClosure.bare.map((use) => use.specifier))]).toEqual([
      "node:crypto",
    ]);
  });

  it("gets the same answer from the borrowed detectors every time", () => {
    // The behavioural half of the same argument, and the one that would catch a
    // detector that memoized, sampled or learned. A hidden input that varies
    // between calls shows up here even if the import graph looks innocent.
    const value = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
    expect([1, 2, 3].map(() => looksLikeSecretValue(value))).toEqual([
      true,
      true,
      true,
    ]);
    expect([1, 2, 3].map(() => looksLikeSecretValue("all systems ok"))).toEqual([
      false,
      false,
      false,
    ]);
    expect([1, 2, 3].map(() => isSensitiveKey("password"))).toEqual([
      true,
      true,
      true,
    ]);
    expect([1, 2, 3].map(() => redactValue("hunter2"))).toEqual([
      redactValue("hunter2"),
      redactValue("hunter2"),
      redactValue("hunter2"),
    ]);
    expect(typeof SCAN_BUDGET).toBe("number");
  });

  it("re-declares no constant that another package owns (§11)", () => {
    // The failure mode §11 exists for: a copied literal is correct on the day it
    // is written and drifts from its owner forever after. Comments are stripped
    // first — prose is allowed to NAME the marker, and this file's own header
    // does exactly that.
    const source = blankComments(
      readSource(join(SRC_ROOT, "serialize", "redactor.ts"))
    );

    expect(source).not.toContain("__SYNCRONA_REDACTED__");
    expect(source).not.toContain(String(SCAN_BUDGET));
    expect(source).not.toContain("sha256");
  });

  it("touches no ambient source of state", () => {
    // Same list as the serializer's, for the same reason: `Date`, `Math.random`,
    // `process` and `globalThis` need no import, so the graph walk above cannot
    // see them. The scan is textual and includes comments on purpose — a comment
    // may discuss why the clock is absent, but must do so without writing the
    // token.
    const forbidden = [
      "process.env",
      "process.cwd",
      "process.hrtime",
      "globalThis",
      "Date.now",
      "new Date",
      "Math.random",
      "readFile",
      "writeFile",
      "require(",
      "import(",
    ];

    for (const file of closure.absolute) {
      const source = readSource(file);
      for (const token of forbidden) {
        expect({
          file: relative(SRC_ROOT, file),
          token,
          present: source.includes(token),
        }).toEqual({
          file: relative(SRC_ROOT, file),
          token,
          present: false,
        });
      }
    }
  });

  it("declares no module-level mutable binding", () => {
    // A `let` at module scope is state that survives between calls — which is
    // how the second run of an unchanged instance turns into a diff.
    for (const file of closure.absolute) {
      const offenders = readSource(file)
        .split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => /^(?:export\s+)?(?:let|var)\s/.test(line))
        .map(({ line, number }) => `${relative(SRC_ROOT, file)}:${number}: ${line.trim()}`);

      expect(offenders).toEqual([]);
    }
  });
});
