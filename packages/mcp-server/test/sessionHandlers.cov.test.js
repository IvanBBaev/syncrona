// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleSessionTool,
} = require('../dist/handlers/sessionHandlers.js');
const {
  getSessionContext,
  listScopes,
  setCurrentScope,
  setCurrentUpdateSet,
} = require('../dist/sessionContext.js');
const {
  clearServiceNowSecretsCache,
  clearScopedApiPrefixCache,
} = require('../dist/servicenowCore.js');

// --- shared fetch/env plumbing -------------------------------------------

const REAL_GLOBAL_FETCH = global.fetch;
test.afterEach(() => {
  global.fetch = REAL_GLOBAL_FETCH;
});

function mkResponse(status, payload) {
  return {
    status,
    text: async () =>
      typeof payload === 'string' ? payload : JSON.stringify(payload),
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
    });
}

// Generic router: dispatches on substring match against the request URL so
// tests can describe just the pieces of the ServiceNow REST surface they
// care about (sys_user lookup, getCurrentScope, sys_scope, sys_update_set,
// sys_user_preference) without hardcoding the full querystring.
function routedFetch(routes) {
  return async (url) => {
    const href = String(url);
    for (const [match, handler] of routes) {
      if (href.includes(match)) {
        return handler(href);
      }
    }
    throw new Error(`Unmatched fetch URL in test: ${href}`);
  };
}

function tableResult(rows) {
  return mkResponse(200, { result: rows });
}

// --- sessionContext.ts -----------------------------------------------------

test('getSessionContext: happy path resolves scope via getCurrentScope + update set pref', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = routedFetch([
        [
          '/api/now/table/sys_user?',
          () => tableResult([{ sys_id: 'user-1', user_name: 'admin' }]),
        ],
        [
          '/getCurrentScope',
          () => mkResponse(200, { result: { scope: 'x_app', sys_id: 'scope-sys-1' } }),
        ],
        [
          '/api/now/table/sys_scope?',
          () => tableResult([{ sys_id: 'scope-sys-1', scope: 'x_app', name: 'My App' }]),
        ],
        [
          '/api/now/table/sys_user_preference?',
          (href) => {
            if (href.includes('sys_update_set')) {
              return tableResult([{ sys_id: 'pref-us', value: 'us-sys-1' }]);
            }
            return tableResult([]);
          },
        ],
        [
          '/api/now/table/sys_update_set?',
          () => tableResult([{ sys_id: 'us-sys-1', name: 'My Update Set', state: 'in progress' }]),
        ],
      ]);

      const ctx = await getSessionContext(1000);
      assert.equal(ctx.userSysId, 'user-1');
      assert.equal(ctx.scope.scope, 'x_app');
      assert.equal(ctx.scope.scopeSysId, 'scope-sys-1');
      assert.equal(ctx.scope.name, 'My App');
      assert.equal(ctx.updateSet.sysId, 'us-sys-1');
      assert.equal(ctx.updateSet.name, 'My Update Set');
      assert.equal(ctx.updateSet.state, 'in progress');
    }
  );
});

test('getSessionContext: falls back to apps.current_app preference when getCurrentScope fails', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = routedFetch([
        [
          '/api/now/table/sys_user?',
          () => tableResult([{ sys_id: 'user-1', user_name: 'admin' }]),
        ],
        // getCurrentScope endpoint returns a non-2xx status for every scoped
        // prefix attempted -> forces the catch branch in getSessionContext.
        ['/getCurrentScope', () => mkResponse(404, { error: 'not found' })],
        [
          '/api/now/table/sys_user_preference?',
          (href) => {
            if (href.includes('apps.current_app')) {
              return tableResult([{ sys_id: 'pref-1', value: 'scope-sys-9' }]);
            }
            // sys_update_set preference lookup: none set.
            return tableResult([]);
          },
        ],
        [
          '/api/now/table/sys_scope?',
          () => tableResult([{ sys_id: 'scope-sys-9', scope: 'x_fallback', name: 'Fallback App' }]),
        ],
      ]);

      const ctx = await getSessionContext(1000);
      assert.equal(ctx.scope.scope, 'x_fallback');
      assert.equal(ctx.scope.scopeSysId, 'scope-sys-9');
      assert.equal(ctx.scope.name, 'Fallback App');
      // No sys_update_set preference -> empty update set fields.
      assert.equal(ctx.updateSet.sysId, '');
      assert.equal(ctx.updateSet.name, '');
    }
  );
});

