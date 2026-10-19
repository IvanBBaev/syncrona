// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * INV-7 enforcement: serialization is a pure function of (row, catalog entry).
 *
 * The behavioural tests can only observe purity indirectly — call twice, compare.
 * That catches an accidental cache but not a deliberate dependency: a serializer
 * that stamped `Date.now()` into every record would still be self-consistent
 * within one process and would still pass every "serialize twice" assertion.
 *
 * So this file asserts the STRUCTURAL half of the invariant, by walking the
 * serializer's transitive import graph and reading the sources it reaches. What
 * it forbids is not an aesthetic preference:
 *
 *  - **No foreign value is imported and used.** Any bare specifier is either a
 *    node builtin (`node:fs`, `node:os`, `node:process` — I/O, ambient state) or a
 *    dependency that can perform I/O on its own. Keeping foreign values out of the
 *    closure's logic makes "no config, no clock, no fs" a property of the graph
 *    rather than of a hand-maintained deny list, and it simultaneously enforces
 *    §4.1's rule that `packages/mirror` must not reach into the core CLI package.
 *
 *    There is exactly one carve-out, and it is narrower than it first looks.
 *    §11 requires that a constant have ONE home: `SYS_ID_RE` belongs to
 *    `@syncrona/sn-transport` and `REDACTION_MARKER_PREFIX` to
 *    `@syncrona/redaction`, so `constants.ts` re-exports them rather than
 *    re-declaring them — a re-declared copy passes review on the day it is
 *    written and drifts from its owner forever after. The carve-out therefore
 *    permits those two packages, and ONLY in `export … from` position. A
 *    re-export is a name passing through: it hands a binding to consumers without
 *    the serializer's own code being able to read it. `import { x } from` in the
 *    same closure would be a foreign value in the serializer's logic, which is
 *    what this file exists to forbid, and it stays forbidden.
 *
 *    What that carve-out honestly does NOT prove: those packages execute their
 *    module bodies when the closure is loaded. The compensating assertion is
 *    below — the borrowed values are frozen primitives and regexes, identical to
 *    the owner's, so they cannot be a per-call hidden input regardless of what
 *    their package does at load time.
 *  - **No ambient globals.** `Date`, `Math.random`, `process` and `globalThis`
 *    need no import at all, so the graph check cannot see them; they are the
 *    cheapest possible way to smuggle a hidden input in.
 *  - **No module-level mutable bindings.** A `let` at module scope is state that
 *    survives between calls, which is exactly how a memoized comparator or a
 *    warmed cache turns the second run of an unchanged instance into a diff.
 *
 * The scan is textual and includes comments on purpose. A comment is allowed to
 * discuss why the clock is absent, but it must do so without writing the token —
 * a slightly awkward sentence is a fair price for a check with no parser and no
 * false negatives.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import * as constants from "../src/constants";

const SRC_ROOT = resolve(__dirname, "..", "src");
const ENTRY = join(SRC_ROOT, "serialize", "serializer.ts");

/** Every `from "…"`, bare `import "…"` and `require("…")` specifier in a source. */
const SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*|\brequire\s*\()\s*["']([^"']+)["']/g;

const readSource = (path: string): string => readFileSync(path, "utf8");

/**
 * Resolve a relative specifier the way TypeScript's NodeNext resolution does for
 * this package: extensionless, `.ts` first, then a directory's `index.ts`.
 */
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
  throw new Error(
    `Cannot resolve "${specifier}" from ${relative(SRC_ROOT, fromFile)}`
  );
};

/**
 * The only packages a module in the serializer's closure may name, and then only
 * to pass a §11 constant through. Adding to this list is a deliberate, visible
 * edit — which is the point.
 */
const REEXPORT_ALLOWLIST = ["@syncrona/redaction", "@syncrona/sn-transport"];

interface BareUse {
  file: string;
  specifier: string;
  /** True when the specifier appeared on an `export … from` line. */
  reexport: boolean;
}

interface Closure {
  /** Absolute paths of every module reachable from the entry point. */
  files: string[];
  /** Every non-relative specifier seen anywhere in the closure. */
  bareSpecifiers: BareUse[];
}

/**
 * Blank out comments while preserving every character position.
 *
 * Only ever used to CLASSIFY a specifier that was already found in the raw
 * source, never to find one — so a mis-stripped line can weaken the reasoning
 * about a specifier but can never hide one. Prose is full of the words "import"
 * and "export", and the classifier below reads exactly those words.
 */
const blankComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (line) => " ".repeat(line.length));

/**
 * Whether a specifier occurrence sits inside an `export … from "…"` statement.
 *
 * The clause may span lines and contains braces of its own, so the nearest
 * `;`/`}` is not the statement boundary — `export { A, B } from "x"` would be
 * misread as starting at its own closing brace. What actually disambiguates the
 * two forms is which keyword introduced the statement, so this finds the nearer
 * of the two and answers accordingly.
 */
const isReexport = (source: string, index: number): boolean => {
  const before = blankComments(source).slice(0, index);
  const lastImport = before.lastIndexOf("import");
  const lastExport = before.lastIndexOf("export");
  return lastExport > lastImport;
};

