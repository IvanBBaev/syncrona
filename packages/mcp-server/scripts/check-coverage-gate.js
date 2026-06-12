const { spawnSync } = require('node:child_process');

function parseArgs(argv) {
  const out = {
    lineThreshold: 90,
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
  return Number.isFinite(linePct) ? linePct : null;
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

  const lineCoverage = parseAllFilesLineCoverage(run.output);
  if (lineCoverage === null) {
    console.error('Could not parse all files line coverage from report.');
    process.exit(1);
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
