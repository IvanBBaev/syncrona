const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCipheriv, randomBytes, scryptSync } = require('node:crypto');

const {
  parseDotEnv,
  parseGuardrailConfig,
  instanceToBaseUrl,
  shouldRetryStatus,
  snRequest,
  resolveServiceNowSecrets,
  summarizeRows,
  findScriptIncludeLocalPaths,
  getSourceDirectory,
  normalizeTimeout,
  toTableResultRows,
  checkSyncronaCapabilities,
  clearScopedApiPrefixCache,
  clearServiceNowSecretsCache,
  parseHealthHttpConfig,
  startHealthHttpServer,
  getHealthEndpointStatus,
  loadGuardrailConfig,
  buildPreflightReport,
  getSessionContext,
  listScopes,
  setCurrentScope,
  setCurrentUpdateSet,
  isUnsafeWorkspaceCommand,
  isMutatingTool,
  sanitizeForAudit,
  checkAuditLogIntegrity,
  isDryRunRequested,
  formatToolError,
  formatStructuredToolError,
  McpError,
  normalizeMcpError,
  riskLevelFromScore,
  parseRiskLevel,
  getApprovalRequirements,
  isApprovalSatisfied,
  validateRollbackEvidence,
  evaluateMinimalFootprint,
  evaluateToolPolicy,
  normalizeScopeCode,
  getScopeDocsPaths,
  getScopeKnowledgePaths,
  getScopeTableDocPath,
  getTableDependencyReportPaths,
  getWorkflowSimulationReportPaths,
  discoverWorkspaceScopeKnowledge,
  discoverWorkspaceScopeKnowledgeAsync,
  executeMcpToolIntegration,
  createGracefulShutdownController,
  validateToolArguments,
  auditToolCall,
  getSemanticIndex,
  getSemanticIndexState,
  invalidateSemanticIndex,
} = require('../dist/index.js');
const { handleWorkspaceTool } = require('../dist/handlers/workspaceHandlers.js');
const { handleHealthPlanningTool } = require('../dist/handlers/healthPlanningHandlers.js');
const { writeAuditEvent } = require('../dist/audit.js');
const { appendMetricEvent, loadMetricEvents } = require('../dist/metricsStore.js');
const {
  handleInsightTool,
  buildScriptExcerpt,
  isoToServiceNowDateTime,
  buildRecentChangesQuery,
  buildReleaseNotesMarkdown,
  formatRecordHistory,
  buildAtfRunScript,
  parseAtfTrigger,
  summarizeAtfResults,
  evaluateValidationStatus,
  hashRecordContent,
  diffInstanceRecords,
  buildUpdateSetExportPath,
} = require('../dist/handlers/insightToolHandlers.js');

function mkResponse(status, payload) {
  return {
    status,
    text: async () =>
      typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
}

// A test that fails mid-body would otherwise leak its global.fetch mock into
// every subsequent test (and, via an unclosed health server, hang the run).
const REAL_GLOBAL_FETCH = global.fetch;
test.afterEach(() => {
  global.fetch = REAL_GLOBAL_FETCH;
});

function withEnv(vars, fn) {
  const old = {
    SN_INSTANCE: process.env.SN_INSTANCE,
    SN_USER: process.env.SN_USER,
    SN_PASSWORD: process.env.SN_PASSWORD,
  };

  process.env.SN_INSTANCE = vars.SN_INSTANCE;
  process.env.SN_USER = vars.SN_USER;
  process.env.SN_PASSWORD = vars.SN_PASSWORD;
  // Module-level caches would otherwise leak the previous test's credentials
  // and scoped-prefix ordering into this one.
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

test('parseDotEnv parses key values and strips quotes', () => {
  const raw = [
    '# comment',
    'SN_INSTANCE=dev12345.service-now.com',
    'SN_USER="admin"',
    "SN_PASSWORD='secret'",
    '',
  ].join('\n');

  const parsed = parseDotEnv(raw);
  assert.equal(parsed.SN_INSTANCE, 'dev12345.service-now.com');
  assert.equal(parsed.SN_USER, 'admin');
  assert.equal(parsed.SN_PASSWORD, 'secret');
});

test('resolveServiceNowSecrets reads credentials from secrets file when env is empty', () => {
  const old = {
    SN_INSTANCE: process.env.SN_INSTANCE,
    SN_USER: process.env.SN_USER,
    SN_PASSWORD: process.env.SN_PASSWORD,
    SYNCRONA_SECRETS_FILE: process.env.SYNCRONA_SECRETS_FILE,
    HOME: process.env.HOME,
  };

  delete process.env.SN_INSTANCE;
  delete process.env.SN_USER;
  delete process.env.SN_PASSWORD;
  delete process.env.SYNCRONA_SECRETS_FILE;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-mcp-secrets-'));
  // Isolate HOME so the auth-store provider does not read real ~/.syncrona credentials.
  process.env.HOME = tempDir;
  const secretsDir = path.join(tempDir, '.syncrona-mcp');
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.writeFileSync(
    path.join(secretsDir, 'secrets.json'),
    JSON.stringify({
      servicenow: {
        instance: 'file-instance.service-now.com',
        user: 'file-user',
        password: 'file-pass',
      },
    }),
    'utf-8'
  );

  const cfg = resolveServiceNowSecrets(tempDir);
  assert.equal(cfg.instance, 'file-instance.service-now.com');
  assert.equal(cfg.user, 'file-user');
  assert.equal(cfg.password, 'file-pass');

  process.env.SN_INSTANCE = old.SN_INSTANCE;
  process.env.SN_USER = old.SN_USER;
  process.env.SN_PASSWORD = old.SN_PASSWORD;
  process.env.SYNCRONA_SECRETS_FILE = old.SYNCRONA_SECRETS_FILE;
  process.env.HOME = old.HOME;
});

test('resolveServiceNowSecrets reads credentials from auth store when env is empty', () => {
  const old = {
    SN_INSTANCE: process.env.SN_INSTANCE,
    SN_USER: process.env.SN_USER,
    SN_PASSWORD: process.env.SN_PASSWORD,
    SYNCRONA_SECRETS_FILE: process.env.SYNCRONA_SECRETS_FILE,
    HOME: process.env.HOME,
  };

  delete process.env.SN_INSTANCE;
  delete process.env.SN_USER;
  delete process.env.SN_PASSWORD;
  delete process.env.SYNCRONA_SECRETS_FILE;

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-auth-store-'));
  process.env.HOME = tempHome;

  const syncronaDir = path.join(tempHome, '.syncrona');
  const credentialsDir = path.join(syncronaDir, 'credentials');
  fs.mkdirSync(credentialsDir, { recursive: true });

  const instance = 'store-instance.service-now.com';
  fs.writeFileSync(
    path.join(syncronaDir, 'config.json'),
    JSON.stringify({ activeInstance: instance }),
    'utf-8'
  );

  const salt = 'syncrona-credential-store-v1';
  const key = scryptSync(`${os.hostname()}:${os.userInfo().username}:${salt}`, salt, 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(
      JSON.stringify({
        instance,
        user: 'store-user',
        password: 'store-pass',
      }),
      'utf8'
    ),
    cipher.final(),
  ]);
  const payload = `${iv.toString('hex')}:${cipher
    .getAuthTag()
    .toString('hex')}:${encrypted.toString('hex')}`;

  fs.writeFileSync(
    path.join(credentialsDir, `${instance.replace(/[^a-zA-Z0-9.-]/g, '_')}.enc`),
    payload,
    'utf-8'
  );

  const cfg = resolveServiceNowSecrets(path.join(tempHome, 'workspace'));
  assert.equal(cfg.instance, instance);
  assert.equal(cfg.user, 'store-user');
  assert.equal(cfg.password, 'store-pass');

  process.env.SN_INSTANCE = old.SN_INSTANCE;
  process.env.SN_USER = old.SN_USER;
  process.env.SN_PASSWORD = old.SN_PASSWORD;
  process.env.SYNCRONA_SECRETS_FILE = old.SYNCRONA_SECRETS_FILE;
  process.env.HOME = old.HOME;
});

test('evaluateToolPolicy enforces environment and tool rules', () => {
  const cfg = parseGuardrailConfig({
    policy: {
      activeEnvironment: 'ci',
      environments: {
        ci: {
          denyTools: ['run_node_code'],
        },
      },
      tools: {
        sync_unified_change_workflow: {
          requireDryRun: true,
        },
      },
    },
  });

  const deniedByEnv = evaluateToolPolicy(cfg, 'run_node_code', {}, false);
  assert.equal(deniedByEnv.allowed, false);
  assert.equal(String(deniedByEnv.reason).includes('denied'), true);

  const deniedByToolRule = evaluateToolPolicy(
    cfg,
    'sync_unified_change_workflow',
    { apply: true },
    false
  );
  assert.equal(deniedByToolRule.allowed, false);
  assert.equal(String(deniedByToolRule.reason).includes('dryRun=true'), true);

  const allowed = evaluateToolPolicy(
    cfg,
    'sync_unified_change_workflow',
    { apply: false, dryRun: true },
    true
  );
  assert.equal(allowed.allowed, true);
});

test('sync_tool_contract_info returns deterministic contract metadata', async () => {
  const response = await handleHealthPlanningTool(
    'sync_tool_contract_info',
    {},
    {
      timeoutMs: 5000,
      contractVersion: '1.0.0',
      serverInfo: {
        name: 'syncro-now-ai-mcp-server',
        version: '0.1.0',
      },
      getDeclaredToolNames: () => ['b_tool', 'a_tool', 'a_tool'],
      getDeclaredTools: () => [
        { name: 'b_tool', metadata: { version: '1.2.0', deprecated: true, replacedBy: 'a_tool' } },
        { name: 'a_tool', metadata: { version: '1.0.0', deprecated: false } },
      ],
      getToolMetrics: () => [],
      checkSyncronaCapabilities: async () => ({}),
      toGraphFromUnknown: () => ({ nodes: [], edges: [] }),
    }
  );

  assert.equal(response.isError, false);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.contractVersion, '1.0.0');
  assert.equal(payload.server.name, 'syncro-now-ai-mcp-server');
  assert.equal(payload.server.version, '0.1.0');
  assert.deepEqual(payload.tools.names, ['a_tool', 'b_tool']);
  assert.equal(payload.tools.count, 2);
  assert.equal(typeof payload.tools.hash, 'string');
  assert.equal(payload.tools.hash.length, 8);
  assert.equal(payload.tools.deprecatedCount, 1);
  assert.deepEqual(payload.tools.deprecatedTools, ['b_tool']);
  assert.deepEqual(payload.tools.lifecycle, [
    { name: 'a_tool', version: '1.0.0', deprecated: false },
    { name: 'b_tool', version: '1.2.0', deprecated: true, replacedBy: 'a_tool' },
  ]);
});

