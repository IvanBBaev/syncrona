// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  checkToolContract,
  hashToolContract,
  runCli,
} = require('../scripts/check-tool-contract.js');
const {
  checkDocsDrift,
  deriveToolPrefixes,
  parseToolNamesFromDocs,
  parseToolNamesFromSchemas,
  runCli: runDocsDriftCli,
} = require('../scripts/check-docs-drift.js');
const {
  validateReleaseChecklist,
  runCli: runReleaseChecklistCli,
  DEFAULT_REQUIRED_SECTIONS: RELEASE_GOVERNANCE_SECTIONS,
} = require('../scripts/validate-release-checklist.js');
const {
  validateClaudeDocsDrift,
  parseCommandNamesFromReadme,
  parseCommandNamesFromClaude,
  sliceCommandTableSection,
  runCli: runClaudeDocsDriftCli,
} = require('../scripts/check-claude-docs-drift.js');
const {
  validateClaimsDrift,
  runCli: runClaimsDriftCli,
  parseRuntimeOverrides: parseClaimsRuntimeOverrides,
  extractAuthSection,
} = require('../scripts/check-claims-drift.js');
const { getToolLifecycleMetadata } = require('../dist/toolSchemas.js');

test('tool contract checker passes when required tools exist', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-contract-'));
  const file = path.join(tempDir, 'index.ts');
  fs.writeFileSync(file, 'name: "a"\nname: "b"\n');

  const res = checkToolContract(file, ['a', 'b']);
  assert.equal(res.ok, true);
  assert.deepEqual(res.missing, []);
});

test('tool contract checker reports missing tools', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-contract-'));
  const file = path.join(tempDir, 'index.ts');
  fs.writeFileSync(file, 'name: "a"\n');

  const res = checkToolContract(file, ['a', 'b']);
  assert.equal(res.ok, false);
  assert.deepEqual(res.missing, ['b']);
});

test('tool contract hash is stable for reordered inputs', () => {
  const a = hashToolContract(['b', 'a', 'c']);
  const b = hashToolContract(['c', 'b', 'a']);
  assert.equal(a, b);
});

test('tool contract checker detects duplicate declared tools', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-contract-'));
  const file = path.join(tempDir, 'index.ts');
  fs.writeFileSync(file, 'name: "a"\nname: "a"\nname: "b"\n');

  const res = checkToolContract(file, ['a', 'b']);
  assert.equal(res.ok, false);
  assert.deepEqual(res.duplicates, ['a']);
});

test('tool contract CLI runner returns 0 and prints success', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-contract-'));
  const file = path.join(tempDir, 'index.ts');
  fs.writeFileSync(file, 'name: "a"\nname: "b"\n');

  const logs = [];
  const errors = [];
  const exitCode = runCli({
    indexFilePath: file,
    requiredTools: ['a', 'b'],
    console: {
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(errors.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Tool contract check passed/);
});

test('tool contract CLI runner returns 1 and prints missing/duplicate details', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-contract-'));
  const file = path.join(tempDir, 'index.ts');
  fs.writeFileSync(file, 'name: "a"\nname: "a"\n');

  const logs = [];
  const errors = [];
  const exitCode = runCli({
    indexFilePath: file,
    requiredTools: ['a', 'b'],
    console: {
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(logs.length, 0);
  assert.deepEqual(errors, [
    'Tool contract check failed. Missing tools:',
    '- b',
    'Duplicate tool declarations:',
    '- a',
  ]);
});

test('tool contract CLI entrypoint exits 0 when overrides satisfy contract', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-contract-'));
  const file = path.join(tempDir, 'index.ts');
  fs.writeFileSync(file, 'name: "a"\nname: "b"\n');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'check-tool-contract.js');
  const run = spawnSync('node', [scriptPath], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      SYNC_TOOL_CONTRACT_INDEX: file,
      SYNC_TOOL_CONTRACT_REQUIRED: 'a,b',
    },
  });

  assert.equal(run.status, 0);
  assert.match(run.stdout, /Tool contract check passed/);
});

