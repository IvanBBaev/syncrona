// SPDX-License-Identifier: GPL-3.0-or-later
// ServiceNow scope discovery reads reference columns from the Table API, which
// (without sysparm_exclude_reference_link) returns them as { link, value }
// objects. These tests feed the shape a real instance returns.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hydrateScopeKnowledgeInputs } = require('../dist/analysis/scopeDiscovery.js');
const {
  clearServiceNowSecretsCache,
  clearScopedApiPrefixCache,
} = require('../dist/servicenowCore.js');

const REAL_GLOBAL_FETCH = global.fetch;
test.afterEach(() => {
  global.fetch = REAL_GLOBAL_FETCH;
});

function mkResponse(status, payload) {
  return {
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

function withEnv(fn) {
  const old = {
    SN_INSTANCE: process.env.SN_INSTANCE,
    SN_USER: process.env.SN_USER,
    SN_PASSWORD: process.env.SN_PASSWORD,
  };
  process.env.SN_INSTANCE = 'dev123.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  clearServiceNowSecretsCache();
  clearScopedApiPrefixCache();

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      clearServiceNowSecretsCache();
      clearScopedApiPrefixCache();
    });
}

const TASK_SYS_ID = '8c58a5aa0a0a0b07008047e8ef0fe1ee';

function mockInstance(urls) {
  global.fetch = async (url) => {
    const uri = String(url);
    urls.push(uri);
    if (uri.includes('/api/now/table/sys_db_object?')) {
      const fields = new URL(uri).searchParams.get('sysparm_fields') || '';
      const row = {
        sys_id: 'dbo1',
        name: 'x_demo_child',
        super_class: {
          link: `https://dev123.service-now.com/api/now/table/sys_db_object/${TASK_SYS_ID}`,
          value: TASK_SYS_ID,
        },
        sys_scope: { link: 'https://dev123.service-now.com/api/now/table/sys_scope/s1', value: 's1' },
      };
      if (fields.split(',').includes('super_class.name')) {
        row['super_class.name'] = 'task';
      }
      return mkResponse(200, { result: [row] });
    }
    return mkResponse(200, { result: [] });
  };
}

test('table inheritance names the parent table, not its sys_db_object sys_id', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-scope-ref-'));
  const urls = [];
  mockInstance(urls);

  await withEnv(async () => {
    const hydrated = await hydrateScopeKnowledgeInputs([], { nodes: [], edges: [] }, 'x_demo', 5000, projectDir);
    const inheritance = hydrated.graph.edges.filter((e) => e.why === 'ServiceNow table inheritance');
    assert.deepEqual(
      inheritance.map((e) => [e.from, e.to]),
      [['table:x_demo_child', 'table:task']]
    );
    assert.equal(hydrated.graph.nodes.some((n) => n.id === `table:${TASK_SYS_ID}`), false);
  });
});
