// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tests for `scripts/check-coverage-annotations.mjs` — the gate that compares the
// `// measured L / B` comment beside every per-file coverage floor with what the
// file actually measures.
//
// This suite lives here for the same reason `ciCheckChain.test.js` and
// `depcruiseSelftest.test.js` do: root-level `scripts/` have no suite of their own,
// and this package's `node --test` runner is the repo's home for gate self-tests.
//
// The point of every case below is that the gate must FAIL rather than fall silent.
// The floors it audits already rotted once while two static audits read the
// annotations and believed them; a checker that skips what it cannot parse, or
// passes when the data is absent, would recreate exactly that failure with an extra
// green tick on top.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'check-coverage-annotations.mjs');

/** The checker is native ESM; `main()` is guarded so importing it runs nothing. */
async function loadChecker() {
  return import(pathToFileURL(SCRIPT).href);
}

/** A resolver over a plain object, in the shape `compareTarget` expects. */
function resolverFor(map) {
  return (key) => (key in map ? { status: 'ok', branchesTotal: null, ...map[key] } : { status: 'missing' });
}

test('parses both annotation shapes and ignores prose that merely quotes the format', async () => {
  const { parseMeasuredAnnotations } = await loadChecker();
  const source = [
    '// The `// measured L / B` annotations are MACHINE-CHECKED. Measured 2026-07-30,',
    '// the weakest file is src/x.ts; recorded per entry as `measured L/B`.',
    "    './src/FileUtils.ts': { lines: 95, branches: 87 }, // measured 98.23 / 92.06",
    "    './src/cliCommands.ts': { lines: 96 }, // measured 100.00 lines (0 branches)",
    "  { pattern: 'dist/audit.js', line: 94, branch: 88 }, // measured 96.57 / 92.12",
  ].join('\n');

  const { annotations, malformed } = parseMeasuredAnnotations(source);

  assert.deepEqual(malformed, []);
  assert.deepEqual([...annotations.keys()], [
    './src/FileUtils.ts',
    './src/cliCommands.ts',
    'dist/audit.js',
  ]);
  assert.equal(annotations.get('./src/FileUtils.ts').recordedBranches, '92.06');
  assert.equal(annotations.get('./src/cliCommands.ts').zeroBranches, true);
  assert.equal(annotations.get('dist/audit.js').lineNumber, 5);
});

test('an exact match passes and a 0.01 difference does not', async () => {
  const { compareTarget } = await loadChecker();
  const source = "    './src/a.ts': { lines: 90 }, // measured 93.55 / 81.02";

  assert.deepEqual(
    compareTarget({
      keys: ['./src/a.ts'],
      source,
      resolve: resolverFor({ './src/a.ts': { lines: 93.55, branches: 81.02 } }),
    }),
    []
  );

  // No tolerance is deliberate: both numbers are already quantised to two decimals
  // by the reporter, and "close enough" is how a 0.84-point error in
  // manifestBuilder's recorded line coverage survived. Where the instrument really
  // does report two values (V8 range coverage), the second one is DECLARED rather
  // than tolerated — see the `(also ...)` cases below.
  const drift = compareTarget({
    keys: ['./src/a.ts'],
    source,
    resolve: resolverFor({ './src/a.ts': { lines: 93.56, branches: 81.02 } }),
  });
  assert.equal(drift.length, 1);
  assert.equal(drift[0].kind, 'drift');
  assert.equal(drift[0].actual, '93.56 / 81.02');
  assert.equal(drift[0].fix, '// measured 93.56 / 81.02');
});

test('`100` and `100.00` are the same measurement, not drift', async () => {
  const { compareTarget } = await loadChecker();
  assert.deepEqual(
    compareTarget({
      keys: ['./src/a.ts'],
      source: "    './src/a.ts': { lines: 90 }, // measured 100 / 100",
      resolve: resolverFor({ './src/a.ts': { lines: 100, branches: 100 } }),
    }),
    []
  );
});

