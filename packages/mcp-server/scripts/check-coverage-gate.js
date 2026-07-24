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

// The directory COVERAGE_INCLUDE scopes to, resolved against the gate's cwd.
const COVERAGE_ROOT = 'dist';

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

// Per-file line-coverage floor. The `all files` ratchet is an AGGREGATE: a single
// new file at 0% that IS present in the report (some test imported the module but
// exercised nothing in it) barely moves the aggregate and ships green, which is
// the exact opposite of what a coverage gate is for. This floor scores every
// reported source file on its own, so a present-but-untested file fails even while
// the aggregate stays above its threshold. It is deliberately far below the
// `--line-threshold 90` global ratchet — it exists to catch ~0% files, not to
// second-guess legitimately-thin ones — so the aggregate remains the ceiling
// raiser and this is only the floor.
const PER_FILE_LINE_FLOOR = 10;

// `--test-coverage-include` only FILTERS the modules the run actually loaded; V8
// reports coverage for scripts it saw execute. A dist module that no test ever
// imports is therefore absent from the report entirely — it cannot lower the
// "all files" ratio and cannot fail this gate. Left alone, a module with zero
// tests is invisible rather than scored 0%, which is the exact opposite of what
// a coverage gate is for (verified: a 2-function module no test imports leaves
// "all files" reading 100.00%).
//
// So the reported set is diffed against what is actually on disk, and any owned
// module missing from the report fails the gate. The report is a TREE (one space
// of indent per level, directory rows carry empty percentage cells), not a list
// of paths, so the paths are reconstructed with an indent stack.
const REPORT_START_REGEX = /^\s*#?\s*start of coverage report\s*$/i;
const REPORT_END_REGEX = /^\s*#?\s*end of coverage report\s*$/i;

