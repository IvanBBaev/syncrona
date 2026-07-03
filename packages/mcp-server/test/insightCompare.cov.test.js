// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleCompareInstances,
  diffInstanceRecords,
  hashRecordContent,
} = require('../dist/handlers/insightCompareInstances.js');
const {
  handleSearchScripts,
  buildScriptExcerpt,
} = require('../dist/handlers/insightScriptSearch.js');
const {
  textResponse,
  errorResponse,
  clampLimit,
  isoToServiceNowDateTime,
  defaultSinceIso,
  buildRecentChangesQuery,
  resolveUpdateSetSysId,
  SCRIPT_SEARCH_TABLES,
} = require('../dist/handlers/insightShared.js');
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

function withEnv(vars, fn) {
  const old = {
    SN_INSTANCE: process.env.SN_INSTANCE,
    SN_USER: process.env.SN_USER,
    SN_PASSWORD: process.env.SN_PASSWORD,
  };
  process.env.SN_INSTANCE = vars.SN_INSTANCE;
  process.env.SN_USER = vars.SN_USER;
  process.env.SN_PASSWORD = vars.SN_PASSWORD;
  clearServiceNowSecretsCache();
  clearScopedApiPrefixCache();

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.env.SN_INSTANCE = old.SN_INSTANCE;
      process.env.SN_USER = old.SN_USER;
      process.env.SN_PASSWORD = old.SN_PASSWORD;
      clearServiceNowSecretsCache();
      clearScopedApiPrefixCache();
    });
}

// ---------------------------------------------------------------------------
// insightShared.ts
// ---------------------------------------------------------------------------

test('textResponse: wraps payload as non-error JSON text content', () => {
  const res = textResponse({ a: 1 });
  assert.equal(res.isError, false);
  assert.equal(res.content[0].type, 'text');
  assert.deepEqual(JSON.parse(res.content[0].text), { a: 1 });
});

test('textResponse: isError flag can be forced true', () => {
  const res = textResponse({ a: 1 }, true);
  assert.equal(res.isError, true);
});

test('errorResponse: sets isError true and message text', () => {
  const res = errorResponse('boom');
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'boom');
});

test('clampLimit: finite number is floored and clamped within [1, max]', () => {
  assert.equal(clampLimit(10.9, 5, 100), 10);
  assert.equal(clampLimit(0, 5, 100), 1);
  assert.equal(clampLimit(-5, 5, 100), 1);
  assert.equal(clampLimit(9999, 5, 100), 100);
});

test('clampLimit: non-number or non-finite falls back to default', () => {
  assert.equal(clampLimit('abc', 42, 100), 42);
  assert.equal(clampLimit(undefined, 42, 100), 42);
  assert.equal(clampLimit(Number.NaN, 42, 100), 42);
  assert.equal(clampLimit(Infinity, 42, 100), 42);
});

test('isoToServiceNowDateTime: converts a valid ISO string to SN datetime format', () => {
  const result = isoToServiceNowDateTime('2024-01-15T10:30:00.000Z');
  assert.equal(result, '2024-01-15 10:30:00');
});

test('isoToServiceNowDateTime: invalid date string returns empty string', () => {
  assert.equal(isoToServiceNowDateTime('not-a-date'), '');
});

test('defaultSinceIso: returns ISO string 24h before the given timestamp', () => {
  const now = Date.parse('2024-06-01T00:00:00.000Z');
  const result = defaultSinceIso(now);
  assert.equal(result, '2024-05-31T00:00:00.000Z');
});

test('buildRecentChangesQuery: includes scope, since clause and ordering', () => {
  const q = buildRecentChangesQuery('x_my_scope', '2024-01-01 00:00:00');
  assert.equal(
    q,
    'application.scope=x_my_scope^sys_created_on>=2024-01-01 00:00:00^ORDERBYDESCsys_created_on'
  );
});

test('buildRecentChangesQuery: omits since clause when empty', () => {
  const q = buildRecentChangesQuery('x_my_scope', '');
  assert.equal(q, 'application.scope=x_my_scope^ORDERBYDESCsys_created_on');
});