test('getSessionContext: fallback branch with no apps.current_app preference at all', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = routedFetch([
        [
          '/api/now/table/sys_user?',
          () => tableResult([{ sys_id: 'user-1', user_name: 'admin' }]),
        ],
        ['/getCurrentScope', () => mkResponse(500, { error: 'boom' })],
        ['/api/now/table/sys_user_preference?', () => tableResult([])],
      ]);

      const ctx = await getSessionContext(1000);
      assert.equal(ctx.scope.scope, '');
      assert.equal(ctx.scope.scopeSysId, '');
      assert.equal(ctx.scope.name, '');
      assert.equal(ctx.updateSet.sysId, '');
    }
  );
});

test('getSessionContext: throws when sys_user cannot be found for SN_USER', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'ghost', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = routedFetch([['/api/now/table/sys_user?', () => tableResult([])]]);

      await assert.rejects(
        () => getSessionContext(1000),
        /Could not find sys_user for SN_USER=ghost/
      );
    }
  );
});

test('listScopes: trims/query passthrough and clamps limit into [1,500]', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const seenUrls = [];
      global.fetch = async (url) => {
        seenUrls.push(String(url));
        return tableResult([{ sys_id: 's1', scope: 'x_a', name: 'A' }]);
      };

      const rows = await listScopes(1000, '  scope=x_a  ', 999);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].scope, 'x_a');
      const url = seenUrls[0];
      assert.match(url, /sysparm_query=scope%3Dx_a/);
      assert.match(url, /sysparm_limit=500/);
    }
  );
});

test('listScopes: default query/limit when omitted, floor of 1', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const seenUrls = [];
      global.fetch = async (url) => {
        seenUrls.push(String(url));
        return tableResult([]);
      };

      const rows = await listScopes(1000, undefined, -5);
      assert.equal(rows.length, 0);
      const url = seenUrls[0];
      assert.match(url, /sysparm_query=(&|$)/);
      assert.match(url, /sysparm_limit=1(&|$)/);
    }
  );
});

test('setCurrentScope: throws when scope code does not exist', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = routedFetch([['/api/now/table/sys_scope?', () => tableResult([])]]);

      await assert.rejects(
        () => setCurrentScope('x_missing', 1000),
        /Scope not found: x_missing/
      );
    }
  );
});

