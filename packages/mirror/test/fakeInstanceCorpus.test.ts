// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * WP-M2 acceptance, half one: "fixture generation is deterministic (two runs →
 * identical bytes)" (architecture §12).
 *
 * Determinism is asserted four independent ways, because each catches a class
 * the others miss:
 *
 *  1. **Two calls, one process.** Catches an accidental cache or a generator
 *     that consumes its own PRNG state across calls. Misses anything ambient
 *     that is stable within a process — a clock read once, an RNG seeded at
 *     import.
 *  2. **Against the committed bytes.** The files under `corpus/` were written by
 *     an EARLIER process on an earlier day. Re-rendering now and comparing byte
 *     for byte is literally the "two runs" clause, with the second run separated
 *     from the first by everything a real difference could hide in: a different
 *     process, a different date, a different working directory.
 *  3. **With the ambient sources poisoned.** The global RNG and the wall clock
 *     are replaced with functions that throw. A generator that touched either
 *     would fail loudly instead of producing plausible-but-unstable output. This
 *     is the check that would have caught a "temporary" global-RNG call left in
 *     a helper, since (1) and (2) both pass for a generator whose randomness is
 *     only re-drawn when the committed corpus is regenerated.
 *  4. **Structurally, by reading the sources.** Poisoning covers the two globals
 *     that get reached for; a source scan covers `randomUUID`, `hrtime`,
 *     the environment and everything else nobody thought to poison. Modelled on
 *     `serializerPurity.test.ts`.
 *
 * Regenerating the corpus after an intentional change:
 *
 *     SYNCRONA_UPDATE_FAKE_CORPUS=1 NODE_OPTIONS= npx jest \
 *       --config packages/mirror/jest.config.js --coverage=false \
 *       --testPathPatterns fakeInstanceCorpus
 *
 * The update path lives here rather than in an npm script deliberately: WP-M2
 * owns no manifest, and a fixture-refresh procedure that requires editing a file
 * this work package may not touch is a procedure that will be done by hand and
 * wrongly.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  BULK_TABLE_NAME,
  BULK_TABLE_ROW_COUNT,
  COMMITTED_CORPUS_DIR,
  CORPUS_FORMAT_VERSION,
  DEFAULT_CORPUS_SEED,
  generateCorpus,
  loadCommittedCorpus,
  loadCorpusFromDirectory,
  renderCorpusFiles,
  resolveWireColumns,
  synthesizeAttachmentBytes,
  wireColumnsByTable,
  writeCorpusFiles,
  type FixtureCorpus,
  type FixtureRow,
  type FixtureTable,
} from "./fakeInstance/corpus";

const SOURCE_DIR = join(__dirname, "fakeInstance");

/** Regenerate rather than assert. See the module docstring. */
const UPDATING = process.env.SYNCRONA_UPDATE_FAKE_CORPUS === "1";

if (UPDATING) {
  writeCorpusFiles(COMMITTED_CORPUS_DIR, renderCorpusFiles(generateCorpus()));
}

/** The reference render every determinism assertion below compares against. */
const rendered = renderCorpusFiles(generateCorpus());
const renderedNames = [...rendered.keys()].sort();

const committedFiles = (): string[] => {
  const out: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(COMMITTED_CORPUS_DIR, full).split("\\").join("/"));
    }
  };
  walk(COMMITTED_CORPUS_DIR);
  return out.sort();
};

/**
 * Compare as text first, then as bytes.
 *
 * The text comparison is what produces a diff a human can read; the byte
 * comparison is what the acceptance criterion actually says. Asserting only the
 * first would let a BOM or a CRLF through, asserting only the second would print
 * "Buffers differ" and nothing else.
 */
const expectSameBytes = (actual: string, expected: string, label: string): void => {
  expect({ label, text: actual }).toEqual({ label, text: expected });
  expect(Buffer.from(actual, "utf8").equals(Buffer.from(expected, "utf8"))).toBe(true);
};