test('sync_ai_next_actions returns prioritized safe orchestration steps', async () => {
  const response = await handleHealthPlanningTool(
    'sync_ai_next_actions',
    {
      objective: 'Prepare scope and update set, then push changes safely',
      maxSteps: 4,
    },
    {
      timeoutMs: 5000,
      contractVersion: '1.0.0',
      serverInfo: {
        name: 'syncro-now-ai-mcp-server',
        version: '0.1.0',
      },
      getDeclaredToolNames: () => [
        'sync_prepare_session',
        'sync_preflight_check',
        'sync_plan_minimal_footprint',
        'sync_health_check',
        'sync_tool_contract_info',
      ],
      getDeclaredTools: () => [],
      getToolMetrics: () => [],
      checkSyncronaCapabilities: async () => ({}),
      toGraphFromUnknown: () => ({ nodes: [], edges: [] }),
    }
  );

  assert.equal(response.isError, false);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.objective.includes('push'), true);
  assert.equal(payload.count <= 4, true);
  assert.equal(payload.count > 0, true);
  assert.equal(Array.isArray(payload.nextActions), true);
  assert.equal(payload.nextActions.some((step) => step.tool === 'sync_prepare_session'), true);
  assert.equal(payload.nextActions.some((step) => step.tool === 'sync_preflight_check'), true);
});

test('sync_ai_next_actions tokenizes multi-word objectives', async () => {
  const response = await handleHealthPlanningTool(
    'sync_ai_next_actions',
    {
      objective: 'Prepare scope and context, then push the changes safely',
      maxSteps: 3,
    },
    {
      timeoutMs: 5000,
      contractVersion: '1.0.0',
      serverInfo: {
        name: 'syncro-now-ai-mcp-server',
        version: '0.1.0',
      },
      getDeclaredToolNames: () => [
        'sync_prepare_session',
        'sync_preflight_check',
        'sync_plan_minimal_footprint',
      ],
      getDeclaredTools: () => [],
      getToolMetrics: () => [],
      checkSyncronaCapabilities: async () => ({}),
      toGraphFromUnknown: () => ({ nodes: [], edges: [] }),
    }
  );

  assert.equal(response.isError, false);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.count > 0, true);
  assert.equal(payload.nextActions.some((step) => step.tool === 'sync_prepare_session'), true);
});

test('instanceToBaseUrl normalizes with protocol and trailing slash', () => {
  assert.equal(instanceToBaseUrl('dev123.service-now.com'), 'https://dev123.service-now.com/');
  assert.equal(instanceToBaseUrl('https://dev123.service-now.com'), 'https://dev123.service-now.com/');
  assert.equal(instanceToBaseUrl('https://dev123.service-now.com/'), 'https://dev123.service-now.com/');
});

test('shouldRetryStatus classifies transient HTTP statuses', () => {
  assert.equal(shouldRetryStatus(429), true);
  assert.equal(shouldRetryStatus(500), true);
  assert.equal(shouldRetryStatus(503), true);
  assert.equal(shouldRetryStatus(404), false);
  assert.equal(shouldRetryStatus(200), false);
});

test('snRequest retries transient status codes and succeeds on a later attempt', async () => {
  const originalFetch = global.fetch;
  let attempts = 0;
  global.fetch = async () => {
    attempts += 1;
    if (attempts < 3) {
      return mkResponse(503, { error: 'temporary unavailable' });
    }
    return mkResponse(200, { result: { ok: true } });
  };

  await withEnv(
    {
      SN_INSTANCE: 'dev123.service-now.com',
      SN_USER: 'admin',
      SN_PASSWORD: 'secret',
    },
    async () => {
      const response = await snRequest('GET', '/api/now/table/sys_user?sysparm_limit=1', undefined, 5000);
      assert.equal(response.status, 200);
      assert.equal(attempts, 3);
    }
  );

  global.fetch = originalFetch;
});

test('summarizeRows aggregates counts by field', () => {
  const rows = [
    { state: '1' },
    { state: '2' },
    { state: '1' },
    {},
  ];

  const counts = summarizeRows(rows, 'state');
  assert.deepEqual(counts, {
    '1': 2,
    '2': 1,
    '<empty>': 1,
  });
});

test('getSourceDirectory reads sync.config.js when present', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-mcp-test-'));
  fs.writeFileSync(
    path.join(tempDir, 'sync.config.js'),
    'module.exports = { sourceDirectory: "custom_src" };\n'
  );

  const sourceDir = getSourceDirectory(tempDir);
  assert.equal(sourceDir, 'custom_src');
});

test('findScriptIncludeLocalPaths resolves script include paths from manifest', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-mcp-test-'));
  fs.writeFileSync(
    path.join(tempDir, 'sync.config.js'),
    'module.exports = { sourceDirectory: "src" };\n'
  );

  fs.writeFileSync(
    path.join(tempDir, 'sync.manifest.json'),
    JSON.stringify(
      {
        scope: 'x_test',
        tables: {
          sys_script_include: {
            records: {
              rec_1: {
                name: 'My Include',
                sys_id: 'abc123',
                files: [{ name: 'script', type: 'js' }],
              },
            },
          },
        },
      },
      null,
      2
    )
  );

  const paths = findScriptIncludeLocalPaths('My Include', tempDir);
  assert.equal(paths.length, 1);
  assert.equal(
    paths[0],
    path.join(tempDir, 'src', 'sys_script_include', 'My Include', 'script.js')
  );
});

test('normalizeTimeout clamps invalid and out-of-range values', () => {
  assert.equal(normalizeTimeout(undefined), 120000);
  assert.equal(normalizeTimeout(NaN), 120000);
  assert.equal(normalizeTimeout(500), 1000);
  assert.equal(normalizeTimeout(9999999), 900000);
  assert.equal(normalizeTimeout(2000), 2000);
});

test('semantic index initializes lazily and supports invalidation', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-semantic-'));
  const sourceDir = path.join(tmpDir, 'src');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, 'demo.ts'),
    [
      'export function localFunction() {',
      '  return 1;',
      '}',
    ].join('\n'),
    'utf-8'
  );

  invalidateSemanticIndex('test:lazy-init');
  const before = getSemanticIndexState();
  assert.equal(before.dirty, true);

  const rows = getSemanticIndex(tmpDir);
  assert.equal(Array.isArray(rows), true);
  assert.equal(rows.length > 0, true);

  const afterBuild = getSemanticIndexState();
  assert.equal(afterBuild.built, true);
  assert.equal(afterBuild.dirty, false);
  assert.equal(afterBuild.symbolCount > 0, true);

  invalidateSemanticIndex('test:manual-invalidate');
  const afterInvalidate = getSemanticIndexState();
  assert.equal(afterInvalidate.dirty, true);
});

test('validateToolArguments rejects invalid table names for ServiceNow CRUD tools', () => {
  const result = validateToolArguments('sn_query_records', {
    table: 'sys_user;drop_table',
    limit: 10,
  });

  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.error.includes('table'), true);
  }
});

test('validateToolArguments rejects invalid sys_id shape', () => {
  const result = validateToolArguments('sync_set_update_set', {
    updateSetSysId: '12345',
  });

  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.error.includes('updateSetSysId'), true);
  }
});

test('validateToolArguments accepts valid table and sys_id values', () => {
  const validSysId = '0123456789abcdef0123456789abcdef';
  const result = validateToolArguments('sn_get_metadata_record', {
    recordType: 'acl',
    sysId: validSysId,
    timeoutMs: 5000,
  });

  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.normalizedArgs.sysId, validSysId);
  }
});

test('toTableResultRows returns only valid objects from result array', () => {
  assert.deepEqual(toTableResultRows({}), []);
  assert.deepEqual(toTableResultRows({ result: 'bad' }), []);
  assert.deepEqual(
    toTableResultRows({ result: [{ a: 1 }, null, 5, { b: 2 }] }),
    [{ a: 1 }, { b: 2 }]
  );
});

test('listScopes uses empty default query when no filter is provided', async () => {
  const originalFetch = global.fetch;
  let observedQuery = null;

  global.fetch = async (url) => {
    const uri = String(url);
    const parsed = new URL(uri);
    observedQuery = parsed.searchParams.get('sysparm_query');
    return mkResponse(200, {
      result: [{ sys_id: 'scope1', scope: 'global', name: 'Global' }],
    });
  };

  await withEnv(
    {
      SN_INSTANCE: 'dev123.service-now.com',
      SN_USER: 'admin',
      SN_PASSWORD: 'secret',
    },
    async () => {
      const rows = await listScopes(5000);
      assert.equal(rows.length, 1);
      assert.equal(observedQuery, '');
    }
  );

  global.fetch = originalFetch;
});

test('findScriptIncludeLocalPaths returns empty when manifest is missing', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-mcp-test-'));
  assert.deepEqual(findScriptIncludeLocalPaths('Missing Include', tempDir), []);
});

test('checkSyncronaCapabilities reports per-endpoint availability', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const uri = String(url);
    const method = (options && options.method) || 'GET';

    if (uri.includes('/api/x_nuvo_sinc/sinc/getCurrentScope') && method === 'GET') {
      return mkResponse(200, { result: { scope: 'x_nuvo_sinc', sys_id: 'scope1' } });
    }
    if (uri.includes('/api/x_nuvo_sinc/sinc/getAppList') && method === 'GET') {
      return mkResponse(403, { error: 'forbidden' });
    }
    if (uri.includes('/api/x_nuvo_sinc/sinc/getManifest/x_nuvo_sinc') && method === 'POST') {
      return mkResponse(200, { result: { tables: {}, scope: 'x_nuvo_sinc' } });
    }
    if (uri.includes('/api/x_nuvo_sinc/sinc/runBackgroundScript') && method === 'GET') {
      return mkResponse(404, { error: 'not_found' });
    }

    return mkResponse(500, { error: 'unexpected route' });
  };

  await withEnv(
    {
      SN_INSTANCE: 'dev123.service-now.com',
      SN_USER: 'admin',
      SN_PASSWORD: 'secret',
    },
    async () => {
      const res = await checkSyncronaCapabilities(5000);
      assert.equal(res.getCurrentScope.ok, true);
      assert.equal(res.getAppList.ok, false);
      assert.equal(res.getManifestSample.ok, true);
      assert.equal(res.runBackgroundScript.ok, false);
    }
  );

  global.fetch = originalFetch;
});