test('setCurrentScope: creates a new preference when none exists yet, then reports session context', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      let createCalled = false;
      global.fetch = routedFetch([
        [
          '/api/now/table/sys_scope?',
          () => tableResult([{ sys_id: 'scope-sys-1', scope: 'x_app', name: 'My App' }]),
        ],
        [
          '/api/now/table/sys_user?',
          () => tableResult([{ sys_id: 'user-1', user_name: 'admin' }]),
        ],
        // No existing preference -> POST create path.
        ['/api/now/table/sys_user_preference?', () => tableResult([])],
        [
          '/api/now/table/sys_user_preference',
          (href) => {
            createCalled = true;
            return mkResponse(201, { result: { sys_id: 'pref-new', value: 'scope-sys-1' } });
          },
        ],
        ['/getCurrentScope', () => mkResponse(404, { error: 'nope' })],
      ]);

      // snRequest for POST uses the exact endpoint (no querystring), so the
      // routed matcher above for the plain path must win for POST while the
      // '?'-suffixed one wins for GET list calls. Re-route explicitly:
      global.fetch = async (url, init) => {
        const href = String(url);
        const method = init && init.method ? init.method : 'GET';
        if (href.includes('/api/now/table/sys_scope?')) {
          return tableResult([{ sys_id: 'scope-sys-1', scope: 'x_app', name: 'My App' }]);
        }
        if (href.includes('/api/now/table/sys_user?')) {
          return tableResult([{ sys_id: 'user-1', user_name: 'admin' }]);
        }
        if (method === 'POST' && href.includes('/api/now/table/sys_user_preference')) {
          createCalled = true;
          return mkResponse(201, { result: { sys_id: 'pref-new', value: 'scope-sys-1' } });
        }
        if (href.includes('/api/now/table/sys_user_preference?')) {
          return tableResult([]);
        }
        if (href.includes('/getCurrentScope')) {
          return mkResponse(404, { error: 'nope' });
        }
        throw new Error(`Unmatched: ${method} ${href}`);
      };

      const result = await setCurrentScope('x_app', 1000);
      assert.equal(result.requestedScope, 'x_app');
      assert.equal(result.scopeSysId, 'scope-sys-1');
      assert.equal(result.scopeName, 'My App');
      assert.equal(createCalled, true);
      assert.ok(result.sessionContext);
    }
  );
});

test('setCurrentScope: updates an existing preference via PUT', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      let putCalled = false;
      global.fetch = async (url, init) => {
        const href = String(url);
        const method = init && init.method ? init.method : 'GET';
        if (href.includes('/api/now/table/sys_scope?')) {
          return tableResult([{ sys_id: 'scope-sys-1', scope: 'x_app', name: 'My App' }]);
        }
        if (href.includes('/api/now/table/sys_user?')) {
          return tableResult([{ sys_id: 'user-1', user_name: 'admin' }]);
        }
        if (href.includes('/api/now/table/sys_user_preference?')) {
          return tableResult([{ sys_id: 'pref-existing', value: 'scope-old' }]);
        }
        if (method === 'PUT' && href.includes('/api/now/table/sys_user_preference/pref-existing')) {
          putCalled = true;
          return mkResponse(200, { result: { sys_id: 'pref-existing', value: 'scope-sys-1' } });
        }
        if (href.includes('/getCurrentScope')) {
          return mkResponse(404, { error: 'nope' });
        }
        // getSessionContext (called at the end of setCurrentScope) looks up
        // the update-set preference by its own sys_id -> falls back to the
        // fallback-scope preference lookup path, then may query sys_update_set.
        if (href.includes('/api/now/table/sys_update_set?')) {
          return tableResult([]);
        }
        throw new Error(`Unmatched: ${method} ${href}`);
      };

      const result = await setCurrentScope('x_app', 1000);
      assert.equal(putCalled, true);
      assert.equal(result.scopeSysId, 'scope-sys-1');
    }
  );
});

test('setCurrentUpdateSet: throws when neither sysId nor name resolve to a set', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      await assert.rejects(
        () => setCurrentUpdateSet({}, 1000),
        /Update set not found\. Provide updateSetName or updateSetSysId\./
      );
    }
  );
});

test('setCurrentUpdateSet: resolves by updateSetSysId directly', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async (url, init) => {
        const href = String(url);
        const method = init && init.method ? init.method : 'GET';
        if (href.includes('/api/now/table/sys_update_set?') && href.includes('sys_id')) {
          return tableResult([{ sys_id: 'us-1', name: 'Set A', state: 'in progress' }]);
        }
        if (href.includes('/api/now/table/sys_user?')) {
          return tableResult([{ sys_id: 'user-1', user_name: 'admin' }]);
        }
        if (href.includes('/api/now/table/sys_user_preference?')) {
          return tableResult([]);
        }
        if (method === 'POST' && href.includes('/api/now/table/sys_user_preference')) {
          return mkResponse(201, { result: { sys_id: 'pref-new', value: 'us-1' } });
        }
        if (href.includes('/getCurrentScope')) {
          return mkResponse(404, { error: 'nope' });
        }
        throw new Error(`Unmatched: ${method} ${href}`);
      };

      const result = await setCurrentUpdateSet({ updateSetSysId: 'us-1' }, 1000);
      assert.equal(result.targetUpdateSet.sysId, 'us-1');
      assert.equal(result.targetUpdateSet.name, 'Set A');
    }
  );
});

