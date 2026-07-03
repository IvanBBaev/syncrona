// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  handleDeveloperTool,
} = require('../dist/handlers/developerToolHandlers.js');

function makeContext(overrides = {}) {
  return {
    timeoutMs: 1000,
    projectDir: '/tmp/does-not-exist',
    sourceDirectory: 'src',
    resolveScope: async () => 'unknown_scope',
    tableGet: async () => [],
    ...overrides,
  };
}

function mkTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dev-tool-handlers-cov-'));
}

// ---------------------------------------------------------------------------
// sync_suggest_tests
// ---------------------------------------------------------------------------

test('sync_suggest_tests: missing both scriptIncludeName and scriptIncludeSysId is rejected', async () => {
  const res = await handleDeveloperTool('sync_suggest_tests', { script: '' }, makeContext());
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Provide scriptIncludeName or scriptIncludeSysId/);
});

test('sync_suggest_tests: resolves by sysId when name is absent, hits instance', async () => {
  let capturedQuery = null;
  const ctx = makeContext({
    tableGet: async (table, opts) => {
      capturedQuery = opts.query;
      assert.equal(table, 'sys_script_include');
      return [
        {
          sys_id: 'abc123',
          name: 'ResolvedName',
          script: 'var ResolvedName = Class.create();\nResolvedName.prototype = { doThing: function(a, b) {} };',
          client_callable: 'true',
        },
      ];
    },
  });
  const res = await handleDeveloperTool(
    'sync_suggest_tests',
    { scriptIncludeSysId: 'abc123' },
    ctx
  );
  assert.equal(res.isError, false);
  assert.ok(capturedQuery.includes('sys_id=abc123'));
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.source, 'instance');
  assert.equal(parsed.suggestion.scriptIncludeName, 'ResolvedName');
  assert.equal(parsed.suggestion.clientCallable, true);
});

test('sync_suggest_tests: resolves by name, applies scope condition when scope known', async () => {
  let capturedQuery = null;
  const ctx = makeContext({
    resolveScope: async () => 'x_app',
    tableGet: async (_table, opts) => {
      capturedQuery = opts.query;
      return [
        {
          sys_id: 'sid1',
          name: 'MyUtil',
          script: 'var MyUtil = Class.create();',
          client_callable: true,
        },
      ];
    },
  });
  const res = await handleDeveloperTool(
    'sync_suggest_tests',
    { scriptIncludeName: 'MyUtil', scope: 'x_app' },
    ctx
  );
  assert.equal(res.isError, false);
  assert.ok(capturedQuery.includes('name=MyUtil'));
  assert.ok(capturedQuery.includes('sys_scope.scope=x_app'));
});

test('sync_suggest_tests: not found on instance returns error mentioning the sysId', async () => {
  const ctx = makeContext({
    tableGet: async () => [],
  });
  const res = await handleDeveloperTool(
    'sync_suggest_tests',
    { scriptIncludeSysId: 'missing-sid' },
    ctx
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Script Include not found for missing-sid/);
});

test('sync_suggest_tests: not found on instance falls back to name in the error message', async () => {
  const ctx = makeContext({
    tableGet: async () => [],
  });
  const res = await handleDeveloperTool(
    'sync_suggest_tests',
    { scriptIncludeName: 'GhostUtil' },
    ctx
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Script Include not found for GhostUtil/);
});

test('sync_suggest_tests: instance record with an empty/whitespace script body is rejected', async () => {
  const ctx = makeContext({
    tableGet: async () => [
      { sys_id: 'sid2', name: 'EmptyUtil', script: '   ', client_callable: false },
    ],
  });
  const res = await handleDeveloperTool(
    'sync_suggest_tests',
    { scriptIncludeName: 'EmptyUtil' },
    ctx
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /EmptyUtil has no script body to analyze/);
});

test('sync_suggest_tests: client_callable boolean true is honored (non-string variant)', async () => {
  const ctx = makeContext({
    tableGet: async () => [
      {
        sys_id: 'sid3',
        name: 'ClientUtil',
        script: 'var ClientUtil = Class.create();',
        client_callable: true,
      },
    ],
  });
  const res = await handleDeveloperTool(
    'sync_suggest_tests',
    { scriptIncludeName: 'ClientUtil' },
    ctx
  );
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.suggestion.clientCallable, true);
});

