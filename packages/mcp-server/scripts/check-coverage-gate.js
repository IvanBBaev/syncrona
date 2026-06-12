const { spawnSync } = require('node:child_process');

function parseArgs(argv) {
  const out = {
    lineThreshold: 90,
    // 0 disables the branch gate (kept opt-in for callers that only ratchet lines).
    branchThreshold: 0,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--line-threshold') {
      const next = argv[i + 1];
      const parsed = Number(next);
      if (Number.isFinite(parsed)) {
        out.lineThreshold = parsed;
      }
      i += 1;
    }
    if (item === '--branch-threshold') {
      const next = argv[i + 1];
      const parsed = Number(next);
      if (Number.isFinite(parsed)) {
        out.branchThreshold = parsed;
      }
      i += 1;
    }
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

function runCoverage() {
  const result = spawnSync(
    'node',
    ['--test', '--experimental-test-coverage', 'test/*.test.js'],
    {
      encoding: 'utf-8',
      shell: true,
      stdio: 'pipe',
    }
  );

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const combined = `${stdout}\n${stderr}`;

  return {
    exitCode: result.status || 0,
    output: combined,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
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
