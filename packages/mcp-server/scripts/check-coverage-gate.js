// SPDX-License-Identifier: GPL-3.0-or-later
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// The two recognized flags and the option key each writes.
const THRESHOLD_FLAGS = {
  '--line-threshold': 'lineThreshold',
  '--branch-threshold': 'branchThreshold',
};

function parseArgs(argv) {
  const out = {
    lineThreshold: 90,
    // 0 disables the branch gate (kept opt-in for callers that only ratchet lines).
    branchThreshold: 0,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];

    // Accept both `--flag value` and `--flag=value`. Splitting on `=` first means
    // an inline form is recognized rather than treated as an unknown token.
    let flag = item;
    let inlineValue = null;
    if (typeof item === 'string' && item.startsWith('--')) {
      const eq = item.indexOf('=');
      if (eq !== -1) {
        flag = item.slice(0, eq);
        inlineValue = item.slice(eq + 1);
      }
    }

    // A typo in a threshold flag used to be silently ignored, leaving the gate at
    // its default — most dangerously `--branch-threshhold 80` left the branch gate
    // OFF (default 0) with the run still reporting success. Reject every
    // unrecognized token so a misspelled flag fails loudly instead of no-op'ing.
    const optionKey = THRESHOLD_FLAGS[flag];
    if (!optionKey) {
      throw new Error(
        `Unknown argument "${item}". Expected --line-threshold and/or --branch-threshold.`
      );
    }

    let rawValue;
    if (inlineValue !== null) {
      rawValue = inlineValue;
    } else {
      rawValue = argv[i + 1];
      i += 1;
    }

    if (rawValue === undefined || String(rawValue).trim() === '') {
      throw new Error(`Missing value for ${flag}.`);
    }
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid numeric value for ${flag}: "${rawValue}".`);
    }
    // A threshold is a percentage; anything outside 0–100 (e.g. a dropped decimal
    // point, `--line-threshold 900`) can never be met or is meaningless.
    if (parsed < 0 || parsed > 100) {
      throw new Error(`Threshold for ${flag} must be between 0 and 100, got ${parsed}.`);
    }
    out[optionKey] = parsed;
  }

  return out;
}

function parseAllFilesLineCoverage(output) {
  const lines = output.split(/\r?\n/);
  const row = lines.find((line) => /^\s*#?\s*all files\s*\|/i.test(line));
  if (!row) {
    return null;
  }

  const normalized = row.replace(/^\s*#\s*/, '');
  const cells = normalized.split('|').map((v) => v.trim());
  if (cells.length < 2) {
    return null;
  }

  const linePct = Number(cells[1]);
  const branchPct = Number(cells[2]);
  return Number.isFinite(linePct)
    ? { linePct, branchPct: Number.isFinite(branchPct) ? branchPct : null }
    : null;
}

// Scope coverage to this package's OWN compiled output (`dist/**`). The test
// suite loads code from sibling workspace packages it depends on at runtime
// (@syncrona/core CLI commands, credential-store, jira, sn-transport); those
// files are exercised — and coverage-gated — by their own package suites, so
// counting their module-load-only lines here would double-count and drag the
// ratio down with code this package does not own. `dist/**` (relative to the
// package root, the gate's cwd) matches only this package's build output;
// sibling packages resolve to `../<pkg>/dist/...` and are excluded.
const COVERAGE_INCLUDE = 'dist/**';

// `toolSchemas` is ~1500 lines of a single top-level declarative object literal
// (the MCP tool schema catalogue). V8's line coverage cannot mark the body of a
// static data literal as executed — even a test that requires the module and
// iterates every entry leaves the literal reported as uncovered (verified:
// 1.9%). It carries no branch/logic to exercise, so excluding this pure-data
// file keeps the "all files" line ratio honest about actual code.
//
// Coverage is measured WITHOUT source maps, i.e. against the emitted `dist/*.js`
// directly, so the ratio reflects real executable lines. Source-mapped `.ts`
// coverage is deflated by non-executable declaration lines (imports, `type`
// aliases, interface bodies) that compile to nothing yet count as "uncovered";
// the raw dist figure is the honest measure of what actually ran. (`.ts` glob
// kept in the exclude list as a harmless guard if source maps are reintroduced.)
const COVERAGE_EXCLUDES = ['**/toolSchemas.ts', '**/toolSchemas.js'];

// Enumerate the test files in JS rather than leaning on a shell to expand
// `test/*.test.js`. The child is spawned with `shell: false`, so the coverage
// include/exclude GLOBS reach Node verbatim (Node matches them internally); a
// shell would otherwise expand `dist/**` against the filesystem and shatter the
// single include argument into dozens of stray positional paths.
function listTestFiles() {
  const testDir = path.join(process.cwd(), 'test');
  return fs
    .readdirSync(testDir)
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => path.join('test', name));
}

function runCoverage() {
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--experimental-test-coverage',
      '--test-coverage-include',
      COVERAGE_INCLUDE,
      ...COVERAGE_EXCLUDES.flatMap((glob) => ['--test-coverage-exclude', glob]),
      ...listTestFiles(),
    ],
    {
      encoding: 'utf-8',
      shell: false,
      stdio: 'pipe',
    }
  );

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const combined = `${stdout}\n${stderr}`;

  // A run killed by a signal (e.g. OOM, timeout) reports status=null; the old
  // `status || 0` collapsed that to 0 and treated the kill as success, letting
  // an aborted test run pass the gate. Surface signal deaths and a null status
  // as a non-zero failure so the coverage gate cannot be silently bypassed.
  if (result.error) {
    return { exitCode: 1, output: `${combined}\nCoverage runner error: ${result.error.message}` };
  }
  if (result.signal) {
    return { exitCode: 1, output: `${combined}\nCoverage run terminated by signal ${result.signal}.` };
  }
  if (result.status === null || result.status === undefined) {
    return { exitCode: 1, output: `${combined}\nCoverage run ended with no exit status.` };
  }

  return {
    exitCode: result.status,
    output: combined,
  };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Coverage gate: ${error.message}`);
    process.exit(1);
    return;
  }
  const run = runCoverage();

  process.stdout.write(run.output);

  if (run.exitCode !== 0) {
    console.error('Coverage run failed before threshold check.');
    process.exit(run.exitCode);
  }

  const coverage = parseAllFilesLineCoverage(run.output);
  if (coverage === null) {
    console.error('Could not parse all files line coverage from report.');
    process.exit(1);
  }
  const lineCoverage = coverage.linePct;

  if (args.branchThreshold > 0) {
    if (coverage.branchPct === null) {
      console.error('Could not parse all files branch coverage from report.');
      process.exit(1);
    }
    if (coverage.branchPct < args.branchThreshold) {
      console.error(
        `Coverage gate failed: all files branch coverage ${coverage.branchPct.toFixed(2)}% < ${args.branchThreshold.toFixed(2)}%`
      );
      process.exit(1);
    }
    console.log(
      `Branch coverage gate passed: ${coverage.branchPct.toFixed(2)}% >= ${args.branchThreshold.toFixed(2)}%`
    );
  }

  if (lineCoverage < args.lineThreshold) {
    console.error(
      `Coverage gate failed: all files line coverage ${lineCoverage.toFixed(2)}% < ${args.lineThreshold.toFixed(2)}%`
    );
    process.exit(1);
  }

  console.log(
    `Coverage gate passed: all files line coverage ${lineCoverage.toFixed(2)}% >= ${args.lineThreshold.toFixed(2)}%`
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  parseAllFilesLineCoverage,
};
