// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const { handleValidateBeforePush } = require('../dist/handlers/insightValidateBeforePush.js');
const compareModule = require('../dist/handlers/insightCompareInstances.js');
const { handleCompareInstances } = compareModule;
const { validateToolArguments } = require('../dist/inputValidation.js');
const { PRIMARY_SYNCRO_CLI } = require('../dist/runtimeConfig.js');
const servicenowCore = require('../dist/servicenowCore.js');
const {
  clearServiceNowSecretsCache,
  clearScopedApiPrefixCache,
  clearTokenManagerCache,
} = servicenowCore;

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
  const keys = [
    'SN_INSTANCE',
    'SN_USER',
    'SN_PASSWORD',
    'SN_AUTH_METHOD',
    'SN_OAUTH_CLIENT_ID',
    'SN_OAUTH_CLIENT_SECRET',
  ];
  const old = {};
  for (const key of keys) {
    old[key] = process.env[key];
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key];
    }
  }
  clearServiceNowSecretsCache();
  clearScopedApiPrefixCache();
  clearTokenManagerCache();

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of keys) {
        if (old[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = old[key];
        }
      }
      clearServiceNowSecretsCache();
      clearScopedApiPrefixCache();
      clearTokenManagerCache();
    });
}

const BASIC_ENV = {
  SN_INSTANCE: 'dev123.service-now.com',
  SN_USER: 'admin',
  SN_PASSWORD: 'secret',
};

// ---------------------------------------------------------------------------
// sync_validate_before_push: a failed table query must not report a green gate
// ---------------------------------------------------------------------------

test('handleValidateBeforePush: every table query failing does not report ready', async () => {
  await withEnv(BASIC_ENV, async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('sys_update_xml')) {
        return mkResponse(200, { result: [] });
      }
      return mkResponse(403, { error: { message: 'insufficient rights' } });
    };
    const res = await handleValidateBeforePush(
      { scope: 'x_acme_app', tables: ['sys_script_include', 'sys_script'] },
      1000
    );
    const parsed = JSON.parse(res.content[0].text);

    // Zero scripts were analysed, so the gate verdict is unknown — not clean.
    assert.equal(parsed.fileCount, 0);
    assert.equal(parsed.blockedCount, 0);
    assert.equal(parsed.errors.length, 2);
    assert.equal(parsed.validated, false);
    assert.equal(parsed.ready, false, 'a run that analysed nothing must not be ready');
    assert.equal(res.isError, true, 'an unvalidated run must not look like a success');
  });
});

test('handleValidateBeforePush: one failed table among clean ones still blocks ready', async () => {
  await withEnv(BASIC_ENV, async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('sys_update_xml')) {
        return mkResponse(200, { result: [] });
      }
      if (u.includes('sys_script_include')) {
        return mkResponse(200, {
          result: [{ sys_id: 's1', name: 'Clean', script: 'gs.info("hi");' }],
        });
      }
      return mkResponse(500, { error: { message: 'boom' } });
    };
    const res = await handleValidateBeforePush(
      { scope: 'x_acme_app', tables: ['sys_script_include', 'sys_script'] },
      1000
    );
    const parsed = JSON.parse(res.content[0].text);

    assert.equal(parsed.fileCount, 1);
    assert.equal(parsed.blockedCount, 0);
    assert.deepEqual(parsed.errors, [{ table: 'sys_script', status: 500 }]);
    assert.equal(parsed.ready, false, 'a partially analysed scope must not be ready');
    assert.equal(res.isError, true);
  });
});

test('handleValidateBeforePush: fully successful clean run is ready and validated', async () => {
  await withEnv(BASIC_ENV, async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('sys_update_xml')) {
        return mkResponse(200, { result: [] });
      }
      return mkResponse(200, {
        result: [{ sys_id: 's1', name: 'Clean', script: 'gs.info("hi");' }],
      });
    };
    const res = await handleValidateBeforePush(
      { scope: 'x_acme_app', tables: ['sys_script_include'] },
      1000
    );
    const parsed = JSON.parse(res.content[0].text);

    assert.equal(parsed.ready, true);
    assert.equal(parsed.validated, true);
    assert.equal(parsed.conflictCheckPerformed, true);
    assert.deepEqual(parsed.errors, []);
    assert.equal(res.isError, false);
  });
});