test('tool contract CLI entrypoint exits 1 when overrides fail contract', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-contract-'));
  const file = path.join(tempDir, 'index.ts');
  fs.writeFileSync(file, 'name: "a"\nname: "a"\n');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'check-tool-contract.js');
  const run = spawnSync('node', [scriptPath], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      SYNC_TOOL_CONTRACT_INDEX: file,
      SYNC_TOOL_CONTRACT_REQUIRED: 'a,b',
    },
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /Tool contract check failed/);
  assert.match(run.stderr, /- b/);
  assert.match(run.stderr, /Duplicate tool declarations:/);
  assert.match(run.stderr, /- a/);
});

test('docs drift parser extracts tools from schemas and docs', () => {
  const schemaRaw =
    'name: "sync_a"\nname: "sn_b"\nname: "sync_a"\nname: "run_workspace_command"\nname: "run_node_code"\n';
  const docsRaw = [
    '- sync_a',
    '- sn_b',
    '- run_workspace_command',
    '`sync_a`',
    '`run_node_code`',
  ].join('\n');

  const schemaNames = parseToolNamesFromSchemas(schemaRaw);
  const docNames = parseToolNamesFromDocs(docsRaw, schemaNames);

  assert.deepEqual(schemaNames, ['run_node_code', 'run_workspace_command', 'sn_b', 'sync_a']);
  assert.deepEqual(docNames, ['run_node_code', 'run_workspace_command', 'sn_b', 'sync_a']);
});

test('docs drift parser derives tool families from the schemas instead of hardcoding them', () => {
  const schemaNames = parseToolNamesFromSchemas('name: "sync_a"\nname: "gh_deploy"\n');

  assert.deepEqual(deriveToolPrefixes(schemaNames), ['gh_', 'sync_']);
  // A brand-new family is matched on both sides, so documenting it satisfies the
  // gate and forgetting it still fails the gate.
  assert.deepEqual(parseToolNamesFromDocs('- sync_a\n- gh_deploy\n', schemaNames), [
    'gh_deploy',
    'sync_a',
  ]);
  assert.deepEqual(parseToolNamesFromDocs('- sync_a\n', schemaNames), ['sync_a']);
});

test('docs drift parser ignores ServiceNow table names mentioned in prose', () => {
  const schemaNames = parseToolNamesFromSchemas('name: "sn_query_records"\n');
  const docsRaw = [
    '- sn_query_records',
    '',
    'The handler reads from `sn_hr_core_case` and sn_customerservice_case tables.',
  ].join('\n');

  assert.deepEqual(parseToolNamesFromDocs(docsRaw, schemaNames), ['sn_query_records']);
});

test('docs drift parser does not match a tool name nested inside a longer identifier', () => {
  const schemaNames = ['sn_query'];

  assert.deepEqual(parseToolNamesFromDocs('Reads the sn_query_table view.', schemaNames), []);
  assert.deepEqual(parseToolNamesFromDocs('Calls `sn_query` first.', schemaNames), ['sn_query']);
});

test('docs drift checker reports missing and extra tools', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-docs-drift-'));
  const schemaFile = path.join(tempDir, 'toolSchemas.ts');
  const catalogFile = path.join(tempDir, 'tools-catalog.md');
  const readmeFile = path.join(tempDir, 'README.md');

  fs.writeFileSync(schemaFile, 'name: "sync_a"\nname: "sn_b"\n');
  fs.writeFileSync(catalogFile, '- sync_a\n- sn_extra\n');
  fs.writeFileSync(readmeFile, '- `sync_a`\n- `sn_b`\n');

  const result = checkDocsDrift({
    toolSource: schemaFile,
    catalogSource: catalogFile,
    readmeSource: readmeFile,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.catalog.missingInDocs, ['sn_b']);
  assert.deepEqual(result.catalog.extraInDocs, ['sn_extra']);
  assert.deepEqual(result.readme.missingInDocs, []);
  assert.deepEqual(result.readme.extraInDocs, []);
});

