// SPDX-License-Identifier: GPL-3.0-or-later
// A ServiceNow metadata table that cannot be read (401/403/5xx) must be reported
// as a failed fetch, so callers can tell an incomplete scope from an empty one.
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

test('a failed metadata fetch is reported instead of read as an empty table', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-scope-fail-'));
  global.fetch = async (url) => {
    const uri = String(url);
    if (uri.includes('/api/now/table/sys_script?')) {
      return mkResponse(403, { error: { message: 'User Not Authorized' } });
    }
    return mkResponse(200, { result: [] });
  };

  await withEnv(async () => {
    const hydrated = await hydrateScopeKnowledgeInputs([], { nodes: [], edges: [] }, 'x_demo', 5000, projectDir);
    assert.equal(hydrated.sourceSummary.serviceNowFailed, true);
    const tables = hydrated.sourceSummary.serviceNowFailures.map((f) => f.table);
    assert.deepEqual(tables, ['sys_script']);
    assert.match(hydrated.sourceSummary.serviceNowFailures[0].error, /403/);
  });
});

test('a fully readable scope reports no failures', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-scope-fail-'));
  global.fetch = async () => mkResponse(200, { result: [] });

  await withEnv(async () => {
    const hydrated = await hydrateScopeKnowledgeInputs([], { nodes: [], edges: [] }, 'x_demo', 5000, projectDir);
    assert.equal(hydrated.sourceSummary.serviceNowFailed, false);
    assert.deepEqual(hydrated.sourceSummary.serviceNowFailures, []);
  });
});