// ---------------------------------------------------------------------------
// sync_validate_before_push: a failed conflict query must not read as "no conflicts"
// ---------------------------------------------------------------------------

test('handleValidateBeforePush: failed conflict query is reported, not degraded to "no recent changes"', async () => {
  await withEnv(BASIC_ENV, async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('sys_update_xml')) {
        return mkResponse(403, { error: { message: 'insufficient rights' } });
      }
      return mkResponse(200, {
        result: [{ sys_id: 'a', name: 'Foo', script: "gs.info('ok');" }],
      });
    };
    const res = await handleValidateBeforePush(
      { scope: 'x_acme_app', tables: ['sys_script_include'] },
      1000
    );
    const parsed = JSON.parse(res.content[0].text);

    // "nobody else changed the scope" and "the conflict check never ran" are
    // opposite verdicts; an empty recentChanges list must not stand for both.
    assert.equal(parsed.conflictCheckPerformed, false);
    assert.deepEqual(parsed.recentChanges, []);
    assert.deepEqual(parsed.errors, [{ table: 'sys_update_xml', status: 403 }]);
    assert.equal(parsed.ready, false, 'an unrun conflict check must not be ready');
    assert.equal(res.isError, true);
  });
});

test('handleValidateBeforePush: successful conflict query still maps recent changes', async () => {
  await withEnv(BASIC_ENV, async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('sys_update_xml')) {
        return mkResponse(200, {
          result: [
            {
              target_name: 'Widget',
              type: 'Script Include',
              action: 'insert',
              sys_created_by: 'jane',
              sys_created_on: '2024-06-01 10:00:00',
            },
          ],
        });
      }
      return mkResponse(200, { result: [] });
    };
    const res = await handleValidateBeforePush(
      { scope: 'x_acme_app', tables: ['sys_script_include'] },
      1000
    );
    const parsed = JSON.parse(res.content[0].text);

    assert.equal(parsed.conflictCheckPerformed, true);
    assert.deepEqual(parsed.recentChanges, [
      {
        name: 'Widget',
        type: 'Script Include',
        action: 'INSERT',
        changedBy: 'jane',
        changedAt: '2024-06-01 10:00:00',
      },
    ]);
    assert.equal(parsed.ready, true);
  });
});

// ---------------------------------------------------------------------------
// sync_compare_instances: a fulfilled non-2xx must not be diffed as an empty set
// ---------------------------------------------------------------------------

function withStubbedProfiles(fn) {
  const realLoad = servicenowCore.loadAuthStoreProfile;
  const realRequest = servicenowCore.snRequestWithConfig;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      servicenowCore.loadAuthStoreProfile = realLoad;
      servicenowCore.snRequestWithConfig = realRequest;
    });
}

test('handleCompareInstances: fulfilled non-2xx from one instance does not fabricate onlyInB', async () => {
  await withStubbedProfiles(async () => {
    servicenowCore.loadAuthStoreProfile = (name) => ({
      instance: `${name}.service-now.com`,
      user: 'admin',
      password: 'secret',
    });
    servicenowCore.snRequestWithConfig = async (config) => {
      if (config.instance.startsWith('inst-a')) {
        return { status: 403, data: { error: { message: 'insufficient rights' } }, text: '' };
      }
      return {
        status: 200,
        data: {
          result: [
            { sys_id: '1', name: 'Helper', script: 'x' },
            { sys_id: '2', name: 'Util', script: 'y' },
          ],
        },
        text: '',
      };
    };

    const res = await handleCompareInstances(
      { profileA: 'inst-a', profileB: 'inst-b', scope: 'x_acme_app', tables: ['sys_script_include'] },
      1000
    );
    const parsed = JSON.parse(res.content[0].text);
    const row = parsed.tables[0];

    // Diffing an error body's (empty) row set would claim every record on B is
    // missing from A, driving a promotion that overwrites existing records.
    assert.deepEqual(row.onlyInB, []);
    assert.deepEqual(row.onlyInA, []);
    assert.equal(row.statusA, 403);
    assert.match(row.error, /non-2xx status/);
    assert.equal(parsed.summary.onlyInB, 0, 'a skipped table must not inflate the summary');
    assert.equal(parsed.summary.errors, 1);
    assert.equal(parsed.summary.complete, false);
    assert.equal(res.isError, true, 'a partial comparison must not look complete');
  });
});