test('docs drift CLI runner returns 0 on aligned docs', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-docs-drift-'));
  const schemaFile = path.join(tempDir, 'toolSchemas.ts');
  const catalogFile = path.join(tempDir, 'tools-catalog.md');
  const readmeFile = path.join(tempDir, 'README.md');

  fs.writeFileSync(schemaFile, 'name: "sync_a"\nname: "sn_b"\n');
  fs.writeFileSync(catalogFile, '- sync_a\n- sn_b\n');
  fs.writeFileSync(readmeFile, '- `sync_a`\n- `sn_b`\n');

  const logs = [];
  const errors = [];
  const exitCode = runDocsDriftCli({
    toolSource: schemaFile,
    catalogSource: catalogFile,
    readmeSource: readmeFile,
    console: {
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(errors.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Docs drift check passed/);
});

test('release checklist validator passes when artifacts and sections are present', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-release-checklist-'));
  const readmePath = path.join(tempDir, 'README.md');
  const governancePath = path.join(tempDir, 'release-governance.md');
  const changelogPath = path.join(tempDir, 'CHANGELOG.md');

  fs.writeFileSync(readmePath, '# README\n');
  // Mirror whatever the validator currently demands, so adding a required section
  // fails only the docs that lack it -- never these fixtures.
  fs.writeFileSync(governancePath, RELEASE_GOVERNANCE_SECTIONS.join('\n'), 'utf-8');
  fs.writeFileSync(changelogPath, '# Changelog\n\n## [1.0.0] - 2026-05-29\n', 'utf-8');

  const result = validateReleaseChecklist({
    readmePath,
    governancePath,
    changelogPath,
  });

  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.changelogHasReleaseEntries, true);
});

test('release checklist validator reports missing sections and invalid changelog headings', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-release-checklist-'));
  const readmePath = path.join(tempDir, 'README.md');
  const governancePath = path.join(tempDir, 'release-governance.md');
  const changelogPath = path.join(tempDir, 'CHANGELOG.md');

  fs.writeFileSync(readmePath, '# README\n');
  fs.writeFileSync(governancePath, '## Versioning\n', 'utf-8');
  fs.writeFileSync(changelogPath, '# Changelog\n\nNo release headings\n', 'utf-8');

  const result = validateReleaseChecklist({
    readmePath,
    governancePath,
    changelogPath,
  });

  assert.equal(result.ok, false);
  assert.equal(result.missingSections.length >= 1, true);
  assert.equal(result.changelogHasReleaseEntries, false);
  assert.equal(result.errors.some((line) => line.includes('CHANGELOG.md')), true);
});

test('release checklist validator rejects a changelog holding only [Unreleased]', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-release-checklist-'));
  const readmePath = path.join(tempDir, 'README.md');
  const governancePath = path.join(tempDir, 'release-governance.md');
  const changelogPath = path.join(tempDir, 'CHANGELOG.md');

  fs.writeFileSync(readmePath, '# README\n');
  // Mirror whatever the validator currently demands, so adding a required section
  // fails only the docs that lack it -- never these fixtures.
  fs.writeFileSync(governancePath, RELEASE_GOVERNANCE_SECTIONS.join('\n'), 'utf-8');
  fs.writeFileSync(changelogPath, '# Changelog\n\n## [Unreleased]\n\n- pending\n', 'utf-8');

  const result = validateReleaseChecklist({
    readmePath,
    governancePath,
    changelogPath,
  });

  assert.equal(result.changelogHasReleaseEntries, false);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((line) => line.includes('CHANGELOG.md')), true);
});

