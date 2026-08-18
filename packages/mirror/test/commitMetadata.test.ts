// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * D10 — the suggested commit message (WP-M8, §5.11).
 *
 * Two things are under test. The first is the trailer block, which is the durable
 * half: it outlives the report and the log, and someone reading a five-year-old
 * commit will take it literally. The rule that matters there is that
 * `Mirror-Consistency: quiescent` appears if and only if quiescence was PROVEN
 * (§7 rule 3, D1) — the `false` and `null` cases are asserted separately, because
 * an implementation that emitted the trailer for anything other than `true` would
 * pass a test that only checked `true`.
 *
 * The second is that this module still does not commit anything. §5.11 says the
 * mirror never runs `git commit` in Phase 1; the last test pins the module's whole
 * import list so that "we shelled out to git after all" cannot arrive quietly in a
 * later change. It reads the source rather than the compiled behaviour because
 * that is the only way to assert the absence of a capability.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MIRROR_TRAILER_CONSISTENCY,
  MIRROR_TRAILER_SCOPES,
  MIRROR_TRAILER_SWEEP,
  MIRROR_TRAILER_TABLES_CHANGED,
  buildMirrorCommitMessage,
} from "../src/report/commitMetadata";
import type { CoverageReport, TableCoverage } from "../src/contracts";

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
      tablesMirrored: 2,
      recordsMirrored: 44,
      redactions: 0,
      danglingRefs: 0,
    },
    suppressions: [],
    tables: { sys_script_include: coverageOf(), sys_user: coverageOf({ mirroredRows: 41 }) },
    ...overrides,
  };
}

/** The trailer paragraph — the last block of the message, as `Key: value` lines. */
function trailersOf(message: string): string[] {
  const paragraphs = message.split("\n\n");
  return paragraphs[paragraphs.length - 1].split("\n");
}

function trailerValue(message: string, key: string): string | undefined {
  const line = trailersOf(message).find((entry) => entry.startsWith(`${key}: `));
  return line === undefined ? undefined : line.slice(key.length + 2);
}

describe("message shape", () => {
  it("is a subject, a body and a trailer paragraph", () => {
    // Git's own layout: blank line after the subject, trailers alone in the last
    // paragraph. `git interpret-trailers` only recognises them there.
    const message = buildMirrorCommitMessage({ report: reportOf() });
    const paragraphs = message.split("\n\n");
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0]).not.toContain("\n");
    expect(trailersOf(message).every((line) => /^[A-Za-z-]+: /.test(line))).toBe(true);
  });
});

describe("subject line", () => {
  it("names the read mode", () => {
    const message = buildMirrorCommitMessage({ report: reportOf({ mode: "incremental" }) });
    expect(message.split("\n")[0]).toBe("mirror(incremental): 2 tables changed");
  });

  it("uses the singular noun for one table", () => {
    const message = buildMirrorCommitMessage({
      report: reportOf(),
      changedTables: ["sys_user"],
    });
    expect(message.split("\n")[0]).toBe("mirror(full): 1 table changed");
  });

  it("uses the plural noun for none", () => {
    // A sweep that changed nothing is the normal outcome for an unchanged
    // instance, and "0 table changed" reads as a bug in the tool.
    const message = buildMirrorCommitMessage({ report: reportOf(), changedTables: [] });
    expect(message.split("\n")[0]).toBe("mirror(full): 0 tables changed");
  });
});

describe("body", () => {
  it("reports the run totals without locale-formatted numbers", () => {
    // `toLocaleString` inserts separators from the ICU data in the running Node
    // build, so the same sweep would suggest different messages on different
    // machines - the machine-dependence INV-1 keeps out of this repository.
    const message = buildMirrorCommitMessage({
      report: reportOf({
        totals: {
          tablesDiscovered: 640,
          tablesMirrored: 638,
          recordsMirrored: 412_907,
          redactions: 61,
          danglingRefs: 9,
        },
      }),
    });
    expect(message).toContain("Observed state of 638 of 640 discovered tables,");
    expect(message).toContain("412907 records, 61 redactions, 9 dangling references.");
  });

  it("calls the result an observed state, never a snapshot (§7 rule 1)", () => {
    const message = buildMirrorCommitMessage({
      report: reportOf({ quiescent: true, exitCode: 2 }),
    });
    expect(message.toLowerCase()).not.toContain("snapshot");
    expect(message).toContain("Observed state of");
  });

  it("stays silent about degradation when there is none", () => {
    const message = buildMirrorCommitMessage({ report: reportOf() });
    expect(message).not.toContain("partial,");
    expect(message).not.toContain("exit code");
  });

  it("counts the partial, failed and skipped tables when any exist", () => {
    const message = buildMirrorCommitMessage({
      report: reportOf({
        exitCode: 2,
        tables: {
          sys_script_include: coverageOf(),
          sys_user: coverageOf({ status: "partial", reason: "acl-403", mirroredRows: 1 }),
          sys_email: coverageOf({ status: "failed", reason: "transient-exhausted", mirroredRows: 0 }),
          sys_attachment: coverageOf({
            status: "skipped",
            reason: "excluded-config",
            expectedRows: null,
            mirroredRows: 0,
          }),
        },
      }),
    });
    expect(message).toContain(
      "1 partial, 1 failed, 1 skipped - see coverage.json for the reason on each."
    );
  });

  it("states a non-zero exit code in prose as well as the totals", () => {
    // Prose survives a squash or a rebase that strips trailers, and an incomplete
    // mirror is the one fact a reader must not miss.
    const fatal = buildMirrorCommitMessage({
      report: reportOf({ exitCode: 1, tables: {}, totals: { ...reportOf().totals, tablesMirrored: 0 } }),
    });
    expect(fatal).toContain("Sweep exit code 1: this mirror is not complete.");
    const partial = buildMirrorCommitMessage({
      report: reportOf({
        exitCode: 2,
        tables: { sys_user: coverageOf({ status: "partial", reason: "acl-403", mirroredRows: 1 }) },
      }),
    });
    expect(partial).toContain("Sweep exit code 2: this mirror is not complete.");
  });
});