test('sync_suggest_tests: client_callable falsy value maps to false', async () => {
  const ctx = makeContext({
    tableGet: async () => [
      {
        sys_id: 'sid4',
        name: 'NonClientUtil',
        script: 'var NonClientUtil = Class.create();',
        client_callable: undefined,
      },
    ],
  });
  const res = await handleDeveloperTool(
    'sync_suggest_tests',
    { scriptIncludeName: 'NonClientUtil' },
    ctx
  );
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.suggestion.clientCallable, false);
});

test('sync_suggest_tests: row name missing falls back to the requested scriptIncludeName', async () => {
  const ctx = makeContext({
    tableGet: async () => [
      { sys_id: 'sid5', script: 'var Foo = Class.create();', client_callable: false },
    ],
  });
  const res = await handleDeveloperTool(
    'sync_suggest_tests',
    { scriptIncludeName: 'RequestedName' },
    ctx
  );
  assert.equal(res.isError, false);
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.suggestion.scriptIncludeName, 'RequestedName');
});

test('sync_suggest_tests: inline script source is reported as "inline"', async () => {
  const res = await handleDeveloperTool(
    'sync_suggest_tests',
    { scriptIncludeName: 'InlineUtil', script: 'var InlineUtil = Class.create();' },
    makeContext()
  );
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.source, 'inline');
});

test('sync_suggest_tests: inline empty script body is rejected without calling the instance', async () => {
  let called = false;
  const ctx = makeContext({
    tableGet: async () => {
      called = true;
      return [];
    },
  });
  const res = await handleDeveloperTool(
    'sync_suggest_tests',
    { scriptIncludeName: 'Blank', script: '   ' },
    ctx
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /has no script body to analyze/);
  assert.equal(called, false, 'inline path with blank script must not hit the instance');
});

// ---------------------------------------------------------------------------
// sync_diff_instance_vs_local
// ---------------------------------------------------------------------------

test('sync_diff_instance_vs_local: defaults tableName to sys_script_include when omitted', async () => {
  let capturedTable = null;
  const ctx = makeContext({
    tableGet: async (table) => {
      capturedTable = table;
      return [];
    },
  });
  const res = await handleDeveloperTool('sync_diff_instance_vs_local', {}, ctx);
  assert.equal(res.isError, false);
  assert.equal(capturedTable, 'sys_script_include');
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.table, 'sys_script_include');
  assert.equal(parsed.recordName, null);
});

test('sync_diff_instance_vs_local: unknown table falls back to default script/name field config', async () => {
  let capturedFields = null;
  const ctx = makeContext({
    tableGet: async (_table, opts) => {
      capturedFields = opts.fields;
      return [];
    },
  });
  const res = await handleDeveloperTool(
    'sync_diff_instance_vs_local',
    { tableName: 'x_custom_table' },
    ctx
  );
  assert.equal(res.isError, false);
  assert.ok(capturedFields.includes('script'));
  assert.ok(capturedFields.includes('name'));
});

test('sync_diff_instance_vs_local: sys_ws_operation uses operation_script as the script field', async () => {
  let capturedFields = null;
  const ctx = makeContext({
    tableGet: async (_table, opts) => {
      capturedFields = opts.fields;
      return [
        {
          sys_id: 'ws1',
          name: 'MyOperation',
          operation_script: '(function process() {})();',
          sys_updated_on: '2024-01-01 00:00:00',
        },
      ];
    },
  });
  const res = await handleDeveloperTool(
    'sync_diff_instance_vs_local',
    { tableName: 'sys_ws_operation', recordName: 'MyOperation' },
    ctx
  );
  assert.equal(res.isError, false);
  assert.ok(capturedFields.includes('operation_script'));
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.recordName, 'MyOperation');
});

test('sync_diff_instance_vs_local: scope known adds condition and is reflected in the response', async () => {
  let capturedQuery = null;
  const ctx = makeContext({
    resolveScope: async () => 'x_app',
    tableGet: async (_table, opts) => {
      capturedQuery = opts.query;
      return [];
    },
  });
  const res = await handleDeveloperTool(
    'sync_diff_instance_vs_local',
    { tableName: 'sys_script_include' },
    ctx
  );
  assert.ok(capturedQuery.includes('sys_scope.scope=x_app'));
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.scope, 'x_app');
});