test('release checklist validator accepts a semver heading alongside [Unreleased]', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-release-checklist-'));
  const readmePath = path.join(tempDir, 'README.md');
  const governancePath = path.join(tempDir, 'release-governance.md');
  const changelogPath = path.join(tempDir, 'CHANGELOG.md');

  fs.writeFileSync(readmePath, '# README\n');
  // Mirror whatever the validator currently demands, so adding a required section
  // fails only the docs that lack it -- never these fixtures.
  fs.writeFileSync(governancePath, RELEASE_GOVERNANCE_SECTIONS.join('\n'), 'utf-8');
  fs.writeFileSync(
    changelogPath,
    '# Changelog\n\n## [Unreleased]\n\n## [0.9.1] - 2026-07-04\n',
    'utf-8'
  );

  const result = validateReleaseChecklist({
    readmePath,
    governancePath,
    changelogPath,
  });

  assert.equal(result.changelogHasReleaseEntries, true);
  assert.equal(result.ok, true);
});

test('release checklist validator rejects governance sections demoted to a deeper heading level', () => {
  // Every required `## Section` is present only as `### Section`. A page-wide
  // substring match would find "## Versioning" inside "### Versioning" and pass,
  // letting a top-level governance section quietly vanish; the anchored
  // line-start check must flag all of them.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-release-checklist-'));
  const readmePath = path.join(tempDir, 'README.md');
  const governancePath = path.join(tempDir, 'release-governance.md');
  const changelogPath = path.join(tempDir, 'CHANGELOG.md');

  fs.writeFileSync(readmePath, '# README\n');
  const demoted = RELEASE_GOVERNANCE_SECTIONS.map((section) => `#${section}`).join('\n') + '\n';
  fs.writeFileSync(governancePath, demoted, 'utf-8');
  fs.writeFileSync(changelogPath, '# Changelog\n\n## [1.0.0] - 2026-05-29\n', 'utf-8');

  const result = validateReleaseChecklist({ readmePath, governancePath, changelogPath });

  assert.equal(result.ok, false);
  assert.deepEqual(result.missingSections, RELEASE_GOVERNANCE_SECTIONS);
  // The changelog is valid, so the demoted sections are the only failures.
  assert.equal(result.changelogHasReleaseEntries, true);
});

