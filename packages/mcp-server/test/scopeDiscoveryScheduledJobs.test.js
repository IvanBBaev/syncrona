// SPDX-License-Identifier: GPL-3.0-or-later
// sys_trigger has no sys_scope column, so a `sys_scope.scope=` query on it is
// dropped by ServiceNow and returns every trigger on the instance. Scope
// discovery must read the scope's scheduled jobs from sysauto_script instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hydrateScopeKnowledgeInputs } = require('../dist/analysis/scopeDiscovery.js');
const {
  clearServiceNowSecretsCache,
} = require('../dist/servicenowCore.js');

const REAL_GLOBAL_FETCH = global.fetch;
test.afterEach(() => {
  global.fetch = REAL_GLOBAL_FETCH;
});

function mkResponse(status, payload) {
  return {
    status,
    text: async () => JSON.stringify(payload),
  };
}

async function withEnv(fn) {
  const old = {
    SN_INSTANCE: process.env.SN_INSTANCE,
    SN_USER: process.env.SN_USER,
    SN_PASSWORD: process.env.SN_PASSWORD,
  };
  process.env.SN_INSTANCE = 'dev123.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'placeholder';
  clearServiceNowSecretsCache();
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    clearServiceNowSecretsCache();
  }
}

test('scope discovery reads scheduled jobs from sysauto_script, not the unscoped sys_trigger', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-scope-jobs-'));
  const requestedTables = [];
  global.fetch = async (url) => {
    const uri = String(url);
    const table = /\/api\/now\/table\/([a-z0-9_]+)\?/.exec(uri)?.[1] ?? '';
    requestedTables.push(table);
    if (table === 'sys_trigger') {
      // What the instance answers: the scope condition is ignored.
      return mkResponse(200, {
        result: [{ sys_id: 'a'.repeat(32), name: 'Global housekeeping trigger', script: '' }],
      });
    }
    if (table === 'sysauto_script') {
      return mkResponse(200, {
        result: [{
          sys_id: 'b'.repeat(32),
          name: 'Nightly cleanup',
          script: 'new GlideRecord("x_demo_item");',
          run_type: 'daily',
          run_period: '',
          run_time: '1970-01-01 02:00:00',
        }],
      });
    }
    return mkResponse(200, { result: [] });
  };

  await withEnv(async () => {
    const hydrated = await hydrateScopeKnowledgeInputs([], { nodes: [], edges: [] }, 'x_demo', 5000, projectDir);
    assert.ok(!requestedTables.includes('sys_trigger'));
    assert.ok(requestedTables.includes('sysauto_script'));
    const jobs = hydrated.entities.filter((entity) => entity.metadataType === 'scheduled_job');
    assert.deepEqual(jobs.map((job) => [job.name, job.metadataTable, job.runType]), [
      ['Nightly cleanup', 'sysauto_script', 'daily'],
    ]);
  });
});
