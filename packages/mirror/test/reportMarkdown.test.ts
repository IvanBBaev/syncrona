// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `MIRROR-REPORT.md` rendering — WP-M8, §5.11.
 *
 * The renderer is a pure function, so the tests are about the two ways its output
 * can be wrong rather than about how it is wired:
 *
 *  - *It can churn.* The file is COMMITTED. A `Record` iterated in insertion order
 *    renders in whatever sequence the sweep finished tables in, so the shuffle
 *    tests below build the same report twice with every collection reversed and
 *    demand identical text. That is the assertion INV-1 actually needs; asserting
 *    that one particular row sorts first would pass just as well against an
 *    implementation that preserved insertion order for a lucky fixture.
 *  - *It can lie about the consistency model.* §7 rule 1 forbids the word
 *    "snapshot" for a sync result, and the ban is grepped here rather than trusted,
 *    because the word is the natural one to reach for and a future edit will reach
 *    for it.
 *
 * There is no filesystem in this file. If a test here needs one, the rendering and
 * the I/O have grown into each other and the split in §5.11 has been lost.
 */
import { MIRROR_REPORT_REL_PATH, renderMirrorReport } from "../src/report/reportMarkdown";
import type { CoverageReport, CoverageSuppression, TableCoverage } from "../src/contracts";

function coverageOf(overrides: Partial<TableCoverage> = {}): TableCoverage {
  return { status: "complete", expectedRows: 3, mirroredRows: 3, ...overrides };
}

function reportOf(overrides: Partial<CoverageReport> = {}): CoverageReport {
  return {
    formatVersion: 1,
    sweepId: "sweep-7f3a",
    mode: "full",
    startedAt: "2026-08-18T09:00:00.000Z",
    finishedAt: "2026-08-18T09:14:22.000Z",
    quiescent: null,
    exitCode: 0,
    totals: {
      tablesDiscovered: 12,
      tablesMirrored: 1,
      recordsMirrored: 3,
      redactions: 0,
      danglingRefs: 0,
    },
    suppressions: [],
    tables: { sys_script_include: coverageOf() },
    ...overrides,
  };
}

/** The body rows of the Markdown table under `heading`, without the two header rows. */
function tableRowsUnder(text: string, heading: string): string[] {
  const section = text.slice(text.indexOf(`## ${heading}`));
  const end = section.indexOf("\n## ");
  const scoped = end === -1 ? section : section.slice(0, end);
  return scoped
    .split("\n")
    .filter((line) => line.startsWith("| "))
    .filter((line) => !line.startsWith("| ---"))
    .slice(1);
}

describe("report structure", () => {
  it("renders the four sections and ends in exactly one newline", () => {
    const text = renderMirrorReport(reportOf());
    expect(text.startsWith("# Mirror report\n")).toBe(true);
    expect(text).toContain("## Totals");
    expect(text).toContain("## Tables");
    expect(text).toContain("## Suppressed fields");
    // §8: one trailing newline. Zero turns every later diff into a two-line change
    // of the last line; two produce a diff the moment something is appended.
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).not.toContain("\r");
  });

  it("names the file the mirror repository actually commits", () => {
    expect(MIRROR_REPORT_REL_PATH).toBe("MIRROR-REPORT.md");
  });

  it("prints the sweep identity and the injected timestamps verbatim", () => {
    const text = renderMirrorReport(
      reportOf({ sweepId: "sweep-0001", mode: "reconcile", formatVersion: 1 })
    );
    expect(text).toContain("| Sweep | `sweep-0001` |");
    expect(text).toContain("| Mode | reconcile |");
    expect(text).toContain("| Started | 2026-08-18T09:00:00.000Z |");
    expect(text).toContain("| Finished | 2026-08-18T09:14:22.000Z |");
    expect(text).toContain("| Format version | 1 |");
  });

  it("prints every run-level total", () => {
    const text = renderMirrorReport(
      reportOf({
        totals: {
          tablesDiscovered: 640,
          tablesMirrored: 638,
          recordsMirrored: 412_907,
          redactions: 61,
          danglingRefs: 9,
        },
      })
    );
    // Plain digits, no thousands separator: `toLocaleString` output depends on the
    // ICU data in the Node build, so the same sweep would render differently on
    // different machines and the committed file would diff for no reason.
    expect(text).toContain("| Records mirrored | 412907 |");
    expect(text).toContain("| Tables discovered | 640 |");
    expect(text).toContain("| Tables mirrored | 638 |");
    expect(text).toContain("| Redactions | 61 |");
    expect(text).toContain("| Dangling references | 9 |");
  });

  it("explains that dangling references are counted and not repaired (D2)", () => {
    expect(renderMirrorReport(reportOf())).toContain("never repaired");
  });
});

// ---------------------------------------------------------------------------
// §7 rule 1 — the vocabulary is normative
// ---------------------------------------------------------------------------

