// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  handleMetadataAnalysisTool,
} = require('../dist/handlers/metadataAnalysisHandlers.js');
const {
  clearServiceNowSecretsCache,
  clearScopedApiPrefixCache,
} = require('../dist/servicenowCore.js');

// parseMetadataType is injected; stub it to accept a known type and reject the
// rest, so we can drive the validation branches without a live instance.
function makeContext(overrides = {}) {
  const audits = [];
  const dryRuns = [];
  return {
    timeoutMs: 1000,
    dryRun: false,
    startedAt: Date.now(),
    projectDir: '/tmp/does-not-exist',
    parseMetadataType: (value) => (value === 'business_rule' ? 'business_rule' : null),
    makeDryRunAuditResponse: (toolName, args, details) => {
      dryRuns.push({ toolName, args, details });
      return { isError: false, content: [{ type: 'text', text: `dry-run:${toolName}` }] };
    },
    auditMutatingTool: (toolName, args, outcome, durationMs) => {
      audits.push({ toolName, args, outcome, durationMs });
    },
    getLastSemanticIndex: () => [],
    setLastSemanticIndex: () => {},
    _audits: audits,
    _dryRuns: dryRuns,
    ...overrides,
  };
}

function mkResponse(status, payload) {
  return {
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

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

// --- sn_list_metadata_records -------------------------------------------

test('sn_list_metadata_records: happy path lists and normalizes rows via fetch-backed tableGet', async () => {
  global.fetch = async () =>
    mkResponse(200, {
      result: [
        { sys_id: 's1', name: 'MyRule', active: 'true', collection: 'incident', script: 'gs.info(1);' },
      ],
    });

  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const res = await handleMetadataAnalysisTool(
        'sn_list_metadata_records',
        { recordType: 'business_rule', query: 'active=true', limit: 5 },
        makeContext()
      );
      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.recordType, 'business_rule');
      assert.equal(parsed.count, 1);
      assert.equal(parsed.rows[0].sysId, 's1');
      assert.equal(parsed.rows[0].name, 'MyRule');
      assert.equal(parsed.rows[0].active, true);
      assert.equal(parsed.rows[0].tableName, 'incident');
    }
  );
});

test('sn_list_metadata_records: default query/limit and limit clamping (over max)', async () => {
  let capturedUrl = null;
  global.fetch = async (url) => {
    capturedUrl = url;
    return mkResponse(200, { result: [] });
  };

  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const res = await handleMetadataAnalysisTool(
        'sn_list_metadata_records',
        { recordType: 'business_rule', limit: 99999 },
        makeContext()
      );
      assert.equal(res.isError, false);
      assert.match(capturedUrl, /sysparm_limit=500/);
    }
  );
});

test('sn_list_metadata_records: limit below 1 is clamped up to 1', async () => {
  let capturedUrl = null;
  global.fetch = async (url) => {
    capturedUrl = url;
    return mkResponse(200, { result: [] });
  };

  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      await handleMetadataAnalysisTool(
        'sn_list_metadata_records',
        { recordType: 'business_rule', limit: -5 },
        makeContext()
      );
      assert.match(capturedUrl, /sysparm_limit=1\b/);
    }
  );
});

test('sn_list_metadata_records: non-numeric limit falls back to default 100', async () => {
  let capturedUrl = null;
  global.fetch = async (url) => {
    capturedUrl = url;
    return mkResponse(200, { result: [] });
  };

  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      await handleMetadataAnalysisTool(
        'sn_list_metadata_records',
        { recordType: 'business_rule', limit: 'not-a-number' },
        makeContext()
      );
      assert.match(capturedUrl, /sysparm_limit=100\b/);
    }
  );
});

// --- sn_get_metadata_record ----------------------------------------------