test('a floor with no annotation fails, so drift cannot be silenced by deleting the comment', async () => {
  const { compareTarget } = await loadChecker();
  const problems = compareTarget({
    keys: ['./src/a.ts'],
    source: "    './src/a.ts': { lines: 90, branches: 70 },",
    resolve: resolverFor({ './src/a.ts': { lines: 93.55, branches: 81.02 } }),
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'unannotated');
});

test('a malformed annotation payload surfaces twice, never as silence', async () => {
  const { compareTarget } = await loadChecker();
  // A decimal comma is the realistic typo; the entry must not read as annotated.
  const problems = compareTarget({
    keys: ['./src/a.ts'],
    source: "    './src/a.ts': { lines: 90 }, // measured 93,55 / 81.02",
    resolve: resolverFor({ './src/a.ts': { lines: 93.55, branches: 81.02 } }),
  });
  assert.deepEqual(problems.map((p) => p.kind).sort(), ['malformed', 'unannotated']);
});

test('a duplicated annotation for one key is reported rather than last-one-wins', async () => {
  const { parseMeasuredAnnotations } = await loadChecker();
  const { annotations, malformed } = parseMeasuredAnnotations(
    [
      "    './src/a.ts': { lines: 90 }, // measured 93.55 / 81.02",
      "    './src/a.ts': { lines: 91 }, // measured 99.99 / 99.99",
    ].join('\n')
  );
  assert.equal(annotations.get('./src/a.ts').recordedLines, '93.55');
  assert.equal(malformed.length, 1);
  assert.match(malformed[0].reason, /duplicate annotation/);
});

test('an annotation with no coverage data fails instead of being skipped', async () => {
  const { compareTarget } = await loadChecker();
  const problems = compareTarget({
    keys: ['./src/gone.ts'],
    source: "    './src/gone.ts': { lines: 90 }, // measured 93.55 / 81.02",
    resolve: resolverFor({}),
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'no-coverage');
});

test('a missing branch percentage fails closed rather than verifying only lines', async () => {
  const { compareTarget } = await loadChecker();
  // The mcp report parser yields null (not 0) for an unreadable branch cell;
  // "cannot verify" must never render as "verified".
  const problems = compareTarget({
    keys: ['dist/a.js'],
    source: "  { pattern: 'dist/a.js', line: 90, branch: 70 }, // measured 93.55 / 81.02",
    resolve: () => ({ status: 'ok', lines: 93.55, branches: null, branchesTotal: null }),
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'no-coverage');
});

test('a pattern matching several reported files cannot carry one measurement', async () => {
  const { compareTarget } = await loadChecker();
  const problems = compareTarget({
    keys: ['dist/*.js'],
    source: "  { pattern: 'dist/*.js', line: 90, branch: 70 }, // measured 93.55 / 81.02",
    resolve: () => ({ status: 'ambiguous', matches: ['dist/a.js', 'dist/b.js'] }),
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'ambiguous');
});

test('a "(0 branches)" claim fails once the file grows a branch', async () => {
  const { compareTarget } = await loadChecker();
  const source = "    './src/cli.ts': { lines: 96 }, // measured 100.00 lines (0 branches)";

  assert.deepEqual(
    compareTarget({
      keys: ['./src/cli.ts'],
      source,
      resolve: resolverFor({ './src/cli.ts': { lines: 100, branches: 100, branchesTotal: 0 } }),
    }),
    []
  );

  const problems = compareTarget({
    keys: ['./src/cli.ts'],
    source,
    resolve: resolverFor({ './src/cli.ts': { lines: 100, branches: 50, branchesTotal: 4 } }),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /declares 4 branches/);
});

test('a measurement recorded next to nothing is reported as an orphan', async () => {
  const { compareTarget } = await loadChecker();
  const problems = compareTarget({
    keys: [],
    source: "    './src/removed.ts': { lines: 90 }, // measured 93.55 / 81.02",
    resolve: resolverFor({}),
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'orphan');
});

test('a report older than its inputs is detected as stale', async () => {
  const { findNewerInputs } = await loadChecker();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-annotations-'));
  const report = path.join(dir, 'report.txt');
  const older = path.join(dir, 'older.ts');
  const newer = path.join(dir, 'newer.ts');

  fs.writeFileSync(older, 'x', 'utf8');
  fs.writeFileSync(report, 'x', 'utf8');
  fs.writeFileSync(newer, 'x', 'utf8');
  // mtimes are set explicitly: writing three files back to back can land inside a
  // single filesystem timestamp tick, which would make the assertion depend on the
  // host filesystem rather than on the logic.
  fs.utimesSync(older, new Date(1_000_000), new Date(1_000_000));
  fs.utimesSync(report, new Date(2_000_000), new Date(2_000_000));
  fs.utimesSync(newer, new Date(3_000_000), new Date(3_000_000));

  const stale = findNewerInputs(report, [older, newer]);
  assert.equal(stale.length, 1);
  assert.match(stale[0], /newer\.ts$/);
  assert.deepEqual(findNewerInputs(report, [older]), []);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a 0.00% measurement against a non-zero annotation is a partial-report suspect, not drift', async () => {
  const { findPartialReportSuspects } = await loadChecker();
  // The shape a filtered run (`jest --testPathPatterns x` with coverage on)
  // leaves behind: collectCoverageFrom lists every unloaded file at 0%, every
  // key resolves, and the report is NEWER than the sources — so the missing-data
  // and staleness checks both read it as healthy. Reporting it as drift would
  // print a `fix: // measured 0.00 / 0.00` directive for the developer to paste
  // over a real measurement. Both annotation shapes must be caught.
  const source = [
    "    './src/a.ts': { lines: 90 }, // measured 93.55 / 81.02",
    "    './src/b.ts': { lines: 90 }, // measured 95.00 / 80.00",
    "    './src/cli.ts': { lines: 96 }, // measured 100.00 lines (0 branches)",
  ].join('\n');
  const resolve = resolverFor({
    './src/a.ts': { lines: 0, branches: 0 },
    './src/b.ts': { lines: 95, branches: 80 },
    './src/cli.ts': { lines: 0, branches: 100, branchesTotal: 0 },
  });

  assert.deepEqual(
    findPartialReportSuspects({ keys: ['./src/a.ts', './src/b.ts', './src/cli.ts'], source, resolve }),
    ['./src/a.ts', './src/cli.ts']
  );
});

test('the partial-report guard stays out of the cases other checks own', async () => {
  const { findPartialReportSuspects } = await loadChecker();
  // A key with no report data is the "no-coverage" failure, an unannotated key
  // is the "unannotated" failure, and an annotation that RECORDS zero agrees
  // with a zero measurement — none of them is evidence of a filtered run, so
  // none of them may divert the exit-1 verdict those checks render.
  const source = [
    "    './src/gone.ts': { lines: 90 }, // measured 93.55 / 81.02",
    "    './src/zero.ts': { lines: 0 }, // measured 0.00 / 0.00",
  ].join('\n');
  const suspects = findPartialReportSuspects({
    keys: ['./src/gone.ts', './src/zero.ts', './src/unannotated.ts'],
    source,
    resolve: resolverFor({ './src/zero.ts': { lines: 0, branches: 0 } }),
  });
  assert.deepEqual(suspects, []);
});

test('the freshness inputs include the measurement configuration, not just the tree', async () => {
  const { coreTarget, mcpTarget } = await loadChecker();
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const relative = (target) =>
    target.inputFiles.map((file) => path.relative(repoRoot, file).split(path.sep).join('/'));

  // jest.setup.cjs decides which keychain branches a run can reach at all, and
  // each package.json carries the test invocation the report comes from; a
  // report older than either describes a measurement setup that no longer
  // exists, which is exactly what the staleness check exists to refuse.
  const core = relative(coreTarget());
  assert.ok(core.includes('packages/core/jest.setup.cjs'));
  assert.ok(core.includes('packages/core/package.json'));
  assert.ok(core.some((file) => file.startsWith('packages/core/src/')));

  const mcp = relative(mcpTarget());
  assert.ok(mcp.includes('packages/mcp-server/package.json'));
  assert.ok(mcp.some((file) => file.startsWith('packages/mcp-server/test/')));
});

test('the checker is wired into the root check chain', async () => {
  // The gate only protects the repo if it runs. `ciCheckChain.test.js` then
  // requires the link to have a matching CI step.
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.check, /npm run test:coverage:annotations(?![\w:-])/);
  assert.match(pkg.scripts['test:coverage:annotations'], /check-coverage-annotations\.mjs/);
});

// ---------------------------------------------------------------------------
// Declared second readings
//
// V8 range coverage is not reproducible run-to-run on an unchanged tree: across
// 45 mcp-server tables, dist/audit.js reported 92.62% branches 42 times and
// 92.65% three times, with a byte-identical uncovered-line list every time,
// because V8 counted one extra range that was already executing (226/244 vs
// 227/245). No test can drive a range that is already covered, and a tolerance
// window would absorb the real regressions this gate exists to catch — some of
// which moved a file by as little as 0.42 points. So the second value is
// DECLARED: exactly two readings pass, a third is still drift. The cases below
// are the fence around that escape hatch, because a wide escape hatch IS a
// tolerance.
// ---------------------------------------------------------------------------

test('a declared second reading is accepted only where the instrument is not reproducible', async () => {
  const { parseMeasuredAnnotations } = await loadChecker();
  const source =
    "  { pattern: 'dist/audit.js', line: 94, branch: 88 }, " +
    '// measured 96.83 / 92.62 (also 96.83 / 92.65: V8 range granularity, 226/244 vs 227/245)';

  const allowed = parseMeasuredAnnotations(source, { allowSecondReading: true });
  assert.deepEqual(allowed.malformed, []);
  assert.deepEqual(allowed.annotations.get('dist/audit.js').alternative, {
    recordedLines: '96.83',
    recordedBranches: '92.65',
    reason: 'V8 range granularity, 226/244 vs 227/245',
  });
  // The primary pair is unchanged by the suffix — the two floor audits parse it
  // and ignore the rest, so they keep reading the conservative measurement.
  assert.equal(allowed.annotations.get('dist/audit.js').recordedLines, '96.83');
  assert.equal(allowed.annotations.get('dist/audit.js').recordedBranches, '92.62');

  // The istanbul target does not opt in: measured over three full runs, it
  // produced a byte-identical coverage summary, so an annotation that no longer
  // matches there is drift, not flicker.
  const refused = parseMeasuredAnnotations(source);
  assert.equal(refused.annotations.size, 0);
  assert.equal(refused.malformed.length, 1);
  assert.match(refused.malformed[0].reason, /not accepted for this target/);
});

test('exactly the two declared readings pass, and a third is still drift', async () => {
  const { compareTarget } = await loadChecker();
  const source =
    "  { pattern: 'dist/audit.js', line: 94, branch: 88 }, " +
    '// measured 96.83 / 92.62 (also 96.83 / 92.65: V8 range granularity)';
  const at = (lines, branches) =>
    compareTarget({
      keys: ['dist/audit.js'],
      source,
      resolve: resolverFor({ 'dist/audit.js': { lines, branches } }),
      allowSecondReading: true,
    });

  assert.deepEqual(at(96.83, 92.62), []);
  assert.deepEqual(at(96.83, 92.65), []);

  // A third value is the whole difference between a declaration and a tolerance:
  // a window would swallow anything between 92.62 and 92.65 and beyond.
  const third = at(96.83, 92.64);
  assert.equal(third.length, 1);
  assert.equal(third[0].kind, 'drift');

  // And a real regression below the primary is still caught, which is the point.
  const regression = at(96.83, 92.2);
  assert.equal(regression.length, 1);
  assert.equal(regression[0].kind, 'drift');
});

test('a declaration must name its cause', async () => {
  const { parseMeasuredAnnotations } = await loadChecker();
  const { annotations, malformed } = parseMeasuredAnnotations(
    "  { pattern: 'dist/audit.js' }, // measured 96.83 / 92.62 (also 96.83 / 92.65)",
    { allowSecondReading: true }
  );
  // An undocumented second number is indistinguishable from someone widening the
  // gate to make a red build green.
  assert.equal(annotations.size, 0);
  assert.equal(malformed.length, 1);
  assert.match(malformed[0].reason, /unparseable second reading/);
});

test('the lower reading must be written first, because the floor audits read only the first pair', async () => {
  const { parseMeasuredAnnotations } = await loadChecker();
  const parse = (text) => parseMeasuredAnnotations(text, { allowSecondReading: true });

  // coverageGatePerFile.test.js and coverageFloors.test.ts both capture the first
  // pair and ignore the rest. If the higher reading were written first, both
  // would compute headroom against a measurement the tree does not always reach.
  const inverted = parse(
    "  { pattern: 'dist/audit.js' }, // measured 96.83 / 92.65 (also 96.83 / 92.62: wrong way round)"
  );
  assert.equal(inverted.annotations.size, 0);
  assert.match(inverted.malformed[0].reason, /is below the first/);

  // A declaration that repeats the primary records no second reading at all.
  const repeated = parse(
    "  { pattern: 'dist/audit.js' }, // measured 96.83 / 92.62 (also 96.83 / 92.62: same value)"
  );
  assert.equal(repeated.annotations.size, 0);
  assert.match(repeated.malformed[0].reason, /repeats the first/);

  // A file the reporter shows as "N lines (0 branches)" has no branch total to
  // flicker, so a second reading there is a category error.
  const zeroBranches = parse(
    "  { pattern: 'dist/x.js' }, // measured 100.00 lines (0 branches) (also 100.00 / 99.00: nope)"
  );
  assert.equal(zeroBranches.annotations.size, 0);
  assert.match(zeroBranches.malformed[0].reason, /has no branch total/);
});

test('a fix directive never emits an annotation the gate would reject', async () => {
  const { compareTarget } = await loadChecker();
  const source =
    "  { pattern: 'dist/audit.js' }, // measured 96.83 / 92.62 (also 96.83 / 92.65: V8 range granularity)";
  const at = (lines, branches) =>
    compareTarget({
      keys: ['dist/audit.js'],
      source,
      resolve: resolverFor({ 'dist/audit.js': { lines, branches } }),
      allowSecondReading: true,
    })[0];

  // Below both readings: the declaration still sits above the measurement, so it
  // is carried through rather than silently deleted from the record.
  const below = at(96.83, 92.2);
  assert.equal(below.fix, '// measured 96.83 / 92.20 (also 96.83 / 92.65: V8 range granularity)');
  assert.equal(below.droppedAlternative, undefined);

  // Above the declared second reading: carrying it would produce exactly the
  // "lower reading first" violation the parser rejects, so the directive drops it
  // — and says so, instead of losing it between two runs.
  const above = at(96.83, 92.7);
  assert.equal(above.fix, '// measured 96.83 / 92.70');
  assert.equal(above.droppedAlternative, '96.83 / 92.65');
});

test('every emitted fix directive re-parses as a well-formed annotation', async () => {
  const { compareTarget, parseMeasuredAnnotations } = await loadChecker();
  const source =
    "  { pattern: 'dist/audit.js' }, // measured 96.83 / 92.62 (also 96.83 / 92.65: V8 range granularity)";

  // Round-tripping is the property that matters: a `fix:` line is meant to be
  // pasted over the old one, and a directive that produces a malformed
  // annotation would turn one red gate into a different red gate.
  for (const [lines, branches] of [[96.83, 92.2], [96.83, 92.64], [96.83, 92.7], [90.0, 80.0], [100, 100]]) {
    const problem = compareTarget({
      keys: ['dist/audit.js'],
      source,
      resolve: resolverFor({ 'dist/audit.js': { lines, branches } }),
      allowSecondReading: true,
    })[0];
    assert.ok(problem, `expected drift for ${lines} / ${branches}`);

    const round = parseMeasuredAnnotations(`  { pattern: 'dist/audit.js' }, ${problem.fix}`, {
      allowSecondReading: true,
    });
    assert.deepEqual(round.malformed, [], `fix "${problem.fix}" does not re-parse`);
    const reparsed = round.annotations.get('dist/audit.js');
    assert.equal(Number(reparsed.recordedLines), lines);
    assert.equal(Number(reparsed.recordedBranches), branches);
  }
});

test('the partial-report guard still watches files that declare a second reading', async () => {
  const { findPartialReportSuspects } = await loadChecker();
  const source =
    "  { pattern: 'dist/audit.js' }, // measured 96.83 / 92.62 (also 96.83 / 92.65: V8 range granularity)";

  // Without the option threaded through, the annotation parses as malformed here,
  // drops out of the map, and the file stops being watched for the 0.00% shape a
  // filtered run produces — a silent hole in a fail-closed guard.
  assert.deepEqual(
    findPartialReportSuspects({
      keys: ['dist/audit.js'],
      source,
      resolve: resolverFor({ 'dist/audit.js': { lines: 0, branches: 0 } }),
      allowSecondReading: true,
    }),
    ['dist/audit.js']
  );
});

test('the declaration in check-coverage-gate.js records the arithmetic that explains it', async () => {
  // The rule the header states is that a declaration must be traceable to a
  // measurement, not to a convenience. This asserts the two live entries actually
  // carry that evidence, so the escape hatch cannot decay into an unexplained
  // second number that later readers take on faith.
  const gate = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'check-coverage-gate.js'), 'utf8');
  const declarations = [...gate.matchAll(/\/\/\s*measured\s+[\d.]+\s*\/\s*[\d.]+\s*\(also\s+[\d.]+\s*\/\s*[\d.]+\s*:\s*([^)]+)\)/g)];
  assert.ok(declarations.length > 0, 'expected at least one declared second reading');
  for (const [, reason] of declarations) {
    assert.match(reason, /\d+\s*\/\s*\d+\s+vs\s+\d+\s*\/\s*\d+/, `reason "${reason}" records no arithmetic`);
  }
});

test('every declared fraction renders the two percentages it is offered as the explanation for', () => {
  // "Records arithmetic" above is a shape check; this is the arithmetic itself. A
  // declaration is only evidence if the fractions divide out to the two readings
  // beside them — a transposed digit produces a reason that looks authoritative,
  // reads plausibly in review, and explains nothing. The convention it pins is that
  // the FIRST fraction belongs to the FIRST pair, which is the same lower-reading-
  // first ordering the floor audits depend on.
  const gate = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'check-coverage-gate.js'), 'utf8');
  const declarations = [
    ...gate.matchAll(
      /\/\/\s*measured\s+[\d.]+\s*\/\s*([\d.]+)\s*\(also\s+[\d.]+\s*\/\s*([\d.]+)\s*:\s*([^)]+)\)/g
    ),
  ];
  assert.ok(declarations.length > 0, 'expected at least one declared second reading');
  for (const [, firstBranches, secondBranches, reason] of declarations) {
    const fractions = /(\d+)\s*\/\s*(\d+)\s+vs\s+(\d+)\s*\/\s*(\d+)/.exec(reason);
    assert.ok(fractions, `reason "${reason}" records no arithmetic`);
    const [, n1, d1, n2, d2] = fractions.map(Number);
    assert.equal(
      ((n1 / d1) * 100).toFixed(2),
      Number(firstBranches).toFixed(2),
      `${n1}/${d1} does not render the first reading ${firstBranches}`
    );
    assert.equal(
      ((n2 / d2) * 100).toFixed(2),
      Number(secondBranches).toFixed(2),
      `${n2}/${d2} does not render the second reading ${secondBranches}`
    );
  }
});

test('the failure banner offers the declaration recipe only where a declaration is allowed', async () => {
  const { failureBanner } = await loadChecker();
  const problems = [{ key: 'a' }, { key: 'b' }];
  const core = { label: 'packages/core', allowSecondReading: false };
  const mcp = { label: 'packages/mcp-server', allowSecondReading: true };

  // On an istanbul-only failure the recipe would be advice this gate then rejects:
  // the same run that printed it refuses `(also ...)` on that target unconditionally.
  const coreOnly = failureBanner([{ target: core, problems }]);
  assert.match(coreOnly, /2 recorded measurement\(s\)/);
  assert.doesNotMatch(coreOnly, /also/i);

  // With a V8 target in the failing set, the uncovered-LINE diagnostic has to lead —
  // "update each comment to the measured pair" is the wrong move for a flicker, and
  // it is the only instruction the banner used to give.
  const withMcp = failureBanner([{ target: core, problems }, { target: mcp, problems: [{ key: 'c' }] }]);
  assert.match(withMcp, /3 recorded measurement\(s\)/);
  assert.match(withMcp, /uncovered-LINE column/);
  assert.match(withMcp, /also <higher L> \/ <higher B>: cause/);
});