test('release checklist CLI returns 1 and prints failures', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-release-checklist-'));
  const readmePath = path.join(tempDir, 'README.md');
  const governancePath = path.join(tempDir, 'release-governance.md');
  const changelogPath = path.join(tempDir, 'CHANGELOG.md');

  fs.writeFileSync(readmePath, '# README\n');
  fs.writeFileSync(governancePath, '## Versioning\n', 'utf-8');
  fs.writeFileSync(changelogPath, '# Changelog\n\nNo release headings\n', 'utf-8');

  const logs = [];
  const errors = [];
  const exitCode = runReleaseChecklistCli({
    readmePath,
    governancePath,
    changelogPath,
    console: {
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(logs.length, 0);
  assert.equal(errors[0], 'Release checklist failed.');
  assert.equal(errors.some((line) => line.includes('Missing governance section:')), true);
});

const CLAUDE_REQUIRED_SECTIONS = [
  '## Purpose',
  '## Workspace Layout',
  '## Quality Gates',
  '## Command Reference',
  '## Documentation Drift Policy',
];

// A README command table row only counts when it sits under `### Commands` and
// documents an `npx syncrona ...` invocation.
function readmeCommandTable(rows) {
  return [
    '### Commands',
    '',
    '| Command | Aliases | Description | Example |',
    '| --- | --- | --- | --- |',
    ...rows.map((name) => `| \`${name}\` | none | Does a thing. | \`npx syncrona ${name}\` |`),
    '',
  ].join('\n');
}

function claudeDoc(commands, sections = CLAUDE_REQUIRED_SECTIONS) {
  return [...sections, ...commands.map((name) => `- \`npx syncrona ${name}\` does a thing.`)].join(
    '\n'
  );
}

// Shape mirrors the `command:` entries of packages/core/src/cliCommands.ts, whose
// four-space indentation the registry parser keys on.
function cliCommandsSource(entries) {
  const body = entries
    .map((entry) => {
      const value = Array.isArray(entry)
        ? `[${entry.map((alias) => `"${alias}"`).join(', ')}]`
        : `"${entry}"`;
      return `  {\n    command: ${value},\n    describe: "Does a thing.",\n  },`;
    })
    .join('\n');
  return `export const cliCommands = [\n${body}\n];\n`;
}

function writeClaudeDriftFixture({ readmeRows, claudeCommands, registry, sections }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-claude-drift-'));
  const readmeSource = path.join(tempDir, 'README.md');
  const claudeSource = path.join(tempDir, 'CLAUDE.md');
  const cliCommandsSourcePath = path.join(tempDir, 'cliCommands.ts');

  fs.writeFileSync(readmeSource, readmeCommandTable(readmeRows), 'utf-8');
  fs.writeFileSync(claudeSource, claudeDoc(claudeCommands, sections), 'utf-8');
  fs.writeFileSync(cliCommandsSourcePath, cliCommandsSource(registry), 'utf-8');

  return { readmeSource, claudeSource, cliCommandsSource: cliCommandsSourcePath };
}

test('CLAUDE docs drift parser extracts command names from README and CLAUDE docs', () => {
  const readmeRaw = readmeCommandTable(['refresh', 'download <scope>', 'status']);
  const claudeRaw = claudeDoc(['refresh', 'download', 'status'], []);

  assert.deepEqual(parseCommandNamesFromReadme(readmeRaw), ['download', 'refresh', 'status']);
  assert.deepEqual(parseCommandNamesFromClaude(claudeRaw), ['download', 'refresh', 'status']);
});

test('CLAUDE docs drift parser ignores tables outside the command section', () => {
  // README also documents environment variables in backticked-first-cell tables.
  // Those rows are not CLI commands and must not be parsed as such, otherwise the
  // drift gate demands a nonexistent `npx syncrona jira_base_url` entry in
  // CLAUDE.md.
  const readmeRaw = [
    readmeCommandTable(['jira']),
    '### Environment',
    '',
    '| Variable | Purpose |',
    '| --- | --- |',
    '| `JIRA_BASE_URL` | Jira base URL. |',
    '| `JIRA_TOKEN` | Cloud API token or PAT. |',
    '| `logLevel` | Verbosity. |',
  ].join('\n');

  assert.deepEqual(parseCommandNamesFromReadme(readmeRaw), ['jira']);
});

test('CLAUDE docs drift parser yields nothing when the command table heading is missing', () => {
  // An empty slice makes the command comparison fail loudly rather than silently
  // agreeing that zero commands are documented.
  const readmeRaw = '| `refresh` | none | Refresh. | `npx syncrona refresh` |\n';

  assert.equal(sliceCommandTableSection(readmeRaw), '');
  assert.deepEqual(parseCommandNamesFromReadme(readmeRaw), []);
});

test('CLAUDE docs drift validator reports missing sections and missing command docs', () => {
  const fixture = writeClaudeDriftFixture({
    readmeRows: ['refresh', 'status', 'doctor'],
    claudeCommands: ['refresh'],
    registry: ['refresh', 'status', 'doctor'],
    sections: ['## Purpose', '## Command Reference'],
  });

  const result = validateClaudeDocsDrift(fixture);

  assert.equal(result.ok, false);
  assert.equal(result.missingSections.length > 0, true);
  assert.deepEqual(result.missingCommandDocs, ['doctor', 'status']);
});

test('CLAUDE docs drift validator flags a command dropped from the README table', () => {
  // The exact regression the two-way check exists for: deleting the `doctor` row
  // from the README used to pass every gate.
  const fixture = writeClaudeDriftFixture({
    readmeRows: ['refresh', 'status'],
    claudeCommands: ['refresh', 'status', 'doctor'],
    registry: ['refresh', 'status', 'doctor'],
  });

  const result = validateClaudeDocsDrift(fixture);

  assert.equal(result.ok, false);
  assert.deepEqual(result.missingReadmeDocs, ['doctor']);
  assert.deepEqual(result.undocumentedInReadme, ['doctor']);
  assert.equal(
    result.errors.some((line) => line.includes('Missing command in README command table: doctor')),
    true
  );
});

test('CLAUDE docs drift validator flags a documented command missing from the registry', () => {
  const fixture = writeClaudeDriftFixture({
    readmeRows: ['refresh', 'legacy'],
    claudeCommands: ['refresh', 'legacy'],
    registry: ['refresh'],
  });

  const result = validateClaudeDocsDrift(fixture);

  assert.equal(result.ok, false);
  assert.deepEqual(result.unknownCommandDocs, ['legacy']);
  assert.equal(
    result.errors.some((line) =>
      line.includes('Documented command not registered in cliCommands.ts: legacy')
    ),
    true
  );
});

test('CLAUDE docs drift validator rejects a required section demoted to a deeper heading level', () => {
  // "## Documentation Drift Policy" is present only as "### Documentation Drift
  // Policy". A substring match still finds the required heading nested inside the
  // demoted one and passes; the anchored line-start check must flag it missing.
  const fixture = writeClaudeDriftFixture({
    readmeRows: ['refresh'],
    claudeCommands: ['refresh'],
    registry: ['refresh'],
    sections: [
      '## Purpose',
      '## Workspace Layout',
      '## Quality Gates',
      '## Command Reference',
      '### Documentation Drift Policy',
    ],
  });

  const result = validateClaudeDocsDrift(fixture);

  assert.equal(result.ok, false);
  assert.deepEqual(result.missingSections, ['## Documentation Drift Policy']);
  assert.equal(
    result.errors.some((line) =>
      line.includes('Missing required CLAUDE.md section: ## Documentation Drift Policy')
    ),
    true
  );
});

test('CLAUDE docs drift CLI runner returns 0 on aligned docs', () => {
  // `dev` is registered through an alias array, `download <scope>` through a
  // positional-argument string; both reduce to their primary name.
  const fixture = writeClaudeDriftFixture({
    readmeRows: ['refresh', 'status', 'dev', 'download <scope>'],
    claudeCommands: ['refresh', 'status', 'dev', 'download'],
    registry: ['refresh', 'status', ['dev', 'd'], 'download <scope>'],
  });

  const logs = [];
  const errors = [];
  const exitCode = runClaudeDocsDriftCli({
    ...fixture,
    console: {
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(errors.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /CLAUDE docs drift check passed \(4 commands aligned with cliCommands\.ts\)\./);
});

// This runs the live gate against the live repository, so it turns red during the
// test phase of `npm run check` -- before the gate itself would have run. The hint
// keeps that failure legible: the usual cause is a version bump that never reached
// the site.
const CLAIMS_DRIFT_HINT =
  'See "Version bump procedure" in packages/mcp-server/docs/release-governance.md: ' +
  'bump the docs/index.html badge and JSON-LD softwareVersion before running the tests.';

test('claims drift checker passes against the real repo artifacts', () => {
  const logs = [];
  const errors = [];
  const exitCode = runClaimsDriftCli({ console: { log: (m) => logs.push(m), error: (m) => errors.push(m) } });
  assert.equal(exitCode, 0, [...errors, '', CLAIMS_DRIFT_HINT].join('\n'));
  assert.match(logs[0], /Claims drift check passed/);
});

test('claims drift checker flags a missing marker and a resurrected old bin name', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-claims-drift-'));
  fs.mkdirSync(path.join(tempDir, 'docs'), { recursive: true });
  // README keeps the brand but drops the bin name; the comparison page resurrects
  // the old `npx syncro-now-ai` invocation; the site is missing entirely.
  fs.writeFileSync(path.join(tempDir, 'README.md'), 'SyncroNow AI is great.', 'utf-8');
  fs.writeFileSync(path.join(tempDir, 'docs', 'COMPARISON.md'), 'SyncroNow AI\nRun `npx syncro-now-ai push`.', 'utf-8');

  const result = validateClaimsDrift({ rootDir: tempDir });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /Missing required claim "syncrona" in README\.md/.test(e)));
  assert.ok(result.errors.some((e) => /Forbidden claim npx syncro-now-ai .* in docs\/COMPARISON\.md/.test(e)));
  assert.ok(result.errors.some((e) => /Missing claims artifact: docs\/index\.html/.test(e)));
});

test('extractAuthSection isolates the security section and returns null when absent', () => {
  const html =
    '<section id="intro">intro mentions basic auth prose</section>' +
    '<section class="x" id="security">only here: --auth-method basic</section>' +
    '<section id="faq">frequently asked</section>';

  const section = extractAuthSection(html);
  assert.ok(section.includes('--auth-method basic'));
  assert.ok(!section.includes('intro mentions'));
  assert.ok(!section.includes('frequently asked'));
  assert.equal(extractAuthSection('<html>no security anchor</html>'), null);
});

test('claims drift auth gate flags a method whose only match is a substring like "basically"', () => {
  // The security section documents every method EXCEPT basic, yet contains the
  // word "basically". Under the old page-wide substring match that stray word
  // satisfied "basic" even with every real Basic-auth reference removed. The
  // section-scoped, word-boundary check must still flag basic while leaving the
  // five genuinely-documented methods alone.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-claims-auth-'));
  const indexHtmlPath = path.join(tempDir, 'index.html');
  const authSection = [
    '<section class="section" id="security">',
    '  <h2>Security &amp; credentials</h2>',
    '  <p>Configuration is basically self-service.</p>',
    '  <code>--auth-method oauth-password</code>',
    '  <code>--auth-method oauth-client-credentials</code>',
    '  <code>--auth-method oauth-jwt-bearer</code>',
    '  <code>--auth-method api-key</code>',
    '  <p>Mutual TLS (mTLS) may be layered on top.</p>',
    '</section>',
  ].join('\n');
  fs.writeFileSync(indexHtmlPath, `<html><body>${authSection}</body></html>`, 'utf-8');

  const result = validateClaimsDrift({ indexHtmlPath });

  assert.ok(
    result.errors.some((e) => /Missing auth method "basic"/.test(e)),
    'basic must be flagged even though "basically" is present in the section'
  );
  for (const documented of [
    'oauth-password',
    'oauth-client-credentials',
    'oauth-jwt-bearer',
    'api-key',
    'mtls',
  ]) {
    assert.ok(
      !result.errors.some((e) => e.includes(`Missing auth method "${documented}"`)),
      `${documented} is documented in the section and must not be flagged`
    );
  }
});

test('claims drift auth gate reports a missing security section instead of passing', () => {
  // Deleting the whole `id="security"` section must be reported, rather than
  // silently finding zero methods to check.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-claims-auth-'));
  const indexHtmlPath = path.join(tempDir, 'index.html');
  fs.writeFileSync(
    indexHtmlPath,
    '<html><body><section id="hero">no auth here</section></body></html>',
    'utf-8'
  );

  const result = validateClaimsDrift({ indexHtmlPath });

  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => /Missing auth section \(id="security"\) in docs\/index\.html/.test(e)),
    'the absent security section must be reported'
  );
  // With no section there is nothing to check per-method, so no per-method errors.
  assert.ok(!result.errors.some((e) => /Missing auth method/.test(e)));
});