test('setCurrentUpdateSet: creates a set by name when missing and createIfMissing is true (default)', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      let createBody = null;
      global.fetch = async (url, init) => {
        const href = String(url);
        const method = init && init.method ? init.method : 'GET';
        if (href.includes('/api/now/table/sys_update_set?') && href.includes('name')) {
          return tableResult([]);
        }
        if (method === 'POST' && href.includes('/api/now/table/sys_update_set')) {
          createBody = JSON.parse(init.body);
          return mkResponse(201, {
            result: { sys_id: 'us-new', name: 'Brand New Set', state: 'in progress' },
          });
        }
        if (href.includes('/api/now/table/sys_user?')) {
          return tableResult([{ sys_id: 'user-1', user_name: 'admin' }]);
        }
        if (href.includes('/api/now/table/sys_user_preference?')) {
          return tableResult([]);
        }
        if (method === 'POST' && href.includes('/api/now/table/sys_user_preference')) {
          return mkResponse(201, { result: { sys_id: 'pref-new', value: 'us-new' } });
        }
        if (href.includes('/getCurrentScope')) {
          return mkResponse(404, { error: 'nope' });
        }
        throw new Error(`Unmatched: ${method} ${href}`);
      };

      const result = await setCurrentUpdateSet(
        { updateSetName: 'Brand New Set', createIfMissing: true },
        1000
      );
      assert.equal(result.targetUpdateSet.sysId, 'us-new');
      assert.equal(createBody.name, 'Brand New Set');
    }
  );
});

test('setCurrentUpdateSet: does not create when createIfMissing is false -> throws', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async (url) => {
        const href = String(url);
        if (href.includes('/api/now/table/sys_update_set?')) {
          return tableResult([]);
        }
        throw new Error(`Unmatched: ${href}`);
      };

      await assert.rejects(
        () =>
          setCurrentUpdateSet({ updateSetName: 'Nope', createIfMissing: false }, 1000),
        /Update set not found\. Provide updateSetName or updateSetSysId\./
      );
    }
  );
});

test('setCurrentUpdateSet: throws when resolved target update set is missing sys_id', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async (url) => {
        const href = String(url);
        if (href.includes('/api/now/table/sys_update_set?')) {
          // Found a row, but it has no sys_id field.
          return tableResult([{ name: 'Weird Set', state: 'in progress' }]);
        }
        throw new Error(`Unmatched: ${href}`);
      };

      await assert.rejects(
        () => setCurrentUpdateSet({ updateSetSysId: 'us-weird' }, 1000),
        /Target update set is missing sys_id\./
      );
    }
  );
});

// --- sessionHandlers.ts: branches not covered by the existing test file ----

function makeContext(overrides = {}) {
  const audits = [];
  const dryRuns = [];
  return {
    timeoutMs: 1000,
    dryRun: false,
    startedAt: Date.now(),
    buildPreflightReport: async () => ({ checks: { allOk: true } }),
    checkSyncronaCapabilities: async () => ({ ok: true }),
    makeDryRunAuditResponse: (toolName, args, details) => {
      dryRuns.push({ toolName, args, details });
      return { isError: false, content: [{ type: 'text', text: `dry-run:${toolName}` }] };
    },
    auditMutatingTool: (toolName, args, outcome, durationMs) => {
      audits.push({ toolName, args, outcome, durationMs });
    },
    _audits: audits,
    _dryRuns: dryRuns,
    ...overrides,
  };
}

