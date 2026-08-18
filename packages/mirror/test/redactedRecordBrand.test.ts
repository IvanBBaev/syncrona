// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * INV-3, enforced by the COMPILER rather than at run time.
 *
 * The brand on `RedactedRecord` has no runtime existence at all: nothing assigns
 * `__redacted`, it is absent from `Object.keys`, and it survives no serialization.
 * That is not a weakness to be worked around — it is what the guarantee is. A
 * runtime check ("does this record look redacted?") could only ever inspect the
 * bytes, and bytes that have not been redacted look exactly like bytes that have.
 * So the assertion has to be that the code DOES NOT COMPILE, which no
 * `expect(...).toThrow()` can express.
 *
 * This file therefore runs the TypeScript compiler in-process over small virtual
 * sources placed inside this package, and asserts on the diagnostics. The virtual
 * files are compiled with the package's real tsconfig against the real `src/` tree,
 * so what is being measured is the actual contract, not a re-declared imitation
 * of it.
 *
 * Non-vacuity is the thing to be careful about here, because every failure mode of
 * a compile-time test is silent:
 *
 *  - A `// @ts-expect-error` on a line that was already fine passes forever and
 *    proves nothing. Asserted against directly, twice: the same forge is compiled
 *    WITHOUT the directive and must error, and a directive over a deliberately
 *    fine line must be reported as unused (TS2578).
 *  - A harness that failed to resolve `../src` would report an import error and
 *    every "this must not compile" assertion would pass for the wrong reason. So
 *    the legitimate program must produce ZERO diagnostics.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import * as ts from "typescript";

const PACKAGE_ROOT = resolve(__dirname, "..");
const VIRTUAL_DIR = join(PACKAGE_ROOT, "test", "__brand__");

/**
 * The one construct that can produce a branded record outside the redactor, built
 * from fragments so this file does not trip the scan it performs at the bottom.
 */
const MINT_CAST = ["as", "RedactedRecord"].join(" ");

/** Blank out comments while preserving every character position. */
const blankComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (line) => " ".repeat(line.length));

/**
 * A Writer stub with the signature §4.6 mandates: it accepts a `RedactedRecord`
 * and nothing else. Every virtual source below is a caller of it.
 */
const WRITER = `
import type { RedactedRecord } from "../../src/contracts";

export function write(record: RedactedRecord): number {
  return record.recordJsonBytes.length;
}
`;

const PRELUDE = `
import type { SerializedRecord, TableCatalogEntry } from "../../src/contracts";
import { redactRecord } from "../../src/serialize/redactor";
import { write } from "./writer";

declare const serializedRecord: SerializedRecord;
declare const tableEntry: TableCatalogEntry;
`;

/** The virtual sources, each compiled as part of one program. */
const SOURCES: Record<string, string> = {
  "writer.ts": WRITER,

  // The point of the whole exercise: the Writer must not accept the shape the
  // serializer produces, because that shape still holds every plaintext.
  "forgeUnbranded.ts": `${PRELUDE}
export const attempt = write(serializedRecord);
`,

  // The same line with the directive. If the line were legal, this file would
  // report an UNUSED directive instead of compiling clean — so "zero diagnostics
  // here" and "an error there" are two independent readings of the same fact.
  "forgeUnbrandedSuppressed.ts": `${PRELUDE}
// @ts-expect-error a SerializedRecord is not redacted and must not be writable
export const attempt = write(serializedRecord);
`,

  // A hand-built literal carrying every runtime field. Structural typing would
  // accept this; the brand is what does not.
  "forgeLiteral.ts": `${PRELUDE}
export const attempt = write({
  sysId: "aa00000000000000000000000000bb00",
  table: "incident",
  recordJsonBytes: new Uint8Array(),
  extractedFiles: [],
  redactions: [],
});
`,

  // A forger who reads the interface and tries to supply the brand. Neither a
  // plain symbol nor a locally-declared unique symbol is assignable to another
  // module's unique symbol.
  "forgeSymbol.ts": `${PRELUDE}
declare const mine: unique symbol;
export const attempt = write({
  __redacted: mine,
  sysId: "aa00000000000000000000000000bb00",
  table: "incident",
  recordJsonBytes: new Uint8Array(),
  extractedFiles: [],
  redactions: [],
});
`,

  // The harness's own self-test: a directive over a line that is already fine.
  // This is the silent-pass failure mode, made loud.
  "vacuousDirective.ts": `${PRELUDE}
// @ts-expect-error this line is legal, so the directive is unused
export const attempt = write(redactRecord(serializedRecord, { table: tableEntry }));
`,

  // And the positive control. If resolution or the options were wrong, this file
  // would carry diagnostics and every negative assertion above would be passing
  // for a reason that has nothing to do with the brand.
  "legit.ts": `${PRELUDE}
export const attempt = write(redactRecord(serializedRecord, { table: tableEntry }));
export const withAllowlist = write(
  redactRecord(serializedRecord, {
    table: tableEntry,
    redaction: { propertyAllowlist: ["glide.servlet.uri"] },
  })
);
`,
};

