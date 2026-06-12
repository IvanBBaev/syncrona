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
  parseToolNamesFromDocs,
  parseToolNamesFromSchemas,
  runCli: runDocsDriftCli,
} = require('../scripts/check-docs-drift.js');
const {
  validateReleaseChecklist,
  runCli: runReleaseChecklistCli,
} = require('../scripts/validate-release-checklist.js');
const {
  validateClaudeDocsDrift,
  parseCommandNamesFromReadme,
  parseCommandNamesFromClaude,
  runCli: runClaudeDocsDriftCli,
} = require('../scripts/check-claude-docs-drift.js');
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
  const schemaRaw = 'name: "sync_a"\nname: "sn_b"\nname: "sync_a"\n';
  const docsRaw = [
    '- sync_a',
    '- sn_b',
    '- run_workspace_command',
    '`sync_a`',
    '`run_node_code`',
  ].join('\n');

  const schemaNames = parseToolNamesFromSchemas(schemaRaw);
  const docNames = parseToolNamesFromDocs(docsRaw);

  assert.deepEqual(schemaNames, ['sn_b', 'sync_a']);
  assert.deepEqual(docNames, ['run_node_code', 'run_workspace_command', 'sn_b', 'sync_a']);
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
  fs.writeFileSync(
    governancePath,
    [
      '## Versioning',
      '## Changelog policy',
      '## Backward compatibility notes',
      '## Audit retention guidance',
      '## Incident response guidance',
    ].join('\n'),
    'utf-8'
  );
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

test('CLAUDE docs drift parser extracts command names from README and CLAUDE docs', () => {
  const readmeRaw = [
    '| `refresh` | none |',
    '| `download <scope>` | none |',
    '| `status` | none |',
  ].join('\n');
  const claudeRaw = [
    '- `npx syncrona refresh`',
    '- `npx syncrona download`',
    '- `npx syncrona status`',
  ].join('\n');

  assert.deepEqual(parseCommandNamesFromReadme(readmeRaw), ['download', 'refresh', 'status']);
  assert.deepEqual(parseCommandNamesFromClaude(claudeRaw), ['download', 'refresh', 'status']);
});

test('CLAUDE docs drift validator reports missing sections and missing command docs', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-claude-drift-'));
  const readmePath = path.join(tempDir, 'README.md');
  const claudePath = path.join(tempDir, 'CLAUDE.md');

  fs.writeFileSync(
    readmePath,
    ['| `refresh` | none |', '| `status` | none |', '| `doctor` | none |'].join('\n'),
    'utf-8'
  );
  fs.writeFileSync(
    claudePath,
    ['## Purpose', '## Command Reference', '- `npx syncrona refresh`'].join('\n'),
    'utf-8'
  );

  const result = validateClaudeDocsDrift({
    readmeSource: readmePath,
    claudeSource: claudePath,
  });

  assert.equal(result.ok, false);
  assert.equal(result.missingSections.length > 0, true);
  assert.deepEqual(result.missingCommandDocs, ['doctor', 'status']);
});

test('CLAUDE docs drift CLI runner returns 0 on aligned docs', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-claude-drift-'));
  const readmePath = path.join(tempDir, 'README.md');
  const claudePath = path.join(tempDir, 'CLAUDE.md');

  fs.writeFileSync(
    readmePath,
    ['| `refresh` | none |', '| `status` | none |'].join('\n'),
    'utf-8'
  );
  fs.writeFileSync(
    claudePath,
    [
      '## Purpose',
      '## Workspace Layout',
      '## Quality Gates',
      '## Command Reference',
      '## Documentation Drift Policy',
      '- `npx syncrona refresh`',
      '- `npx syncrona status`',
    ].join('\n'),
    'utf-8'
  );

  const logs = [];
  const errors = [];
  const exitCode = runClaudeDocsDriftCli({
    readmeSource: readmePath,
    claudeSource: claudePath,
    console: {
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(errors.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /CLAUDE docs drift check passed/);
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