test('sync_get_session_context: happy path delegates to getSessionContext', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async (url) => {
        const href = String(url);
        if (href.includes('/api/now/table/sys_user?')) {
          return tableResult([{ sys_id: 'user-1', user_name: 'admin' }]);
        }
        if (href.includes('/getCurrentScope')) {
          return mkResponse(404, { error: 'nope' });
        }
        if (href.includes('/api/now/table/sys_user_preference?')) {
          return tableResult([]);
        }
        throw new Error(`Unmatched: ${href}`);
      };

      const res = await handleSessionTool('sync_get_session_context', {}, makeContext());
      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.userSysId, 'user-1');
      // B2 contract: a tool that declares an outputSchema must mirror its text
      // payload into structuredContent on every success result.
      assert.deepEqual(res.structuredContent, parsed);
    }
  );
});

test('sync_list_scopes: returns count + rows and clamps a huge limit', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const seenUrls = [];
      global.fetch = async (url) => {
        seenUrls.push(String(url));
        return tableResult([{ sys_id: 's1', scope: 'x_a', name: 'A' }]);
      };

      const res = await handleSessionTool(
        'sync_list_scopes',
        { query: 'nameLIKEa', limit: 10000 },
        makeContext()
      );
      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.count, 1);
      assert.equal(parsed.rows[0].scope, 'x_a');
      assert.match(seenUrls[0], /sysparm_limit=500/);
      // B2 contract: declared outputSchema => structuredContent on success.
      assert.deepEqual(res.structuredContent, parsed);
    }
  );
});

test('sync_list_scopes: non-numeric/invalid limit falls back to default 100', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const seenUrls = [];
      global.fetch = async (url) => {
        seenUrls.push(String(url));
        return tableResult([]);
      };

      const res = await handleSessionTool(
        'sync_list_scopes',
        { limit: 'not-a-number' },
        makeContext()
      );
      assert.equal(res.isError, false);
      assert.match(seenUrls[0], /sysparm_limit=100/);
    }
  );
});

test('sync_list_update_sets: returns count + rows', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async () =>
        tableResult([{ sys_id: 'us-1', name: 'Set A', state: 'in progress' }]);

      const res = await handleSessionTool('sync_list_update_sets', {}, makeContext());
      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.count, 1);
      assert.equal(parsed.rows[0].name, 'Set A');
    }
  );
});

test('sync_set_scope: non-dry-run applies the scope switch and audits it', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async (url, init) => {
        const href = String(url);
        const method = init && init.method ? init.method : 'GET';
        if (href.includes('/api/now/table/sys_scope?')) {
          return tableResult([{ sys_id: 'scope-sys-1', scope: 'x_app', name: 'My App' }]);
        }
        if (href.includes('/api/now/table/sys_user?')) {
          return tableResult([{ sys_id: 'user-1', user_name: 'admin' }]);
        }
        if (href.includes('/api/now/table/sys_user_preference?')) {
          return tableResult([]);
        }
        if (method === 'POST' && href.includes('/api/now/table/sys_user_preference')) {
          return mkResponse(201, { result: { sys_id: 'pref-new', value: 'scope-sys-1' } });
        }
        if (href.includes('/getCurrentScope')) {
          return mkResponse(404, { error: 'nope' });
        }
        throw new Error(`Unmatched: ${method} ${href}`);
      };

      const ctx = makeContext();
      const res = await handleSessionTool('sync_set_scope', { scope: '  x_app  ' }, ctx);
      assert.equal(res.isError, false);
      assert.equal(ctx._audits.length, 1);
      assert.equal(ctx._audits[0].toolName, 'sync_set_scope');
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.requestedScope, 'x_app');
    }
  );
});