test('sn_get_metadata_record: found row is normalized and isError is false', async () => {
  global.fetch = async () =>
    mkResponse(200, {
      result: [{ sys_id: 'abc', name: 'Found', active: true }],
    });

  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const res = await handleMetadataAnalysisTool(
        'sn_get_metadata_record',
        { recordType: 'business_rule', sysId: 'abc' },
        makeContext()
      );
      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.row.sysId, 'abc');
      assert.equal(parsed.row.name, 'Found');
    }
  );
});

test('sn_get_metadata_record: not found (empty rows) yields isError true with null row', async () => {
  global.fetch = async () => mkResponse(200, { result: [] });

  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const res = await handleMetadataAnalysisTool(
        'sn_get_metadata_record',
        { recordType: 'business_rule', sysId: 'missing' },
        makeContext()
      );
      assert.equal(res.isError, true);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.row, null);
    }
  );
});

test('sn_get_metadata_record: whitespace-only sysId is rejected as missing', async () => {
  const res = await handleMetadataAnalysisTool(
    'sn_get_metadata_record',
    { recordType: 'business_rule', sysId: '   ' },
    makeContext()
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /recordType\/sysId/);
});

// --- sn_update_metadata_record --------------------------------------------

test('sn_update_metadata_record: live PATCH success path audits and returns filtered payload result', async () => {
  let capturedMethod = null;
  let capturedBody = null;
  global.fetch = async (url, init) => {
    capturedMethod = init.method;
    capturedBody = JSON.parse(init.body);
    return mkResponse(200, { result: { sys_id: 'abc', name: 'Updated' } });
  };

  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const ctx = makeContext();
      const res = await handleMetadataAnalysisTool(
        'sn_update_metadata_record',
        {
          recordType: 'business_rule',
          sysId: 'abc',
          confirmDestructive: true,
          updates: { name: 'Updated', active: true, notAllowedField: 'x' },
        },
        ctx
      );
      assert.equal(res.isError, false);
      assert.equal(capturedMethod, 'PATCH');
      // notAllowedField must be filtered out by buildMetadataUpdatePayload's allowlist
      assert.equal(capturedBody.notAllowedField, undefined);
      assert.equal(capturedBody.name, 'Updated');
      assert.equal(ctx._audits.length, 1);
      assert.equal(ctx._audits[0].toolName, 'sn_update_metadata_record');
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.status, 200);
      assert.equal(parsed.sysId, 'abc');
    }
  );
});

test('sn_update_metadata_record: live PATCH failure status (>=300) reports isError true', async () => {
  global.fetch = async () => mkResponse(404, { error: { message: 'not found' } });

  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const ctx = makeContext();
      const res = await handleMetadataAnalysisTool(
        'sn_update_metadata_record',
        { recordType: 'business_rule', sysId: 'abc', confirmDestructive: true, updates: { name: 'X' } },
        ctx
      );
      assert.equal(res.isError, true);
      assert.equal(ctx._audits.length, 1);
      assert.equal(ctx._audits[0].outcome.status, 404);
    }
  );
});

// --- sn_build_dependency_graph ---------------------------------------------

test('sn_build_dependency_graph: detects a cycle and reports hotspots/provenance', async () => {
  const res = await handleMetadataAnalysisTool(
    'sn_build_dependency_graph',
    {
      records: [
        { sys_id: 'a', name: 'A', script: "new B();" },
        { sys_id: 'b', name: 'B', script: "new A();" },
      ],
    },
    makeContext()
  );
  assert.equal(res.isError, false);
  const parsed = JSON.parse(res.content[0].text);
  assert.ok(Array.isArray(parsed.nodes));
  assert.ok(Array.isArray(parsed.edges));
  assert.ok(Array.isArray(parsed.hotspots));
  assert.ok(Array.isArray(parsed.provenance));
  assert.ok(Array.isArray(parsed.why));
});

// --- sn_analyze_impact -------------------------------------------------