function parseReportedFiles(output) {
  const files = new Set();
  const stack = [];
  let inside = false;
  for (const line of output.split(/\r?\n/)) {
    if (REPORT_START_REGEX.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) {
      continue;
    }
    if (REPORT_END_REGEX.test(line)) {
      break;
    }
    // Drop the TAP comment marker only; the spaces after it encode the depth.
    const body = line.replace(/^\s*#/, '');
    if (!body.includes('|')) {
      continue;
    }
    const cells = body.split('|');
    const label = cells[0];
    const name = label.trim();
    if (name === '' || /^-+$/.test(name) || /^all files$/i.test(name)) {
      continue;
    }
    if (name === 'file' && /line\s*%/i.test(cells[1] || '')) {
      continue;
    }
    const depth = label.length - label.trimStart().length - 1;
    if (depth < 0) {
      continue;
    }
    stack.length = depth;
    stack.push(name);
    // A directory row leaves the line% cell blank; only file rows carry numbers.
    // `Number('')` is 0 and finite, so the emptiness must be tested first.
    const linePct = (cells[1] || '').trim();
    if (linePct !== '' && Number.isFinite(Number(linePct))) {
      files.add(stack.join('/'));
    }
  }
  return files;
}

// Per-file line coverage as an array of { file, linePct }, reconstructed from the
// SAME indented TAP tree parseReportedFiles walks: one space of indent per depth
// level, directory rows carry a blank line% cell (skipped), only file rows carry a
// finite number. Kept separate from parseReportedFiles because that returns a Set
// of paths for the unreported-module diff, whereas this must retain the percentage.
function parsePerFileLineCoverage(output) {
  const files = [];
  const stack = [];
  let inside = false;
  for (const line of output.split(/\r?\n/)) {
    if (REPORT_START_REGEX.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) {
      continue;
    }
    if (REPORT_END_REGEX.test(line)) {
      break;
    }
    const body = line.replace(/^\s*#/, '');
    if (!body.includes('|')) {
      continue;
    }
    const cells = body.split('|');
    const label = cells[0];
    const name = label.trim();
    if (name === '' || /^-+$/.test(name) || /^all files$/i.test(name)) {
      continue;
    }
    if (name === 'file' && /line\s*%/i.test(cells[1] || '')) {
      continue;
    }
    const depth = label.length - label.trimStart().length - 1;
    if (depth < 0) {
      continue;
    }
    stack.length = depth;
    stack.push(name);
    // A directory row leaves the line% cell blank; `Number('')` is a finite 0, so
    // the emptiness must be tested first or every directory would score 0%.
    const linePct = (cells[1] || '').trim();
    if (linePct !== '' && Number.isFinite(Number(linePct))) {
      files.push({ file: stack.join('/'), linePct: Number(linePct) });
    }
  }
  return files;
}

// Reported source files scoring below the per-file floor. The same excludes that
// keep the pure-data schema literal out of the aggregate are honored here, so the
// floor can never fail on a file the aggregate itself does not count.
function findFilesBelowFloor(output, floor = PER_FILE_LINE_FLOOR) {
  const excludes = COVERAGE_EXCLUDES.map(globToRegExp);
  return parsePerFileLineCoverage(output).filter(
    ({ file, linePct }) => !excludes.some((re) => re.test(file)) && linePct < floor
  );
}

function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

// A `.ts` file that exports only types compiles to a stub with no executable
// body — no statement, so nothing for V8 to report and no importer to load it.
// Its absence from the report proves nothing, so it is not a coverage hole. A
// module with real code always has a body left after this strip and is reported
// as missing, which is the failure mode this check exists to produce.
function isTypeOnlyEmit(source) {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/["']use strict["'];?/g, '')
    .replace(/Object\.defineProperty\(\s*exports\s*,\s*["']__esModule["']\s*,\s*\{[^}]*\}\s*\)\s*;?/g, '')
    .replace(/exports\.__esModule\s*=\s*(?:true|!0)\s*;?/g, '')
    .trim();
  return stripped === '';
}

// Every `.js` under dist/ that the include glob covers and no exclude removes.
function listCoverageCandidates(rootDir) {
  const base = path.join(rootDir, COVERAGE_ROOT);
  if (!fs.existsSync(base)) {
    return [];
  }
  const excludes = COVERAGE_EXCLUDES.map(globToRegExp);
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        const rel = path.relative(rootDir, abs).split(path.sep).join('/');
        if (!excludes.some((re) => re.test(rel))) {
          found.push(rel);
        }
      }
    }
  };
  walk(base);
  return found;
}

// Owned modules the report never mentioned, i.e. modules no test loaded.
function findUnreportedModules(output, rootDir) {
  const reported = parseReportedFiles(output);
  const candidates = listCoverageCandidates(rootDir);
  return candidates.filter((rel) => {
    if (reported.has(rel)) {
      return false;
    }
    let source;
    try {
      source = fs.readFileSync(path.join(rootDir, rel), 'utf-8');
    } catch {
      return true;
    }
    return !isTypeOnlyEmit(source);
  });
}

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

  // Run this BEFORE the ratio checks: an untested module is absent from the
  // report rather than scored, so "all files" can read 100% while real code has
  // no test at all. The ratio cannot speak for modules it never saw.
  const unreported = findUnreportedModules(run.output, process.cwd());
  if (unreported.length > 0) {
    console.error(
      `Coverage gate failed: ${unreported.length} module(s) under ${COVERAGE_ROOT}/ were never ` +
        'loaded by any test, so they carry no coverage at all:'
    );
    for (const rel of unreported) {
      console.error(`- ${rel}`);
    }
    console.error(
      'Add a test that exercises each module, or exclude it deliberately via COVERAGE_EXCLUDES ' +
        'with a stated reason.'
    );
    process.exit(1);
  }

  // Per-file floor, checked BEFORE the aggregate: a file present in the report but
  // effectively untested (~0%) is invisible to the `all files` ratio, so the
  // aggregate can read 90%+ while a specific module has no real test at all.
  const belowFloor = findFilesBelowFloor(run.output);
  if (belowFloor.length > 0) {
    console.error(
      `Coverage gate failed: ${belowFloor.length} file(s) under ${COVERAGE_ROOT}/ are below the ` +
        `per-file line floor of ${PER_FILE_LINE_FLOOR.toFixed(2)}% (present in the report but ` +
        'effectively untested):'
    );
    for (const { file, linePct } of belowFloor) {
      console.error(`- ${file} (${linePct.toFixed(2)}%)`);
    }
    console.error(
      'Add a test that exercises each file, or exclude it deliberately via COVERAGE_EXCLUDES ' +
        'with a stated reason.'
    );
    process.exit(1);
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
  parseReportedFiles,
  parsePerFileLineCoverage,
  findFilesBelowFloor,
  listCoverageCandidates,
  findUnreportedModules,
  isTypeOnlyEmit,
  globToRegExp,
  PER_FILE_LINE_FLOOR,
};
