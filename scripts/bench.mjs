#!/usr/bin/env node
// G14: performance baseline for SyncroNow AI's CPU-bound manifest/doc pipeline.
//
// This benchmarks the deterministic, pure manifest-processing path the CLI runs
// on every `refresh` / `docs` (summarize a downloaded manifest, then render the
// Mermaid diagram and the Markdown doc body). It needs no network and no
// instance — a synthetic manifest of a fixed size is processed in a loop so a
// speed regression shows up as a number instead of a vague "feels slow".
//
// Usage:
//   npm run bench                       # default dataset, just report
//   node scripts/bench.mjs --tables 40 --records 80 --iterations 200
//   node scripts/bench.mjs --max-ms 25  # exit 1 if the median run exceeds 25ms
//
// It imports the COMPILED output, so run `npm run build` first (the `bench` npm
// script does this for you).

import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, "../packages/core/dist/scopeDocs.js");

let scopeDocs;
try {
  scopeDocs = await import(distPath);
} catch (err) {
  console.error(
    `Could not load ${distPath}. Run \`npm run build\` first.\n${err.message}`
  );
  process.exit(2);
}
const { summarizeManifest, buildScopeMermaid, buildScopeDocBody } = scopeDocs;

function parseArgs(argv) {
  const args = { tables: 40, records: 80, iterations: 200, maxMs: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, "");
    const val = argv[i + 1];
    if (key === "tables") args.tables = Number(val);
    else if (key === "records") args.records = Number(val);
    else if (key === "iterations") args.iterations = Number(val);
    else if (key === "max-ms") args.maxMs = Number(val);
  }
  return args;
}

// A deterministic, realistically-shaped scoped-app manifest: a spread of common
// code tables, each with `records` records, each with one or two code files.
function makeManifest(nTables, nRecords) {
  const baseTables = [
    "sys_script_include",
    "sys_script",
    "sys_script_client",
    "sys_ui_action",
    "sys_ws_operation",
    "sp_widget",
    "sys_ui_policy",
    "catalog_script_client",
  ];
  const tables = {};
  for (let t = 0; t < nTables; t += 1) {
    const tableName =
      t < baseTables.length ? baseTables[t] : `${baseTables[t % baseTables.length]}_${t}`;
    const records = {};
    for (let r = 0; r < nRecords; r += 1) {
      const name = `Record_${t}_${r}`;
      records[name] = {
        name,
        sys_id: `${t}-${r}`,
        files:
          r % 3 === 0
            ? [
                { name: `${name}.script.js`, type: "js" },
                { name: `${name}.client.js`, type: "js" },
              ]
            : [{ name: `${name}.script.js`, type: "js" }],
      };
    }
    tables[tableName] = { records };
  }
  return { scope: "x_bench_app", tables };
}

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");

function runWorkload(manifest) {
  const summary = summarizeManifest(manifest);
  buildScopeMermaid(summary);
  buildScopeDocBody(summary, FIXED_NOW);
  return summary;
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return { min: sorted[0], median: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1], mean };
}

const args = parseArgs(process.argv.slice(2));
const manifest = makeManifest(args.tables, args.records);

// Sanity + warm-up (JIT) before measuring.
const warm = runWorkload(manifest);
for (let i = 0; i < 20; i += 1) runWorkload(manifest);

const samples = [];
for (let i = 0; i < args.iterations; i += 1) {
  const start = performance.now();
  runWorkload(manifest);
  samples.push(performance.now() - start);
}
const s = stats(samples);
const opsPerSec = 1000 / s.median;

console.log("SyncroNow AI — manifest/doc pipeline benchmark (G14)");
console.log(
  `  dataset:    ${args.tables} tables × ${args.records} records = ` +
    `${warm.recordCount} records, ${warm.fileCount} files`
);
console.log(`  iterations: ${args.iterations} (after 21 warm-up runs)`);
console.log(`  median:     ${s.median.toFixed(3)} ms   (${opsPerSec.toFixed(0)} runs/sec)`);
console.log(`  p95:        ${s.p95.toFixed(3)} ms`);
console.log(`  min / max:  ${s.min.toFixed(3)} / ${s.max.toFixed(3)} ms`);
console.log(`  mean:       ${s.mean.toFixed(3)} ms`);

if (args.maxMs !== undefined && Number.isFinite(args.maxMs)) {
  if (s.median > args.maxMs) {
    console.error(
      `\n✗ median ${s.median.toFixed(3)} ms exceeds threshold ${args.maxMs} ms`
    );
    process.exit(1);
  }
  console.log(`\n✓ median within threshold (${args.maxMs} ms)`);
}