test('checkSyncronaCapabilities uses provided scope for manifest check', async () => {
  const originalFetch = global.fetch;
  let requestedManifestUrl = '';

  global.fetch = async (url, options) => {
    const uri = String(url);
    const method = (options && options.method) || 'GET';

    if (uri.includes('/api/x_nuvo_sinc/sinc/getManifest/') && method === 'POST') {
      requestedManifestUrl = uri;
      return mkResponse(200, { result: { tables: {}, scope: 'x_custom_scope' } });
    }

    return mkResponse(200, { result: {} });
  };

  await withEnv(
    {
      SN_INSTANCE: 'dev123.service-now.com',
      SN_USER: 'admin',
      SN_PASSWORD: 'secret',
    },
    async () => {
      await checkSyncronaCapabilities(5000, 'x_custom_scope');
      assert.equal(requestedManifestUrl.includes('/getManifest/x_custom_scope'), true);
    }
  );

  global.fetch = originalFetch;
});

test('parseHealthHttpConfig resolves defaults and validates input', () => {
  const disabled = parseHealthHttpConfig({});
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.path, '/healthz');

  const invalid = parseHealthHttpConfig({ SYNCRONA_HEALTH_HTTP_PORT: 'abc' });
  assert.equal(invalid.enabled, false);

  const valid = parseHealthHttpConfig({
    SYNCRONA_HEALTH_HTTP_PORT: '8088',
    SYNCRONA_HEALTH_HTTP_HOST: '127.0.0.1',
    SYNCRONA_HEALTH_HTTP_PATH: 'health/custom',
  });
  assert.equal(valid.enabled, true);
  assert.equal(valid.port, 8088);
  assert.equal(valid.host, '127.0.0.1');
  assert.equal(valid.path, '/health/custom');
});

test('startHealthHttpServer serves health snapshot and updates status', async () => {
  const server = await startHealthHttpServer(
    {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      path: '/healthz',
    },
    () => ({ status: 'ok', source: 'test' }),
    () => {}
  );

  assert.equal(Boolean(server), true);
  if (!server) {
    return;
  }

  try {
    const healthRes = await fetch(server.url);
    assert.equal(healthRes.status, 200);
    const healthPayload = await healthRes.json();
    assert.equal(healthPayload.status, 'ok');
    assert.equal(healthPayload.source, 'test');

    const notFoundRes = await fetch(server.url.replace('/healthz', '/unknown'));
    assert.equal(notFoundRes.status, 404);

    const status = getHealthEndpointStatus();
    assert.equal(status.enabled, true);
    assert.equal(String(status.path), '/healthz');
  } finally {
    // A leaked listener keeps the test child process alive forever.
    await server.close();
  }

  const afterClose = getHealthEndpointStatus();
  assert.equal(afterClose.enabled, false);
});

test('getSessionContext resolves scope and update set details', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const uri = String(url);
    const method = (options && options.method) || 'GET';

    if (uri.includes('/api/now/table/sys_user?') && method === 'GET') {
      return mkResponse(200, { result: [{ sys_id: 'user1', user_name: 'admin' }] });
    }

    if (uri.includes('/api/x_nuvo_sinc/sinc/getCurrentScope') && method === 'GET') {
      return mkResponse(200, { result: { scope: 'x_nuvo_sinc', sys_id: 'scope1' } });
    }

    if (uri.includes('/api/now/table/sys_scope?') && method === 'GET') {
      return mkResponse(200, {
        result: [{ sys_id: 'scope1', scope: 'x_nuvo_sinc', name: 'SyncroNow AI' }],
      });
    }

    if (
      uri.includes('/api/now/table/sys_user_preference?') &&
      uri.includes('sys_update_set') &&
      method === 'GET'
    ) {
      return mkResponse(200, {
        result: [{ sys_id: 'pref1', name: 'sys_update_set', value: 'us1', user: 'user1' }],
      });
    }

    if (uri.includes('/api/now/table/sys_update_set?') && method === 'GET') {
      return mkResponse(200, {
        result: [{ sys_id: 'us1', name: 'Current Set', state: 'in progress' }],
      });
    }

    return mkResponse(500, { error: `unexpected route ${uri}` });
  };

  await withEnv(
    {
      SN_INSTANCE: 'dev123.service-now.com',
      SN_USER: 'admin',
      SN_PASSWORD: 'secret',
    },
    async () => {
      const res = await getSessionContext(5000);
      assert.equal(res.scope.scope, 'x_nuvo_sinc');
      assert.equal(res.scope.scopeSysId, 'scope1');
      assert.equal(res.updateSet.sysId, 'us1');
      assert.equal(res.updateSet.name, 'Current Set');
    }
  );

  global.fetch = originalFetch;
});

test('setCurrentScope updates apps.current_app user preference', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, options) => {
    const uri = String(url);
    const method = (options && options.method) || 'GET';
    calls.push({ uri, method, body: options && options.body ? String(options.body) : '' });

    if (uri.includes('/api/now/table/sys_scope?') && method === 'GET') {
      return mkResponse(200, {
        result: [{ sys_id: 'scope1', scope: 'x_nuvo_sync', name: 'SyncroNow AI' }],
      });
    }
    if (uri.includes('/api/now/table/sys_user?') && method === 'GET') {
      return mkResponse(200, { result: [{ sys_id: 'user1', user_name: 'admin' }] });
    }
    if (
      uri.includes('/api/now/table/sys_user_preference?') &&
      uri.includes('apps.current_app') &&
      method === 'GET'
    ) {
      return mkResponse(200, {
        result: [{ sys_id: 'pref_scope', name: 'apps.current_app', value: 'old_scope', user: 'user1' }],
      });
    }
    if (uri.includes('/api/now/table/sys_user_preference/pref_scope') && method === 'PUT') {
      return mkResponse(200, { result: { sys_id: 'pref_scope', value: 'scope1' } });
    }
    if (uri.includes('/api/x_nuvo_sinc/sinc/getCurrentScope') && method === 'GET') {
      return mkResponse(200, { result: { scope: 'x_nuvo_sync', sys_id: 'scope1' } });
    }
    if (
      uri.includes('/api/now/table/sys_user_preference?') &&
      uri.includes('sys_update_set') &&
      method === 'GET'
    ) {
      return mkResponse(200, { result: [] });
    }

    return mkResponse(200, { result: [] });
  };

  await withEnv(
    {
      SN_INSTANCE: 'dev123.service-now.com',
      SN_USER: 'admin',
      SN_PASSWORD: 'secret',
    },
    async () => {
      const result = await setCurrentScope('x_nuvo_sync', 5000);
      assert.equal(result.requestedScope, 'x_nuvo_sync');
      assert.equal(result.scopeSysId, 'scope1');
      const putCall = calls.find((c) => c.uri.includes('/sys_user_preference/pref_scope') && c.method === 'PUT');
      assert.equal(Boolean(putCall), true);
      assert.equal(putCall.body.includes('scope1'), true);
    }
  );

  global.fetch = originalFetch;
});

test('setCurrentUpdateSet creates missing update set and assigns preference', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, options) => {
    const uri = String(url);
    const method = (options && options.method) || 'GET';
    calls.push({ uri, method, body: options && options.body ? String(options.body) : '' });

    if (uri.includes('/api/now/table/sys_update_set?') && method === 'GET') {
      return mkResponse(200, { result: [] });
    }
    if (uri.includes('/api/now/table/sys_update_set') && method === 'POST') {
      return mkResponse(200, {
        result: { sys_id: 'new_us', name: 'AI Work', state: 'in progress' },
      });
    }
    if (uri.includes('/api/now/table/sys_user?') && method === 'GET') {
      return mkResponse(200, { result: [{ sys_id: 'user1', user_name: 'admin' }] });
    }
    if (
      uri.includes('/api/now/table/sys_user_preference?') &&
      uri.includes('sys_update_set') &&
      method === 'GET'
    ) {
      return mkResponse(200, { result: [] });
    }
    if (uri.includes('/api/now/table/sys_user_preference') && method === 'POST') {
      return mkResponse(200, {
        result: { sys_id: 'pref_us', name: 'sys_update_set', value: 'new_us', user: 'user1' },
      });
    }
    if (uri.includes('/api/x_nuvo_sinc/sinc/getCurrentScope') && method === 'GET') {
      return mkResponse(500, { error: 'no endpoint' });
    }
    if (
      uri.includes('/api/now/table/sys_user_preference?') &&
      uri.includes('apps.current_app') &&
      method === 'GET'
    ) {
      return mkResponse(200, {
        result: [{ sys_id: 'pref_scope', name: 'apps.current_app', value: 'scope1', user: 'user1' }],
      });
    }
    if (uri.includes('/api/now/table/sys_scope?') && method === 'GET') {
      return mkResponse(200, {
        result: [{ sys_id: 'scope1', scope: 'x_nuvo_sync', name: 'SyncroNow AI' }],
      });
    }

    return mkResponse(200, { result: [] });
  };

  await withEnv(
    {
      SN_INSTANCE: 'dev123.service-now.com',
      SN_USER: 'admin',
      SN_PASSWORD: 'secret',
    },
    async () => {
      const result = await setCurrentUpdateSet(
        { updateSetName: 'AI Work', createIfMissing: true },
        5000
      );
      assert.equal(result.targetUpdateSet.sysId, 'new_us');
      const createUS = calls.find((c) => c.uri.includes('/api/now/table/sys_update_set') && c.method === 'POST');
      assert.equal(Boolean(createUS), true);
      const prefCreate = calls.find((c) => c.uri.includes('/api/now/table/sys_user_preference') && c.method === 'POST');
      assert.equal(Boolean(prefCreate), true);
      assert.equal(prefCreate.body.includes('new_us'), true);
    }
  );

  global.fetch = originalFetch;
});

test('setCurrentUpdateSet throws when not found and creation is disabled', async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const uri = String(url);
    const method = (options && options.method) || 'GET';

    if (uri.includes('/api/now/table/sys_update_set?') && method === 'GET') {
      return mkResponse(200, { result: [] });
    }

    return mkResponse(200, { result: [] });
  };

  await withEnv(
    {
      SN_INSTANCE: 'dev123.service-now.com',
      SN_USER: 'admin',
      SN_PASSWORD: 'secret',
    },
    async () => {
      await assert.rejects(
        () =>
          setCurrentUpdateSet(
            { updateSetName: 'Missing Set', createIfMissing: false },
            5000
          ),
        /Update set not found/
      );
    }
  );

  global.fetch = originalFetch;
});

test('isUnsafeWorkspaceCommand blocks shell -c patterns', () => {
  assert.equal(isUnsafeWorkspaceCommand('bash', ['-c', 'echo hi']), true);
  assert.equal(isUnsafeWorkspaceCommand('sh', ['--command', 'echo hi']), true);
  assert.equal(isUnsafeWorkspaceCommand('npm', ['run', 'build&&echo']), true);
  assert.equal(isUnsafeWorkspaceCommand('node', ['-e', 'console.log(1)']), false);
  assert.equal(isUnsafeWorkspaceCommand('npm', ['test']), false);
  assert.equal(isUnsafeWorkspaceCommand('rm', ['-rf', '/tmp/a']), true);
});

