// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `coverage.json` — WP-M8, §5.11, §4.4.
 *
 * The report is the mirror's only self-description, and every test below targets
 * one of the four ways that description can lie:
 *
 *  - *Claiming success it did not have.* R1's exit code is what CI branches on, so
 *    it is derived here rather than accepted, and the three codes each get a test
 *    against the table rows that must produce them.
 *  - *Claiming consistency it did not prove.* D1's `quiescent` is `boolean | null`
 *    and the `null` is the whole point: "not checked" and "checked and it moved"
 *    are different claims about the instance. All three verdicts are asserted, and
 *    so is the case where the pre-reading exists but the post-reading never
 *    arrived.
 *  - *Dropping a field without saying so.* D7 requires that a field missing from
 *    the tree always have a stated cause. The enumeration tests check that all
 *    three mechanisms are represented and that the built-in rule is stated once,
 *    globally, rather than repeated per table.
 *  - *Churning.* The file is COMMITTED. Two runs over an unchanged instance must
 *    produce identical bytes apart from the timestamps and the sweep id (INV-1) —
 *    including when the sweep visited the tables in a different order — and the
 *    bytes must obey §8, which is why they go through `canonicalJsonBytes` and the
 *    `WriterFs` seam rather than `JSON.stringify` and `node:fs`.
 *
 * The in-memory filesystem refuses to write into a directory nobody made, the way
 * `open(2)` does, so a writer that forgot its `makeDir` fails here instead of
 * passing against a forgiving fake.
 */
import { sep } from "node:path";

import {
  COVERAGE_REL_PATH,
  buildCoverageReport,
  writeCoverageReport,
  writeMirrorReport,
  type CoverageReportInputs,
} from "../src/report/coverageReport";
import { MIRROR_REPORT_REL_PATH } from "../src/report/reportMarkdown";
import type { TableSuppressions } from "../src/catalog/catalogService";
import { NOISE_ELEMENTS } from "../src/catalog/fieldPolicy";
import type {
  CoverageSuppression,
  QuiescenceReading,
  SyncPlan,
  TableCoverage,
} from "../src/contracts";
import { isStagingName } from "../src/write/atomicWrite";
import type { WriterDirEntry, WriterFs } from "../src/write/fs";

const ROOT = `${sep}mirror-root`;
const COVERAGE_NATIVE = `${ROOT}${sep}${COVERAGE_REL_PATH}`;
const REPORT_NATIVE = `${ROOT}${sep}${MIRROR_REPORT_REL_PATH}`;
const STARTED_AT = "2026-08-18T09:00:00.000Z";
const FINISHED_AT = "2026-08-18T09:14:22.000Z";

// ---------------------------------------------------------------------------
// In-memory filesystem
// ---------------------------------------------------------------------------

function parentOf(nativePath: string): string {
  const index = nativePath.lastIndexOf(sep);
  return index <= 0 ? sep : nativePath.slice(0, index);
}

class MemoryFs implements WriterFs {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();
  readonly calls: string[] = [];

  async makeDir(dir: string): Promise<void> {
    this.calls.push(`makeDir ${dir}`);
    const parts = dir.split(sep);
    for (let depth = parts.length; depth > 0; depth -= 1) {
      const candidate = parts.slice(0, depth).join(sep);
      if (candidate !== "") {
        this.dirs.add(candidate);
      }
    }
  }

  async writeFile(filePath: string, bytes: Uint8Array): Promise<void> {
    this.calls.push(`writeFile ${filePath}`);
    if (!this.dirs.has(parentOf(filePath))) {
      throw new Error(`ENOENT: no directory holds ${filePath}`);
    }
    this.files.set(filePath, new Uint8Array(bytes));
  }

  async rename(from: string, to: string): Promise<void> {
    this.calls.push(`rename ${from} -> ${to}`);
    const bytes = this.files.get(from);
    if (bytes === undefined) {
      throw new Error(`ENOENT: nothing to rename at ${from}`);
    }
    this.files.delete(from);
    this.files.set(to, bytes);
  }

  async readFile(filePath: string): Promise<Uint8Array | null> {
    const bytes = this.files.get(filePath);
    return bytes === undefined ? null : new Uint8Array(bytes);
  }