test('sn_analyze_impact: valid targetId with a real graph ranks impact and blast radius', async () => {
  const graph = {
    nodes: [
      { id: 'a', kind: 'script', label: 'A' },
      { id: 'b', kind: 'table', label: 'B' },
    ],
    edges: [{ from: 'a', to: 'b', relation: 'depends_on', why: 'uses table' }],
  };
  const res = await handleMetadataAnalysisTool(
    'sn_analyze_impact',
    { graph, targetId: 'a' },
    makeContext()
  );
  assert.equal(res.isError, false);
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.targetId, 'a');
  assert.ok(Array.isArray(parsed.impact));
  assert.ok(parsed.blastRadius);
  assert.equal(parsed.blastRadius.totalImpacted, parsed.impact.length);
});

test('sn_analyze_impact: missing targetId reports isError true', async () => {
  const res = await handleMetadataAnalysisTool(
    'sn_analyze_impact',
    { graph: { nodes: [], edges: [] } },
    makeContext()
  );
  assert.equal(res.isError, true);
});

test('sn_analyze_impact: non-object graph and non-array nodes/edges degrade to empty', async () => {
  const res = await handleMetadataAnalysisTool(
    'sn_analyze_impact',
    { graph: { nodes: 'nope', edges: 'nope' }, targetId: 'x' },
    makeContext()
  );
  assert.equal(res.isError, false);
  const parsed = JSON.parse(res.content[0].text);
  assert.deepEqual(parsed.impact, []);
});

// --- sn_diff_dependency_graphs -------------------------------------------

test('sn_diff_dependency_graphs: computes added/removed nodes and edges', async () => {
  const beforeGraph = {
    nodes: [{ id: 'a', kind: 'script', label: 'A' }],
    edges: [],
  };
  const afterGraph = {
    nodes: [
      { id: 'a', kind: 'script', label: 'A' },
      { id: 'b', kind: 'table', label: 'B' },
    ],
    edges: [{ from: 'a', to: 'b', relation: 'depends_on', why: 'x' }],
  };
  const res = await handleMetadataAnalysisTool(
    'sn_diff_dependency_graphs',
    { beforeGraph, afterGraph },
    makeContext()
  );
  assert.equal(res.isError, false);
  const parsed = JSON.parse(res.content[0].text);
  assert.deepEqual(parsed.addedNodes, ['b']);
  assert.deepEqual(parsed.removedNodes, []);
  assert.equal(parsed.addedEdges.length, 1);
});

test('sn_diff_dependency_graphs: missing before/after graphs default to empty graphs', async () => {
  const res = await handleMetadataAnalysisTool('sn_diff_dependency_graphs', {}, makeContext());
  assert.equal(res.isError, false);
  const parsed = JSON.parse(res.content[0].text);
  assert.deepEqual(parsed.addedNodes, []);
  assert.deepEqual(parsed.removedNodes, []);
});

// --- sync_detect_drift ----------------------------------------------------

test('sync_detect_drift: builds a drift report from local vs instance records', async () => {
  const res = await handleMetadataAnalysisTool(
    'sync_detect_drift',
    {
      localRecords: [{ sys_id: 'a', name: 'A', key: 'a' }],
      instanceRecords: [{ sys_id: 'a', name: 'A-changed', key: 'a' }],
      updateSetSysId: 'us1',
    },
    makeContext()
  );
  assert.equal(res.isError, false);
  assert.doesNotThrow(() => JSON.parse(res.content[0].text));
});

test('sync_detect_drift: non-array inputs degrade to empty record lists', async () => {
  const res = await handleMetadataAnalysisTool(
    'sync_detect_drift',
    { localRecords: 'nope', instanceRecords: 42 },
    makeContext()
  );
  assert.equal(res.isError, false);
});

// --- sync_validate_change_package -------------------------------------