test('isMutatingTool supports allow/deny matrix by tool type', () => {
  assert.equal(isMutatingTool('sn_create_record'), true);
  assert.equal(isMutatingTool('sn_update_metadata_record'), true);
  assert.equal(isMutatingTool('sync_unified_change_workflow'), true);
  assert.equal(isMutatingTool('sync_preflight_check'), false);
  assert.equal(isMutatingTool('sn_query_records'), false);
});

test('risk level helpers resolve explicit and score-based levels', () => {
  assert.equal(riskLevelFromScore(1), 'low');
  assert.equal(riskLevelFromScore(3), 'medium');
  assert.equal(riskLevelFromScore(6), 'high');
  assert.equal(riskLevelFromScore(12), 'critical');

  assert.equal(parseRiskLevel('LOW'), 'low');
  assert.equal(parseRiskLevel('medium'), 'medium');
  assert.equal(parseRiskLevel('unknown'), null);
});

test('approval helpers enforce matrix expectations', () => {
  const lowReq = getApprovalRequirements('low');
  assert.equal(lowReq.required, false);

  const highReq = getApprovalRequirements('high');
  assert.equal(highReq.required, true);
  assert.equal(highReq.minimumApprovers, 2);

  assert.equal(
    isApprovalSatisfied(
      { approvalId: 'APR-1', approvers: ['alice', 'bob'] },
      'high'
    ),
    true
  );
  assert.equal(
    isApprovalSatisfied(
      { approvalId: 'APR-1', approvers: ['alice'] },
      'high'
    ),
    false
  );
});

test('rollback evidence validation applies stricter high-risk requirements', () => {
  const low = validateRollbackEvidence({ revertSteps: ['undo A'] }, 'low');
  assert.equal(low.ok, true);

  const highMissing = validateRollbackEvidence({ revertSteps: ['undo A'] }, 'high');
  assert.equal(highMissing.ok, false);
  assert.equal(highMissing.missing.includes('reason'), true);

  const highComplete = validateRollbackEvidence(
    {
      reason: 'protect prod stability',
      impactedEntities: ['sys_script_include.a'],
      revertSteps: ['restore previous script'],
      validationPlan: 'run full analysis and smoke tests',
    },
    'high'
  );
  assert.equal(highComplete.ok, true);
});

test('minimal-footprint evaluator reports budget violations deterministically', () => {
  const ok = evaluateMinimalFootprint([
    { filePath: 'a.js', objectId: 'o1', estimatedLines: 20 },
    { filePath: 'b.js', objectId: 'o2', estimatedLines: 30 },
  ]);
  assert.equal(ok.withinBudget, true);

  const over = evaluateMinimalFootprint(
    [
      { filePath: 'a.js', objectId: 'o1', estimatedLines: 120 },
      { filePath: 'b.js', objectId: 'o2', estimatedLines: 120 },
      { filePath: 'c.js', objectId: 'o3', estimatedLines: 20 },
      { filePath: 'd.js', objectId: 'o4', estimatedLines: 20 },
      { filePath: 'e.js', objectId: 'o5', estimatedLines: 20 },
      { filePath: 'f.js', objectId: 'o6', estimatedLines: 20 },
    ],
    { maxFiles: 5, maxLines: 200, maxObjects: 10 }
  );
  assert.equal(over.withinBudget, false);
  assert.equal(over.violations.length >= 1, true);
});

test('scope code and artifact paths are normalized safely', () => {
  assert.equal(normalizeScopeCode(' X-Nuvo.Sync '), 'x_nuvo_sync');

  const paths = getScopeKnowledgePaths('X-Nuvo.Sync');
  assert.equal(paths.markdownPath.endsWith('/.syncrona-mcp/scopes/x_nuvo_sync.md'), true);
  assert.equal(paths.jsonPath.endsWith('/.syncrona-mcp/scopes/x_nuvo_sync.json'), true);
});

test('sanitizeForAudit redacts secrets and script body', () => {
  const sanitized = sanitizeForAudit({
    password: 'secret',
    token: 'abc',
    nested: {
      authorization: 'x',
      api_password: 'pw',
      bearer_token: 'bt',
      'x-auth-token': 'xt',
      'x-api-key': 'k',
    },
    script: 'gs.log("very long script");',
  });

  assert.equal(sanitized.password, '<redacted>');
  assert.equal(sanitized.token, '<redacted>');
  assert.equal(sanitized.nested.authorization, '<redacted>');
  assert.equal(sanitized.nested.api_password, '<redacted>');
  assert.equal(sanitized.nested.bearer_token, '<redacted>');
  assert.equal(sanitized.nested['x-auth-token'], '<redacted>');
  assert.equal(sanitized.nested['x-api-key'], '<redacted>');
  assert.equal(String(sanitized.script).startsWith('<script:'), true);
});

test('writeAuditEvent rotates file when log exceeds max bytes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-mcp-audit-'));
  const auditFile = path.join(tempDir, 'audit.log');

  fs.writeFileSync(auditFile, 'x'.repeat(64), 'utf8');

  writeAuditEvent(tempDir, auditFile, { event: 'rotate' }, 32);

  const files = fs.readdirSync(tempDir);
  const rotatedFiles = files.filter(
    (name) => name !== 'audit.log' && name.startsWith('audit.') && name.endsWith('.log')
  );

  assert.equal(rotatedFiles.length >= 1, true);
  assert.equal(fs.existsSync(auditFile), true);
  const latest = fs.readFileSync(auditFile, 'utf8');
  assert.equal(latest.includes('"event":"rotate"'), true);
});

test('writeAuditEvent appends without rotation under max bytes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-mcp-audit-'));
  const auditFile = path.join(tempDir, 'audit.log');

  writeAuditEvent(tempDir, auditFile, { event: 'first' }, 1024);
  writeAuditEvent(tempDir, auditFile, { event: 'second' }, 1024);

  const files = fs.readdirSync(tempDir);
  const rotatedFiles = files.filter(
    (name) => name !== 'audit.log' && name.startsWith('audit.') && name.endsWith('.log')
  );

  assert.equal(rotatedFiles.length, 0);
  const logText = fs.readFileSync(auditFile, 'utf8');
  assert.equal(logText.includes('"event":"first"'), true);
  assert.equal(logText.includes('"event":"second"'), true);
});

test('checkAuditLogIntegrity returns valid for well-formed JSONL log', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-mcp-audit-'));
  const auditFile = path.join(tempDir, 'audit.log');

  writeAuditEvent(tempDir, auditFile, { event: 'ok' }, 1024);
  const result = checkAuditLogIntegrity(tempDir, auditFile);

  assert.equal(result.ok, true);
  assert.equal(result.status, 'valid');
  assert.equal(result.malformedLines, 0);
  assert.equal(fs.existsSync(auditFile), true);
});

test('checkAuditLogIntegrity quarantines malformed audit log and recovers', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-mcp-audit-'));
  const auditFile = path.join(tempDir, 'audit.log');

  fs.writeFileSync(auditFile, '{"event":"good"}\nnot-json\n', 'utf8');
  const result = checkAuditLogIntegrity(tempDir, auditFile);

  assert.equal(result.ok, false);
  assert.equal(result.status, 'quarantined');
  assert.equal(result.malformedLines >= 1, true);
  assert.equal(fs.existsSync(auditFile), true);
  assert.equal(fs.existsSync(result.quarantinedFile), true);

  const currentLogText = fs.readFileSync(auditFile, 'utf8');
  assert.equal(currentLogText.includes('"event":"audit.integrity.recovered"'), true);
});

test('auditToolCall writes entries for non-mutating and mutating tools', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-mcp-audit-'));
  const auditFile = path.join(tempDir, 'audit.log');

  auditToolCall(
    'sn_query_records',
    { table: 'sys_user', dryRun: false },
    { isError: false },
    12,
    tempDir,
    auditFile
  );

  auditToolCall(
    'sn_create_record',
    { table: 'sys_user', dryRun: true },
    { isError: true, error: 'blocked' },
    7,
    tempDir,
    auditFile,
    'corr-test-1'
  );

  const rows = fs
    .readFileSync(auditFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  assert.equal(rows.length, 2);
  assert.equal(rows[0].event, 'tool.call');
  assert.equal(rows[0].tool, 'sn_query_records');
  assert.equal(rows[0].mutating, false);
  assert.equal(rows[0].ok, true);

  assert.equal(rows[1].event, 'tool.call');
  assert.equal(rows[1].tool, 'sn_create_record');
  assert.equal(rows[1].mutating, true);
  assert.equal(rows[1].ok, false);
  assert.equal(rows[1].correlationId, 'corr-test-1');
});

test('metricsStore appends and reloads persisted tool metrics', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-mcp-metrics-'));
  const metricsFile = path.join(tempDir, 'metrics.jsonl');

  appendMetricEvent(tempDir, metricsFile, {
    tool: 'sync_tool_a',
    ok: true,
    latencyMs: 12,
    timestamp: new Date().toISOString(),
  });
  appendMetricEvent(tempDir, metricsFile, {
    tool: 'sync_tool_b',
    ok: false,
    latencyMs: 45,
    timestamp: new Date().toISOString(),
    correlationId: 'corr-metric-1',
  });

  const rows = loadMetricEvents(tempDir, metricsFile, 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tool, 'sync_tool_a');
  assert.equal(rows[1].tool, 'sync_tool_b');
  assert.equal(rows[1].correlationId, 'corr-metric-1');
});

test('metricsStore ignores malformed jsonl lines while loading', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-mcp-metrics-'));
  const metricsFile = path.join(tempDir, 'metrics.jsonl');

  fs.writeFileSync(
    metricsFile,
    [
      '{"tool":"sync_tool_a","ok":true,"latencyMs":10,"timestamp":"2026-05-29T00:00:00.000Z"}',
      'not-json',
      '{"tool":"","ok":true,"latencyMs":1,"timestamp":"2026-05-29T00:00:00.000Z"}',
      '{"tool":"sync_tool_b","ok":false,"latencyMs":20,"timestamp":"2026-05-29T00:00:00.000Z"}',
      '',
    ].join('\n'),
    'utf8'
  );

  const rows = loadMetricEvents(tempDir, metricsFile, 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tool, 'sync_tool_a');
  assert.equal(rows[1].tool, 'sync_tool_b');
});

