// SPDX-License-Identifier: GPL-3.0-or-later
// sys_transform_script has no `name` column (its display field is `when`), yet the
// script-table maps named its rows by `name`. Every instance row then came back
// nameless: sync_diff_instance_vs_local dropped them all, so each local transform
// script read as missing on the instance, and sn_search_scripts returned hits with
// an empty name. Core names these records by sys_id; the MCP side now does too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handleDeveloperTool } = require('../dist/handlers/developerToolHandlers.js');
const { handleSearchScripts } = require('../dist/handlers/insightScriptSearch.js');
const {
  clearServiceNowSecretsCache,
  clearScopedApiPrefixCache,
} = require('../dist/servicenowCore.js');

const SYS_ID = '0123456789abcdef0123456789abcdef';
const SCRIPT = '(function runTransformScript(source, map, log, target) {})(source, map, log, target);\n';

function mkProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-transform-script-'));
  fs.writeFileSync(
    path.join(dir, 'sync.manifest.json'),
    JSON.stringify({
      tables: {
        sys_transform_script: {
          records: { [SYS_ID]: { name: SYS_ID, sys_id: SYS_ID, files: [{ name: 'script', type: 'js' }] } },
        },
      },
    })
  );
  const recordDir = path.join(dir, 'src', 'sys_transform_script', SYS_ID);
  fs.mkdirSync(recordDir, { recursive: true });
  fs.writeFileSync(path.join(recordDir, 'script.js'), SCRIPT);
  return dir;
}

test('a transform script pairs with its local file by sys_id', async () => {
  const dir = mkProject();
  const calls = [];
  try {
    const res = await handleDeveloperTool(
      'sync_diff_instance_vs_local',
      { tableName: 'sys_transform_script', recordName: SYS_ID },
      {
        timeoutMs: 1000,
        projectDir: dir,
        layout: { sourceDirectory: 'src', flat: false },
        resolveScope: async () => 'x_app',
        tableGet: async (table, params) => {
          calls.push(params);
          return [{ sys_id: SYS_ID, script: SCRIPT, sys_updated_on: '2026-10-01 10:00:00' }];
        },
      }
    );
    assert.equal(res.isError, false);
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.report.summary.unchanged, 1);
    assert.equal(payload.report.summary.localOnly ?? 0, 0);
    assert.match(calls[0].query, new RegExp(`\\^sys_id=${SYS_ID}\\^`));
    assert.doesNotMatch(calls[0].query, /\bname=|ORDERBYname/);
    assert.deepEqual(calls[0].fields, ['sys_id', 'script', 'sys_updated_on']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sn_search_scripts names a transform script hit by its sys_id', async () => {
  const old = {
    SN_INSTANCE: process.env.SN_INSTANCE,
    SN_USER: process.env.SN_USER,
    SN_PASSWORD: process.env.SN_PASSWORD,
  };
  const realFetch = global.fetch;
  const urls = [];
  process.env.SN_INSTANCE = 'dev123.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  clearServiceNowSecretsCache();
  clearScopedApiPrefixCache();
  global.fetch = async (url) => {
    urls.push(String(url));
    return { status: 200, text: async () => JSON.stringify({ result: [{ sys_id: SYS_ID, script: SCRIPT }] }) };
  };
  try {
    const res = await handleSearchScripts({ query: 'runTransformScript', tables: ['sys_transform_script'] }, 1000);
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.matches.length, 1);
    assert.equal(payload.matches[0].name, SYS_ID);
    assert.equal(new URL(urls[0]).searchParams.get('sysparm_fields'), 'sys_id,script');
  } finally {
    global.fetch = realFetch;
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearServiceNowSecretsCache();
    clearScopedApiPrefixCache();
  }
});