test('sync_diff_instance_vs_local: scope unknown_scope omits the scope condition and reports null scope', async () => {
  let capturedQuery = null;
  const ctx = makeContext({
    resolveScope: async () => 'unknown_scope',
    tableGet: async (_table, opts) => {
      capturedQuery = opts.query;
      return [];
    },
  });
  const res = await handleDeveloperTool(
    'sync_diff_instance_vs_local',
    { tableName: 'sys_script_include' },
    ctx
  );
  assert.ok(!capturedQuery.includes('sys_scope.scope'));
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.scope, null);
});

test('sync_diff_instance_vs_local: no manifest file on disk yields empty local side, report still returned', async () => {
  const tempDir = mkTempProject();
  const res = await handleDeveloperTool(
    'sync_diff_instance_vs_local',
    { tableName: 'sys_script_include', recordName: 'Anything' },
    makeContext({ projectDir: tempDir })
  );
  assert.equal(res.isError, false);
  const parsed = JSON.parse(res.content[0].text);
  assert.ok(parsed.report);
});

test('sync_diff_instance_vs_local: malformed manifest JSON is tolerated (parse error -> empty local)', async () => {
  const tempDir = mkTempProject();
  fs.writeFileSync(path.join(tempDir, 'sync.manifest.json'), '{ not valid json ');
  const res = await handleDeveloperTool(
    'sync_diff_instance_vs_local',
    { tableName: 'sys_script_include' },
    makeContext({ projectDir: tempDir })
  );
  assert.equal(res.isError, false);
  assert.doesNotThrow(() => JSON.parse(res.content[0].text));
});

test('sync_diff_instance_vs_local: manifest with a matching local record and readable file diffs against instance', async () => {
  const tempDir = mkTempProject();
  fs.writeFileSync(
    path.join(tempDir, 'sync.manifest.json'),
    JSON.stringify({
      tables: {
        sys_script_include: {
          records: {
            rec_1: {
              name: 'MyUtil',
              sys_id: 'local-sid',
              sys_updated_on: '2024-01-01 00:00:00',
              files: [{ name: 'script', type: 'js' }],
            },
          },
        },
      },
    })
  );
  const fileDir = path.join(tempDir, 'src', 'sys_script_include', 'MyUtil');
  fs.mkdirSync(fileDir, { recursive: true });
  fs.writeFileSync(path.join(fileDir, 'script.js'), 'var MyUtil = Class.create();');

  const ctx = makeContext({
    projectDir: tempDir,
    tableGet: async () => [
      {
        sys_id: 'local-sid',
        name: 'MyUtil',
        script: 'var MyUtil = Class.create(); // changed',
        sys_updated_on: '2024-02-01 00:00:00',
      },
    ],
  });

  const res = await handleDeveloperTool(
    'sync_diff_instance_vs_local',
    { tableName: 'sys_script_include', recordName: 'MyUtil' },
    ctx
  );
  assert.equal(res.isError, false);
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.recordName, 'MyUtil');
  assert.ok(parsed.report);
});

test('sync_diff_instance_vs_local: manifest record without a name is skipped', async () => {
  const tempDir = mkTempProject();
  fs.writeFileSync(
    path.join(tempDir, 'sync.manifest.json'),
    JSON.stringify({
      tables: {
        sys_script_include: {
          records: {
            rec_1: { sys_id: 'no-name-sid', files: [] },
          },
        },
      },
    })
  );
  const res = await handleDeveloperTool(
    'sync_diff_instance_vs_local',
    { tableName: 'sys_script_include' },
    makeContext({ projectDir: tempDir })
  );
  assert.equal(res.isError, false);
  assert.doesNotThrow(() => JSON.parse(res.content[0].text));
});

test('sync_diff_instance_vs_local: manifest record filtered out by a non-matching recordName', async () => {
  const tempDir = mkTempProject();
  fs.writeFileSync(
    path.join(tempDir, 'sync.manifest.json'),
    JSON.stringify({
      tables: {
        sys_script_include: {
          records: {
            rec_1: { name: 'OtherUtil', sys_id: 'sid-other', files: [] },
          },
        },
      },
    })
  );
  const res = await handleDeveloperTool(
    'sync_diff_instance_vs_local',
    { tableName: 'sys_script_include', recordName: 'MyUtil' },
    makeContext({ projectDir: tempDir })
  );
  assert.equal(res.isError, false);
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.recordName, 'MyUtil');
});