test('handleCompareInstances: both instances 2xx still produce a real diff', async () => {
  await withStubbedProfiles(async () => {
    servicenowCore.loadAuthStoreProfile = (name) => ({
      instance: `${name}.service-now.com`,
      user: 'admin',
      password: 'secret',
    });
    servicenowCore.snRequestWithConfig = async (config) => {
      if (config.instance.startsWith('inst-a')) {
        return {
          status: 200,
          data: { result: [{ sys_id: '1', name: 'Helper', script: 'x' }] },
          text: '',
        };
      }
      return {
        status: 200,
        data: {
          result: [
            { sys_id: '1', name: 'Helper', script: 'CHANGED' },
            { sys_id: '2', name: 'Util', script: 'y' },
          ],
        },
        text: '',
      };
    };

    const res = await handleCompareInstances(
      { profileA: 'inst-a', profileB: 'inst-b', scope: 'x_acme_app', tables: ['sys_script_include'] },
      1000
    );
    const parsed = JSON.parse(res.content[0].text);

    assert.deepEqual(parsed.tables[0].onlyInB, ['Util']);
    assert.equal(parsed.tables[0].different.length, 1);
    assert.equal(parsed.summary.errors, 0);
    assert.equal(parsed.summary.complete, true);
    assert.equal(res.isError, false);
  });
});

test('handleCompareInstances: a rejected request is counted as an error too', async () => {
  await withStubbedProfiles(async () => {
    servicenowCore.loadAuthStoreProfile = (name) => ({
      instance: `${name}.service-now.com`,
      user: 'admin',
      password: 'secret',
    });
    servicenowCore.snRequestWithConfig = async (config) => {
      if (config.instance.startsWith('inst-a')) {
        throw new Error('socket hang up');
      }
      return { status: 200, data: { result: [] }, text: '' };
    };

    const res = await handleCompareInstances(
      { profileA: 'inst-a', profileB: 'inst-b', scope: 'x_acme_app', tables: ['sys_script_include'] },
      1000
    );
    const parsed = JSON.parse(res.content[0].text);

    assert.equal(parsed.summary.errors, 1);
    assert.equal(parsed.summary.complete, false);
    assert.equal(res.isError, true);
    assert.match(parsed.tables[0].error, /instance request failed/);
  });
});

// ---------------------------------------------------------------------------
// PRIMARY_SYNCRO_CLI must be an npm identifier, not the brand display name
// ---------------------------------------------------------------------------

// Mirrors npm's package-name rules for the subset that matters here: `npx <pkg>`
// rejects spaces and uppercase outright (EINVALIDTAGNAME / EINVALIDPACKAGENAME).
const NPM_PACKAGE_NAME_REGEX = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

test('PRIMARY_SYNCRO_CLI is a valid npm package identifier', () => {
  assert.match(
    PRIMARY_SYNCRO_CLI,
    NPM_PACKAGE_NAME_REGEX,
    `npx would reject "${PRIMARY_SYNCRO_CLI}" as a package name`
  );
  assert.doesNotMatch(PRIMARY_SYNCRO_CLI, /\s/, 'npm package names cannot contain spaces');
});

test('PRIMARY_SYNCRO_CLI matches the core package name and bin key', () => {
  const corePkgPath = path.join(__dirname, '..', '..', 'core', 'package.json');
  const corePkg = JSON.parse(fs.readFileSync(corePkgPath, 'utf8'));
  assert.equal(PRIMARY_SYNCRO_CLI, corePkg.name);
  assert.ok(
    Object.prototype.hasOwnProperty.call(corePkg.bin, PRIMARY_SYNCRO_CLI),
    `packages/core/package.json bin must expose a "${PRIMARY_SYNCRO_CLI}" binary`
  );
});