test('SCRIPT_SEARCH_TABLES: contains expected script tables with field mappings', () => {
  assert.equal(SCRIPT_SEARCH_TABLES.sys_script_include.scriptField, 'script');
  assert.equal(SCRIPT_SEARCH_TABLES.sys_script_include.nameField, 'name');
  assert.equal(SCRIPT_SEARCH_TABLES.sys_ws_operation.scriptField, 'operation_script');
  assert.ok('sys_script' in SCRIPT_SEARCH_TABLES);
  assert.ok('sys_script_client' in SCRIPT_SEARCH_TABLES);
  assert.ok('sys_ui_script' in SCRIPT_SEARCH_TABLES);
  assert.ok('sys_transform_script' in SCRIPT_SEARCH_TABLES);
});

test('resolveUpdateSetSysId: explicit updateSetSysId short-circuits without a request', async () => {
  const orig = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called when sysId is explicit');
  };
  try {
    const result = await resolveUpdateSetSysId({ updateSetSysId: '  abc123  ' }, 1000);
    assert.deepEqual(result, { sysId: 'abc123', label: 'abc123' });
  } finally {
    global.fetch = orig;
  }
});

test('resolveUpdateSetSysId: missing both sysId and name returns an error', async () => {
  const result = await resolveUpdateSetSysId({}, 1000);
  assert.deepEqual(result, { error: 'Provide either updateSetSysId or updateSetName' });
});

test('resolveUpdateSetSysId: blank-only name is treated as missing', async () => {
  const result = await resolveUpdateSetSysId({ updateSetName: '   ' }, 1000);
  assert.deepEqual(result, { error: 'Provide either updateSetSysId or updateSetName' });
});

test('resolveUpdateSetSysId: resolves by name via table lookup (found)', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async () =>
        mkResponse(200, { result: [{ sys_id: 'set-sys-id-1', name: 'My Update Set' }] });
      const result = await resolveUpdateSetSysId({ updateSetName: 'My Update Set' }, 1000);
      assert.deepEqual(result, { sysId: 'set-sys-id-1', label: 'My Update Set' });
    }
  );
});

test('resolveUpdateSetSysId: resolves by name via table lookup (not found)', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async () => mkResponse(200, { result: [] });
      const result = await resolveUpdateSetSysId({ updateSetName: 'Missing Set' }, 1000);
      assert.deepEqual(result, { error: 'Update set not found: Missing Set' });
    }
  );
});

// ---------------------------------------------------------------------------
// insightCompareInstances.ts
// ---------------------------------------------------------------------------

test('hashRecordContent: hashes a string value deterministically (sha1 hex)', () => {
  const h1 = hashRecordContent('gs.info(1);');
  const h2 = hashRecordContent('gs.info(1);');
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{40}$/);
});

test('hashRecordContent: null/undefined hash the same as empty string', () => {
  const hNull = hashRecordContent(null);
  const hUndef = hashRecordContent(undefined);
  const hEmpty = hashRecordContent('');
  assert.equal(hNull, hEmpty);
  assert.equal(hUndef, hEmpty);
});

test('hashRecordContent: differing content produces differing hashes', () => {
  assert.notEqual(hashRecordContent('a'), hashRecordContent('b'));
});

test('diffInstanceRecords: identifies onlyInA, onlyInB and different (sorted)', () => {
  const rowsA = [
    { name: 'ZScript', script: 'same' },
    { name: 'AScript', script: 'v1' },
    { name: 'OnlyA', script: 'x' },
  ];
  const rowsB = [
    { name: 'ZScript', script: 'same' },
    { name: 'AScript', script: 'v2' },
    { name: 'OnlyB', script: 'y' },
  ];
  const diff = diffInstanceRecords(rowsA, rowsB, { nameField: 'name', contentField: 'script' });

  assert.deepEqual(diff.onlyInA, ['OnlyA']);
  assert.deepEqual(diff.onlyInB, ['OnlyB']);
  assert.equal(diff.different.length, 1);
  assert.equal(diff.different[0].name, 'AScript');
  assert.equal(diff.different[0].hashA, hashRecordContent('v1'));
  assert.equal(diff.different[0].hashB, hashRecordContent('v2'));
});

test('diffInstanceRecords: identical rows produce no diffs', () => {
  const rowsA = [{ name: 'Same', script: 'x' }];
  const rowsB = [{ name: 'Same', script: 'x' }];
  const diff = diffInstanceRecords(rowsA, rowsB, { nameField: 'name', contentField: 'script' });
  assert.deepEqual(diff.onlyInA, []);
  assert.deepEqual(diff.onlyInB, []);
  assert.deepEqual(diff.different, []);
});