test('createGracefulShutdownController drains pending requests before close', async () => {
  const events = [];
  let waitCalls = 0;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-mcp-audit-'));

  const controller = createGracefulShutdownController({
    serverResource: {
      close: () => {
        events.push('server-close');
      },
    },
    drainTimeoutMs: 5000,
    pollIntervalMs: 1,
    waitFn: async () => {
      waitCalls += 1;
      if (waitCalls === 1) {
        controller.endRequest();
      }
    },
    exitProcess: false,
    logger: () => {},
    auditDir: tempDir,
    auditFile: path.join(tempDir, 'audit.log'),
  });

  controller.setTransportResource({
    close: () => {
      events.push('transport-close');
    },
  });

  assert.equal(controller.beginRequest(), true);
  await controller.shutdown('SIGTERM');

  assert.equal(waitCalls >= 1, true);
  assert.deepEqual(events, ['transport-close', 'server-close']);
  assert.equal(controller.isShuttingDown(), true);
});

test('createGracefulShutdownController rejects new requests during shutdown', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-mcp-audit-'));
  const controller = createGracefulShutdownController({
    exitProcess: false,
    logger: () => {},
    auditDir: tempDir,
    auditFile: path.join(tempDir, 'audit.log'),
  });

  await controller.shutdown('SIGINT');
  assert.equal(controller.beginRequest(), false);
});

test('isDryRunRequested controls no-write execution path flag', () => {
  assert.equal(isDryRunRequested({ dryRun: true }), true);
  assert.equal(isDryRunRequested({ dryRun: false }), false);
  assert.equal(isDryRunRequested({}), false);
});

test('formatToolError returns stable error shape', () => {
  const err = formatToolError('boom');
  assert.equal(err.isError, true);
  assert.equal(Array.isArray(err.content), true);
  assert.equal(err.content[0].type, 'text');
  assert.equal(err.content[0].text.includes('Tool execution failed: boom'), true);
});

test('formatStructuredToolError returns code and details payload', () => {
  const err = formatStructuredToolError('policy blocked', {
    code: 'POLICY_VIOLATION',
    details: { toolName: 'sn_create_record' },
  });
  assert.equal(err.isError, true);
  assert.equal(Array.isArray(err.content), true);
  assert.equal(err.content[0].type, 'text');
  assert.equal(err.content[0].text.includes('Tool execution failed [POLICY_VIOLATION]'), true);
  assert.equal(err.content[0].text.includes('sn_create_record'), true);
});

test('normalizeMcpError converts native and unknown errors to McpError', () => {
  const native = normalizeMcpError(new Error('native failure'));
  assert.equal(native instanceof McpError, true);
  assert.equal(native.code, 'TOOL_EXECUTION');
  assert.equal(native.message, 'native failure');

  const unknown = normalizeMcpError({ message: 'custom failure', stage: 'test' });
  assert.equal(unknown instanceof McpError, true);
  assert.equal(unknown.code, 'UNKNOWN');
  assert.equal(unknown.message, 'custom failure');
  assert.equal(unknown.details.stage, 'test');
});

test('loadGuardrailConfig returns defaults when file is missing', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-mcp-guardrail-'));
  const cfg = loadGuardrailConfig(tempDir);
  assert.equal(cfg.enforcePreflightForMutations, false);
  assert.equal(cfg.expectedScope, '');
  assert.equal(cfg.expectedUpdateSetName, '');
  assert.equal(cfg.expectedUpdateSetSysId, '');
  assert.equal(cfg.allowFullNodeAccess, false);
});

test('loadGuardrailConfig loads configured values from file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-mcp-guardrail-'));
  fs.writeFileSync(
    path.join(tempDir, 'sync.mcp.guardrails.json'),
    JSON.stringify(
      {
        enforcePreflightForMutations: true,
        expectedScope: 'x_nuvo_sync',
        expectedUpdateSetName: 'AI Work',
        expectedUpdateSetSysId: 'us1',
        allowFullNodeAccess: true,
        policy: {
          activeEnvironment: 'ci',
          tools: {
            run_node_code: { deny: true },
          },
        },
      },
      null,
      2
    )
  );

  const cfg = loadGuardrailConfig(tempDir);
  assert.equal(cfg.enforcePreflightForMutations, true);
  assert.equal(cfg.expectedScope, 'x_nuvo_sync');
  assert.equal(cfg.expectedUpdateSetName, 'AI Work');
  assert.equal(cfg.expectedUpdateSetSysId, 'us1');
  assert.equal(cfg.allowFullNodeAccess, true);
  assert.equal(cfg.policy.activeEnvironment, 'ci');
  assert.equal(cfg.policy.tools.run_node_code.deny, true);
});

test('buildPreflightReport evaluates scope and update set checks', async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const uri = String(url);
    const method = (options && options.method) || 'GET';

    if (uri.includes('/api/now/table/sys_user?') && method === 'GET') {
      return mkResponse(200, { result: [{ sys_id: 'user1', user_name: 'admin' }] });
    }
    if (uri.includes('/api/x_nuvo_sinc/sinc/getCurrentScope') && method === 'GET') {
      return mkResponse(200, { result: { scope: 'x_nuvo_sinc', sys_id: 'scope1' } });
    }
    if (uri.includes('/api/now/table/sys_scope?') && method === 'GET') {
      return mkResponse(200, {
        result: [{ sys_id: 'scope1', scope: 'x_nuvo_sinc', name: 'SyncroNow AI' }],
      });
    }
    if (
      uri.includes('/api/now/table/sys_user_preference?') &&
      uri.includes('sys_update_set') &&
      method === 'GET'
    ) {
      return mkResponse(200, {
        result: [{ sys_id: 'pref1', name: 'sys_update_set', value: 'us1', user: 'user1' }],
      });
    }
    if (uri.includes('/api/now/table/sys_update_set?') && method === 'GET') {
      return mkResponse(200, {
        result: [{ sys_id: 'us1', name: 'AI Work', state: 'in progress' }],
      });
    }

    return mkResponse(500, { error: `unexpected route ${uri}` });
  };

  await withEnv(
    {
      SN_INSTANCE: 'dev123.service-now.com',
      SN_USER: 'admin',
      SN_PASSWORD: 'secret',
    },
    async () => {
      const ok = await buildPreflightReport(5000, {
        expectedScope: 'x_nuvo_sinc',
        expectedUpdateSetName: 'AI Work',
        expectedUpdateSetSysId: 'us1',
      });
      assert.equal(ok.checks.allOk, true);

      const fail = await buildPreflightReport(5000, {
        expectedScope: 'x_other_scope',
      });
      assert.equal(fail.checks.scopeOk, false);
      assert.equal(fail.checks.allOk, false);
    }
  );

  global.fetch = originalFetch;
});

test('integration helper runs scope knowledge generation and auto-update tools', async () => {
  const generate = await executeMcpToolIntegration(
    'sync_generate_scope_knowledge',
    {
      scope: 'x_demo',
      entities: [{ id: 'script:A', name: 'A' }],
      graph: {
        nodes: [{ id: 'script:A', kind: 'script', label: 'A' }],
        edges: [],
      },
      writeFiles: false,
    },
    { timeoutMs: 5000 }
  );
  assert.equal(generate.isError, false);
  assert.equal(generate.payload.validation.valid, true);

  const autoUpdate = await executeMcpToolIntegration(
    'sync_scope_knowledge_auto_update',
    {
      trigger: 'refresh',
      scope: 'x_demo',
      entities: [{ id: 'script:A', name: 'A' }],
      graph: {
        nodes: [{ id: 'script:A', kind: 'script', label: 'A' }],
        edges: [],
      },
      writeFiles: false,
    },
    {
      timeoutMs: 5000,
      sessionContext: { updateSet: { sysId: 'us1', name: 'AI Work' } },
    }
  );
  assert.equal(autoUpdate.isError, false);
  assert.equal(autoUpdate.payload.validation.valid, true);
});

test('scope knowledge writeFiles generates per-table field markdown docs', async () => {
  const scopeCode = 'x_demo_fields';
  const paths = getScopeKnowledgePaths(scopeCode);
  const tableDocPath = getScopeTableDocPath(scopeCode, 'x_demo_table');

  if (fs.existsSync(paths.jsonPath)) {
    fs.unlinkSync(paths.jsonPath);
  }
  if (fs.existsSync(paths.markdownPath)) {
    fs.unlinkSync(paths.markdownPath);
  }
  if (fs.existsSync(tableDocPath)) {
    fs.unlinkSync(tableDocPath);
  }

  const result = await executeMcpToolIntegration(
    'sync_generate_scope_knowledge',
    {
      scope: scopeCode,
      entities: [
        {
          id: 'record:dict1',
          name: 'u_customer',
          metadataType: 'dictionary',
          tableName: 'x_demo_table',
          fieldName: 'u_customer',
          columnLabel: 'Customer',
          internalType: 'reference',
          maxLength: '40',
          mandatory: true,
          reference: 'core_company',
        },
      ],
      graph: {
        nodes: [{ id: 'table:x_demo_table', kind: 'table', label: 'x_demo_table' }],
        edges: [],
      },
      writeFiles: true,
    },
    { timeoutMs: 5000 }
  );

  assert.equal(result.isError, false);
  assert.equal(result.payload.written, true);
  assert.equal(result.payload.tableDocs.count, 1);
  assert.equal(fs.existsSync(paths.jsonPath), true);
  assert.equal(fs.existsSync(paths.markdownPath), true);
  assert.equal(fs.existsSync(tableDocPath), true);
  assert.equal(fs.readFileSync(tableDocPath, 'utf-8').includes('| u_customer | Customer | reference(40) | yes | core_company | - |'), true);

  fs.unlinkSync(paths.jsonPath);
  fs.unlinkSync(paths.markdownPath);
  fs.unlinkSync(tableDocPath);
});

