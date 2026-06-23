// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleDeveloperTool,
} = require('../dist/handlers/developerToolHandlers.js');

// resolveScope / tableGet are injected and only used when no inline script is
// supplied, so passing `script` keeps these tests off the network.
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

test('sync_diff_instance_vs_local: returns a response (no manifest => empty local side)', async () => {
  const res = await handleDeveloperTool(
    'sync_diff_instance_vs_local',
    { table: 'sys_script_include', recordName: 'MyUtil' },
    makeContext()
  );
  assert.ok(res, 'handler should return a response');
  assert.equal(res.content[0].type, 'text');
});

test('unknown tool returns null so dispatch can fall through', async () => {
  const res = await handleDeveloperTool('not_a_real_tool', {}, makeContext());
  assert.equal(res, null);
});