const tableOf = (corpus: FixtureCorpus, name: string): FixtureTable => {
  const table = corpus.tables.find((entry) => entry.name === name);
  if (!table) throw new Error(`corpus has no table ${name}`);
  return table;
};

const rowNamed = (table: FixtureTable, name: string): FixtureRow => {
  const row = table.rows.find((entry) => entry.name === name || entry.sys_name === name);
  if (!row) throw new Error(`table ${table.name} has no row named ${JSON.stringify(name)}`);
  return row;
};

describe("fixture corpus determinism (§12 acceptance: two runs → identical bytes)", () => {
  it("renders identical bytes when generated twice in one process", () => {
    const second = renderCorpusFiles(generateCorpus());
    expect([...second.keys()].sort()).toEqual(renderedNames);
    for (const [name, contents] of rendered) {
      expectSameBytes(second.get(name) as string, contents, name);
    }
  });

  it("renders exactly the bytes committed under corpus/ by an earlier run", () => {
    // The file LIST is compared before the contents so that a table added
    // without regenerating, or a stale file left behind by a rename, fails as
    // itself rather than as a confusing content mismatch on some other file.
    expect(committedFiles()).toEqual(renderedNames);
    for (const [name, contents] of rendered) {
      expectSameBytes(readFileSync(join(COMMITTED_CORPUS_DIR, name), "utf8"), contents, name);
    }
  });

  it("generates identically with the global RNG and the clock poisoned", () => {
    const realRandom = Math.random;
    const realNow = Date.now;
    Math.random = (): number => {
      throw new Error("the corpus generator must not read the global RNG");
    };
    Date.now = (): number => {
      throw new Error("the corpus generator must not read the wall clock");
    };
    try {
      const poisoned = renderCorpusFiles(generateCorpus());
      for (const [name, contents] of rendered) {
        expectSameBytes(poisoned.get(name) as string, contents, name);
      }
    } finally {
      Math.random = realRandom;
      Date.now = realNow;
    }
  });

  it("reaches no ambient source of state in any fake-instance source", () => {
    // Comment lines are stripped before scanning. The banned tokens are named in
    // the docstrings that explain why they are banned, and a guard that forbids
    // documenting its own subject buys purity with ignorance.
    //
    // The stripper is line-prefix based rather than a real tokenizer on purpose.
    // A tokenizer has to tell the `/` that opens a comment from the `/` that
    // opens a regex literal — corpus.ts contains both — and getting that wrong
    // silently WIDENS the blind spot. A line-prefix rule can only ever be too
    // strict, which fails loudly and is fixed by moving a trailing comment onto
    // its own line.
    const stripComments = (source: string): string =>
      source
        .split("\n")
        .filter((line) => {
          const trimmed = line.trimStart();
          return !(trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"));
        })
        .join("\n");

    // `node:fs` is imported by corpus.ts and IS allowed: reading a committed
    // corpus and writing a regenerated one are both outside the generation path.
    // What is forbidden is anything that could vary between two runs given the
    // same seed.
    const forbidden = [
      "Math.random",
      "Date.now",
      "new Date()",
      "randomUUID",
      "randomBytes",
      "randomInt",
      "hrtime",
      "performance.now",
      "process.env",
      "process.cwd",
      "tmpdir",
      "homedir",
    ];
    const sources = readdirSync(SOURCE_DIR)
      .filter((entry) => entry.endsWith(".ts"))
      .sort();

    // Guard against a vacuous pass: an empty or shrunken file list would satisfy
    // every assertion below while checking nothing.
    expect(sources).toEqual([
      "client.ts",
      "corpus.ts",
      "index.ts",
      "prng.ts",
      "query.ts",
      "server.ts",
      "tableState.ts",
    ]);

    for (const file of sources) {
      const code = stripComments(readFileSync(join(SOURCE_DIR, file), "utf8"));
      for (const token of forbidden) {
        expect({ file, token, present: code.includes(token) }).toEqual({ file, token, present: false });
      }
    }
  });

  it("declares no module-level mutable binding in the generation modules", () => {
    // A module-scoped `let` is state that outlives a call, which is precisely
    // how run N+1 comes to differ from run N. Class fields in server.ts are
    // per-instance and therefore not in scope here.
    for (const file of ["prng.ts", "corpus.ts", "query.ts", "tableState.ts"]) {
      const offenders = readFileSync(join(SOURCE_DIR, file), "utf8")
        .split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => /^(?:export\s+)?(?:let|var)\s/.test(line))
        .map(({ line, number }) => `${file}:${number}: ${line.trim()}`);
      expect(offenders).toEqual([]);
    }
  });

  it("threads the seed: a different seed yields different bytes", () => {
    // Without this, a generator that ignored its seed argument entirely would
    // pass every determinism assertion above — perfectly reproducible, and
    // reproducibly insensitive to the one input it has.
    const other = renderCorpusFiles(generateCorpus(DEFAULT_CORPUS_SEED + 1));
    expect([...other.keys()].sort()).toEqual(renderedNames);
    const changed = renderedNames.filter((name) => other.get(name) !== rendered.get(name));
    expect(changed).toContain("MANIFEST.json");
    expect(changed).toContain("tables/sys_script.json");
  });

  it("round-trips through the on-disk format without loss", () => {
    // §5.14 allows the generator to be replaced later by a sanitized recording
    // of a real instance. That swap is only safe if what the loader returns
    // re-renders to the bytes it was loaded from.
    const reRendered = renderCorpusFiles(loadCommittedCorpus());
    expect([...reRendered.keys()].sort()).toEqual(renderedNames);
    for (const [name, contents] of rendered) {
      expectSameBytes(reRendered.get(name) as string, contents, name);
    }
  });

  it("prunes table files a later render no longer produces", () => {
    const scratch = mkdtempSync(join(tmpdir(), "syncrona-fake-corpus-"));
    try {
      writeCorpusFiles(scratch, rendered);
      writeFileSync(join(scratch, "tables", "x_syn_stale.json"), "{}\n", "utf8");
      // A renamed or deleted table leaves its old file behind, and the loader
      // globs the directory rather than reading the manifest's table list — so
      // the stale file would be LOADED and SERVED. This is the one drift the
      // byte comparison cannot see, because it only compares files that exist on
      // both sides; the writer has to delete it.
      writeCorpusFiles(scratch, rendered);
      expect(readdirSync(join(scratch, "tables")).sort()).toEqual(
        renderedNames
          .filter((name) => name.startsWith("tables/"))
          .map((name) => name.slice("tables/".length))
      );

      const loaded = loadCorpusFromDirectory(scratch);
      expect(loaded.seed).toBe(DEFAULT_CORPUS_SEED);
      expect(loaded.formatVersion).toBe(CORPUS_FORMAT_VERSION);
      expect(loaded.tables.map((table) => table.name)).toEqual(
        loadCommittedCorpus().tables.map((table) => table.name)
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("commits the manifest digests the table files actually hash to", () => {
    const manifest = JSON.parse(readFileSync(join(COMMITTED_CORPUS_DIR, "MANIFEST.json"), "utf8")) as {
      formatVersion: number;
      seed: number;
      tables: Array<{ name: string; rowCount: number; materialized: boolean; sha256: string }>;
      attachmentCount: number;
    };
    expect(manifest.formatVersion).toBe(CORPUS_FORMAT_VERSION);
    expect(manifest.seed).toBe(DEFAULT_CORPUS_SEED);

    const corpus = loadCommittedCorpus();
    expect(manifest.tables.map((entry) => entry.name)).toEqual(corpus.tables.map((table) => table.name));
    expect(manifest.attachmentCount).toBe(corpus.attachments.length);

    for (const entry of manifest.tables) {
      const bytes = readFileSync(join(COMMITTED_CORPUS_DIR, `tables/${entry.name}.json`));
      // Recomputing the digest is what makes the manifest worth committing: a
      // truncated or half-written corpus file fails here, by name, instead of
      // three work packages later as an inexplicable missing record.
      expect({ name: entry.name, sha256: createHash("sha256").update(bytes).digest("hex") }).toEqual({
        name: entry.name,
        sha256: entry.sha256,
      });
      const table = tableOf(corpus, entry.name);
      expect(entry.materialized).toBe(table.synthetic === null);
      expect(entry.rowCount).toBe(table.synthetic ? table.synthetic.rowCount : table.rows.length);
    }
  });
});

describe("fixture corpus content (§5.14 required hazards)", () => {
  const corpus = generateCorpus();
  const bySysId = new Map(corpus.tables.map((table) => [table.sysId, table] as const));
  const wire = wireColumnsByTable(corpus);

  it("carries a multi-level inheritance chain", () => {
    const leaf = tableOf(corpus, "sys_hub_flow_snapshot");
    const middle = tableOf(corpus, "sys_hub_flow_base");
    const root = tableOf(corpus, "sys_metadata");
    expect(leaf.superClass).toBe(middle.sysId);
    expect(middle.superClass).toBe(root.sysId);
    expect(root.superClass).toBeNull();

    // D21: the wire shape is the UNION over the chain, not the leaf's own
    // columns. M13/P3 measured exactly this ratio — two own columns, thirteen
    // fields on the wire — and it is why a catalog built from `sys_dictionary`
    // rows alone silently under-projects every leaf table on the instance.
    const elements = (wire.get("sys_hub_flow_snapshot") ?? []).map((column) => column.element);
    expect(leaf.columns).toHaveLength(2);
    expect(elements).toEqual(expect.arrayContaining(["snapshot", "internal_name", "sys_class_name", "sys_scope"]));
    expect(elements.length).toBeGreaterThan(12);
  });

  it("carries a table whose super_class chain is broken", () => {
    const orphan = tableOf(corpus, "x_syn_demo_orphan");
    expect(orphan.superClass).not.toBeNull();
    expect(bySysId.has(orphan.superClass as string)).toBe(false);
    // The walk must terminate rather than throw or loop: a real instance serves
    // such a table without complaint, so the mirror has to as well.
    const resolved = resolveWireColumns(orphan, bySysId).map((column) => column.element);
    expect(resolved).toEqual(orphan.columns.map((column) => column.element));
  });

  it("carries empty tables from two different causes", () => {
    expect(tableOf(corpus, "x_syn_demo_empty").rows).toEqual([]);
    expect(tableOf(corpus, "sys_metadata").rows).toEqual([]);
  });

  it("carries a table above the 16 000-row fanout threshold without materializing it", () => {
    const bulk = tableOf(corpus, BULK_TABLE_NAME);
    expect(bulk.synthetic).not.toBeNull();
    expect(bulk.synthetic?.rowCount).toBe(BULK_TABLE_ROW_COUNT);
    expect(BULK_TABLE_ROW_COUNT).toBeGreaterThan(16_000);
    // The committed file holds the row COUNT and the row SEED, not the rows:
    // ~10 MB of JSON would have to be reviewed on every regeneration otherwise.
    // The server still serves all 24 000, so this is a decision about the size
    // of the repository, not a claim about the size of the table.
    expect(bulk.rows).toEqual([]);
    const committed = readFileSync(join(COMMITTED_CORPUS_DIR, `tables/${BULK_TABLE_NAME}.json`), "utf8");
    expect(committed.length).toBeLessThan(20_000);
  });

  it("carries records with extracted fields", () => {
    const script = rowNamed(tableOf(corpus, "sys_script"), "Validate Assignment Group");
    // §5.6 extracts a script column into its own file. A one-line value would
    // let a broken extractor look correct, so the fixture is multi-line.
    expect(script.script).toContain("\n");
    expect(script.script.split("\n").length).toBeGreaterThan(3);
  });

  it("carries a parseable JSON blob and an unparseable one (F6)", () => {
    const snapshots = tableOf(corpus, "sys_hub_flow_snapshot");
    const good = rowNamed(snapshots, "Incident Intake v1");
    expect(() => JSON.parse(good.snapshot)).not.toThrow();

    const broken = rowNamed(snapshots, "Broken Snapshot");
    expect(() => JSON.parse(broken.snapshot)).toThrow();
    // Non-empty matters: F6 says an unparseable blob is preserved verbatim
    // behind `raw:`, and an empty string is preserved by every implementation
    // including a wrong one.
    expect(broken.snapshot.length).toBeGreaterThan(10);
  });

  it("carries a password2 ciphertext of the measured length (M10/D19)", () => {
    const source = tableOf(corpus, "sys_update_set_source");
    expect(source.rows.length).toBeGreaterThan(0);
    for (const row of source.rows) {
      // 106 characters is what M10 measured, and the length is the load-bearing
      // part: a redaction test asserting only "the value changed" would pass
      // against a 4-character placeholder, i.e. against a truncating bug.
      expect(row.password).toHaveLength(106);
      // Base64 alphabet after the `FAKE-` prefix, which is spent from the 106
      // rather than added to it. The prefix is asserted rather than tolerated:
      // it is what keeps a committed 106-character blob distinguishable from a
      // leaked one, in a file that cannot carry a `gitleaks:allow` comment.
      expect(row.password).toMatch(/^FAKE-[A-Za-z0-9+/]{101}$/);
    }
  });

  it("carries Unicode names and a name over MAX_NAME_BYTES", () => {
    const names = tableOf(corpus, "sys_script").rows.map((row) => row.name);
    expect(names).toContain("Създай инцидент");
    expect(names).toContain("日本語スクリプト");
    expect(names).toContain("Incident / Problem Link");

    // D18/§11: MAX_NAME_BYTES is 200 UTF-8 BYTES. The overlong fixture is
    // Cyrillic on purpose — it is under 200 characters and over 200 bytes, so a
    // length check written against `String.length` passes it and ext4 rejects it.
    const overlong = names.find((name) => Buffer.byteLength(name, "utf8") > 200);
    expect(overlong).toBeDefined();
    expect((overlong as string).length).toBeLessThan(200);
  });

  it("carries names that collide case-insensitively and under NFC", () => {
    const names = tableOf(corpus, "sys_script").rows.map((row) => row.name);
    const lowered = names.map((name) => name.toLowerCase());
    const caseCollisions = lowered.filter((name, index) => lowered.indexOf(name) !== index);
    expect(caseCollisions).toContain("set priority");

    // The NFC/NFD pair: distinct code point sequences, identical after
    // normalization. Asserted on lengths as well as identity, because on screen
    // the two names are the same picture.
    const nfcPair = names.filter((name) => name.normalize("NFC") === "Café Menu Extract".normalize("NFC"));
    expect(nfcPair).toHaveLength(2);
    expect(nfcPair[0]).not.toBe(nfcPair[1]);
    expect(new Set(nfcPair.map((name) => name.normalize("NFC"))).size).toBe(1);
    expect(new Set(nfcPair.map((name) => name.length)).size).toBe(2);
  });

  it("declares a column that never appears on the wire (F5)", () => {
    const uiAction = tableOf(corpus, "sys_ui_action");
    const declared = uiAction.columns.map((column) => column.element);
    expect(declared).toContain("hint");
    expect((wire.get("sys_ui_action") ?? []).map((column) => column.element)).not.toContain("hint");
    for (const row of uiAction.rows) {
      expect(Object.keys(row)).not.toContain("hint");
    }
    // The dictionary still lists it, because that is what makes the mismatch
    // reachable: a projection built from sys_dictionary asks for a field the
    // Table API will never return.
    const dictionary = tableOf(corpus, "sys_dictionary").rows;
    expect(dictionary.some((row) => row.name === "sys_ui_action" && row.element === "hint")).toBe(true);
  });

  it("carries a table with no sys_scope at all (M11)", () => {
    const elements = (wire.get("sys_choice") ?? []).map((column) => column.element);
    expect(elements).not.toContain("sys_scope");
    expect(elements).not.toContain("sys_package");
    expect(tableOf(corpus, "sys_choice").rows.length).toBeGreaterThan(0);
  });

  it("stores every value as a string, empty rather than absent (M8)", () => {
    for (const table of corpus.tables) {
      const elements = [...new Set((wire.get(table.name) ?? []).map((column) => column.element))].sort();
      for (const row of table.rows) {
        for (const value of Object.values(row)) {
          expect(typeof value).toBe("string");
        }
        // Every wire column present on every row: a consumer must never be able
        // to distinguish "unset" from "absent", because the platform does not
        // offer that distinction. This doubles as a self-consistency check on
        // the four hand-built catalog tables.
        expect(Object.keys(row).sort()).toEqual(elements);
      }
    }
  });

  it("formats every timestamp the way the platform does (M9)", () => {
    const pattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    for (const table of corpus.tables) {
      for (const row of table.rows) {
        expect(row.sys_created_on).toMatch(pattern);
        expect(row.sys_updated_on).toMatch(pattern);
        // Lexicographic ordering is only meaningful because of that format;
        // the watermark comparisons in query.ts depend on it holding.
        expect(row.sys_updated_on >= row.sys_created_on).toBe(true);
      }
    }
  });

  it("describes its own attachments, including one over the LFS threshold", () => {
    expect(corpus.attachments).toHaveLength(2);
    expect(corpus.attachments.some((item) => item.sizeBytes > 262_144)).toBe(true);

    for (const attachment of corpus.attachments) {
      const bytes = synthesizeAttachmentBytes(attachment.contentSeed, attachment.sizeBytes);
      expect(bytes).toHaveLength(attachment.sizeBytes);
      // Regenerating the body must reproduce the committed digest, or the
      // attachment route would serve bytes no consumer could verify.
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(attachment.sha256);
      const again = synthesizeAttachmentBytes(attachment.contentSeed, attachment.sizeBytes);
      expect(Buffer.from(bytes).equals(Buffer.from(again))).toBe(true);
    }

    const rows = tableOf(corpus, "sys_attachment").rows;
    expect(rows).toHaveLength(corpus.attachments.length);
    for (const attachment of corpus.attachments) {
      const row = rows.find((entry) => entry.sys_id === attachment.sysId);
      expect(row?.hash).toBe(attachment.sha256);
      expect(row?.size_bytes).toBe(String(attachment.sizeBytes));
      expect(row?.table_name).toBe(attachment.tableName);
      expect(row?.table_sys_id).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("derives a catalog that agrees with the corpus it describes", () => {
    const objects = tableOf(corpus, "sys_db_object").rows;
    expect(objects.map((row) => row.name).sort()).toEqual(corpus.tables.map((table) => table.name).sort());
    for (const table of corpus.tables) {
      const row = objects.find((entry) => entry.name === table.name);
      expect(row?.sys_id).toBe(table.sysId);
      expect(row?.super_class).toBe(table.superClass ?? "");
    }

    const dictionary = tableOf(corpus, "sys_dictionary").rows;
    const declared = corpus.tables.reduce((total, table) => total + table.columns.length, 0);
    expect(dictionary).toHaveLength(declared);
    // INV-6: every sys_id in the corpus is 32 lowercase hex, including the
    // derived ones — an identifier that fails SYS_ID_RE would be rejected as a
    // keyset cursor and stall a sweep on page one.
    for (const table of corpus.tables) {
      expect(table.sysId).toMatch(/^[0-9a-f]{32}$/);
      for (const row of table.rows) {
        expect(row.sys_id).toMatch(/^[0-9a-f]{32}$/);
      }
    }
  });

  it("keeps every table's rows sorted and unique by sys_id", () => {
    // The server's keyset fast path binary-searches this array, and `page()`
    // trusts the order rather than re-sorting. An unsorted corpus would make
    // paging silently skip rows in a way no other assertion here would catch.
    for (const table of corpus.tables) {
      const ids = table.rows.map((row) => row.sys_id);
      expect(ids).toEqual([...ids].sort());
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