test('sync_diff_instance_vs_local: manifest file entry that resolves to a directory (unreadable as text) is tolerated', async () => {
  const tempDir = mkTempProject();
  fs.writeFileSync(
    path.join(tempDir, 'sync.manifest.json'),
    JSON.stringify({
      tables: {
        sys_script_include: {
          records: {
            rec_1: {
              name: 'DirClashUtil',
              sys_id: 'sid-dir-clash',
              files: [{ name: 'script', type: 'js' }],
            },
          },
        },
      },
    })
  );
  // "script.js" exists but as a directory, so readFileSync throws (EISDIR) and
  // must be swallowed by the catch block rather than propagating.
  const fileDir = path.join(tempDir, 'src', 'sys_script_include', 'DirClashUtil', 'script.js');
  fs.mkdirSync(fileDir, { recursive: true });

  const res = await handleDeveloperTool(
    'sync_diff_instance_vs_local',
    { tableName: 'sys_script_include', recordName: 'DirClashUtil' },
    makeContext({ projectDir: tempDir })
  );
  assert.equal(res.isError, false);
  assert.doesNotThrow(() => JSON.parse(res.content[0].text));
});

test('sync_diff_instance_vs_local: manifest record with a file entry that does not exist on disk is tolerated', async () => {
  const tempDir = mkTempProject();
  fs.writeFileSync(
    path.join(tempDir, 'sync.manifest.json'),
    JSON.stringify({
      tables: {
        sys_script_include: {
          records: {
            rec_1: {
              name: 'MissingFileUtil',
              sys_id: 'sid-missing-file',
              files: [{ name: 'script', type: 'js' }],
            },
          },
        },
      },
    })
  );
  const res = await handleDeveloperTool(
    'sync_diff_instance_vs_local',
    { tableName: 'sys_script_include', recordName: 'MissingFileUtil' },
    makeContext({ projectDir: tempDir })
  );
  assert.equal(res.isError, false);
  assert.doesNotThrow(() => JSON.parse(res.content[0].text));
});

test('sync_diff_instance_vs_local: manifest record with files as a non-array is tolerated (defaults to empty)', async () => {
  const tempDir = mkTempProject();
  fs.writeFileSync(
    path.join(tempDir, 'sync.manifest.json'),
    JSON.stringify({
      tables: {
        sys_script_include: {
          records: {
            rec_1: { name: 'BadFilesUtil', sys_id: 'sid-bad-files', files: 'not-an-array' },
          },
        },
      },
    })
  );
  const res = await handleDeveloperTool(
    'sync_diff_instance_vs_local',
    { tableName: 'sys_script_include' },
    makeContext({ projectDir: tempDir })
  );
  assert.equal(res.isError, false);
  assert.doesNotThrow(() => JSON.parse(res.content[0].text));
});

test('sync_diff_instance_vs_local: manifest tables entry absent for the requested table yields empty local side', async () => {
  const tempDir = mkTempProject();
  fs.writeFileSync(
    path.join(tempDir, 'sync.manifest.json'),
    JSON.stringify({ tables: {} })
  );
  const res = await handleDeveloperTool(
    'sync_diff_instance_vs_local',
    { tableName: 'sys_script' },
    makeContext({ projectDir: tempDir })
  );
  assert.equal(res.isError, false);
  assert.doesNotThrow(() => JSON.parse(res.content[0].text));
});

test('sync_diff_instance_vs_local: root manifest JSON that is not an object yields empty local side', async () => {
  const tempDir = mkTempProject();
  fs.writeFileSync(path.join(tempDir, 'sync.manifest.json'), JSON.stringify([1, 2, 3]));
  const res = await handleDeveloperTool(
    'sync_diff_instance_vs_local',
    { tableName: 'sys_script_include' },
    makeContext({ projectDir: tempDir })
  );
  assert.equal(res.isError, false);
  assert.doesNotThrow(() => JSON.parse(res.content[0].text));
});

test('sync_diff_instance_vs_local: instance rows missing optional fields still map through cleanly', async () => {
  const ctx = makeContext({
    tableGet: async () => [{}],
  });
  const res = await handleDeveloperTool(
    'sync_diff_instance_vs_local',
    { tableName: 'sys_script_include' },
    ctx
  );
  assert.equal(res.isError, false);
  assert.doesNotThrow(() => JSON.parse(res.content[0].text));
});

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

test('unknown tool name returns null (dispatch fallthrough)', async () => {
  const res = await handleDeveloperTool('sync_totally_unknown', { foo: 'bar' }, makeContext());
  assert.equal(res, null);
});