describe("consistency vocabulary (§7 rule 1)", () => {
  it("never calls the mirrored tree a snapshot", () => {
    // A mirror commit is an OBSERVED STATE. "Snapshot" promises an atomic
    // point-in-time image the engine cannot produce - it reads table by table over
    // minutes - and a reader who believed the promise would restore an
    // inconsistent graph believing it whole. Every branch is exercised so the grep
    // covers the whole vocabulary, not just the default fixture's.
    const variants: CoverageReport[] = [
      reportOf(),
      reportOf({ quiescent: true, exitCode: 0 }),
      reportOf({ quiescent: false, exitCode: 2 }),
      reportOf({ exitCode: 1, tables: {} }),
      reportOf({
        suppressions: [{ table: "*", field: "sys_updated_on", source: "builtin-noise" }],
      }),
    ];
    for (const report of variants) {
      expect(renderMirrorReport(report).toLowerCase()).not.toContain("snapshot");
    }
  });

  it("states the observed-state caveat above the numbers", () => {
    const text = renderMirrorReport(reportOf());
    expect(text).toContain("**observed state**");
    expect(text.indexOf("observed state")).toBeLessThan(text.indexOf("## Totals"));
  });

  it("distinguishes proven, disproven and unchecked quiescence (D1)", () => {
    // Three claims, three sentences. "We did not check" must not read like "we
    // checked and it was fine", and must not read like "we checked and it moved".
    const proven = renderMirrorReport(reportOf({ quiescent: true }));
    const disproven = renderMirrorReport(reportOf({ quiescent: false }));
    const unchecked = renderMirrorReport(reportOf({ quiescent: null }));
    expect(proven).toContain("| Consistency | proven quiescent");
    expect(disproven).toContain("| Consistency | NOT quiescent");
    expect(unchecked).toContain("| Consistency | not verified");
    expect(unchecked).toContain("nothing is claimed either way");
    expect(new Set([proven, disproven, unchecked]).size).toBe(3);
  });

  it("spells out each of R1's three exit codes", () => {
    expect(renderMirrorReport(reportOf({ exitCode: 0 }))).toContain("| Exit code | 0 - complete |");
    expect(renderMirrorReport(reportOf({ exitCode: 1 }))).toContain(
      "| Exit code | 1 - fatal, the sweep stopped before it finished |"
    );
    expect(renderMirrorReport(reportOf({ exitCode: 2 }))).toContain(
      "| Exit code | 2 - completed, but some tables are partial or failed |"
    );
  });
});

// ---------------------------------------------------------------------------
// Ordering — the committed file must not churn
// ---------------------------------------------------------------------------

describe("stable ordering (INV-1)", () => {
  it("renders identically when the tables arrive in a different order", () => {
    // Two sweeps of one unchanged instance differ in exactly this: which table
    // finished first. If that reached the file, every mirror commit would carry a
    // diff nobody caused.
    const tables: Record<string, TableCoverage> = {
      sys_script_include: coverageOf(),
      sys_user: coverageOf({ mirroredRows: 9, expectedRows: 9 }),
      x_acme_widget: coverageOf({ status: "partial", reason: "acl-403", mirroredRows: 1 }),
    };
    const reversed = Object.fromEntries(Object.entries(tables).reverse());
    expect(renderMirrorReport(reportOf({ tables: reversed }))).toBe(
      renderMirrorReport(reportOf({ tables }))
    );
  });

  it("sorts table rows by name", () => {
    const text = renderMirrorReport(
      reportOf({
        tables: {
          zzz_last: coverageOf(),
          aaa_first: coverageOf(),
          mmm_middle: coverageOf(),
        },
      })
    );
    const names = tableRowsUnder(text, "Tables").map((row) => row.split(" | ")[0]);
    expect(names).toEqual(["| `aaa_first`", "| `mmm_middle`", "| `zzz_last`"]);
  });

  it("renders identically when the suppressions arrive in a different order", () => {
    const suppressions: CoverageSuppression[] = [
      { table: "*", field: "sys_updated_on", source: "builtin-noise" },
      { table: "sys_user", field: "user_password", source: "redaction-deny" },
      { table: "sys_user", field: "last_login_time", source: "config-ignore" },
    ];
    expect(renderMirrorReport(reportOf({ suppressions: [...suppressions].reverse() }))).toBe(
      renderMirrorReport(reportOf({ suppressions }))
    );
  });

  it("sorts suppression rows by table, then field, then source", () => {
    const text = renderMirrorReport(
      reportOf({
        suppressions: [
          { table: "sys_user", field: "alpha", source: "redaction-deny" },
          { table: "sys_user", field: "alpha", source: "config-ignore" },
          { table: "*", field: "sys_updated_on", source: "builtin-noise" },
          { table: "sys_script_include", field: "beta", source: "config-ignore" },
        ],
      })
    );
    const rows = tableRowsUnder(text, "Suppressed fields");
    expect(rows[0]).toContain("| `*` | `sys_updated_on` |");
    expect(rows[1]).toContain("| `sys_script_include` | `beta` |");
    // Same table, same field, two mechanisms: `config-ignore` sorts before
    // `redaction-deny`, so the pair never swaps between runs.
    expect(rows[2]).toContain("`ignoreFields`");
    expect(rows[3]).toContain("never safe to mirror");
  });

  it("sorts the not-decomposed field list inside its own cell", () => {
    const text = renderMirrorReport(
      reportOf({ tables: { sys_user: coverageOf({ notDecomposed: ["zeta", "alpha", "mid"] }) } })
    );
    expect(text).toContain("`alpha`, `mid`, `zeta`");
  });
});