describe("trailers", () => {
  it("ties the commit to the sweep that produced it", () => {
    const message = buildMirrorCommitMessage({ report: reportOf({ sweepId: "sweep-b912" }) });
    expect(trailerValue(message, MIRROR_TRAILER_SWEEP)).toBe("sweep-b912");
  });

  it("counts the tables the caller says changed, deduplicated", () => {
    // A caller accumulating names per shard flush would otherwise report a large
    // table once per flush and claim more tables than the instance has.
    const message = buildMirrorCommitMessage({
      report: reportOf(),
      changedTables: ["sys_user", "sys_script_include", "sys_user"],
    });
    expect(trailerValue(message, MIRROR_TRAILER_TABLES_CHANGED)).toBe("2");
  });

  it("falls back to the tables that received records when the caller cannot tell", () => {
    // The mirror re-writes every record it fetches and relies on byte-identical
    // output to keep an unchanged record out of the diff, so "changed" is a fact
    // about the git index - and this module is forbidden to ask git. The tables
    // with rows are the honest superset.
    const message = buildMirrorCommitMessage({
      report: reportOf({
        tables: {
          sys_script_include: coverageOf(),
          sys_attachment: coverageOf({
            status: "skipped",
            reason: "excluded-config",
            expectedRows: null,
            mirroredRows: 0,
          }),
        },
      }),
    });
    expect(trailerValue(message, MIRROR_TRAILER_TABLES_CHANGED)).toBe("1");
  });

  it("lists the scopes deduplicated and byte-sorted", () => {
    const message = buildMirrorCommitMessage({
      report: reportOf(),
      scopes: ["x_acme_app", "global", "x_acme_app"],
    });
    expect(trailerValue(message, MIRROR_TRAILER_SCOPES)).toBe("global,x_acme_app");
  });

  it("omits the scope trailer when nothing is known, rather than emitting it empty", () => {
    // `Mirror-Scopes:` with no value parses as a present trailer whose value is
    // the empty string, so a reader could not tell "we determined the set and it
    // is empty" from "we have no scope information".
    const absent = buildMirrorCommitMessage({ report: reportOf() });
    const empty = buildMirrorCommitMessage({ report: reportOf(), scopes: [] });
    expect(trailerValue(absent, MIRROR_TRAILER_SCOPES)).toBeUndefined();
    expect(trailerValue(empty, MIRROR_TRAILER_SCOPES)).toBeUndefined();
    expect(absent).not.toContain(`${MIRROR_TRAILER_SCOPES}:`);
  });

  it("asserts quiescence only when it was proven (D1, §7 rule 3)", () => {
    const proven = buildMirrorCommitMessage({ report: reportOf({ quiescent: true }) });
    expect(trailerValue(proven, MIRROR_TRAILER_CONSISTENCY)).toBe("quiescent");
  });

  it("makes no consistency claim when the instance was seen to move", () => {
    const moved = buildMirrorCommitMessage({ report: reportOf({ quiescent: false }) });
    expect(moved).not.toContain(`${MIRROR_TRAILER_CONSISTENCY}:`);
  });

  it("makes no consistency claim when quiescence was never checked", () => {
    // The `null` case is the dangerous one: an implementation testing for
    // "not false" would stamp a proof onto a run that proved nothing, which is
    // precisely the assumed consistency §7 rule 3 forbids.
    const unchecked = buildMirrorCommitMessage({ report: reportOf({ quiescent: null }) });
    expect(unchecked).not.toContain(`${MIRROR_TRAILER_CONSISTENCY}:`);
  });

  it("keeps the trailer order stable across runs of the same shape", () => {
    const inputs = { report: reportOf({ quiescent: true }), scopes: ["global"] };
    expect(trailersOf(buildMirrorCommitMessage(inputs))).toEqual([
      `${MIRROR_TRAILER_SWEEP}: sweep-7f3a`,
      `${MIRROR_TRAILER_TABLES_CHANGED}: 2`,
      `${MIRROR_TRAILER_SCOPES}: global`,
      `${MIRROR_TRAILER_CONSISTENCY}: quiescent`,
    ]);
  });
});

describe("the mirror does not commit (§5.11)", () => {
  it("imports nothing but the two type and ordering modules", () => {
    // Asserting the absence of a capability needs the source, not the behaviour: a
    // module that spawned `git commit` would still return the right string. The
    // prose in the docblock mentions `child_process` deliberately, which is why
    // this pins the import list rather than grepping for the name.
    const source = readFileSync(
      join(__dirname, "..", "src", "report", "commitMetadata.ts"),
      "utf8"
    );
    const specifiers = [...source.matchAll(/^import[^"']*["']([^"']+)["']/gm)].map(
      (match) => match[1]
    );
    expect(specifiers.sort()).toEqual(["../contracts", "../order"]);
    expect(source).not.toContain("require(");
    expect(source).not.toContain("execSync");
    expect(source).not.toContain("spawn");
  });
});