// ---------------------------------------------------------------------------
// inputValidation: the empty string the tool schemas advertise as `default: ""`
// ---------------------------------------------------------------------------

test('validateToolArguments: sync_set_update_set accepts the advertised empty updateSetSysId default', () => {
  const res = validateToolArguments('sync_set_update_set', {
    updateSetName: 'Release 1',
    updateSetSysId: '',
    createIfMissing: true,
  });
  assert.equal(res.valid, true, res.error);
});

test('validateToolArguments: sync_prepare_session accepts the advertised empty expectedUpdateSetSysId default', () => {
  const res = validateToolArguments('sync_prepare_session', {
    expectedUpdateSetName: 'Release 1',
    expectedUpdateSetSysId: '',
  });
  assert.equal(res.valid, true, res.error);
});

test('validateToolArguments: sync_preflight_check accepts the advertised empty expectedUpdateSetSysId default', () => {
  const res = validateToolArguments('sync_preflight_check', {
    expectedUpdateSetName: 'Release 1',
    expectedUpdateSetSysId: '',
  });
  assert.equal(res.valid, true, res.error);
});

test('validateToolArguments: a real sys_id is still accepted', () => {
  const res = validateToolArguments('sync_set_update_set', {
    updateSetSysId: 'a'.repeat(32),
  });
  assert.equal(res.valid, true, res.error);
});

test('validateToolArguments: a malformed non-empty sys_id is still rejected', () => {
  const res = validateToolArguments('sync_set_update_set', { updateSetSysId: 'nope' });
  assert.equal(res.valid, false);
  assert.match(res.error, /32-character hexadecimal sys_id/);
});

// ---------------------------------------------------------------------------
// servicenowCore: the OAuth token leg must observe the caller's timeoutMs
// ---------------------------------------------------------------------------

test('snRequestWithConfig: a hung OAuth token endpoint aborts within the caller timeout', async (t) => {
  const sockets = new Set();
  const server = http.createServer(() => {
    // Accept the request and never respond: without a signal on the token fetch
    // this hangs until undici's 300s default headers timeout.
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
    clearTokenManagerCache();
  });

  clearTokenManagerCache();
  const config = {
    instance: `http://127.0.0.1:${port}`,
    user: 'admin',
    password: 'secret',
    authMethod: 'oauth-password',
    clientId: 'client-id',
    clientSecret: 'client-secret',
  };

  const timeoutMs = 1000;
  const startedAt = Date.now();
  await assert.rejects(
    () => servicenowCore.snRequestWithConfig(config, 'GET', '/api/now/table/incident', undefined, timeoutMs),
    'a hung token endpoint must reject rather than stall'
  );
  const elapsed = Date.now() - startedAt;

  // 3 attempts x ~1s budget + backoff; without the token-leg signal this would
  // run into undici's 300s default instead.
  assert.ok(
    elapsed < 30000,
    `token acquisition ignored the ${timeoutMs}ms budget (took ${elapsed}ms)`
  );
});

test('snRequestWithConfig: a healthy OAuth token endpoint still authorizes the request', async (t) => {
  let tokenCalls = 0;
  let seenAuthorization = null;
  const server = http.createServer((req, res) => {
    if (req.url.includes('oauth_token.do')) {
      tokenCalls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'tok-123', expires_in: 1800 }));
      return;
    }
    seenAuthorization = req.headers.authorization;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: [] }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    clearTokenManagerCache();
  });

  clearTokenManagerCache();
  const config = {
    instance: `http://127.0.0.1:${port}`,
    user: 'admin',
    password: 'secret',
    authMethod: 'oauth-password',
    clientId: 'client-id',
    clientSecret: 'client-secret',
  };

  const res = await servicenowCore.snRequestWithConfig(
    config,
    'GET',
    '/api/now/table/incident',
    undefined,
    10000
  );

  assert.equal(res.status, 200);
  assert.equal(tokenCalls, 1);
  assert.equal(seenAuthorization, 'Bearer tok-123');
});