test('scope docs tool generates full docs bundle structure', async () => {
  const scopeCode = 'x_demo_scope_docs';
  const docsPaths = getScopeDocsPaths(scopeCode);
  if (fs.existsSync(docsPaths.dir)) {
    fs.rmSync(docsPaths.dir, { recursive: true, force: true });
  }

  const result = await executeMcpToolIntegration(
    'sync_generate_scope_docs',
    {
      scope: scopeCode,
      entities: [
        {
          id: 'record:br1',
          name: 'Validate Demo',
          metadataType: 'business_rule',
          tableName: 'x_demo_table',
          script: 'var gr = new GlideRecord("x_demo_table");',
        },
        {
          id: 'record:dict1',
          name: 'u_customer',
          metadataType: 'dictionary',
          tableName: 'x_demo_table',
          fieldName: 'u_customer',
          columnLabel: 'Customer',
          internalType: 'reference',
          maxLength: '40',
          mandatory: true,
          reference: 'core_company',
        },
      ],
      graph: {
        nodes: [
          { id: 'record:br1', kind: 'script', label: 'Validate Demo' },
          { id: 'table:x_demo_table', kind: 'table', label: 'x_demo_table' },
          { id: 'table:core_company', kind: 'table', label: 'core_company' },
        ],
        edges: [
          { from: 'record:br1', to: 'table:x_demo_table', relation: 'reads', why: 'GlideRecord reference' },
          { from: 'table:x_demo_table', to: 'table:core_company', relation: 'depends_on', why: 'Dictionary reference (u_customer:reference)' },
        ],
      },
      writeFiles: true,
    },
    { timeoutMs: 5000 }
  );

  assert.equal(result.isError, false);
  assert.equal(result.payload.written, true);
  assert.equal(fs.existsSync(path.join(docsPaths.dir, 'README.md')), true);
  assert.equal(fs.existsSync(path.join(docsPaths.dir, 'dependencies.md')), true);
  assert.equal(fs.existsSync(path.join(docsPaths.dir, 'table-relationships.md')), true);
  assert.equal(fs.existsSync(path.join(docsPaths.dir, 'cross-scope-dependencies.md')), true);
  assert.equal(fs.existsSync(path.join(docsPaths.dir, 'tables', 'x_demo_table.md')), true);
  assert.equal(fs.existsSync(path.join(docsPaths.dir, 'business-rules', 'validate_demo.md')), true);

  fs.rmSync(docsPaths.dir, { recursive: true, force: true });
});

test('scope knowledge generation auto-discovers ServiceNow metadata by default', { concurrency: false }, async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const uri = String(url);
    if (uri.includes('/api/now/table/sys_script?')) {
      return mkResponse(200, {
        result: [
          {
            sys_id: 'br1',
            name: 'Demo BR',
            script: "var gr = new GlideRecord('incident');",
            collection: 'task',
            sys_scope: { scope: 'x_demo' },
          },
        ],
      });
    }
    if (
      uri.includes('/api/now/table/sys_script_client?') ||
      uri.includes('/api/now/table/sys_security_acl?') ||
      uri.includes('/api/now/table/sys_ui_policy?') ||
      uri.includes('/api/now/table/sys_ws_operation?')
    ) {
      return mkResponse(200, { result: [] });
    }
    if (uri.includes('/api/now/table/sys_dictionary?')) {
      return mkResponse(200, {
        result: [
          {
            sys_id: 'dict1',
            name: 'task',
            element: 'u_customer',
            column_label: 'Customer',
            internal_type: 'reference',
            max_length: '40',
            reference: 'core_company',
            mandatory: 'true',
            default_value: '',
            attributes: '',
            sys_scope: { scope: 'x_demo' },
          },
        ],
      });
    }
    return mkResponse(500, { error: `unexpected route ${uri}` });
  };

  await withEnv(
    {
      SN_INSTANCE: 'dev123.service-now.com',
      SN_USER: 'admin',
      SN_PASSWORD: 'secret',
    },
    async () => {
      const generate = await executeMcpToolIntegration(
        'sync_generate_scope_knowledge',
        {
          scope: 'x_demo',
          writeFiles: false,
        },
        { timeoutMs: 5000 }
      );

      assert.equal(generate.isError, false);
      assert.equal(generate.payload.validation.valid, true);
      assert.equal(generate.payload.serviceNowDiscovered, true);
      assert.equal(generate.payload.entityCount > 0, true);
      assert.equal(generate.payload.dependencyCount > 0, true);
      assert.equal(Array.isArray(generate.payload.index.tableFields), true);
      assert.equal(generate.payload.index.tableFields.length > 0, true);
      assert.equal(Array.isArray(generate.payload.index.referencedTables), true);
      assert.equal(generate.payload.index.referencedTables.length > 0, true);
    }
  );

  global.fetch = originalFetch;
});

test('scope knowledge auto-discovery extracts table dependencies from workspace files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-scope-'));
  const sourceDir = path.join(tmpDir, 'src', 'sys_script_include', 'Demo');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, 'script.sn.ts'),
    [
      "const gr = new GlideRecord('x_demo_table');",
      "const ga = new GlideAggregate('task');",
    ].join('\n'),
    'utf-8'
  );

  const discovered = discoverWorkspaceScopeKnowledge(tmpDir);
  assert.equal(discovered.entities.length > 0, true);
  assert.equal(
    discovered.graph.edges.some((edge) => edge.to === 'table:x_demo_table'),
    true
  );
  assert.equal(
    discovered.graph.edges.some((edge) => edge.to === 'table:task'),
    true
  );
});

test('async scope knowledge discovery is deterministic across concurrency values', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-scope-'));
  const sourceDir = path.join(tmpDir, 'src', 'sys_script_include', 'Demo');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, 'script_a.sn.ts'),
    [
      "const gr = new GlideRecord('x_demo_table');",
      "const ga = new GlideAggregate('task');",
    ].join('\n'),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(sourceDir, 'script_b.sn.ts'),
    [
      "const gr2 = new GlideRecord('sys_user');",
      "const ga2 = new GlideAggregate('cmdb_ci');",
    ].join('\n'),
    'utf-8'
  );

  const c1 = await discoverWorkspaceScopeKnowledgeAsync(tmpDir, { concurrency: 1 });
  const c20 = await discoverWorkspaceScopeKnowledgeAsync(tmpDir, { concurrency: 20 });

  assert.deepEqual(c1, c20);
  assert.equal(c20.entities.length > 0, true);
  assert.equal(
    c20.graph.edges.some((edge) => edge.to === 'table:x_demo_table'),
    true
  );
  assert.equal(
    c20.graph.edges.some((edge) => edge.to === 'table:cmdb_ci'),
    true
  );
});

test('async scope knowledge discovery retries transient file I/O errors', { concurrency: false }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-scope-'));
  const sourceDir = path.join(tmpDir, 'src', 'sys_script_include', 'Demo');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, 'script_retry.sn.ts'),
    "const gr = new GlideRecord('incident');\n",
    'utf-8'
  );

  const fsPromises = fs.promises;
  const originalReadFile = fsPromises.readFile;
  let attempts = 0;
  fsPromises.readFile = async (...args) => {
    attempts += 1;
    if (attempts === 1) {
      const transient = new Error('temporary file lock');
      transient.code = 'EBUSY';
      throw transient;
    }
    return originalReadFile.call(fsPromises, ...args);
  };

  try {
    const discovered = await discoverWorkspaceScopeKnowledgeAsync(tmpDir, { concurrency: 1 });
    assert.equal(discovered.entities.length > 0, true);
    assert.equal(
      discovered.graph.edges.some((edge) => edge.to === 'table:incident'),
      true
    );
    assert.equal(attempts >= 2, true);
  } finally {
    fsPromises.readFile = originalReadFile;
  }
});

test('table dependency report helper returns deterministic file paths', () => {
  const paths = getTableDependencyReportPaths('X_DEMO Scope');
  assert.equal(paths.markdownPath.endsWith('/.syncrona-mcp/reports/x_demo_scope-table-dependencies.md'), true);
  assert.equal(paths.jsonPath.endsWith('/.syncrona-mcp/reports/x_demo_scope-table-dependencies.json'), true);
});

test('workflow simulation report helper returns deterministic file paths', () => {
  const paths = getWorkflowSimulationReportPaths('X_DEMO Scope', 'My Simulation #1');
  assert.equal(
    paths.markdownPath.endsWith('/.syncrona-mcp/reports/x_demo_scope-workflow-simulation-my_simulation_1.md'),
    true
  );
  assert.equal(
    paths.jsonPath.endsWith('/.syncrona-mcp/reports/x_demo_scope-workflow-simulation-my_simulation_1.json'),
    true
  );
});

test('integration helper runs one-command table dependency report generation', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const uri = String(url);
    if (uri.includes('/api/now/table/sys_script?')) {
      return mkResponse(200, {
        result: [
          {
            sys_id: 'br1',
            name: 'Demo BR',
            script: "var gr = new GlideRecord('incident');",
            collection: 'task',
            sys_scope: { scope: 'x_demo' },
          },
        ],
      });
    }
    if (uri.includes('/api/now/table/sys_db_object?')) {
      return mkResponse(200, {
        result: [
          {
            sys_id: 'dbo1',
            name: 'x_demo_custom',
            super_class: { value: 'task' },
            sys_scope: { scope: 'x_demo' },
          },
        ],
      });
    }
    return mkResponse(200, { result: [] });
  };

  await withEnv(
    {
      SN_INSTANCE: 'dev123.service-now.com',
      SN_USER: 'admin',
      SN_PASSWORD: 'secret',
    },
    async () => {
      const report = await executeMcpToolIntegration(
        'sync_generate_table_dependency_report',
        {
          scope: 'x_demo',
          writeFiles: false,
        },
        { timeoutMs: 5000 }
      );

      assert.equal(report.isError, false);
      assert.equal(report.payload.validation.valid, true);
      assert.equal(String(report.payload.paths.markdownPath).includes('.syncrona-mcp/reports/x_demo-table-dependencies.md'), true);
    }
  );

  global.fetch = originalFetch;
});

test('integration helper analyzes scope relations with explicit and hidden evidence', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const uri = String(url);
    if (uri.includes('/api/now/table/sys_db_object?')) {
      return mkResponse(200, {
        result: [
          {
            sys_id: 'dbo1',
            name: 'x_demo_child',
            super_class: { value: 'task' },
            sys_scope: { scope: 'x_demo' },
          },
        ],
      });
    }
    if (uri.includes('/api/now/table/sys_dictionary?')) {
      return mkResponse(200, {
        result: [
          {
            name: 'x_demo_child',
            element: 'u_parent',
            internal_type: 'reference',
            reference: 'incident',
            attributes: '',
          },
          {
            name: 'x_demo_child',
            element: 'u_dynamic',
            internal_type: 'string',
            reference: '',
            attributes: 'ref_table=problem',
          },
        ],
      });
    }
    if (
      uri.includes('/api/now/table/sys_script?') ||
      uri.includes('/api/now/table/sys_script_client?') ||
      uri.includes('/api/now/table/sys_security_acl?') ||
      uri.includes('/api/now/table/sys_ui_policy?') ||
      uri.includes('/api/now/table/sys_ws_operation?') ||
      uri.includes('/api/now/table/sys_script_include?')
    ) {
      return mkResponse(200, { result: [] });
    }
    return mkResponse(200, { result: [] });
  };

  await withEnv(
    {
      SN_INSTANCE: 'dev123.service-now.com',
      SN_USER: 'admin',
      SN_PASSWORD: 'secret',
    },
    async () => {
      const result = await executeMcpToolIntegration(
        'sync_analyze_scope_relations',
        {
          scope: 'x_demo',
          includeWorkspace: false,
          includeServiceNow: true,
        },
        { timeoutMs: 5000 }
      );

      assert.equal(result.isError, false);
      assert.equal(result.payload.scope, 'x_demo');
      assert.equal(result.payload.relationEvidence.explicit >= 2, true);
      assert.equal(result.payload.relationEvidence.hidden >= 1, true);
      assert.equal(result.payload.relationCount >= 3, true);
    }
  );

  global.fetch = originalFetch;
});

