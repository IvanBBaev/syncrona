// SPDX-License-Identifier: GPL-3.0-or-later
// sync_diff_instance_vs_local built a record's local value by joining EVERY file the
// manifest lists for it, while the instance side reads one script column. Every
// record carries the `.meta` sidecar pseudo-file (DX22) and some carry further
// script/html fields, so an untouched record always read as "changed". The local
// side must read only the file of the compared field.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handleDeveloperTool } = require('../dist/handlers/developerToolHandlers.js');

const SCRIPT = 'var MyUtil = Class.create();\n';

function mkProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-script-field-'));
  fs.writeFileSync(
    path.join(dir, 'sync.manifest.json'),
    JSON.stringify({
      tables: {
        sys_script_include: {
          records: { MyUtil: { name: 'MyUtil', sys_id: 'abc', files } },
        },
      },
    })
  );
  const recordDir = path.join(dir, 'src', 'sys_script_include', 'MyUtil');
  fs.mkdirSync(recordDir, { recursive: true });
  fs.writeFileSync(path.join(recordDir, 'script.js'), SCRIPT);
  fs.writeFileSync(path.join(recordDir, '.meta.json'), '{"active":"true","api_name":"x_app.MyUtil"}\n');
  return dir;
}

function makeContext(projectDir) {
  return {
    timeoutMs: 1000,
    projectDir,
    layout: { sourceDirectory: 'src', flat: false },
    resolveScope: async () => 'x_app',
    tableGet: async () => [{ sys_id: 'abc', name: 'MyUtil', script: SCRIPT }],
  };
}

test('the .meta sidecar does not make an untouched record read as changed', async () => {
  const dir = mkProject([
    { name: 'script', type: 'js' },
    { name: '.meta', type: 'json' },
  ]);
  try {
    const res = await handleDeveloperTool(
      'sync_diff_instance_vs_local',
      { tableName: 'sys_script_include', recordName: 'MyUtil' },
      makeContext(dir)
    );
    assert.equal(res.isError, false);
    const payload = JSON.parse(res.content[0].text);
    assert.deepEqual(payload.missingLocalFiles, []);
    assert.equal(payload.report.summary.changed, 0);
    assert.equal(payload.report.summary.unchanged, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a record whose manifest lists no file for the compared field reports it missing', async () => {
  const dir = mkProject([{ name: '.meta', type: 'json' }]);
  fs.rmSync(path.join(dir, 'src', 'sys_script_include', 'MyUtil', 'script.js'));
  try {
    const res = await handleDeveloperTool(
      'sync_diff_instance_vs_local',
      { tableName: 'sys_script_include', recordName: 'MyUtil' },
      makeContext(dir)
    );
    const payload = JSON.parse(res.content[0].text);
    assert.deepEqual(payload.missingLocalFiles, [path.join('src', 'sys_script_include', 'MyUtil', 'script.js')]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
