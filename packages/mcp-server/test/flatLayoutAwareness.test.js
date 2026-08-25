// SPDX-License-Identifier: GPL-3.0-or-later
//
// DX17 flat-layout awareness for the MCP server.
//
// The core CLI supports two on-disk layouts for a record's field files
// (packages/core/src/flatLayout.ts, selected by `flat: true` in sync.config.js):
//
//   record-folder (default)  <sourceDirectory>/<table>/<record>/<field>.<ext>
//   flat                     <sourceDirectory>/<table>/<record>~<field>.<ext>
//
// The MCP server used to know only the first one, and both production readers of
// a record's local files hardcoded it. That is worse than an unsupported feature,
// because neither reader errors when the path is wrong:
//
//   - `sync_diff_instance_vs_local` probes each manifest file with existsSync.
//     Under `flat: true` every probe missed, the local side came back with an
//     EMPTY body, and the tool reported a plausible-looking "changed" record for
//     a file that is byte-identical to the instance.
//   - `createAndSyncScriptInclude` returned `localPaths` that do not exist, plus a
//     `nextStep` telling the agent to go and edit one of them.
//
// These tests pin BOTH directions: the flat layout must be found when it is
// configured, and a file that is genuinely absent must still read as absent — the
// fix must not degenerate into "try every layout until something exists".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handleDeveloperTool } = require('../dist/handlers/developerToolHandlers.js');
const {
  findScriptIncludeLocalPaths,
  getSourceDirectory,
} = require('../dist/toolService.js');
const {
  FLAT_FIELD_SEPARATOR,
  readWorkspaceLayout,
  recordFieldFilePath,
} = require('../dist/workspaceLayout.js');

const SCRIPT_BODY = 'var MyUtil = Class.create();\nMyUtil.prototype = {};';

// Every case gets its OWN temp dir: sync.config.js is loaded with require(), so a
// reused directory would be served from the module cache with the previous case's
// `flat` value.
function tmpProject(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `syncrona-flat-${prefix}-`));
}

function writeManifest(dir, table, recordName) {
  fs.writeFileSync(
    path.join(dir, 'sync.manifest.json'),
    JSON.stringify({
      tables: {
        [table]: {
          records: {
            rec_1: {
              name: recordName,
              sys_id: 'sid-1',
              sys_updated_on: '2024-01-01 00:00:00',
              files: [{ name: 'script', type: 'js' }],
            },
          },
        },
      },
    }),
    'utf-8'
  );
}

function writeConfig(dir, contents) {
  fs.writeFileSync(path.join(dir, 'sync.config.js'), contents, 'utf-8');
}

// The two layouts, written by hand rather than through the module under test so
// the fixtures stay an independent statement of the contract.
function writeNestedFile(dir, sourceDir, table, recordName, contents) {
  const recordDir = path.join(dir, sourceDir, table, recordName);
  fs.mkdirSync(recordDir, { recursive: true });
  fs.writeFileSync(path.join(recordDir, 'script.js'), contents, 'utf-8');
  return path.join(recordDir, 'script.js');
}

function writeFlatFile(dir, sourceDir, table, recordName, contents) {
  const tableDir = path.join(dir, sourceDir, table);
  fs.mkdirSync(tableDir, { recursive: true });
  const file = path.join(tableDir, `${recordName}~script.js`);
  fs.writeFileSync(file, contents, 'utf-8');
  return file;
}

function makeDiffContext(projectDir, layout, instanceScript) {
  return {
    timeoutMs: 1000,
    projectDir,
    layout,
    resolveScope: async () => 'unknown_scope',
    tableGet: async () => [
      {
        sys_id: 'sid-1',
        name: 'MyUtil',
        script: instanceScript,
        sys_updated_on: '2024-01-01 00:00:00',
      },
    ],
  };
}

async function runDiff(projectDir, layout, instanceScript) {
  const res = await handleDeveloperTool(
    'sync_diff_instance_vs_local',
    { tableName: 'sys_script_include', recordName: 'MyUtil' },
    makeDiffContext(projectDir, layout, instanceScript)
  );
  assert.equal(res.isError, false);
  return JSON.parse(res.content[0].text).report;
}

// ---------------------------------------------------------------------------
// workspaceLayout — the single seam both readers go through
// ---------------------------------------------------------------------------