/** Compile the virtual sources against the real `src/` tree, once. */
const compile = (): Map<string, ts.Diagnostic[]> => {
  const configPath = join(PACKAGE_ROOT, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    PACKAGE_ROOT
  );

  const options: ts.CompilerOptions = {
    ...parsed.options,
    // The virtual files sit outside `rootDir` and nothing is being emitted, so
    // both the emit settings and the root constraint are dropped. Everything that
    // affects TYPE CHECKING — strictness, module resolution, target, lib — is
    // taken from the package's real config and left alone.
    noEmit: true,
    declaration: false,
    outDir: undefined,
    rootDir: undefined,
  };

  const virtualPaths = new Map<string, string>(
    Object.entries(SOURCES).map(([name, text]) => [join(VIRTUAL_DIR, name), text])
  );

  const host = ts.createCompilerHost(options, true);
  const realGetSourceFile = host.getSourceFile.bind(host);
  const realFileExists = host.fileExists.bind(host);
  const realReadFile = host.readFile.bind(host);

  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const virtual = virtualPaths.get(resolve(fileName));
    if (virtual !== undefined) {
      return ts.createSourceFile(fileName, virtual, languageVersion, true);
    }
    return realGetSourceFile(fileName, languageVersion, onError, shouldCreate);
  };
  host.fileExists = (fileName) =>
    virtualPaths.has(resolve(fileName)) || realFileExists(fileName);
  host.readFile = (fileName) =>
    virtualPaths.get(resolve(fileName)) ?? realReadFile(fileName);
  // Directory listings drive nothing here, but the virtual directory must look
  // real enough that resolution of `./writer` from a sibling succeeds.
  host.directoryExists = (directory): boolean =>
    resolve(directory) === VIRTUAL_DIR ||
    (ts.sys.directoryExists?.(directory) ?? false);

  const program = ts.createProgram([...virtualPaths.keys()], options, host);

  const byFile = new Map<string, ts.Diagnostic[]>();
  for (const [path] of virtualPaths) {
    const sourceFile = program.getSourceFile(path);
    if (sourceFile === undefined) {
      throw new Error(`virtual source ${path} did not enter the program`);
    }
    byFile.set(path.slice(VIRTUAL_DIR.length + 1), [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile),
    ]);
  }
  return byFile;
};

const diagnostics = compile();

const codesFor = (file: string): number[] =>
  (diagnostics.get(file) ?? []).map((diagnostic) => diagnostic.code);

const messagesFor = (file: string): string =>
  (diagnostics.get(file) ?? [])
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
    )
    .join("\n");

