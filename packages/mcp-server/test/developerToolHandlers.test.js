// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  handleDeveloperTool,
} = require('../dist/handlers/developerToolHandlers.js');

// resolveScope / tableGet are injected and only used when no inline script is
// supplied, so passing `script` keeps these tests off the network.
function makeContext(overrides = {}) {
  return {
    timeoutMs: 1000,
    projectDir: '/tmp/does-not-exist',
    // DX17: the handler takes the resolved workspace layout, not a bare source
    // directory — see test/flatLayoutAwareness.test.js for the flat variants.
    layout: { sourceDirectory: 'src', flat: false },
    resolveScope: async () => 'unknown_scope',
    tableGet: async () => [],
    ...overrides,
  };
}

test('sync_suggest_tests: neither name nor sysId nor script is rejected', async () => {
  const res = await handleDeveloperTool('sync_suggest_tests', {}, makeContext());
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /scriptIncludeName or scriptIncludeSysId/);
});

test('sync_suggest_tests: an inline script produces a suggestion without the network', async () => {
  let tableGetCalls = 0;
  const ctx = makeContext({
    tableGet: async () => {
      tableGetCalls += 1;
      return [];
    },
  });
  const res = await handleDeveloperTool(
    'sync_suggest_tests',
    { scriptIncludeName: 'MyUtil', script: 'var MyUtil = Class.create();' },
    ctx
  );
  assert.equal(res.isError, false);
  assert.equal(tableGetCalls, 0, 'inline script must not hit the instance');
  assert.doesNotThrow(() => JSON.parse(res.content[0].text));
});

function mkManifestProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-tool-handlers-'));
  fs.writeFileSync(path.join(dir, 'sync.manifest.json'), JSON.stringify({ tables: {} }));
  return dir;
}

test('sync_diff_instance_vs_local: no manifest is an error, not an all-instance-only diff', async () => {
  const res = await handleDeveloperTool(
    'sync_diff_instance_vs_local',
    { table: 'sys_script_include', recordName: 'MyUtil' },
    makeContext({ resolveScope: async () => 'x_app' })
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /No sync\.manifest\.json/);
});

test('sync_suggest_tests: a name matching several Script Includes is refused, not guessed', async () => {
  let capturedLimit = null;
  const ctx = makeContext({
    tableGet: async (_table, opts) => {
      capturedLimit = opts.limit;
      return [
        { sys_id: 'a', name: 'MyUtil', script: 'var A = 1;' },
        { sys_id: 'b', name: 'MyUtil', script: 'var B = 2;' },
      ];
    },
  });
  const res = await handleDeveloperTool('sync_suggest_tests', { scriptIncludeName: 'MyUtil' }, ctx);
  assert.equal(capturedLimit, 2, 'a second row reveals the ambiguity');
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /More than one Script Include is named MyUtil on the instance/);
});

test('sync_diff_instance_vs_local: a caret-bearing scope cannot inject extra query conditions', async () => {
  // A scope resolved from user input could carry `^`, the encoded-query condition
  // separator. Without escaping, `sys_scope.scope=x_app^sys_id=ADMIN` would widen
  // the lookup. The handler must neutralize the caret before composing the query.
  let capturedQuery = null;
  const ctx = makeContext({
    projectDir: mkManifestProject(),
    resolveScope: async () => 'x_app^sys_id=ADMIN',
    tableGet: async (_table, opts) => {
      capturedQuery = opts.query;
      return [];
    },
  });
  await handleDeveloperTool(
    'sync_diff_instance_vs_local',
    { table: 'sys_script_include', recordName: 'MyUtil' },
    ctx
  );
  assert.ok(capturedQuery, 'tableGet should have been called with a query');
  assert.ok(
    !capturedQuery.includes('scope=x_app^'),
    `caret must be escaped out of the scope condition; got: ${capturedQuery}`
  );
  assert.ok(
    capturedQuery.includes('sys_scope.scope=x_app sys_id=ADMIN'),
    `caret should become a space; got: ${capturedQuery}`
  );
});

test('unknown tool returns null so dispatch can fall through', async () => {
  const res = await handleDeveloperTool('not_a_real_tool', {}, makeContext());
  assert.equal(res, null);
});