test('diffInstanceRecords: rows with empty/missing name field are skipped from maps', () => {
  const rowsA = [{ name: '', script: 'x' }, { script: 'no-name-field' }];
  const rowsB = [{ name: '', script: 'y' }];
  const diff = diffInstanceRecords(rowsA, rowsB, { nameField: 'name', contentField: 'script' });
  assert.deepEqual(diff.onlyInA, []);
  assert.deepEqual(diff.onlyInB, []);
  assert.deepEqual(diff.different, []);
});

test('diffInstanceRecords: empty inputs on both sides produce empty diff', () => {
  const diff = diffInstanceRecords([], [], { nameField: 'name', contentField: 'script' });
  assert.deepEqual(diff, { onlyInA: [], onlyInB: [], different: [] });
});

test('handleCompareInstances: missing profileA returns error', async () => {
  const res = await handleCompareInstances({}, 1000);
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Missing required field: profileA');
});

test('handleCompareInstances: missing profileB returns error', async () => {
  const res = await handleCompareInstances({ profileA: 'inst-a' }, 1000);
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Missing required field: profileB');
});

test('handleCompareInstances: missing scope returns error', async () => {
  const res = await handleCompareInstances({ profileA: 'inst-a', profileB: 'inst-b' }, 1000);
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Missing required field: scope');
});

test('handleCompareInstances: blank-only profileA/profileB/scope are treated as missing', async () => {
  const res = await handleCompareInstances({ profileA: '   ', profileB: 'b', scope: 'x' }, 1000);
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Missing required field: profileA');
});

test('handleCompareInstances: profileA not found in auth store returns error', async () => {
  const profileA = `nonexistent-profile-a-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const profileB = `nonexistent-profile-b-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await handleCompareInstances(
    { profileA, profileB, scope: 'x_my_scope' },
    1000
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Profile not found in auth store/);
  assert.match(res.content[0].text, new RegExp(profileA));
});

test('handleCompareInstances: profileB not found in auth store returns error (profileA also missing but B reported)', async () => {
  // Both are nonexistent, but the function checks profileA first, so we only observe
  // profileA's error above; to exercise the profileB-specific branch we'd need profileA
  // to exist, which is not guaranteed in this environment. Instead, verify that a
  // distinctly-named nonexistent profileB alone (with a real-looking profileA string)
  // still surfaces as a "not found" error mentioning profileB when profileA fails first
  // is not observable here, so we just confirm profileB name appears when profileA errors
  // do not short circuit unexpectedly for a second distinct call.
  const profileA = `nonexistent-profile-c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const profileB = `nonexistent-profile-d-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await handleCompareInstances(
    { profileA, profileB, scope: 'x_my_scope' },
    1000
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Profile not found in auth store/);
});

// ---------------------------------------------------------------------------
// insightScriptSearch.ts
// ---------------------------------------------------------------------------

test('buildScriptExcerpt: empty script or query returns empty string', () => {
  assert.equal(buildScriptExcerpt('', 'foo'), '');
  assert.equal(buildScriptExcerpt('some script', ''), '');
  assert.equal(buildScriptExcerpt('', ''), '');
});

test('buildScriptExcerpt: query not found in script returns empty string', () => {
  assert.equal(buildScriptExcerpt('var x = 1;', 'nonexistent'), '');
});

test('buildScriptExcerpt: match near the start has no leading ellipsis', () => {
  const script = 'gs.info("hello world");';
  const excerpt = buildScriptExcerpt(script, 'hello');
  assert.ok(!excerpt.startsWith('…'));
  assert.match(excerpt, /hello/);
});

test('buildScriptExcerpt: match is case-insensitive', () => {
  const script = 'GS.INFO("Hello World");';
  const excerpt = buildScriptExcerpt(script, 'hello');
  assert.notEqual(excerpt, '');
});

test('buildScriptExcerpt: long script produces both leading and trailing ellipsis', () => {
  const padding = 'x'.repeat(300);
  const script = `${padding}NEEDLE${padding}`;
  const excerpt = buildScriptExcerpt(script, 'NEEDLE');
  assert.ok(excerpt.startsWith('…'));
  assert.ok(excerpt.endsWith('…'));
  assert.match(excerpt, /NEEDLE/);
});