describe("INV-3: the Writer accepts only a record that went through the redactor", () => {
  it("compiles the legitimate program with no diagnostics at all", () => {
    // The positive control, asserted FIRST because every other assertion in this
    // file depends on the harness being able to resolve and check the real
    // sources. A broken harness makes "does not compile" trivially true.
    expect(messagesFor("legit.ts")).toBe("");
    expect(messagesFor("writer.ts")).toBe("");
  });

  it("rejects a SerializedRecord at the Writer's door", () => {
    // TS2345: argument not assignable to parameter. This is the invariant — the
    // pre-redaction shape carries every plaintext the wire delivered, and there
    // is no cast-free expression that turns it into a writable record.
    expect(codesFor("forgeUnbranded.ts")).toEqual([2345]);
    expect(messagesFor("forgeUnbranded.ts")).toContain("RedactedRecord");
    expect(messagesFor("forgeUnbranded.ts")).toContain("__redacted");
  });

  it("reports that same line as suppressed, not as fine", () => {
    // The other reading of the same fact. A `@ts-expect-error` that sits over a
    // legal line is reported as unused, so a clean compile here means the line
    // really was an error and the directive really did consume it.
    expect(codesFor("forgeUnbrandedSuppressed.ts")).toEqual([]);
  });

  it("flags a directive that suppresses nothing (harness self-test)", () => {
    // TS2578: "Unused '@ts-expect-error' directive." Without this, the previous
    // test could not tell a suppressed error from a line that never errored, and
    // the whole file could pass while checking nothing.
    expect(codesFor("vacuousDirective.ts")).toEqual([2578]);
  });

  it("rejects a hand-built literal carrying every runtime field", () => {
    // Structural typing would accept this; a `unique symbol` is the reason it
    // does not. The message names the missing brand rather than a field the
    // forger could add.
    expect(codesFor("forgeLiteral.ts")).toEqual([2345]);
    expect(messagesFor("forgeLiteral.ts")).toContain("__redacted");
  });

  it("rejects a forger who declares a unique symbol of their own", () => {
    // The measured claim behind the contract's doc comment: no expression outside
    // the redactor denotes this type, so the brand cannot be supplied, only
    // asserted.
    // TS2322 rather than TS2345 here: supplying the property moves the complaint
    // from "wrong argument" to "wrong type for `__redacted`", which is the more
    // specific rejection and the one that names the mechanism.
    expect(codesFor("forgeSymbol.ts")).toEqual([2322]);
    expect(messagesFor("forgeSymbol.ts")).toContain("__redacted");
  });
});

describe("the single mint site", () => {
  const collect = (directory: string): string[] => {
    const found: string[] = [];
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        found.push(...collect(path));
      } else if (path.endsWith(".ts")) {
        found.push(path);
      }
    }
    return found;
  };

  it("exists exactly once in the package, in the redactor", () => {
    // The brand makes the bypass require a type ASSERTION; this makes the
    // assertion countable. Comments are stripped first — both the contract and
    // the redactor discuss the cast in prose, and prose is not a bypass. §9 gives
    // human reviewers the same rule; this is the mechanical half.
    const offenders = [
      ...collect(join(PACKAGE_ROOT, "src")),
      ...collect(join(PACKAGE_ROOT, "test")),
    ]
      .map((path) => ({
        path,
        count: blankComments(readFileSync(path, "utf8")).split(MINT_CAST).length - 1,
      }))
      .filter((file) => file.count > 0)
      .map((file) => `${file.path.slice(PACKAGE_ROOT.length + 1)} x${file.count}`);

    expect(offenders).toEqual(["src/serialize/redactor.ts x1"]);
  });

  it("scans a tree that actually contains files (non-vacuity)", () => {
    // A `collect` that silently returned nothing would make the assertion above
    // pass while nothing was scanned.
    expect(collect(join(PACKAGE_ROOT, "src")).length).toBeGreaterThan(5);
    expect(collect(join(PACKAGE_ROOT, "test")).length).toBeGreaterThan(5);
    // And the detector finds the construct when it is there.
    expect(blankComments(`const x = y ${MINT_CAST};`).split(MINT_CAST).length - 1).toBe(1);
    expect(blankComments(`// a comment about ${MINT_CAST}`).split(MINT_CAST).length - 1).toBe(0);
  });
});

describe("the virtual harness itself", () => {
  it("placed every source into the program", () => {
    expect([...diagnostics.keys()].sort()).toEqual(Object.keys(SOURCES).sort());
  });

  it("compiled against the package's real tsconfig", () => {
    // If `strict` were off, several of the negative assertions above would still
    // pass but for weaker reasons, and future ones might not.
    const configFile = ts.readConfigFile(
      join(PACKAGE_ROOT, "tsconfig.json"),
      ts.sys.readFile
    );
    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      PACKAGE_ROOT
    );
    expect(parsed.options.strict).toBe(true);
    expect(dirname(join(VIRTUAL_DIR, "legit.ts"))).toBe(VIRTUAL_DIR);
  });
});