test('readWorkspaceLayout reports flat: false when sync.config.js is absent', () => {
  const dir = tmpProject('layout-none');
  try {
    assert.deepEqual(readWorkspaceLayout(dir), { sourceDirectory: 'src', flat: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readWorkspaceLayout reads flat: true together with a custom sourceDirectory', () => {
  const dir = tmpProject('layout-flat');
  try {
    writeConfig(dir, 'module.exports = { sourceDirectory: "app-src", flat: true };');
    assert.deepEqual(readWorkspaceLayout(dir), { sourceDirectory: 'app-src', flat: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readWorkspaceLayout treats a truthy non-true flat value as nested (strict === true, like core)', () => {
  const dir = tmpProject('layout-truthy');
  try {
    writeConfig(dir, 'module.exports = { flat: "yes" };');
    assert.deepEqual(readWorkspaceLayout(dir), { sourceDirectory: 'src', flat: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readWorkspaceLayout unwraps a default export and survives a throwing config', () => {
  const withDefault = tmpProject('layout-default');
  try {
    writeConfig(withDefault, 'module.exports = { default: { sourceDirectory: "d", flat: true } };');
    assert.deepEqual(readWorkspaceLayout(withDefault), { sourceDirectory: 'd', flat: true });
  } finally {
    fs.rmSync(withDefault, { recursive: true, force: true });
  }

  const throwing = tmpProject('layout-throws');
  try {
    writeConfig(throwing, 'throw new Error("boom");');
    assert.deepEqual(readWorkspaceLayout(throwing), { sourceDirectory: 'src', flat: false });
  } finally {
    fs.rmSync(throwing, { recursive: true, force: true });
  }
});

test('recordFieldFilePath encodes the separator exactly as packages/core/src/flatLayout.ts does', () => {
  assert.equal(FLAT_FIELD_SEPARATOR, '~');
  const nested = recordFieldFilePath(
    '/proj',
    { sourceDirectory: 'src', flat: false },
    'sys_script_include',
    'MyUtil',
    'script',
    'js'
  );
  assert.equal(nested, path.join('/proj', 'src', 'sys_script_include', 'MyUtil', 'script.js'));

  const flat = recordFieldFilePath(
    '/proj',
    { sourceDirectory: 'src', flat: true },
    'sys_script_include',
    'MyUtil',
    'script',
    'js'
  );
  assert.equal(flat, path.join('/proj', 'src', 'sys_script_include', 'MyUtil~script.js'));
});

test('recordFieldFilePath splits a record name containing the separator on the LAST one', () => {
  // core's folderRelToFlat joins record + '~' + field, so a record already holding
  // a '~' round-trips because flatRelToFolder splits on the LAST separator.
  const flat = recordFieldFilePath(
    '/proj',
    { sourceDirectory: 'src', flat: true },
    'sys_script_include',
    'Odd~Name',
    'script',
    'js'
  );
  assert.equal(flat, path.join('/proj', 'src', 'sys_script_include', 'Odd~Name~script.js'));
});

// ---------------------------------------------------------------------------
// sync_diff_instance_vs_local
// ---------------------------------------------------------------------------

test('sync_diff_instance_vs_local: a flat workspace finds the local file and reports it unchanged', async () => {
  const dir = tmpProject('diff-flat');
  try {
    writeManifest(dir, 'sys_script_include', 'MyUtil');
    writeFlatFile(dir, 'src', 'sys_script_include', 'MyUtil', SCRIPT_BODY);
    const report = await runDiff(dir, { sourceDirectory: 'src', flat: true }, SCRIPT_BODY);
    assert.equal(
      report.summary.unchanged,
      1,
      'an identical flat-layout file must read as unchanged, not as a diff'
    );
    assert.equal(report.summary.changed, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sync_diff_instance_vs_local: the record-folder layout keeps working', async () => {
  const dir = tmpProject('diff-nested');
  try {
    writeManifest(dir, 'sys_script_include', 'MyUtil');
    writeNestedFile(dir, 'src', 'sys_script_include', 'MyUtil', SCRIPT_BODY);
    const report = await runDiff(dir, { sourceDirectory: 'src', flat: false }, SCRIPT_BODY);
    assert.equal(report.summary.unchanged, 1);
    assert.equal(report.summary.changed, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sync_diff_instance_vs_local: a flat workspace honours a custom sourceDirectory', async () => {
  const dir = tmpProject('diff-flat-srcdir');
  try {
    writeManifest(dir, 'sys_script_include', 'MyUtil');
    writeFlatFile(dir, 'app-src', 'sys_script_include', 'MyUtil', SCRIPT_BODY);
    const report = await runDiff(dir, { sourceDirectory: 'app-src', flat: true }, SCRIPT_BODY);
    assert.equal(report.summary.unchanged, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sync_diff_instance_vs_local: a genuinely missing file in a flat workspace is still a diff', async () => {
  // The guard against "fix it by trying both layouts": nothing is on disk at all,
  // so the local body must stay empty and the record must come back as changed.
  const dir = tmpProject('diff-flat-missing');
  try {
    writeManifest(dir, 'sys_script_include', 'MyUtil');
    const report = await runDiff(dir, { sourceDirectory: 'src', flat: true }, SCRIPT_BODY);
    assert.equal(report.summary.unchanged, 0);
    assert.equal(report.summary.changed, 1);
    assert.equal(report.changed[0].localLength, 0, 'a missing file must not be read from anywhere');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sync_diff_instance_vs_local: a flat workspace does not fall back to a stray record-folder file', async () => {
  // A leftover from before `flat: true` was switched on is NOT the file this
  // workspace syncs; reading it would report a stale body as the local truth.
  const dir = tmpProject('diff-flat-stray-nested');
  try {
    writeManifest(dir, 'sys_script_include', 'MyUtil');
    writeNestedFile(dir, 'src', 'sys_script_include', 'MyUtil', SCRIPT_BODY);
    const report = await runDiff(dir, { sourceDirectory: 'src', flat: true }, SCRIPT_BODY);
    assert.equal(report.summary.unchanged, 0);
    assert.equal(report.summary.changed, 1);
    assert.equal(report.changed[0].localLength, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sync_diff_instance_vs_local: a nested workspace does not fall back to a stray flat file', async () => {
  const dir = tmpProject('diff-nested-stray-flat');
  try {
    writeManifest(dir, 'sys_script_include', 'MyUtil');
    writeFlatFile(dir, 'src', 'sys_script_include', 'MyUtil', SCRIPT_BODY);
    const report = await runDiff(dir, { sourceDirectory: 'src', flat: false }, SCRIPT_BODY);
    assert.equal(report.summary.unchanged, 0);
    assert.equal(report.summary.changed, 1);
    assert.equal(report.changed[0].localLength, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// findScriptIncludeLocalPaths (createAndSyncScriptInclude's `localPaths`)
// ---------------------------------------------------------------------------

test('findScriptIncludeLocalPaths returns flat paths that exist on disk under flat: true', () => {
  const dir = tmpProject('paths-flat');
  try {
    writeConfig(dir, 'module.exports = { sourceDirectory: "src", flat: true };');
    writeManifest(dir, 'sys_script_include', 'MyUtil');
    const expected = writeFlatFile(dir, 'src', 'sys_script_include', 'MyUtil', SCRIPT_BODY);

    const paths = findScriptIncludeLocalPaths('MyUtil', dir);
    assert.deepEqual(paths, [expected]);
    // The tool's `nextStep` tells the agent to edit one of these, so they have to
    // be real files, not a plausible-looking string.
    assert.ok(fs.existsSync(paths[0]), `localPaths must point at a file that exists: ${paths[0]}`);
    assert.ok(path.basename(paths[0]).includes(FLAT_FIELD_SEPARATOR));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findScriptIncludeLocalPaths keeps the record-folder layout when flat is not set', () => {
  const dir = tmpProject('paths-nested');
  try {
    writeConfig(dir, 'module.exports = { sourceDirectory: "src" };');
    writeManifest(dir, 'sys_script_include', 'MyUtil');
    const expected = writeNestedFile(dir, 'src', 'sys_script_include', 'MyUtil', SCRIPT_BODY);
    assert.deepEqual(findScriptIncludeLocalPaths('MyUtil', dir), [expected]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findScriptIncludeLocalPaths combines flat: true with a custom sourceDirectory', () => {
  const dir = tmpProject('paths-flat-srcdir');
  try {
    writeConfig(dir, 'module.exports = { sourceDirectory: "app-src", flat: true };');
    writeManifest(dir, 'sys_script_include', 'MyUtil');
    assert.deepEqual(findScriptIncludeLocalPaths('MyUtil', dir), [
      path.join(dir, 'app-src', 'sys_script_include', 'MyUtil~script.js'),
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getSourceDirectory still answers only the directory question after the layout split', () => {
  const dir = tmpProject('srcdir-flat');
  try {
    writeConfig(dir, 'module.exports = { sourceDirectory: "app-src", flat: true };');
    assert.equal(getSourceDirectory(dir), 'app-src');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