// ---------------------------------------------------------------------------
// Per-table cells
// ---------------------------------------------------------------------------

describe("table rows", () => {
  it("says why a table is less than complete", () => {
    const text = renderMirrorReport(
      reportOf({
        exitCode: 2,
        tables: {
          sys_user: coverageOf({
            status: "partial",
            reason: "acl-403",
            expectedRows: 40,
            mirroredRows: 31,
            danglingRefs: 4,
          }),
        },
      })
    );
    expect(text).toContain("| `sys_user` | partial | `acl-403` | 40 | 31 | 4 | - |");
  });

  it("prints 'unknown' rather than 0 when no independent count exists", () => {
    // A null `expectedRows` means no Aggregate answered, which is a different
    // statement from "the table has no rows". Printing 0 would invite a reader to
    // compare the sweep against itself and conclude it was complete.
    const text = renderMirrorReport(
      reportOf({
        tables: {
          sys_attachment: coverageOf({
            status: "skipped",
            reason: "excluded-config",
            expectedRows: null,
            mirroredRows: 0,
          }),
        },
      })
    );
    expect(text).toContain("| `sys_attachment` | skipped | `excluded-config` | unknown | 0 | - | - |");
  });

  it("lists the blob fields a table could not decompose (D8)", () => {
    const text = renderMirrorReport(
      reportOf({ tables: { sys_ui_policy: coverageOf({ notDecomposed: ["variables"] }) } })
    );
    expect(text).toContain("| 3 | 3 | - | `variables` |");
  });

  it("uses the placeholder when a table decomposed everything", () => {
    const text = renderMirrorReport(
      reportOf({ tables: { sys_ui_policy: coverageOf({ notDecomposed: [] }) } })
    );
    expect(text).toContain("| `sys_ui_policy` | complete | - | 3 | 3 | - | - |");
  });

  it("says so plainly when there are no table outcomes at all", () => {
    // A fatal stop before the first table (F2, F8) leaves an empty map. An empty
    // Markdown table header would read as "we looked and found nothing".
    const text = renderMirrorReport(reportOf({ exitCode: 1, tables: {} }));
    expect(text).toContain("No table outcomes were recorded for this sweep.");
    expect(text).not.toContain("| Table | Status |");
  });
});

// ---------------------------------------------------------------------------
// Suppressions section
// ---------------------------------------------------------------------------

describe("suppressions section (D7)", () => {
  it("names the mechanism behind each removed field", () => {
    const text = renderMirrorReport(
      reportOf({
        suppressions: [
          { table: "*", field: "sys_updated_on", source: "builtin-noise" },
          { table: "sys_user", field: "last_login_time", source: "config-ignore" },
          { table: "sys_user", field: "user_password", source: "redaction-deny" },
        ],
      })
    );
    expect(text).toContain("built-in noise column");
    expect(text).toContain("`ignoreFields` in the mirror config");
    expect(text).toContain("field type is never safe to mirror");
    expect(text).toContain("means the rule applies to every mirrored table");
  });

  it("states that an unexplained absence is a bug", () => {
    expect(renderMirrorReport(reportOf())).toContain(
      "absent from this list is a bug, not a policy"
    );
  });

  it("says so plainly when nothing is suppressed", () => {
    const text = renderMirrorReport(reportOf({ suppressions: [] }));
    expect(text).toContain("No suppressions are active for this sweep.");
    expect(text).not.toContain("| Table | Field | Removed by |");
  });
});

// ---------------------------------------------------------------------------
// Cell escaping
// ---------------------------------------------------------------------------

describe("cell escaping", () => {
  it("escapes a pipe so a field name cannot shift the columns", () => {
    // A raw `|` ends the cell; every column after it moves left and the row still
    // renders, meaning wrong. The name arrives from a user's config file, so
    // "ServiceNow column names never contain one" is not a guarantee this module
    // gets to rely on.
    const text = renderMirrorReport(
      reportOf({
        suppressions: [{ table: "sys_user", field: "a|b", source: "config-ignore" }],
      })
    );
    expect(text).toContain("`a\\|b`");
    const rows = tableRowsUnder(text, "Suppressed fields");
    expect(rows).toHaveLength(1);
  });

  it("folds a line break into a space so one value cannot end the row", () => {
    const text = renderMirrorReport(
      reportOf({ tables: { "sys_user\nsys_evil": coverageOf() } })
    );
    expect(text).toContain("`sys_user sys_evil`");
    expect(tableRowsUnder(text, "Tables")).toHaveLength(1);
  });

  it("escapes the sweep id and the mode the same way", () => {
    const text = renderMirrorReport(reportOf({ sweepId: "sweep|x\r\ny" }));
    expect(text).toContain("| Sweep | `sweep\\|x y` |");
  });
});