  async readDir(dir: string): Promise<WriterDirEntry[] | null> {
    if (!this.dirs.has(dir)) {
      return null;
    }
    const entries: WriterDirEntry[] = [];
    for (const filePath of this.files.keys()) {
      if (parentOf(filePath) === dir) {
        entries.push({ name: filePath.slice(dir.length + sep.length), isDirectory: false });
      }
    }
    return entries;
  }

  async removeRecursive(target: string): Promise<void> {
    this.calls.push(`removeRecursive ${target}`);
    this.files.delete(target);
  }

  textAt(nativePath: string): string | null {
    const bytes = this.files.get(nativePath);
    return bytes === undefined ? null : new TextDecoder("utf-8").decode(bytes);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function planOf(overrides: Partial<SyncPlan> = {}): SyncPlan {
  return { sweepId: "sweep-7f3a", mode: "full", tables: [], ...overrides };
}

function coverageOf(overrides: Partial<TableCoverage> = {}): TableCoverage {
  return { status: "complete", expectedRows: 3, mirroredRows: 3, ...overrides };
}

function inputsOf(overrides: Partial<CoverageReportInputs> = {}): CoverageReportInputs {
  return {
    plan: planOf(),
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    tables: { sys_script_include: coverageOf() },
    tablesDiscovered: 12,
    redactions: 0,
    ...overrides,
  };
}

function reading(count: number, maxUpdatedOn: string | null): QuiescenceReading {
  return { count, maxUpdatedOn };
}

function suppressionsFor(table: string, overrides: Partial<TableSuppressions> = {}): TableSuppressions {
  return { table, engineNoise: [], userIgnored: [], denied: [], ...overrides };
}

/** The suppression rows for one source, as `table/field` strings, for readable assertions. */
function rowsFromSource(
  suppressions: readonly CoverageSuppression[],
  source: CoverageSuppression["source"]
): string[] {
  return suppressions
    .filter((entry) => entry.source === source)
    .map((entry) => `${entry.table}/${entry.field}`);
}

// ---------------------------------------------------------------------------
// R1 — the exit code is derived from what the run achieved
// ---------------------------------------------------------------------------

describe("coverage report exit code (R1)", () => {
  it("reports 0 when every table completed", () => {
    const report = buildCoverageReport(
      inputsOf({
        tables: {
          sys_script_include: coverageOf(),
          sys_ui_policy: coverageOf({ expectedRows: 0, mirroredRows: 0 }),
        },
      })
    );
    expect(report.exitCode).toBe(0);
  });

  it("reports 0 when a table was skipped on purpose", () => {
    // `excluded-config`, `excluded-tier` and `not-exportable` are the operator's
    // own decisions. A run that did exactly what it was configured to do is
    // complete, and grading it as a degradation would train CI to ignore code 2.
    const report = buildCoverageReport(
      inputsOf({
        tables: {
          sys_script_include: coverageOf(),
          sys_attachment: coverageOf({
            status: "skipped",
            reason: "excluded-config",
            expectedRows: null,
            mirroredRows: 0,
          }),
        },
      })
    );
    expect(report.exitCode).toBe(0);
  });

  it("reports 2 when a table is partial (F3)", () => {
    const report = buildCoverageReport(
      inputsOf({
        tables: {
          sys_script_include: coverageOf(),
          sys_user: coverageOf({ status: "partial", reason: "acl-403", mirroredRows: 1 }),
        },
      })
    );
    expect(report.exitCode).toBe(2);
  });

  it("reports 2 when a table failed but the sweep carried on (F1)", () => {
    // F1's retries exhaust and the TABLE fails; the taxonomy still grades the run
    // 2, because the rest of the mirror is whole and worth committing.
    const report = buildCoverageReport(
      inputsOf({
        tables: {
          sys_script_include: coverageOf(),
          sys_email: coverageOf({
            status: "failed",
            reason: "transient-exhausted",
            mirroredRows: 0,
          }),
        },
      })
    );
    expect(report.exitCode).toBe(2);
  });

  it("reports 1 when a table's reason says the instance was gone (F4)", () => {
    const report = buildCoverageReport(
      inputsOf({
        tables: {
          sys_script_include: coverageOf(),
          sys_user: coverageOf({
            status: "failed",
            reason: "instance-unreachable",
            expectedRows: null,
            mirroredRows: 0,
          }),
        },
      })
    );
    expect(report.exitCode).toBe(1);
  });

  it("reports 1 for a fatal class that leaves no table row at all (F2, F8)", () => {
    // The taxonomy's coverage column is empty for auth expiry and for local disk
    // failure: neither is a statement about a table. Without the `fatal` input an
    // ENOSPC mid-flush would produce a report of complete tables and exit 0 — a
    // run that lost the rest of the instance claiming it mirrored all it tried.
    for (const fatal of ["auth", "unreachable", "hibernating", "local-io"] as const) {
      const report = buildCoverageReport(inputsOf({ fatal }));
      expect(report.exitCode).toBe(1);
    }
  });

  it("does not treat a per-table failure class as a fatal stop", () => {
    // `transient` ends a TABLE, never the run (F1). A caller passing it here is
    // describing the last thing that went wrong, not a reason to stop.
    const report = buildCoverageReport(
      inputsOf({
        fatal: "transient",
        tables: {
          sys_email: coverageOf({ status: "failed", reason: "transient-exhausted", mirroredRows: 0 }),
        },
      })
    );
    expect(report.exitCode).toBe(2);
  });

  it("lets a fatal stop outrank a merely partial table", () => {
    const report = buildCoverageReport(
      inputsOf({
        fatal: "local-io",
        tables: { sys_user: coverageOf({ status: "partial", reason: "acl-403", mirroredRows: 1 }) },
      })
    );
    expect(report.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// D1 — quiescence is tri-state and only ever proven
// ---------------------------------------------------------------------------

describe("quiescence verdict (D1)", () => {
  it("is null when --verify-quiescent was never requested", () => {
    // Not `false`. §7 rule 3 says quiescence is only ever proven; a boolean
    // defaulting to false would let an unchecked run read as a disproven one.
    const report = buildCoverageReport(inputsOf());
    expect(report.quiescent).toBeNull();
  });

  it("is true when every table's count and change stamp were identical either side", () => {
    const report = buildCoverageReport(
      inputsOf({
        plan: planOf({
          preQuiescence: {
            sys_script_include: reading(3, "2026-08-18T08:00:00Z"),
            sys_user: reading(0, null),
          },
        }),
        postQuiescence: {
          sys_script_include: reading(3, "2026-08-18T08:00:00Z"),
          sys_user: reading(0, null),
        },
      })
    );
    expect(report.quiescent).toBe(true);
  });

  it("is false when a row count moved under the sweep", () => {
    const report = buildCoverageReport(
      inputsOf({
        plan: planOf({ preQuiescence: { sys_script_include: reading(3, "2026-08-18T08:00:00Z") } }),
        postQuiescence: { sys_script_include: reading(4, "2026-08-18T08:00:00Z") },
      })
    );
    expect(report.quiescent).toBe(false);
  });

  it("is false when only the latest change stamp moved", () => {
    // An update in place leaves the count alone. Comparing counts only would miss
    // every edit that is not an insert or a delete, which is most of them.
    const report = buildCoverageReport(
      inputsOf({
        plan: planOf({ preQuiescence: { sys_script_include: reading(3, "2026-08-18T08:00:00Z") } }),
        postQuiescence: { sys_script_include: reading(3, "2026-08-18T09:10:00Z") },
      })
    );
    expect(report.quiescent).toBe(false);
  });

  it("is false when a table appears or vanishes between the two readings", () => {
    // A table that exists on one side only is the instance changing under the
    // sweep in the most literal sense. Both directions are checked because the
    // comparison spans the union of the two key sets, not either one alone.
    const appeared = buildCoverageReport(
      inputsOf({
        plan: planOf({ preQuiescence: { sys_script_include: reading(3, null) } }),
        postQuiescence: {
          sys_script_include: reading(3, null),
          x_acme_thing: reading(1, "2026-08-18T09:05:00Z"),
        },
      })
    );
    const vanished = buildCoverageReport(
      inputsOf({
        plan: planOf({
          preQuiescence: {
            sys_script_include: reading(3, null),
            x_acme_thing: reading(1, "2026-08-18T09:05:00Z"),
          },
        }),
        postQuiescence: { sys_script_include: reading(3, null) },
      })
    );
    expect(appeared.quiescent).toBe(false);
    expect(vanished.quiescent).toBe(false);
  });

  it("is null when the check was requested but the re-read never happened", () => {
    // The run ended before the post-sweep Aggregate. No comparison took place, and
    // "the instance moved" is a positive claim that needs one.
    const report = buildCoverageReport(
      inputsOf({
        plan: planOf({ preQuiescence: { sys_script_include: reading(3, null) } }),
      })
    );
    expect(report.quiescent).toBeNull();
  });

  it("does not mistake an inherited Object property for a table reading", () => {
    // `pre["constructor"]` on a plain object resolves up the prototype chain, so
    // an index-access implementation would find a function where a reading should
    // be and report a table nobody read as unchanged.
    const report = buildCoverageReport(
      inputsOf({
        plan: planOf({ preQuiescence: { constructor: reading(2, null) } }),
        postQuiescence: { toString: reading(2, null) },
      })
    );
    expect(report.quiescent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D7 — every suppression is enumerated, with its cause
// ---------------------------------------------------------------------------

describe("suppression enumeration (D7)", () => {
  it("states the built-in noise rule once, globally", () => {
    // The rule is keyed on the column name, not the table, so repeating it per
    // table would add the same three rows a few thousand times to a committed file
    // and re-order them whenever the table set changed.
    const report = buildCoverageReport(
      inputsOf({
        suppressions: [
          suppressionsFor("sys_script_include", { engineNoise: [...NOISE_ELEMENTS] }),
          suppressionsFor("sys_ui_policy", { engineNoise: [...NOISE_ELEMENTS] }),
        ],
      })
    );
    expect(rowsFromSource(report.suppressions, "builtin-noise")).toEqual(
      [...NOISE_ELEMENTS].map((field) => `*/${field}`).sort()
    );
  });

  it("enumerates the built-in noise rule even when no table was mirrored", () => {
    // The rule is active for the run, not for a table. A report with no rows still
    // has to explain why `sys_updated_on` is nowhere in the tree.
    const report = buildCoverageReport(inputsOf({ tables: {} }));
    expect(rowsFromSource(report.suppressions, "builtin-noise")).toHaveLength(NOISE_ELEMENTS.size);
  });

  it("keeps a per-table engine suppression that the global rule does not cover", () => {
    // Otherwise it would be a field absent from the tree with no stated cause,
    // which is the single outcome D7 exists to forbid.
    const report = buildCoverageReport(
      inputsOf({
        suppressions: [
          suppressionsFor("sys_script_include", {
            engineNoise: ["sys_updated_on", "sys_journal_field"],
          }),
        ],
      })
    );
    expect(rowsFromSource(report.suppressions, "builtin-noise")).toContain(
      "sys_script_include/sys_journal_field"
    );
  });

  it("tags user config and field-type denies with their own sources", () => {
    const report = buildCoverageReport(
      inputsOf({
        suppressions: [
          suppressionsFor("sys_user", {
            engineNoise: ["sys_updated_on"],
            userIgnored: ["last_login_time", "failed_attempts"],
            denied: ["user_password"],
          }),
        ],
      })
    );
    expect(rowsFromSource(report.suppressions, "config-ignore")).toEqual([
      "sys_user/failed_attempts",
      "sys_user/last_login_time",
    ]);
    expect(rowsFromSource(report.suppressions, "redaction-deny")).toEqual([
      "sys_user/user_password",
    ]);
  });

  it("sorts by table, then field, then source, and never repeats a row", () => {
    // Catalog order is a scheduling decision; committing it would make the file
    // churn whenever the planner's ordering changed (INV-1). The duplicate table
    // entry stands in for a caller that accumulates suppressions per shard flush.
    const report = buildCoverageReport(
      inputsOf({
        suppressions: [
          suppressionsFor("sys_user", { userIgnored: ["zeta", "alpha"], denied: ["alpha"] }),
          suppressionsFor("sys_script_include", { userIgnored: ["beta"] }),
          suppressionsFor("sys_user", { userIgnored: ["alpha"] }),
        ],
      })
    );
    const keys = report.suppressions.map(
      (entry) => `${entry.table}|${entry.field}|${entry.source}`
    );
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
    // `alpha` on `sys_user` is suppressed by two different mechanisms, and both
    // are stated: removing the config rule would still leave the type deny.
    expect(keys).toContain("sys_user|alpha|config-ignore");
    expect(keys).toContain("sys_user|alpha|redaction-deny");
  });

  it("sorts the global rules ahead of every table's", () => {
    // `*` is U+002A, below every letter a table name can start with, so the
    // globals land at the top of the committed file where a reader looks first.
    const report = buildCoverageReport(
      inputsOf({ suppressions: [suppressionsFor("sys_user", { userIgnored: ["last_login_time"] })] })
    );
    expect(report.suppressions[0].table).toBe("*");
    expect(report.suppressions[report.suppressions.length - 1].table).toBe("sys_user");
  });
});

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

describe("coverage totals", () => {
  it("derives every count from the table rows rather than accepting them", () => {
    const report = buildCoverageReport(
      inputsOf({
        tablesDiscovered: 640,
        redactions: 17,
        tables: {
          sys_script_include: coverageOf({ mirroredRows: 40, danglingRefs: 2 }),
          sys_ui_policy: coverageOf({ mirroredRows: 5 }),
          sys_attachment: coverageOf({
            status: "skipped",
            reason: "excluded-config",
            expectedRows: null,
            mirroredRows: 0,
            danglingRefs: 3,
          }),
        },
      })
    );
    expect(report.totals).toEqual({
      tablesDiscovered: 640,
      // A table with zero records written is discovered and planned but not
      // mirrored — there is nothing of it in the tree to point at.
      tablesMirrored: 2,
      recordsMirrored: 45,
      redactions: 17,
      danglingRefs: 5,
    });
  });

  it("keeps the plan's identity and the injected clock verbatim", () => {
    const report = buildCoverageReport(
      inputsOf({ plan: planOf({ sweepId: "sweep-0001", mode: "incremental" }) })
    );
    expect(report.formatVersion).toBe(1);
    expect(report.sweepId).toBe("sweep-0001");
    expect(report.mode).toBe("incremental");
    expect(report.startedAt).toBe(STARTED_AT);
    expect(report.finishedAt).toBe(FINISHED_AT);
  });

  it("does not let a caller keep mutating the table map after the report exists", () => {
    // The sweep's accumulator is usually the same object that was handed in. A
    // report already written to disk must not be able to change what it claims.
    const tables: Record<string, TableCoverage> = { sys_script_include: coverageOf() };
    const report = buildCoverageReport(inputsOf({ tables }));
    tables.sys_user = coverageOf({ status: "failed", reason: "acl-403", mirroredRows: 0 });
    expect(Object.keys(report.tables)).toEqual(["sys_script_include"]);
  });
});

// ---------------------------------------------------------------------------
// §8 bytes, R4 atomicity, INV-1 stability
// ---------------------------------------------------------------------------

describe("writing coverage.json", () => {
  it("writes canonical §8 bytes at the mirror root", async () => {
    const fs = new MemoryFs();
    await writeCoverageReport(fs, ROOT, buildCoverageReport(inputsOf()));
    const text = fs.textAt(COVERAGE_NATIVE);
    expect(text).not.toBeNull();
    const contents = text as string;
    // Two-space indent, LF only, exactly one trailing newline, no BOM.
    expect(contents.startsWith('{\n  "exitCode"')).toBe(true);
    expect(contents).not.toContain("\r");
    expect(contents.endsWith("}\n")).toBe(true);
    expect(contents.endsWith("}\n\n")).toBe(false);
    expect(contents.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("sorts object keys at every nesting level (§8)", () => {
    const fs = new MemoryFs();
    return writeCoverageReport(
      fs,
      ROOT,
      buildCoverageReport(inputsOf({ tables: { sys_ui_policy: coverageOf(), aaa_table: coverageOf() } }))
    ).then(() => {
      const contents = fs.textAt(COVERAGE_NATIVE) as string;
      const topLevel = [...contents.matchAll(/^ {2}"([a-zA-Z]+)":/gm)].map((match) => match[1]);
      expect(topLevel).toEqual([...topLevel].sort());
      const tableKeys = [...contents.matchAll(/^ {4}"([a-z_]+)": \{/gm)].map((match) => match[1]);
      expect(tableKeys).toEqual(["aaa_table", "sys_ui_policy"]);
    });
  });

  it("commits through a staging sibling and a rename (R4)", async () => {
    // A half-written coverage file is a committed lie about a sweep that may have
    // gone perfectly, so there may be no window in which the path holds partial
    // bytes. The staged name is what makes the swap a single rename.
    const fs = new MemoryFs();
    await writeCoverageReport(fs, ROOT, buildCoverageReport(inputsOf()));
    const staged = fs.calls.filter((call) => call.startsWith("writeFile "));
    expect(staged).toHaveLength(1);
    const stagedPath = staged[0].slice("writeFile ".length);
    expect(isStagingName(stagedPath.slice(stagedPath.lastIndexOf(sep) + 1))).toBe(true);
    expect(fs.calls).toContain(`rename ${stagedPath} -> ${COVERAGE_NATIVE}`);
    // Nothing is left behind at the staging path once the rename lands.
    expect(fs.files.has(stagedPath)).toBe(false);
  });

  it("creates the mirror root before staging into it", async () => {
    // `atomicWriteFile` stages a sibling of the target, and a rename is only
    // atomic within one directory — so that directory has to exist first. The
    // in-memory filesystem refuses the write otherwise, the way `open(2)` does.
    const fs = new MemoryFs();
    await expect(
      writeCoverageReport(fs, ROOT, buildCoverageReport(inputsOf()))
    ).resolves.toBeUndefined();
    expect(fs.calls[0]).toBe(`makeDir ${ROOT}`);
  });

  it("produces identical bytes for a re-run apart from the timestamps and sweep id (INV-1)", async () => {
    // The mirror commit for an unchanged instance must be empty. The tables are
    // deliberately handed over in a different insertion order on the second run,
    // and the suppressions in a different sequence, because that is exactly what
    // differs between two sweeps that read the same instance.
    const first = new MemoryFs();
    const second = new MemoryFs();
    const suppressions = [
      suppressionsFor("sys_user", { userIgnored: ["last_login_time"], denied: ["user_password"] }),
      suppressionsFor("sys_script_include", { engineNoise: ["sys_updated_on"] }),
    ];
    await writeCoverageReport(
      first,
      ROOT,
      buildCoverageReport(
        inputsOf({
          tables: { sys_script_include: coverageOf(), sys_user: coverageOf({ mirroredRows: 9 }) },
          suppressions,
        })
      )
    );
    await writeCoverageReport(
      second,
      ROOT,
      buildCoverageReport(
        inputsOf({
          plan: planOf({ sweepId: "sweep-b912" }),
          startedAt: "2026-08-19T02:00:00.000Z",
          finishedAt: "2026-08-19T02:11:03.000Z",
          tables: { sys_user: coverageOf({ mirroredRows: 9 }), sys_script_include: coverageOf() },
          suppressions: [...suppressions].reverse(),
        })
      )
    );
    const normalize = (text: string): string =>
      text
        .replace(/"sweepId": "[^"]*"/, '"sweepId": "<sweep>"')
        .replace(/"startedAt": "[^"]*"/, '"startedAt": "<t>"')
        .replace(/"finishedAt": "[^"]*"/, '"finishedAt": "<t>"');
    expect(normalize(second.textAt(COVERAGE_NATIVE) as string)).toBe(
      normalize(first.textAt(COVERAGE_NATIVE) as string)
    );
    // And the three substitutions above are the ONLY differences: without them the
    // two files must actually differ, or the test proves nothing.
    expect(second.textAt(COVERAGE_NATIVE)).not.toBe(first.textAt(COVERAGE_NATIVE));
  });

  it("round-trips through JSON.parse as the §4.4 shape", async () => {
    const fs = new MemoryFs();
    const report = buildCoverageReport(
      inputsOf({ tables: { sys_user: coverageOf({ notDecomposed: ["variables"], danglingRefs: 1 }) } })
    );
    await writeCoverageReport(fs, ROOT, report);
    expect(JSON.parse(fs.textAt(COVERAGE_NATIVE) as string)).toEqual(report);
  });
});

describe("writing MIRROR-REPORT.md", () => {
  it("writes the rendered Markdown at the mirror root, atomically", async () => {
    const fs = new MemoryFs();
    await writeMirrorReport(fs, ROOT, buildCoverageReport(inputsOf()));
    const contents = fs.textAt(REPORT_NATIVE) as string;
    expect(contents.startsWith("# Mirror report\n")).toBe(true);
    expect(contents.endsWith("\n")).toBe(true);
    expect(fs.calls.some((call) => call.endsWith(`-> ${REPORT_NATIVE}`))).toBe(true);
  });

  it("writes UTF-8 without a BOM", async () => {
    const fs = new MemoryFs();
    await writeMirrorReport(fs, ROOT, buildCoverageReport(inputsOf()));
    const bytes = fs.files.get(REPORT_NATIVE) as Uint8Array;
    expect([bytes[0], bytes[1], bytes[2]]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes[0]).toBe("#".charCodeAt(0));
  });
});