test('sync_set_update_set: non-dry-run applies the update-set switch and audits it', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async (url, init) => {
        const href = String(url);
        const method = init && init.method ? init.method : 'GET';
        if (href.includes('/api/now/table/sys_update_set?')) {
          return tableResult([{ sys_id: 'us-1', name: 'Set A', state: 'in progress' }]);
        }
        if (href.includes('/api/now/table/sys_user?')) {
          return tableResult([{ sys_id: 'user-1', user_name: 'admin' }]);
        }
        if (href.includes('/api/now/table/sys_user_preference?')) {
          return tableResult([]);
        }
        if (method === 'POST' && href.includes('/api/now/table/sys_user_preference')) {
          return mkResponse(201, { result: { sys_id: 'pref-new', value: 'us-1' } });
        }
        if (href.includes('/getCurrentScope')) {
          return mkResponse(404, { error: 'nope' });
        }
        throw new Error(`Unmatched: ${method} ${href}`);
      };

      const ctx = makeContext();
      const res = await handleSessionTool(
        'sync_set_update_set',
        { updateSetSysId: 'us-1' },
        ctx
      );
      assert.equal(res.isError, false);
      assert.equal(ctx._audits.length, 1);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.targetUpdateSet.sysId, 'us-1');
    }
  );
});

test('sync_prepare_session: dry-run previews without applying', async () => {
  const ctx = makeContext({ dryRun: true });
  const res = await handleSessionTool(
    'sync_prepare_session',
    { expectedScope: 'x_app' },
    ctx
  );
  assert.equal(res.isError, false);
  assert.equal(ctx._dryRuns.length, 1);
  assert.equal(ctx._dryRuns[0].details.expectedScope, 'x_app');
  assert.equal(ctx._audits.length, 0);
});

test('sync_prepare_session: no expected scope/update-set -> reports unchanged session', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async (url) => {
        const href = String(url);
        if (href.includes('/api/now/table/sys_user?')) {
          return tableResult([{ sys_id: 'user-1', user_name: 'admin' }]);
        }
        if (href.includes('/getCurrentScope')) {
          return mkResponse(404, { error: 'nope' });
        }
        if (href.includes('/api/now/table/sys_user_preference?')) {
          return tableResult([]);
        }
        throw new Error(`Unmatched: ${href}`);
      };

      const ctx = makeContext();
      const res = await handleSessionTool('sync_prepare_session', {}, ctx);
      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.changed, false);
      assert.deepEqual(parsed.actions, []);
      assert.equal(ctx._audits.length, 1);
    }
  );
});

test('sync_prepare_session: scope differs -> switches scope and records the action', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async (url, init) => {
        const href = String(url);
        const method = init && init.method ? init.method : 'GET';
        if (href.includes('/api/now/table/sys_user?')) {
          return tableResult([{ sys_id: 'user-1', user_name: 'admin' }]);
        }
        if (href.includes('/getCurrentScope')) {
          return mkResponse(404, { error: 'nope' });
        }
        if (href.includes('/api/now/table/sys_scope?')) {
          return tableResult([{ sys_id: 'scope-sys-2', scope: 'x_target', name: 'Target App' }]);
        }
        if (href.includes('/api/now/table/sys_user_preference?')) {
          return tableResult([]);
        }
        if (method === 'POST' && href.includes('/api/now/table/sys_user_preference')) {
          return mkResponse(201, { result: { sys_id: 'pref-new', value: 'scope-sys-2' } });
        }
        throw new Error(`Unmatched: ${method} ${href}`);
      };

      const ctx = makeContext();
      const res = await handleSessionTool(
        'sync_prepare_session',
        { expectedScope: 'x_target' },
        ctx
      );
      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.changed, true);
      assert.match(parsed.actions[0], /scope changed: <empty> -> x_target/);
    }
  );
});