test('integration helper runs unified workflow and onboarding behavior', async () => {
  const onboarding = await executeMcpToolIntegration(
    'sync_onboarding_bootstrap',
    {},
    { timeoutMs: 5000 }
  );
  assert.equal(onboarding.isError, false);
  assert.equal(Array.isArray(onboarding.payload.steps), true);

  const plan = await executeMcpToolIntegration(
    'sync_unified_change_workflow',
    {
      task: 'update metadata validation',
      taskType: 'metadata',
      executionMode: 'mocked',
      proposedChanges: [{ objectId: 'script:A', estimatedLines: 10 }],
      apply: false,
      writeSimulationReport: false,
      nowIso: '2026-05-29T00:00:00.000Z',
    },
    {
      timeoutMs: 5000,
      preflight: { checks: { allOk: true } },
    }
  );
  assert.equal(plan.isError, false);
  assert.equal(plan.payload.gates.deepAnalysisOk, true);
  assert.equal(plan.payload.simulationReport.reportVersion, '1.0.0');
  assert.equal(plan.payload.simulationReport.generatedAt, '2026-05-29T00:00:00.000Z');
  assert.equal(plan.payload.simulationArtifact.written, false);

  const reportPaths = getWorkflowSimulationReportPaths('x_demo', 'simulation_demo');
  if (fs.existsSync(reportPaths.jsonPath)) {
    fs.unlinkSync(reportPaths.jsonPath);
  }
  if (fs.existsSync(reportPaths.markdownPath)) {
    fs.unlinkSync(reportPaths.markdownPath);
  }

  const planWithArtifact = await executeMcpToolIntegration(
    'sync_unified_change_workflow',
    {
      task: 'update metadata validation',
      taskType: 'metadata',
      executionMode: 'mocked',
      proposedChanges: [{ objectId: 'script:A', estimatedLines: 10 }],
      apply: false,
      writeSimulationReport: true,
      simulationId: 'simulation_demo',
      scope: 'x_demo',
      nowIso: '2026-05-29T00:00:00.000Z',
    },
    {
      timeoutMs: 5000,
      preflight: { checks: { allOk: true } },
    }
  );
  assert.equal(planWithArtifact.isError, false);
  assert.equal(planWithArtifact.payload.simulationArtifact.written, true);
  assert.equal(fs.existsSync(reportPaths.jsonPath), true);
  assert.equal(fs.existsSync(reportPaths.markdownPath), true);

  fs.unlinkSync(reportPaths.jsonPath);
  fs.unlinkSync(reportPaths.markdownPath);

  const remoteApply = await executeMcpToolIntegration(
    'sync_unified_change_workflow',
    {
      task: 'update metadata validation',
      taskType: 'script',
      script: 'gs.info("remote apply");',
      executionMode: 'remote',
      allowRemoteApply: true,
      apply: true,
      confirmDestructive: true,
      rollbackEvidence: { revertSteps: ['undo change'] },
    },
    {
      timeoutMs: 5000,
      preflight: { checks: { allOk: true } },
      remoteExecutor: async () => ({
        status: 200,
        data: { ok: true },
        text: 'remote-ok',
        usedEndpoint: '/api/x_nuvo_sinc/sinc/runBackgroundScript',
      }),
    }
  );
  assert.equal(remoteApply.isError, false);
  assert.equal(remoteApply.payload.executionMode, 'remote');
  assert.equal(remoteApply.payload.remoteExecution.status, 200);
  assert.equal(remoteApply.payload.mutationApplied, true);

  const remoteWithoutOptIn = await executeMcpToolIntegration(
    'sync_unified_change_workflow',
    {
      task: 'update metadata validation',
      taskType: 'script',
      script: 'gs.info("remote apply");',
      executionMode: 'remote',
      apply: true,
      confirmDestructive: true,
      rollbackEvidence: { revertSteps: ['undo change'] },
    },
    {
      timeoutMs: 5000,
      preflight: { checks: { allOk: true } },
      remoteExecutor: async () => ({
        status: 200,
        data: { ok: true },
        text: 'remote-ok',
        usedEndpoint: '/api/x_nuvo_sinc/sinc/runBackgroundScript',
      }),
    }
  );
  assert.equal(remoteWithoutOptIn.isError, true);
  assert.equal(String(remoteWithoutOptIn.payload.error).includes('allowRemoteApply=true'), true);
});

test('run_node_code enforces confirmDestructive and unsafe checks', async () => {
  let runCommandCalls = 0;
  const mkContext = (unsafe, timeoutMs = 5000, allowFullNodeAccess = false) => ({
    timeoutMs,
    dryRun: false,
    startedAt: Date.now(),
    allowFullNodeAccess,
    runSyncroCliCommand: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    runCommand: async () => {
      runCommandCalls += 1;
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false };
    },
    isUnsafeWorkspaceCommand: () => unsafe,
    makeDryRunAuditResponse: () => ({ isError: false, content: [{ type: 'text', text: '{}' }] }),
    auditMutatingTool: () => {},
  });

  const missingConfirm = await handleWorkspaceTool(
    'run_node_code',
    { code: 'console.log(1)' },
    mkContext(false)
  );
  assert.equal(missingConfirm.isError, true);
  assert.equal(runCommandCalls, 0);
  assert.equal(String(missingConfirm.content[0].text).includes('confirmDestructive=true'), true);

  const unsafeBlocked = await handleWorkspaceTool(
    'run_node_code',
    { code: 'a && b', confirmDestructive: true },
    mkContext(true)
  );
  assert.equal(unsafeBlocked.isError, true);
  assert.equal(runCommandCalls, 0);
  assert.equal(String(unsafeBlocked.content[0].text).includes('Blocked unsafe command'), true);

  const allowed = await handleWorkspaceTool(
    'run_node_code',
    { code: 'console.log(1)', confirmDestructive: true },
    mkContext(false)
  );
  assert.equal(allowed.isError, false);
  assert.equal(runCommandCalls, 0);
  assert.equal(String(allowed.content[0].text).includes('1'), true);

  const processBlocked = await handleWorkspaceTool(
    'run_node_code',
    { code: 'process.exit(1)', confirmDestructive: true },
    mkContext(false)
  );
  assert.equal(processBlocked.isError, true);
  assert.equal(String(processBlocked.content[0].text).toLowerCase().includes('process is not defined'), true);

  const requireBlocked = await handleWorkspaceTool(
    'run_node_code',
    { code: 'require("fs")', confirmDestructive: true },
    mkContext(false)
  );
  assert.equal(requireBlocked.isError, true);
  assert.equal(String(requireBlocked.content[0].text).toLowerCase().includes('require is not defined'), true);

  const evalBlocked = await handleWorkspaceTool(
    'run_node_code',
    { code: 'eval("1+1")', confirmDestructive: true },
    mkContext(false)
  );
  assert.equal(evalBlocked.isError, true);
  assert.equal(String(evalBlocked.content[0].text).toLowerCase().includes('code generation from strings disallowed'), true);

  const timedOut = await handleWorkspaceTool(
    'run_node_code',
    { code: 'while (true) {}', confirmDestructive: true },
    mkContext(false, 100)
  );
  assert.equal(timedOut.isError, true);
  assert.equal(String(timedOut.content[0].text).toLowerCase().includes('timed out'), true);

  const fullAccess = await handleWorkspaceTool(
    'run_node_code',
    { code: 'console.log(process.version)', confirmDestructive: true },
    mkContext(false, 5000, true)
  );
  assert.equal(fullAccess.isError, false);
  assert.equal(runCommandCalls, 1);
});

test('buildScriptExcerpt returns context window around a case-insensitive match', () => {
  const script = 'var prefixHere = 1;\nfunction targetFunction() { return 42; }\nvar suffixHere = 2;';
  const excerpt = buildScriptExcerpt(script, 'TARGETfunction');
  assert.equal(excerpt.includes('targetFunction'), true);
  assert.equal(buildScriptExcerpt(script, 'notpresent'), '');
  assert.equal(buildScriptExcerpt('', 'x'), '');
});

test('isoToServiceNowDateTime converts ISO to GMT datetime and rejects invalid input', () => {
  assert.equal(isoToServiceNowDateTime('2026-01-02T03:04:05.000Z'), '2026-01-02 03:04:05');
  assert.equal(isoToServiceNowDateTime('not-a-date'), '');
});

test('buildRecentChangesQuery scopes by application and orders by created date', () => {
  const query = buildRecentChangesQuery('x_nuvo_sinc', '2026-01-01 00:00:00');
  assert.equal(
    query,
    'application.scope=x_nuvo_sinc^sys_created_on>=2026-01-01 00:00:00^ORDERBYDESCsys_created_on'
  );
  assert.equal(
    buildRecentChangesQuery('x_nuvo_sinc', ''),
    'application.scope=x_nuvo_sinc^ORDERBYDESCsys_created_on'
  );
});

test('formatRecordHistory maps sys_audit rows to field-level diff entries', () => {
  const entries = formatRecordHistory([
    {
      sys_created_by: 'admin',
      sys_created_on: '2026-01-01 10:00:00',
      fieldname: 'script',
      oldvalue: 'a',
      newvalue: 'b',
    },
  ]);
  assert.deepEqual(entries, [
    {
      changedBy: 'admin',
      changedAt: '2026-01-01 10:00:00',
      field: 'script',
      oldValue: 'a',
      newValue: 'b',
    },
  ]);
});

test('buildReleaseNotesMarkdown groups changes by type', () => {
  const md = buildReleaseNotesMarkdown('My Update Set', [
    { type: 'sys_script_include', action: 'insert', target_name: 'HelperA' },
    { type: 'sys_script_include', action: 'update', target_name: 'HelperB' },
    { type: 'sys_script', action: 'delete', target_name: 'RuleC' },
  ]);
  assert.equal(md.includes('# Release Notes — My Update Set'), true);
  assert.equal(md.includes('Total changes: 3'), true);
  assert.equal(md.includes('## sys_script_include'), true);
  assert.equal(md.includes('- INSERT: HelperA'), true);
  assert.equal(md.includes('- DELETE: RuleC'), true);
});

test('handleInsightTool returns null for unrelated tools', async () => {
  const res = await handleInsightTool('some_other_tool', {}, { timeoutMs: 5000 });
  assert.equal(res, null);
});

