#!/usr/bin/env node
// Triage a Stryker JSON report: what survived, grouped so the shape of the gap is
// visible instead of scrolling a thousand console lines.
//
// WHY THIS EXISTS: the clear-text reporter prints every survivor in file order,
// which is the least useful order. The first real measurement of
// packages/mcp-server/src/safetyPolicy.ts came back at 63.14% with 383 survivors,
// and the finding was not in any individual survivor — it was that 327 of them were
// StringLiteral mutants, ~85% of those the same shape (empty one entry out of a
// policy table). That is one missing kind of test, not 327 problems. Reading it off
// the console took an embarrassingly long time; this script answers it in one line.
//
// USAGE
//   node scripts/mutation-triage.mjs reports/mutation/<name>.json [--limit N] [--mutator X]
//
// Produce the report by adding "json" to `reporters` in the Stryker config (see
// packages/mcp-server/stryker.conf.json). Read-only: it never runs Stryker.
//
// NOT A GATE. Mutation runs are deliberately outside `npm run check` (far too slow
// for a per-change gate), so this is a developer tool, not CI plumbing.

import fs from "node:fs";
import path from "node:path";

// Stryker's own status vocabulary. Survived and NoCoverage are the two that mean
// "no test noticed": NoCoverage additionally means no test even executed the line,
// which is a coverage hole wearing a mutation-score costume, so it is reported
// separately rather than merged into the survivor list.
const NOT_KILLED = new Set(["Survived", "NoCoverage"]);

function parseArgs(argv) {
  const args = { reportPath: null, limit: 40, mutator: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--limit") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`--limit needs a non-negative integer, got ${JSON.stringify(argv[i + 1])}`);
      }
      args.limit = value;
      i += 1;
    } else if (arg === "--mutator") {
      args.mutator = argv[i + 1];
      if (!args.mutator) {
        throw new Error("--mutator needs a mutator name, e.g. --mutator StringLiteral");
      }
      i += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${arg}`);
    } else if (args.reportPath === null) {
      args.reportPath = arg;
    } else {
      throw new Error(`Unexpected extra argument ${JSON.stringify(arg)}`);
    }
  }
  if (args.reportPath === null) {
    throw new Error("Usage: node scripts/mutation-triage.mjs <stryker-report.json> [--limit N] [--mutator X]");
  }
  return args;
}

// One line, whitespace collapsed, so a multi-line replacement (a whole mutated
// block statement) stays readable in a table.
function oneLine(value, max = 60) {
  const flat = String(value ?? "").replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function collect(report) {
  const files = report && typeof report.files === "object" ? report.files : null;
  if (!files) {
    throw new Error(
      "Not a Stryker JSON report: expected a top-level `files` object. " +
        'Add "json" to `reporters` in the Stryker config and re-run.'
    );
  }
  const mutants = [];
  const totals = { total: 0, killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0, other: 0 };
  for (const [filePath, entry] of Object.entries(files)) {
    for (const mutant of entry.mutants ?? []) {
      totals.total += 1;
      switch (mutant.status) {
        case "Killed":
          totals.killed += 1;
          break;
        case "Timeout":
          totals.timeout += 1;
          break;
        case "Survived":
          totals.survived += 1;
          break;
        case "NoCoverage":
          totals.noCoverage += 1;
          break;
        case "Ignored":
        case "CompileError":
          totals.ignored += 1;
          break;
        default:
          totals.other += 1;
      }
      if (NOT_KILLED.has(mutant.status)) {
        mutants.push({
          file: filePath,
          line: mutant.location?.start?.line ?? 0,
          column: mutant.location?.start?.column ?? 0,
          mutator: mutant.mutatorName ?? "unknown",
          replacement: mutant.replacement ?? "",
          status: mutant.status,
        });
      }
    }
  }
  return { mutants, totals };
}

// Stryker's own formula: timeouts count as kills, and Ignored/CompileError mutants
// are excluded from the denominator entirely. Recomputed here rather than read from
// the report so the number printed is always consistent with the counts beside it.
function mutationScore(totals) {
  const denominator = totals.killed + totals.timeout + totals.survived + totals.noCoverage;
  return denominator === 0 ? null : ((totals.killed + totals.timeout) / denominator) * 100;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const resolved = path.resolve(args.reportPath);
  let report;
  try {
    report = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (e) {
    console.error(`Could not read ${resolved}: ${e.message}`);
    process.exit(2);
  }

  const { mutants, totals } = collect(report);
  const score = mutationScore(totals);

  console.log(`Report: ${resolved}`);
  console.log(
    `Mutants: ${totals.total} total — ${totals.killed} killed, ${totals.timeout} timeout, ` +
      `${totals.survived} survived, ${totals.noCoverage} no-coverage, ${totals.ignored} ignored`
  );
  console.log(`Mutation score: ${score === null ? "n/a" : `${score.toFixed(2)}%`}`);
  if (totals.timeout > 0) {
    // Worth saying out loud every time: Stryker scores a timeout as a KILL, so a run
    // made slow by a loaded machine reports a HIGHER score than a run on an idle one.
    console.log(
      `NOTE: ${totals.timeout} timeouts are counted as kills. If that number is large, ` +
        `re-run on an unloaded machine before trusting the score.`
    );
  }

  const filtered = args.mutator
    ? mutants.filter((m) => m.mutator.toLowerCase() === args.mutator.toLowerCase())
    : mutants;

  if (filtered.length === 0) {
    console.log(args.mutator ? `\nNo surviving ${args.mutator} mutants.` : "\nNothing survived.");
    return;
  }

  const byMutator = new Map();
  for (const mutant of filtered) {
    byMutator.set(mutant.mutator, (byMutator.get(mutant.mutator) ?? 0) + 1);
  }
  console.log("\nSurvivors by mutator (the shape of the gap):");
  for (const [mutator, count] of [...byMutator.entries()].sort((a, b) => b[1] - a[1])) {
    const share = ((count / filtered.length) * 100).toFixed(1);
    console.log(`  ${String(count).padStart(5)}  ${share.padStart(5)}%  ${mutator}`);
  }

  const shown = args.limit === 0 ? filtered : filtered.slice(0, args.limit);
  const sorted = [...shown].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  console.log(`\nSurvivors (${sorted.length} of ${filtered.length}):`);
  for (const mutant of sorted) {
    const where = `${path.basename(mutant.file)}:${mutant.line}:${mutant.column}`;
    const flag = mutant.status === "NoCoverage" ? " [no coverage]" : "";
    console.log(`  ${where.padEnd(28)} ${mutant.mutator.padEnd(22)} → ${oneLine(mutant.replacement)}${flag}`);
  }
  if (sorted.length < filtered.length) {
    console.log(`  … ${filtered.length - sorted.length} more (use --limit 0 for all)`);
  }
}

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