test('sync_prepare_session: expected update set by name with no sysId always switches', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev1.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async (url, init) => {
        const href = String(url);
        const method = init && init.method ? init.method : 'GET';
        if (href.includes('/api/now/table/sys_user?')) {
          return tableResult([{ sys_id: 'user-1', user_name: 'admin' }]);
        }
        if (href.includes('/getCurrentScope')) {
          return mkResponse(404, { error: 'nope' });
        }
        if (href.includes('/api/now/table/sys_update_set?') && href.includes('name')) {
          return tableResult([{ sys_id: 'us-9', name: 'Feature Set', state: 'in progress' }]);
        }
        if (href.includes('/api/now/table/sys_user_preference?')) {
          return tableResult([]);
        }
        if (method === 'POST' && href.includes('/api/now/table/sys_user_preference')) {
          return mkResponse(201, { result: { sys_id: 'pref-new', value: 'us-9' } });
        }
        throw new Error(`Unmatched: ${method} ${href}`);
      };

      const ctx = makeContext();
      const res = await handleSessionTool(
        'sync_prepare_session',
        { expectedUpdateSetName: 'Feature Set' },
        ctx
      );
      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.changed, true);
      assert.match(parsed.actions[0], /update set changed: <empty> -> us-9/);
    }
  );
});

test('sync_check_instance_capabilities: all ok -> isError false', async () => {
  const ctx = makeContext({
    checkSyncronaCapabilities: async () => ({
      scoped: { ok: true },
      background: { ok: true },
    }),
  });
  const res = await handleSessionTool(
    'sync_check_instance_capabilities',
    { scope: '  x_app  ' },
    ctx
  );
  assert.equal(res.isError, false);
});

test('sync_check_instance_capabilities: a failing capability -> isError true', async () => {
  const ctx = makeContext({
    checkSyncronaCapabilities: async () => ({
      scoped: { ok: true },
      background: { ok: false, error: 'boom' },
    }),
  });
  const res = await handleSessionTool('sync_check_instance_capabilities', {}, ctx);
  assert.equal(res.isError, true);
});

test('sync_preflight_check: empty-string overrides do not clobber guardrail expectations', async () => {
  // Faithfully model buildPreflightReport's contract: overrides layer on top of the
  // guardrail config, and an override only takes effect when actually supplied. The
  // guardrails expect scope "x_guardrail" but the live session is on "x_other", so a
  // truthful report must be allOk:false. Forwarding empty-string overrides would blank
  // the expectation and force a false all-clear.
  const guardrail = { expectedScope: 'x_guardrail' };
  const currentScope = 'x_other';
  let seenOverride;

  const ctx = makeContext({
    buildPreflightReport: async (_timeoutMs, override) => {
      seenOverride = override;
      const cfg = { ...guardrail, ...(override || {}) };
      const scopeOk = !cfg.expectedScope || cfg.expectedScope === currentScope;
      return { checks: { scopeOk, allOk: scopeOk } };
    },
  });

  const res = await handleSessionTool(
    'sync_preflight_check',
    { expectedScope: '', expectedUpdateSetName: '', expectedUpdateSetSysId: '' },
    ctx
  );

  // Empty-string args must not be forwarded as overrides.
  assert.equal(seenOverride.expectedScope, undefined);
  assert.equal(seenOverride.expectedUpdateSetName, undefined);
  assert.equal(seenOverride.expectedUpdateSetSysId, undefined);

  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.checks.allOk, false);
  assert.equal(res.isError, true);
});

test('sync_preflight_check: a real non-empty override is still forwarded', async () => {
  let seenOverride;
  const ctx = makeContext({
    buildPreflightReport: async (_timeoutMs, override) => {
      seenOverride = override;
      return { checks: { allOk: true } };
    },
  });

  await handleSessionTool('sync_preflight_check', { expectedScope: '  x_app  ' }, ctx);
  assert.equal(seenOverride.expectedScope, 'x_app');
  assert.equal(seenOverride.expectedUpdateSetName, undefined);
});

test('unknown tool still returns null with a fully populated context', async () => {
  const res = await handleSessionTool('totally_unknown', { foo: 'bar' }, makeContext());
  assert.equal(res, null);
});