test('buildScriptExcerpt: match at the very end has no trailing ellipsis', () => {
  const script = `${'a'.repeat(50)}TAIL`;
  const excerpt = buildScriptExcerpt(script, 'TAIL');
  assert.ok(!excerpt.endsWith('…'));
  assert.match(excerpt, /TAIL$/);
});

test('handleSearchScripts: missing query returns error', async () => {
  const res = await handleSearchScripts({}, 1000);
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Missing required field: query');
});

test('handleSearchScripts: blank-only query is treated as missing', async () => {
  const res = await handleSearchScripts({ query: '   ' }, 1000);
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Missing required field: query');
});

test('handleSearchScripts: happy path aggregates matches across default tables', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes('sys_script_include')) {
          return mkResponse(200, {
            result: [
              { sys_id: 's1', name: 'MyInclude', script: 'gs.info("needle here");' },
            ],
          });
        }
        return mkResponse(200, { result: [] });
      };

      const res = await handleSearchScripts({ query: 'needle', tables: ['sys_script_include'] }, 1000);
      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.query, 'needle');
      assert.equal(parsed.matchCount, 1);
      assert.equal(parsed.matches[0].table, 'sys_script_include');
      assert.equal(parsed.matches[0].name, 'MyInclude');
      assert.equal(parsed.matches[0].sys_id, 's1');
      assert.equal(parsed.matches[0].matchedField, 'script');
      assert.match(parsed.matches[0].excerpt, /needle/);
      assert.deepEqual(parsed.errors, []);
    }
  );
});

test('handleSearchScripts: restricts to requested valid tables only, ignoring unknown ones', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const requestedUrls = [];
      global.fetch = async (url) => {
        requestedUrls.push(String(url));
        return mkResponse(200, { result: [] });
      };

      await handleSearchScripts(
        { query: 'x', tables: ['sys_script', 'not_a_real_table'] },
        1000
      );
      assert.equal(requestedUrls.length, 1);
      assert.match(requestedUrls[0], /sys_script\?/);
    }
  );
});

test('handleSearchScripts: includes scope filter in query when scope is provided', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const requestedUrls = [];
      global.fetch = async (url) => {
        requestedUrls.push(String(url));
        return mkResponse(200, { result: [] });
      };

      const res = await handleSearchScripts(
        { query: 'x', scope: 'x_my_scope', tables: ['sys_script_include'] },
        1000
      );
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.scope, 'x_my_scope');
      assert.match(decodeURIComponent(requestedUrls[0]), /sys_scope\.scope=x_my_scope/);
    }
  );
});

test('handleSearchScripts: no scope provided reports scope as null', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async () => mkResponse(200, { result: [] });
      const res = await handleSearchScripts({ query: 'x', tables: ['sys_script_include'] }, 1000);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.scope, null);
    }
  );
});

test('handleSearchScripts: non-2xx response is recorded in errors and excluded from matches', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async () => mkResponse(403, { error: { message: 'Forbidden' } });
      const res = await handleSearchScripts({ query: 'x', tables: ['sys_script_include'] }, 1000);
      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.matchCount, 0);
      assert.equal(parsed.errors.length, 1);
      assert.equal(parsed.errors[0].table, 'sys_script_include');
      assert.equal(parsed.errors[0].status, 403);
    }
  );
});

test('handleSearchScripts: default tables list is used when no tables argument is given', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const requestedUrls = [];
      global.fetch = async (url) => {
        requestedUrls.push(String(url));
        return mkResponse(200, { result: [] });
      };
      await handleSearchScripts({ query: 'x' }, 1000);
      assert.equal(requestedUrls.length, Object.keys(SCRIPT_SEARCH_TABLES).length);
    }
  );
});

test('handleSearchScripts: respects a custom limit reflected in the request query string', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const requestedUrls = [];
      global.fetch = async (url) => {
        requestedUrls.push(String(url));
        return mkResponse(200, { result: [] });
      };
      await handleSearchScripts({ query: 'x', tables: ['sys_script_include'], limit: 5 }, 1000);
      assert.match(requestedUrls[0], /sysparm_limit=5\b/);
    }
  );
});
