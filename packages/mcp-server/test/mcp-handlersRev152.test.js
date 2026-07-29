// SPDX-License-Identifier: GPL-3.0-or-later
// REV-152 regression pins.
//
// handleSearchScripts collected per-table failures into `errors` and then always
// returned textResponse(payload) — whose isError defaults to false. A run where
// every /api/now/table/... GET returned 403 therefore came back as a SUCCESS with
// matchCount: 0, indistinguishable from a genuinely clean search. That is the one
// answer a model acts on ("the identifier is unused, safe to change"), so an ACL
// change or an expired token silently turned "unknown" into "absent".
//
// These tests fail against that old code (isError was false and there was no
// searchComplete field) and pass now.
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleSearchScripts } = require('../dist/handlers/insightScriptSearch.js');
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
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      clearServiceNowSecretsCache();
      clearScopedApiPrefixCache();
    });
}

const TWO_TABLES = ['sys_script_include', 'sys_script'];

test('REV-152: a search where every table query failed is an error, not a clean zero-match result', async () => {
  await withEnv(async () => {
    global.fetch = async () => mkResponse(403, { error: { message: 'insufficient rights' } });

    const res = await handleSearchScripts(
      { query: 'gs.setRedirect', scope: 'x_nuvo_sinc', tables: TWO_TABLES },
      1000
    );

    assert.equal(res.isError, true, 'a search that searched nothing must not report success');
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.searchComplete, false);
    assert.equal(payload.matchCount, 0);
    assert.equal(payload.errors.length, 2);
    assert.deepEqual(
      payload.errors.map((entry) => entry.status),
      [403, 403]
    );
  });
});

test('REV-152: a partially failed search is still flagged, even when it found matches', async () => {
  await withEnv(async () => {
    global.fetch = async (url) => {
      if (String(url).includes('/sys_script_include?')) {
        return mkResponse(200, {
          result: [{ sys_id: 'abc', name: 'Helper', script: 'gs.setRedirect("x");' }],
        });
      }
      return mkResponse(500, { error: { message: 'boom' } });
    };

    const res = await handleSearchScripts(
      { query: 'gs.setRedirect', tables: TWO_TABLES },
      1000
    );

    assert.equal(res.isError, true);
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.searchComplete, false);
    assert.equal(payload.matchCount, 1);
    assert.equal(payload.errors.length, 1);
    assert.equal(payload.errors[0].table, 'sys_script');
  });
});

test('REV-152: a fully successful search still reports success and completeness', async () => {
  await withEnv(async () => {
    global.fetch = async () => mkResponse(200, { result: [] });

    const res = await handleSearchScripts(
      { query: 'gs.setRedirect', tables: TWO_TABLES },
      1000
    );

    assert.equal(res.isError, false);
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.searchComplete, true);
    assert.equal(payload.matchCount, 0);
    assert.deepEqual(payload.errors, []);
    // Success payloads are mirrored into structuredContent by textResponse.
    assert.equal(res.structuredContent.searchComplete, true);
  });
});