test('claims drift CLI parses index.html overrides from an argument, a flag, or the env', () => {
  const node = ['node', 'check-claims-drift.js'];

  assert.deepEqual(parseClaimsRuntimeOverrides({}, [...node, '/tmp/a.html']), {
    indexHtmlPath: '/tmp/a.html',
    unknownArgs: [],
    help: false,
  });
  assert.deepEqual(parseClaimsRuntimeOverrides({}, [...node, '--index-html=/tmp/b.html']), {
    indexHtmlPath: '/tmp/b.html',
    unknownArgs: [],
    help: false,
  });
  // An explicit argument beats the ambient env override.
  assert.equal(
    parseClaimsRuntimeOverrides({ SYNC_CLAIMS_INDEX_HTML: '/tmp/env.html' }, [...node, '/tmp/a.html'])
      .indexHtmlPath,
    '/tmp/a.html'
  );
  assert.equal(
    parseClaimsRuntimeOverrides({ SYNC_CLAIMS_INDEX_HTML: '/tmp/env.html' }, node).indexHtmlPath,
    '/tmp/env.html'
  );
  assert.equal(parseClaimsRuntimeOverrides({}, node).indexHtmlPath, undefined);
});

test('claims drift CLI rejects flag-looking arguments instead of reading them as a path', () => {
  const argv = ['node', 'check-claims-drift.js', '--verbose'];
  const overrides = parseClaimsRuntimeOverrides({}, argv);

  // `--verbose` used to become the index.html path and fail downstream with a
  // confusing "Missing claims source" error.
  assert.equal(overrides.indexHtmlPath, undefined);
  assert.deepEqual(overrides.unknownArgs, ['--verbose']);

  const logs = [];
  const errors = [];
  const exitCode = runClaimsDriftCli({
    ...overrides,
    console: { log: (m) => logs.push(m), error: (m) => errors.push(m) },
  });

  assert.equal(exitCode, 1);
  assert.equal(logs.length, 0);
  assert.match(errors[0], /Unrecognized argument: --verbose/);
  assert.match(errors.join('\n'), /Usage: node check-claims-drift\.js/);
});