test('handleInsightTool validates required fields', async () => {
  const missingScope = await handleInsightTool('sync_list_recent_changes', {}, { timeoutMs: 5000 });
  assert.equal(missingScope.isError, true);
  assert.equal(String(missingScope.content[0].text).includes('scope'), true);

  const missingQuery = await handleInsightTool('sn_search_scripts', {}, { timeoutMs: 5000 });
  assert.equal(missingQuery.isError, true);
  assert.equal(String(missingQuery.content[0].text).includes('query'), true);
});

test('handleInsightTool sync_list_recent_changes queries sys_update_xml', async () => {
  const originalFetch = global.fetch;
  let observedUrl = '';

  global.fetch = async (url) => {
    observedUrl = String(url);
    return mkResponse(200, {
      result: [
        {
          target_name: 'HelperA',
          type: 'sys_script_include',
          action: 'INSERT',
          sys_created_by: 'admin',
          sys_created_on: '2026-01-01 10:00:00',
        },
      ],
    });
  };

  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const res = await handleInsightTool(
        'sync_list_recent_changes',
        { scope: 'x_nuvo_sinc', limit: 10 },
        { timeoutMs: 5000 }
      );
      const payload = JSON.parse(res.content[0].text);
      assert.equal(res.isError, false);
      assert.equal(payload.rowCount, 1);
      assert.equal(payload.changes[0].name, 'HelperA');
      assert.equal(observedUrl.includes('/api/now/table/sys_update_xml'), true);
    }
  );

  global.fetch = originalFetch;
});

test('handleInsightTool sn_get_record_history queries sys_audit', async () => {
  const originalFetch = global.fetch;
  let observedUrl = '';

  global.fetch = async (url) => {
    observedUrl = String(url);
    return mkResponse(200, {
      result: [
        {
          sys_created_by: 'admin',
          sys_created_on: '2026-01-01 10:00:00',
          fieldname: 'active',
          oldvalue: 'true',
          newvalue: 'false',
        },
      ],
    });
  };

  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const res = await handleInsightTool(
        'sn_get_record_history',
        { table: 'sys_script_include', sysId: 'abc123' },
        { timeoutMs: 5000 }
      );
      const payload = JSON.parse(res.content[0].text);
      assert.equal(res.isError, false);
      assert.equal(payload.entryCount, 1);
      assert.equal(payload.history[0].field, 'active');
      assert.equal(observedUrl.includes('/api/now/table/sys_audit'), true);
    }
  );

  global.fetch = originalFetch;
});

test('handleInsightTool sync_generate_release_notes requires an update set identifier', async () => {
  const res = await handleInsightTool('sync_generate_release_notes', {}, { timeoutMs: 5000 });
  assert.equal(res.isError, true);
  assert.equal(String(res.content[0].text).includes('updateSetSysId'), true);
});

test('handleInsightTool sync_generate_release_notes builds markdown from update set', async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    const uri = String(url);
    if (uri.includes('/api/now/table/sys_update_xml')) {
      return mkResponse(200, {
        result: [
          { type: 'sys_script_include', action: 'insert', target_name: 'HelperA' },
        ],
      });
    }
    return mkResponse(200, { result: [] });
  };

  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const res = await handleInsightTool(
        'sync_generate_release_notes',
        { updateSetSysId: 'set123', format: 'markdown' },
        { timeoutMs: 5000 }
      );
      assert.equal(res.isError, false);
      assert.equal(res.content[0].text.includes('# Release Notes — set123'), true);
      assert.equal(res.content[0].text.includes('- INSERT: HelperA'), true);
    }
  );

  global.fetch = originalFetch;
});

test('buildAtfRunScript embeds scope and ids and prints a trigger marker', () => {
  const script = buildAtfRunScript({ scope: 'x_nuvo_sinc', suiteIds: ['s1'], testIds: [] });
  assert.equal(script.includes('x_nuvo_sinc'), true);
  assert.equal(script.includes('s1'), true);
  assert.equal(script.includes('SYNCRONA_ATF_TRIGGERED:'), true);
});

test('parseAtfTrigger extracts the JSON marker payload', () => {
  const text = 'log line\nSYNCRONA_ATF_TRIGGERED:{"suites":["s1"],"tests":[],"errors":[]}\nmore';
  const parsed = parseAtfTrigger(text);
  assert.deepEqual(parsed.suites, ['s1']);
  assert.deepEqual(parseAtfTrigger('no marker'), { suites: [], tests: [], errors: [] });
});

test('summarizeAtfResults counts passed and failed rows', () => {
  const summary = summarizeAtfResults([
    { sys_id: 'a', status: 'success', test_suite: 'Suite A' },
    { sys_id: 'b', status: 'failure', output: 'step 2 failed' },
  ]);
  assert.equal(summary.total, 2);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.results[1].status, 'failure');
});

test('handleInsightTool sync_run_atf_tests requires a target', async () => {
  const res = await handleInsightTool('sync_run_atf_tests', { scope: 'x_nuvo_sinc' }, { timeoutMs: 5000 });
  assert.equal(res.isError, true);
  assert.equal(String(res.content[0].text).includes('runAll'), true);
});

test('handleInsightTool sync_run_atf_tests triggers and polls suite results', async () => {
  const originalFetch = global.fetch;
  const seenUrls = [];

  global.fetch = async (url, options) => {
    const uri = String(url);
    seenUrls.push(uri);
    const method = (options && options.method) || 'GET';
    if (method === 'POST' && uri.includes('runBackgroundScript')) {
      return mkResponse(200, { result: { output: 'SYNCRONA_ATF_TRIGGERED:{"suites":["suite1"],"tests":[],"errors":[]}' } });
    }
    if (uri.includes('/api/now/table/sys_atf_test_suite_result')) {
      return mkResponse(200, {
        result: [{ sys_id: 'r1', status: 'success', test_suite: 'suite1', duration: '12' }],
      });
    }
    return mkResponse(200, { result: [] });
  };

  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const res = await handleInsightTool(
        'sync_run_atf_tests',
        { scope: 'x_nuvo_sinc', suiteId: 'suite1' },
        { timeoutMs: 5000 }
      );
      const payload = JSON.parse(res.content[0].text);
      assert.equal(payload.completed, true);
      assert.equal(payload.summary.passed, 1);
      assert.equal(seenUrls.some((u) => u.includes('sys_atf_test_suite_result')), true);
    }
  );

  global.fetch = originalFetch;
});

test('evaluateValidationStatus maps risk distribution to status', () => {
  const blocked = evaluateValidationStatus({ risk: { active: { distribution: { high: 1, medium: 0, low: 0 } } } });
  assert.equal(blocked.status, 'blocked');
  const warning = evaluateValidationStatus({ risk: { active: { distribution: { high: 0, medium: 2, low: 1 } } } });
  assert.equal(warning.status, 'warning');
  const ready = evaluateValidationStatus({ risk: { active: { distribution: { high: 0, medium: 0, low: 0 } } } });
  assert.equal(ready.status, 'ready');
});

test('handleInsightTool sync_validate_before_push reports blocked on high-risk script', async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    const uri = String(url);
    if (uri.includes('/api/now/table/sys_script_include')) {
      return mkResponse(200, {
        result: [
          { sys_id: 'si1', name: 'Risky', script: 'while (gr.next()) { var inner = new GlideRecord("incident"); }' },
        ],
      });
    }
    if (uri.includes('/api/now/table/sys_update_xml')) {
      return mkResponse(200, { result: [] });
    }
    return mkResponse(200, { result: [] });
  };

  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const res = await handleInsightTool(
        'sync_validate_before_push',
        { scope: 'x_nuvo_sinc', tables: ['sys_script_include'] },
        { timeoutMs: 5000 }
      );
      const payload = JSON.parse(res.content[0].text);
      assert.equal(res.isError, true);
      assert.equal(payload.ready, false);
      assert.equal(payload.blockedCount >= 1, true);
      assert.equal(payload.files[0].status, 'blocked');
    }
  );

  global.fetch = originalFetch;
});

test('hashRecordContent and diffInstanceRecords detect differences', () => {
  assert.equal(hashRecordContent('abc'), hashRecordContent('abc'));
  assert.notEqual(hashRecordContent('abc'), hashRecordContent('abd'));

  const diff = diffInstanceRecords(
    [
      { name: 'Same', script: 'x' },
      { name: 'Changed', script: 'v1' },
      { name: 'OnlyA', script: 'a' },
    ],
    [
      { name: 'Same', script: 'x' },
      { name: 'Changed', script: 'v2' },
      { name: 'OnlyB', script: 'b' },
    ],
    { nameField: 'name', contentField: 'script' }
  );
  assert.deepEqual(diff.onlyInA, ['OnlyA']);
  assert.deepEqual(diff.onlyInB, ['OnlyB']);
  assert.equal(diff.different.length, 1);
  assert.equal(diff.different[0].name, 'Changed');
});

test('handleInsightTool sync_compare_instances validates fields and unknown profiles', async () => {
  const missing = await handleInsightTool('sync_compare_instances', { profileA: 'a' }, { timeoutMs: 5000 });
  assert.equal(missing.isError, true);
  assert.equal(String(missing.content[0].text).includes('profileB'), true);

  const unknown = await handleInsightTool(
    'sync_compare_instances',
    { profileA: 'no-such-profile-xyz', profileB: 'other', scope: 'x_nuvo_sinc' },
    { timeoutMs: 5000 }
  );
  assert.equal(unknown.isError, true);
  assert.equal(String(unknown.content[0].text).includes('Profile not found'), true);
});

test('buildUpdateSetExportPath sanitizes the update set name', () => {
  assert.equal(
    buildUpdateSetExportPath('My Set/v2'),
    path.join('.syncrona-mcp', 'exports', 'My_Set_v2.xml')
  );
  assert.equal(
    buildUpdateSetExportPath(''),
    path.join('.syncrona-mcp', 'exports', 'update_set.xml')
  );
});

test('handleInsightTool sync_export_update_set returns xml and record count', async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    const uri = String(url);
    if (uri.includes('/export_update_set.do')) {
      return mkResponse(200, '<?xml version="1.0"?><unload>data</unload>');
    }
    if (uri.includes('/api/now/table/sys_update_xml')) {
      return mkResponse(200, { result: [{ type: 'sys_script_include' }, { type: 'sys_script' }] });
    }
    return mkResponse(200, { result: [] });
  };

  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const res = await handleInsightTool(
        'sync_export_update_set',
        { updateSetSysId: 'set123' },
        { timeoutMs: 5000 }
      );
      const payload = JSON.parse(res.content[0].text);
      assert.equal(res.isError, false);
      assert.equal(payload.recordCount, 2);
      assert.equal(payload.xml.includes('<unload>'), true);
      assert.equal(payload.byteLength > 0, true);
    }
  );

  global.fetch = originalFetch;
});