const collectClosure = (entry: string): Closure => {
  const files: string[] = [];
  const bareSpecifiers: BareUse[] = [];
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    files.push(file);

    const source = readSource(file);
    for (const match of source.matchAll(SPECIFIER_RE)) {
      const specifier = match[1];
      if (specifier.startsWith(".")) {
        queue.push(resolveRelative(file, specifier));
      } else {
        bareSpecifiers.push({
          file: relative(SRC_ROOT, file).split("\\").join("/"),
          specifier,
          reexport: isReexport(source, match.index),
        });
      }
    }
  }

  return { files: files.sort(), bareSpecifiers };
};

const closure = collectClosure(ENTRY);

describe("INV-7: the serializer is a pure function of (row, catalog entry)", () => {
  it("reaches the modules it is supposed to reach", () => {
    // Guard against the check passing vacuously. If resolution silently produced
    // a one-file closure, every assertion below would be trivially satisfied and
    // the invariant would be unguarded while the suite stayed green.
    const relativeFiles = closure.files.map((file) =>
      relative(SRC_ROOT, file).split("\\").join("/")
    );

    expect(relativeFiles).toEqual([
      "constants.ts",
      "contracts.ts",
      "serialize/serializer.ts",
    ]);
  });

  it("lets the serializer itself reach nothing outside this package", () => {
    // The carve-out below is for `constants.ts` passing §11 names through. The
    // serializer's own module gets no carve-out at all: it must be reachable
    // only through relative imports.
    const serializerOwn = closure.bareSpecifiers.filter(
      (use) => use.file === "serialize/serializer.ts"
    );
    expect(serializerOwn).toEqual([]);
  });

  it("imports nothing from outside this package's src tree", () => {
    // No `node:fs`, no `node:process`, no config module, no `syncrona` — and no
    // third-party dependency that could reach any of them on the serializer's
    // behalf. Anything that is not an allowlisted §11 re-export is a violation.
    const violations = closure.bareSpecifiers.filter(
      (use) => !(use.reexport && REEXPORT_ALLOWLIST.includes(use.specifier))
    );
    expect(violations).toEqual([]);
  });

  it("permits those packages only to pass a name through, never to use one", () => {
    // Non-vacuity: if the closure stopped naming the foundation packages
    // altogether — because someone "fixed" this test by re-declaring the
    // constants locally — the assertions above would go green while §11 was
    // being violated. This one fails in that case.
    const reexports = closure.bareSpecifiers.filter((use) => use.reexport);
    expect(reexports.map((use) => use.specifier).sort()).toEqual(REEXPORT_ALLOWLIST);
    expect(reexports.every((use) => use.file === "constants.ts")).toBe(true);

    // And the detector is not simply answering "true" to everything: a plain
    // import in the same file shape is classified as a use, not a re-export.
    expect(isReexport('import { x } from "y";', 20)).toBe(false);
    expect(isReexport('export { x } from "y";', 20)).toBe(true);
    // Multi-line clauses and the braces inside them are the shape that fooled a
    // naive statement-boundary scan, and prose is the shape that fools a naive
    // keyword scan. Both are pinned here.
    expect(isReexport('import {\n  x,\n} from "y";', 24)).toBe(false);
    expect(isReexport('export {\n  x,\n} from "y";', 24)).toBe(true);
    expect(isReexport('/* re-exported below */\nimport { x } from "y";', 43)).toBe(false);
  });

  it("borrows only frozen constants, which cannot vary between calls", () => {
    // This is what makes the carve-out safe rather than merely convenient. A
    // re-exported function or mutable object would be a hidden input wearing a
    // constant's name; a regex literal and two primitives cannot be.
    expect(typeof constants.MAX_NAME_BYTES).toBe("number");
    expect(typeof constants.RPS_MAX).toBe("number");
    expect(typeof constants.REDACTION_MARKER_PREFIX).toBe("string");
    expect(constants.SYS_ID_RE).toBeInstanceOf(RegExp);
    // A stateful regex would make `test()` alternate between true and false on
    // the same input — a per-call hidden input hiding in a constant.
    expect(constants.SYS_ID_RE.global).toBe(false);
    expect(constants.SYS_ID_RE.sticky).toBe(false);

    const sysId = "0123456789abcdef0123456789abcdef";
    expect([1, 2, 3].map(() => constants.SYS_ID_RE.test(sysId))).toEqual([true, true, true]);
  });

  it("touches no ambient source of state", () => {
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

    for (const file of closure.files) {
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
    // Only column 0 counts: a `let` inside a function is a local, and locals are
    // fine — they die with the call. What must not exist is a binding that
    // outlives one invocation and can therefore make call N+1 differ from call N.
    for (const file of closure.files) {
      const offenders = readSource(file)
        .split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => /^(?:export\s+)?(?:let|var)\s/.test(line))
        .map(({ line, number }) => `${relative(SRC_ROOT, file)}:${number}: ${line.trim()}`);

      expect(offenders).toEqual([]);
    }
  });
});