test('claims drift CLI rejects an empty --index-html value and a stray second path', () => {
  const node = ['node', 'check-claims-drift.js'];

  assert.deepEqual(parseClaimsRuntimeOverrides({}, [...node, '--index-html=']).unknownArgs, [
    '--index-html=',
  ]);
  assert.deepEqual(parseClaimsRuntimeOverrides({}, [...node, '/tmp/a.html', '/tmp/b.html']), {
    indexHtmlPath: '/tmp/a.html',
    unknownArgs: ['/tmp/b.html'],
    help: false,
  });
});

test('claims drift CLI prints usage and returns 0 for --help', () => {
  const overrides = parseClaimsRuntimeOverrides({}, ['node', 'check-claims-drift.js', '--help']);
  assert.equal(overrides.help, true);

  const logs = [];
  const errors = [];
  const exitCode = runClaimsDriftCli({
    ...overrides,
    console: { log: (m) => logs.push(m), error: (m) => errors.push(m) },
  });

  assert.equal(exitCode, 0);
  assert.equal(errors.length, 0);
  assert.match(logs[0], /Usage: node check-claims-drift\.js/);
});

test('getToolLifecycleMetadata resolves version metadata with overrides and defaults', () => {
  const overridden = getToolLifecycleMetadata('run_workspace_command');
  assert.ok(overridden);
  assert.equal(overridden.version, '1.1.0');
  assert.equal(overridden.deprecated, false);

  const defaulted = getToolLifecycleMetadata('sync_status');
  assert.ok(defaulted);
  assert.equal(defaulted.version, '1.0.0');
  assert.equal(defaulted.deprecated, false);

  assert.equal(getToolLifecycleMetadata('nonexistent_tool_xyz'), undefined);
});