test('sync_validate_change_package: valid package (all deps selected)', async () => {
  const res = await handleMetadataAnalysisTool(
    'sync_validate_change_package',
    {
      selectedIds: ['a', 'b'],
      graph: {
        nodes: [{ id: 'a' }, { id: 'b' }],
        edges: [{ from: 'a', to: 'b', why: 'needs b' }],
      },
    },
    makeContext()
  );
  assert.equal(res.isError, false);
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.valid, true);
});

test('sync_validate_change_package: missing dependency makes validation invalid/isError true', async () => {
  const res = await handleMetadataAnalysisTool(
    'sync_validate_change_package',
    {
      selectedIds: ['a'],
      graph: {
        nodes: [{ id: 'a' }, { id: 'b' }],
        edges: [{ from: 'a', to: 'b', why: 'needs b' }],
      },
    },
    makeContext()
  );
  assert.equal(res.isError, true);
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.valid, false);
  assert.equal(parsed.missingDependencies.length, 1);
});

test('sync_validate_change_package: non-array selectedIds/graph fields degrade gracefully', async () => {
  const res = await handleMetadataAnalysisTool(
    'sync_validate_change_package',
    { selectedIds: 'nope', graph: { nodes: 'nope', edges: 'nope' } },
    makeContext()
  );
  assert.equal(res.isError, false);
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.valid, true);
});

// --- sync_build_semantic_index / sync_search_semantic_index / sync_symbol_cross_reference ---

test('sync_build_semantic_index: walks a real temp workspace and stores the index via setLastSemanticIndex', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-mcp-metadata-test-'));
  fs.writeFileSync(
    path.join(tempDir, 'sample.ts'),
    'function doThing() {}\nclass Widget {}\nconst answer = 42;\n'
  );

  let storedIndex = null;
  const ctx = makeContext({
    projectDir: tempDir,
    setLastSemanticIndex: (rows) => {
      storedIndex = rows;
    },
  });

  const res = await handleMetadataAnalysisTool('sync_build_semantic_index', {}, ctx);
  assert.equal(res.isError, false);
  const parsed = JSON.parse(res.content[0].text);
  assert.ok(parsed.symbolCount >= 3);
  assert.ok(Array.isArray(storedIndex));
  assert.equal(storedIndex.length, parsed.symbolCount);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('sync_search_semantic_index: matches against the injected semantic index', async () => {
  const fakeIndex = [
    { name: 'doThing', kind: 'function', file: 'a.ts', line: 1 },
    { name: 'Widget', kind: 'class', file: 'a.ts', line: 2 },
  ];
  const ctx = makeContext({ getLastSemanticIndex: () => fakeIndex });

  const res = await handleMetadataAnalysisTool(
    'sync_search_semantic_index',
    { query: 'doThing' },
    ctx
  );
  assert.equal(res.isError, false);
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.query, 'doThing');
  assert.ok(parsed.count >= 1);
  assert.ok(parsed.matches.some((m) => m.name === 'doThing'));
});

test('sync_search_semantic_index: missing query defaults to empty string', async () => {
  const ctx = makeContext({ getLastSemanticIndex: () => [] });
  const res = await handleMetadataAnalysisTool('sync_search_semantic_index', {}, ctx);
  assert.equal(res.isError, false);
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.query, '');
  assert.equal(parsed.count, 0);
});

test('sync_symbol_cross_reference: builds cross-reference rows from the injected index', async () => {
  const fakeIndex = [
    { name: 'shared', kind: 'function', file: 'a.ts', line: 1 },
    { name: 'shared', kind: 'const', file: 'b.ts', line: 5 },
  ];
  const ctx = makeContext({ getLastSemanticIndex: () => fakeIndex });

  const res = await handleMetadataAnalysisTool('sync_symbol_cross_reference', {}, ctx);
  assert.equal(res.isError, false);
  const parsed = JSON.parse(res.content[0].text);
  assert.ok(Array.isArray(parsed.rows));
  assert.equal(parsed.count, parsed.rows.length);
});
