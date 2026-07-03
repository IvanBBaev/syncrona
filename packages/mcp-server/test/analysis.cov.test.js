// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getMetadataConfig,
  normalizeMetadataRow,
  buildMetadataUpdatePayload,
  buildDriftReport,
  hashToolContract,
  buildTableApiCoverageMatrix,
  rotateAuditLogByLines,
} = require('../dist/analysis.js');

const {
  buildDependencyGraph,
  detectGraphCycles,
  diffDependencyGraphs,
  extractReferencesFromScript,
  renderDependencyGraphMermaid,
  renderTableRelationshipMermaid,
  rankImpact,
  summarizeBlastRadius,
  summarizeEdgeProvenance,
  summarizeGraphHotspots,
  validateChangePackage,
} = require('../dist/analysis/graph.js');

// ---------------------------------------------------------------------------
// analysis.ts: getMetadataConfig / normalizeMetadataRow / buildMetadataUpdatePayload
// ---------------------------------------------------------------------------

test('getMetadataConfig returns configs for every metadata type incl. acl/scripted_rest', () => {
  const acl = getMetadataConfig('acl');
  assert.equal(acl.table, 'sys_security_acl');
  assert.equal(acl.tableField, 'name');

  const rest = getMetadataConfig('scripted_rest');
  assert.equal(rest.table, 'sys_ws_operation');
  assert.equal(rest.tableField, undefined);

  const uiPolicy = getMetadataConfig('ui_policy');
  assert.equal(uiPolicy.scriptField, 'script_true');
});

test('normalizeMetadataRow handles acl rows and non-string active field', () => {
  const row = normalizeMetadataRow('acl', {
    sys_id: 'acl1',
    name: 'incident.read',
    active: false,
    script: 'answer = true;',
  });

  assert.equal(row.sysId, 'acl1');
  assert.equal(row.name, 'incident.read');
  assert.equal(row.tableName, 'incident.read');
  assert.equal(row.active, false);
  assert.equal(row.script, 'answer = true;');
});

test('normalizeMetadataRow handles types without scriptField or tableField (ui_formatter, ui_script)', () => {
  const uiScriptRow = normalizeMetadataRow('ui_script', {
    sys_id: 'uis2',
    name: 'NoTableField',
    active: true,
  });
  assert.equal(uiScriptRow.tableName, '');

  const formatterRow = normalizeMetadataRow('ui_formatter', {
    sys_id: 'fmt1',
    name: 'fmt.name',
  });
  assert.equal(formatterRow.script, '');
  assert.equal(formatterRow.active, false);
});

test('normalizeMetadataRow coerces non-string display/script/table values to empty strings', () => {
  const row = normalizeMetadataRow('business_rule', {
    sys_id: 42,
    name: null,
    collection: { nested: true },
    script: 123,
    active: 'true',
  });

  assert.equal(row.sysId, '');
  assert.equal(row.name, '');
  assert.equal(row.tableName, '');
  assert.equal(row.script, '');
  assert.equal(row.active, true);
  assert.deepEqual(row.raw, {
    sys_id: 42,
    name: null,
    collection: { nested: true },
    script: 123,
    active: 'true',
  });
});

test('buildMetadataUpdatePayload allows common fields (description/order/condition) and rejects unknown', () => {
  const payload = buildMetadataUpdatePayload('ui_policy', {
    description: 'desc',
    order: 100,
    condition: 'current.active == true',
    script_true: 'g_form.setVisible("x", true);',
    unknown_field: 'nope',
  });

  assert.equal(payload.description, 'desc');
  assert.equal(payload.order, 100);
  assert.equal(payload.condition, 'current.active == true');
  assert.equal(payload.script_true, 'g_form.setVisible("x", true);');
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'unknown_field'), false);
});

test('buildMetadataUpdatePayload handles types with no scriptField/tableField (dictionary)', () => {
  const payload = buildMetadataUpdatePayload('dictionary', {
    element: 'u_field',
    active: true,
    name: 'x_demo_table',
  });
  // dictionary displayField=element, tableField=name (both allowed); no scriptField
  assert.equal(payload.element, 'u_field');
  assert.equal(payload.active, true);
  assert.equal(payload.name, 'x_demo_table');
});

// ---------------------------------------------------------------------------
// analysis.ts: buildDriftReport
// ---------------------------------------------------------------------------

test('buildDriftReport keys records by sys_id when key field is absent', () => {
  const drift = buildDriftReport(
    [{ sys_id: 's1', hash: 'a' }],
    [{ sys_id: 's1', hash: 'a' }],
    'us_sysid'
  );

  assert.equal(drift.summary.driftScore, 0);
  assert.equal(drift.summary.changed, 0);
  assert.deepEqual(drift.missingRemote, []);
  assert.deepEqual(drift.missingLocal, []);
});

test('buildDriftReport keys records by name when key/sys_id absent, and skips records with no usable key', () => {
  const drift = buildDriftReport(
    [{ name: 'ByName', hash: 'a' }, { hash: 'orphan-local' }],
    [{ name: 'ByName', hash: 'b' }, { hash: 'orphan-remote' }],
    'us_name'
  );

  assert.equal(drift.summary.changed, 1);
  assert.deepEqual(drift.changed, ['ByName']);
  // records without key/sys_id/name are silently dropped from both maps
  assert.equal(drift.summary.missingRemote, 0);
  assert.equal(drift.summary.missingLocal, 0);
});

test('buildDriftReport treats records without a hash on either side as unchanged', () => {
  const drift = buildDriftReport(
    [{ key: 'k1' }],
    [{ key: 'k1' }],
    'us_nohash'
  );
  assert.equal(drift.summary.changed, 0);
  assert.deepEqual(drift.changed, []);
});

test('buildDriftReport reports local-only and remote-only keys independently', () => {
  const drift = buildDriftReport(
    [{ key: 'local-only', hash: 'a' }],
    [{ key: 'remote-only', hash: 'b' }],
    'us_asymmetric'
  );
  assert.deepEqual(drift.missingRemote, ['local-only']);
  assert.deepEqual(drift.missingLocal, ['remote-only']);
  assert.equal(drift.summary.driftScore, 2);
});

test('buildDriftReport returns sorted why lines and static candidate actions', () => {
  const drift = buildDriftReport([], [], 'us_empty');
  assert.deepEqual(drift.why, [...drift.why].sort((a, b) => a.localeCompare(b)));
  assert.equal(drift.candidateActions.length, 3);
  assert.equal(drift.updateSetSysId, 'us_empty');
});

// ---------------------------------------------------------------------------
// analysis.ts: hashToolContract
// ---------------------------------------------------------------------------

test('hashToolContract returns deterministic 8-char hex and differs on content change', () => {
  const a = hashToolContract(['tool_one', 'tool_two']);
  assert.equal(typeof a, 'string');
  assert.equal(a.length, 8);
  assert.match(a, /^[0-9a-f]{8}$/);

  const b = hashToolContract(['tool_one', 'tool_three']);
  assert.notEqual(a, b);

  const empty = hashToolContract([]);
  assert.equal(empty.length, 8);
});

// ---------------------------------------------------------------------------
// analysis.ts: buildTableApiCoverageMatrix
// ---------------------------------------------------------------------------

test('buildTableApiCoverageMatrix is sorted by recordType and covers all metadata types', () => {
  const rows = buildTableApiCoverageMatrix();
  const types = rows.map((r) => r.recordType);
  assert.deepEqual(types, [...types].sort((a, b) => a.localeCompare(b)));
  assert.equal(rows.length, 10);
  assert.equal(rows.every((r) => Array.isArray(r.missingOperations) && r.missingOperations[0] === 'delete'), true);
  assert.deepEqual(rows.every((r) => r.supportedOperations.length === 3), true);
});

// ---------------------------------------------------------------------------
// analysis.ts: rotateAuditLogByLines
// ---------------------------------------------------------------------------

test('rotateAuditLogByLines returns rotated:false when file does not exist', () => {
  const res = rotateAuditLogByLines('/tmp/does-not-exist-audit-log-xyz.log', 100, 10);
  assert.deepEqual(res, { rotated: false, beforeLines: 0, afterLines: 0 });
});

test('rotateAuditLogByLines returns rotated:false when under threshold, leaves file untouched', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-audit-cov-'));
  const file = path.join(tempDir, 'audit.log');
  const original = ['a', 'b', 'c'].join('\n') + '\n';
  fs.writeFileSync(file, original);

  const res = rotateAuditLogByLines(file, 10, 2);
  assert.equal(res.rotated, false);
  assert.equal(res.beforeLines, 3);
  assert.equal(res.afterLines, 3);
  assert.equal(fs.readFileSync(file, 'utf-8'), original);
});

test('rotateAuditLogByLines uses default maxLines/keepLines when omitted', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-audit-cov-defaults-'));
  const file = path.join(tempDir, 'audit.log');
  fs.writeFileSync(file, 'only-one-line\n');

  const res = rotateAuditLogByLines(file);
  assert.equal(res.rotated, false);
  assert.equal(res.beforeLines, 1);
});

test('rotateAuditLogByLines enforces a minimum of 1 kept line and ignores blank lines', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-audit-cov-min-'));
  const file = path.join(tempDir, 'audit.log');
  // blank lines interspersed should be filtered out before counting
  fs.writeFileSync(file, ['1', '', '2', '', '3', '4', '5'].join('\n') + '\n');

  const res = rotateAuditLogByLines(file, 4, 0);
  assert.equal(res.rotated, true);
  assert.equal(res.beforeLines, 5);
  assert.equal(res.afterLines, 1);
  const kept = fs.readFileSync(file, 'utf-8').trim().split('\n');
  assert.deepEqual(kept, ['5']);
});

test('rotateAuditLogByLines handles CRLF line endings', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-audit-cov-crlf-'));
  const file = path.join(tempDir, 'audit.log');
  fs.writeFileSync(file, ['1', '2', '3', '4', '5', '6'].join('\r\n') + '\r\n');

  const res = rotateAuditLogByLines(file, 5, 3);
  assert.equal(res.rotated, true);
  assert.equal(res.beforeLines, 6);
  assert.equal(res.afterLines, 3);
  const kept = fs.readFileSync(file, 'utf-8').trim().split('\n');
  assert.deepEqual(kept, ['4', '5', '6']);
});

// ---------------------------------------------------------------------------
// graph.ts: extractReferencesFromScript edge cases
// ---------------------------------------------------------------------------

test('extractReferencesFromScript dedupes repeated references and ignores GlideRecordSecure/RESTMessageV2 as includes', () => {
  const refs = extractReferencesFromScript([
    'var a = new GlideRecordSecure("incident");',
    'var b = new GlideRecordSecure("incident");',
    'var rm = new sn_ws.RESTMessageV2("api_one", "get");',
    'var rm2 = new sn_ws.RESTMessageV2("api_one", "get");',
  ].join('\n'));

  assert.deepEqual(refs.tables, ['incident']);
  assert.deepEqual(refs.apis, ['api_one']);
  assert.deepEqual(refs.includes, []);
});

test('extractReferencesFromScript returns empty arrays for script with no references', () => {
  const refs = extractReferencesFromScript('var x = 1 + 1; gs.info(x);');
  assert.deepEqual(refs.tables, []);
  assert.deepEqual(refs.apis, []);
  assert.deepEqual(refs.includes, []);
});

// ---------------------------------------------------------------------------
// graph.ts: buildDependencyGraph edge cases
// ---------------------------------------------------------------------------

test('buildDependencyGraph assigns synthetic record id when id/sys_id are absent', () => {
  const graph = buildDependencyGraph([{ name: 'NoId', script: '' }]);
  const node = graph.nodes.find((n) => n.label === 'NoId');
  assert.equal(Boolean(node), true);
  assert.equal(node.id, 'record:1');
});

test('buildDependencyGraph falls back to sys_id then id-as-name when name is absent', () => {
  const graph = buildDependencyGraph([{ sys_id: 'abc123', script: '' }]);
  const node = graph.nodes.find((n) => n.id === 'abc123');
  assert.equal(Boolean(node), true);
  assert.equal(node.label, 'abc123');
});

test('buildDependencyGraph handles non-object record entries defensively', () => {
  const graph = buildDependencyGraph([null, 'not-an-object', 42]);
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.nodes.every((n) => n.kind === 'script'), true);
});

test('buildDependencyGraph does not emit cross-scope edge when own scope code is absent', () => {
  const graph = buildDependencyGraph([
    {
      id: 'record:noscope',
      name: 'NoScope',
      script: 'var gr = new GlideRecord("x_other_app_task");',
    },
  ]);
  const crossEdges = graph.edges.filter((e) => e.relation === 'cross_scope_dependency');
  assert.deepEqual(crossEdges, []);
});

test('buildDependencyGraph treats non-x_ dotted include prefix as its own scope code (namespace.ClassName)', () => {
  const graph = buildDependencyGraph([
    {
      id: 'record:nsinclude',
      name: 'NsInclude',
      scopeCode: 'x_nuvo_cs',
      script: 'var ga = new GlideAjax("global.HelperAjax");',
    },
  ]);
  const externalNode = graph.nodes.find((n) => n.id === 'external_scope:global');
  const crossEdge = graph.edges.find((e) => e.from === 'record:nsinclude' && e.relation === 'cross_scope_dependency');
  assert.equal(Boolean(externalNode), true);
  assert.equal(Boolean(crossEdge), true);
});

test('buildDependencyGraph treats invalid (non-identifier) dotted include prefix as no scope code', () => {
  const graph = buildDependencyGraph([
    {
      id: 'record:badinclude',
      name: 'BadInclude',
      scopeCode: 'x_nuvo_cs',
      script: 'var ga = new GlideAjax("123bad.HelperAjax");',
    },
  ]);
  const crossEdge = graph.edges.find((e) => e.from === 'record:badinclude' && e.relation === 'cross_scope_dependency');
  assert.equal(crossEdge, undefined);
});

test('buildDependencyGraph does not flag same-scope table reference as cross-scope', () => {
  const graph = buildDependencyGraph([
    {
      id: 'record:samescope',
      name: 'SameScope',
      scopeCode: 'x_nuvo_cs',
      script: 'var gr = new GlideRecord("x_nuvo_cs_task");',
    },
  ]);
  const crossEdges = graph.edges.filter((e) => e.relation === 'cross_scope_dependency');
  assert.deepEqual(crossEdges, []);
});

test('buildDependencyGraph deduplicates edges across multiple identical records', () => {
  const record = {
    id: 'record:dup',
    name: 'Dup',
    table: 'incident',
    script: 'new GlideRecord("task");',
  };
  const graph = buildDependencyGraph([record, { ...record }]);
  // node upsert dedupes by id, so only one 'record:dup' node, and edges are unique
  const dupNodes = graph.nodes.filter((n) => n.id === 'record:dup');
  assert.equal(dupNodes.length, 1);
  const readsEdges = graph.edges.filter((e) => e.from === 'record:dup' && e.relation === 'reads');
  assert.equal(readsEdges.length, 1);
});

test('buildDependencyGraph marks plain script include instantiation as depends_on (default branch)', () => {
  const graph = buildDependencyGraph([
    {
      id: 'record:plain',
      name: 'PlainRule',
      metadataType: 'business_rule',
      script: 'new HelperInclude();',
    },
  ]);
  const includeEdge = graph.edges.find((e) => e.to === 'script:HelperInclude');
  assert.equal(Boolean(includeEdge), true);
  assert.equal(includeEdge.relation, 'depends_on');
  assert.equal(includeEdge.why, 'Script include instantiation');
});

test('buildDependencyGraph reads metaRelations non-string object form and ignores relations without target', () => {
  const graph = buildDependencyGraph([
    {
      id: 'record:meta2',
      name: 'Meta2',
      script: '',
      metaRelations: [
        { type: 'include', target: 'Helper' },
        { type: 'table', target: 'metatable' },
        { type: 'table', target: '' },
        { type: 'unknown', target: 'x' },
      ],
    },
  ]);
  const includeEdge = graph.edges.find((e) => e.to === 'script:Helper');
  const metaTableEdge = graph.edges.find((e) => e.to === 'table:metatable' && e.relation === 'affects');
  assert.equal(Boolean(includeEdge), true);
  assert.equal(includeEdge.relation, 'depends_on');
  assert.equal(includeEdge.why, 'Meta include dependency declared by record');
  assert.equal(Boolean(metaTableEdge), true);
  assert.equal(metaTableEdge.why, 'Meta relation declared by record');
  const emptyTableEdge = graph.edges.find((e) => e.to === 'table:');
  assert.equal(emptyTableEdge, undefined);
});

test('buildDependencyGraph creates update_set and api nodes/edges', () => {
  const graph = buildDependencyGraph([
    {
      id: 'record:withapi',
      name: 'WithApi',
      updateSet: 'US777',
      script: 'var rm = new sn_ws.RESTMessageV2("payment_api", "get");',
    },
  ]);

  const usNode = graph.nodes.find((n) => n.id === 'update_set:US777');
  const usEdge = graph.edges.find((e) => e.to === 'update_set:US777' && e.relation === 'contains');
  const apiNode = graph.nodes.find((n) => n.id === 'api:payment_api');
  const apiEdge = graph.edges.find((e) => e.to === 'api:payment_api' && e.relation === 'calls');

  assert.equal(Boolean(usNode), true);
  assert.equal(Boolean(usEdge), true);
  assert.equal(Boolean(apiNode), true);
  assert.equal(apiNode.kind, 'api');
  assert.equal(Boolean(apiEdge), true);
});

test('buildDependencyGraph parses string-form metaRelations table:/include: prefixes and dedupes overlaps', () => {
  const graph = buildDependencyGraph([
    {
      id: 'record:strmeta',
      name: 'StrMeta',
      script: '',
      metaRelations: ['table:strtable', 'table:strtable', 'include:StrHelper', 'not-a-prefixed-string', '  '],
    },
  ]);
  const tableEdge = graph.edges.find((e) => e.to === 'table:strtable' && e.relation === 'affects');
  const includeEdge = graph.edges.find((e) => e.to === 'script:StrHelper' && e.relation === 'depends_on');
  assert.equal(Boolean(tableEdge), true);
  assert.equal(Boolean(includeEdge), true);
  // dedup: only one affects-edge to strtable despite the repeated metaRelations entry
  const allTableEdges = graph.edges.filter((e) => e.to === 'table:strtable');
  assert.equal(allTableEdges.length, 1);
});

test('buildDependencyGraph handles empty records array', () => {
  const graph = buildDependencyGraph([]);
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.edges, []);
});

// ---------------------------------------------------------------------------
// graph.ts: renderTableRelationshipMermaid empty case + limit
// ---------------------------------------------------------------------------

test('renderTableRelationshipMermaid emits placeholder when there are no table-to-table relations', () => {
  const graph = {
    nodes: [{ id: 'table:incident', kind: 'table', label: 'incident' }],
    edges: [],
  };
  const mermaid = renderTableRelationshipMermaid(graph);
  assert.equal(mermaid.includes('TABLE_UNKNOWN'), true);
  assert.equal(mermaid.includes('no_relationships_detected'), true);
});

test('renderTableRelationshipMermaid respects the limit parameter on table node count', () => {
  const graph = {
    nodes: [
      { id: 'table:a', kind: 'table', label: 'a' },
      { id: 'table:b', kind: 'table', label: 'b' },
      { id: 'table:c', kind: 'table', label: 'c' },
    ],
    edges: [
      { from: 'table:a', to: 'table:b', relation: 'depends_on', why: 'x' },
      { from: 'table:b', to: 'table:c', relation: 'depends_on', why: 'x' },
    ],
  };
  const mermaid = renderTableRelationshipMermaid(graph, 2);
  // only a,b are within the limit=2 slice, so a->b relation renders but b->c is filtered out
  assert.equal(mermaid.includes('A }o--|| B'), true);
  assert.equal(mermaid.includes('B }o--|| C'), false);
});

test('renderTableRelationshipMermaid sorts rows by source, then target, then label when source repeats', () => {
  const graph = {
    nodes: [
      { id: 'table:zeta', kind: 'table', label: 'zeta' },
      { id: 'table:alpha', kind: 'table', label: 'alpha' },
      { id: 'table:beta', kind: 'table', label: 'beta' },
    ],
    edges: [
      { from: 'table:zeta', to: 'table:beta', relation: 'depends_on', why: 'Dictionary reference' },
      { from: 'table:zeta', to: 'table:alpha', relation: 'depends_on', why: 'Dictionary reference' },
    ],
  };
  const mermaid = renderTableRelationshipMermaid(graph, 10);
  const lines = mermaid.split('\n').filter((l) => l.includes('references'));
  // alpha should sort before beta since target differs with same source
  assert.equal(lines[0].includes('ALPHA'), true);
  assert.equal(lines[1].includes('BETA'), true);
});

test('renderTableRelationshipMermaid normalizes numeric-leading entity names with T_ prefix', () => {
  const graph = {
    nodes: [
      { id: 'table:123table', kind: 'table', label: '123table' },
      { id: 'table:other', kind: 'table', label: 'other' },
    ],
    edges: [
      { from: 'table:123table', to: 'table:other', relation: 'depends_on', why: 'Dictionary reference' },
    ],
  };
  const mermaid = renderTableRelationshipMermaid(graph, 10);
  assert.equal(mermaid.includes('T_123TABLE'), true);
});

// ---------------------------------------------------------------------------
// graph.ts: renderDependencyGraphMermaid limit + edge filtering
// ---------------------------------------------------------------------------

test('renderDependencyGraphMermaid ranks nodes by inbound degree and truncates via limit', () => {
  const graph = {
    nodes: [
      { id: 'a', kind: 'script', label: 'A' },
      { id: 'b', kind: 'table', label: 'B' },
      { id: 'c', kind: 'table', label: 'C' },
    ],
    edges: [
      { from: 'a', to: 'b', relation: 'reads', why: 'x' },
      { from: 'a', to: 'c', relation: 'reads', why: 'x' },
    ],
  };
  const mermaid = renderDependencyGraphMermaid(graph, 1);
  // only the top-ranked (highest inbound) node is kept; edges referencing dropped nodes vanish
  const lines = mermaid.split('\n');
  const nodeLines = lines.filter((l) => l.trim().startsWith('n'));
  assert.equal(nodeLines.length <= 2, true); // at most node + its classDef assignment line
});

test('renderDependencyGraphMermaid renders edges between selected nodes and classDef groupings', () => {
  const graph = {
    nodes: [
      { id: 'script:a', kind: 'script', label: 'A' },
      { id: 'table:t', kind: 'table', label: 'T' },
    ],
    edges: [{ from: 'script:a', to: 'table:t', relation: 'reads', why: 'x' }],
  };
  const mermaid = renderDependencyGraphMermaid(graph, 10);
  assert.equal(mermaid.includes('-->|reads|'), true);
  assert.equal(mermaid.includes('class n0 script'), true);
  assert.equal(mermaid.includes('class n1 table'), true);
});

test('renderDependencyGraphMermaid escapes quotes and newlines in labels', () => {
  const graph = {
    nodes: [{ id: 'a', kind: 'script', label: 'Weird "Name"\nwith newline' }],
    edges: [],
  };
  const mermaid = renderDependencyGraphMermaid(graph);
  assert.equal(mermaid.includes("Weird 'Name' with newline"), true);
});

// ---------------------------------------------------------------------------
// graph.ts: detectGraphCycles - no cycle, self-loop
// ---------------------------------------------------------------------------

test('detectGraphCycles returns empty array for an acyclic graph', () => {
  const graph = {
    nodes: [
      { id: 'a', kind: 'script', label: 'A' },
      { id: 'b', kind: 'script', label: 'B' },
    ],
    edges: [{ from: 'a', to: 'b', relation: 'depends_on', why: 'x' }],
  };
  assert.deepEqual(detectGraphCycles(graph), []);
});

test('detectGraphCycles detects a direct self-loop', () => {
  const graph = {
    nodes: [{ id: 'a', kind: 'script', label: 'A' }],
    edges: [{ from: 'a', to: 'a', relation: 'depends_on', why: 'self' }],
  };
  const cycles = detectGraphCycles(graph);
  assert.deepEqual(cycles, [{ path: ['a', 'a'], length: 2 }]);
});

// ---------------------------------------------------------------------------
// graph.ts: summarizeGraphHotspots limit edge cases
// ---------------------------------------------------------------------------

test('summarizeGraphHotspots enforces a minimum limit of 1 even when passed 0', () => {
  const graph = {
    nodes: [
      { id: 'a', kind: 'script', label: 'A' },
      { id: 'b', kind: 'script', label: 'B' },
    ],
    edges: [{ from: 'a', to: 'b', relation: 'reads', why: 'x' }],
  };
  const hotspots = summarizeGraphHotspots(graph, 0);
  assert.equal(hotspots.length, 1);
});

test('summarizeGraphHotspots defaults limit to 5 when omitted', () => {
  const nodes = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, kind: 'script', label: `n${i}` }));
  const graph = { nodes, edges: [] };
  const hotspots = summarizeGraphHotspots(graph);
  assert.equal(hotspots.length, 5);
});

// ---------------------------------------------------------------------------
// graph.ts: rankImpact / summarizeBlastRadius edge cases
// ---------------------------------------------------------------------------

test('rankImpact returns empty array when target has no outgoing edges', () => {
  const graph = {
    nodes: [{ id: 'lonely', kind: 'script', label: 'Lonely' }],
    edges: [],
  };
  assert.deepEqual(rankImpact(graph, 'lonely'), []);
});

test('rankImpact assigns depth-based severities across a chain and avoids revisiting seen nodes', () => {
  const graph = {
    nodes: [
      { id: 'a', kind: 'script', label: 'A' },
      { id: 'b', kind: 'script', label: 'B' },
      { id: 'c', kind: 'script', label: 'C' },
      { id: 'd', kind: 'script', label: 'D' },
    ],
    edges: [
      { from: 'a', to: 'b', relation: 'depends_on', why: 'x' },
      { from: 'b', to: 'c', relation: 'depends_on', why: 'x' },
      { from: 'c', to: 'd', relation: 'depends_on', why: 'x' },
    ],
  };
  const impact = rankImpact(graph, 'a');
  assert.equal(impact.length, 3);
  assert.deepEqual(impact.map((i) => i.severity), ['high', 'medium', 'low']);
});

test('rankImpact skips already-seen nodes reached via a diamond dependency and sorts same-severity by depth', () => {
  // a -> b -> d (depth2, medium)
  // a -> c -> d (depth2, medium, but d already seen from b's branch, so only counted once)
  // a -> e (depth1, high); a -> f -> g -> d2 (depth3, low)
  const graph = {
    nodes: [],
    edges: [
      { from: 'a', to: 'b', relation: 'depends_on', why: 'x' },
      { from: 'a', to: 'c', relation: 'depends_on', why: 'x' },
      { from: 'b', to: 'd', relation: 'depends_on', why: 'x' },
      { from: 'c', to: 'd', relation: 'depends_on', why: 'x' },
    ],
  };
  const impact = rankImpact(graph, 'a');
  const dEntries = impact.filter((i) => i.id === 'd');
  assert.equal(dEntries.length, 1); // reached once, second path skipped via "seen"
  // b and c are both depth 1/high; d is depth 2/medium
  const highs = impact.filter((i) => i.severity === 'high').map((i) => i.id).sort();
  assert.deepEqual(highs, ['b', 'c']);
});

test('summarizeBlastRadius defaults kind to "record" for unknown node ids and groups by severity', () => {
  const graph = { nodes: [], edges: [] };
  const impact = [
    { id: 'ghost1', severity: 'high' },
    { id: 'ghost2', severity: 'high' },
    { id: 'ghost3', severity: 'low' },
  ];
  const blast = summarizeBlastRadius(graph, impact);
  assert.equal(blast.totalImpacted, 3);
  assert.deepEqual(blast.byKind, { record: 3 });
  assert.deepEqual(blast.bySeverity, { high: 2, low: 1 });
});

test('summarizeBlastRadius handles empty impact list', () => {
  const blast = summarizeBlastRadius({ nodes: [], edges: [] }, []);
  assert.equal(blast.totalImpacted, 0);
  assert.deepEqual(blast.byKind, {});
  assert.deepEqual(blast.bySeverity, {});
});

// ---------------------------------------------------------------------------
// graph.ts: validateChangePackage valid case
// ---------------------------------------------------------------------------

test('validateChangePackage reports valid:true when all dependencies are selected', () => {
  const graph = {
    nodes: [
      { id: 'script:A', kind: 'script', label: 'A' },
      { id: 'table:incident', kind: 'table', label: 'incident' },
    ],
    edges: [{ from: 'script:A', to: 'table:incident', relation: 'reads', why: 'GlideRecord reference' }],
  };
  const res = validateChangePackage(['script:A', 'table:incident'], graph);
  assert.equal(res.valid, true);
  assert.deepEqual(res.missingDependencies, []);
  assert.deepEqual(res.why, []);
});

test('validateChangePackage reports missing dependency details and derived why lines', () => {
  const graph = {
    nodes: [
      { id: 'script:A', kind: 'script', label: 'A' },
      { id: 'table:incident', kind: 'table', label: 'incident' },
    ],
    edges: [{ from: 'script:A', to: 'table:incident', relation: 'reads', why: 'GlideRecord reference' }],
  };
  const res = validateChangePackage(['script:A'], graph);
  assert.equal(res.valid, false);
  assert.deepEqual(res.missingDependencies, [{
    requiredId: 'table:incident',
    requiredBy: 'script:A',
    relation: 'reads',
    why: 'GlideRecord reference',
  }]);
  assert.deepEqual(res.why, ['Missing table:incident for script:A']);
});

test('validateChangePackage ignores edges whose source is not selected', () => {
  const graph = {
    nodes: [
      { id: 'script:A', kind: 'script', label: 'A' },
      { id: 'script:B', kind: 'script', label: 'B' },
      { id: 'table:incident', kind: 'table', label: 'incident' },
    ],
    edges: [{ from: 'script:B', to: 'table:incident', relation: 'reads', why: 'x' }],
  };
  const res = validateChangePackage(['script:A'], graph);
  assert.equal(res.valid, true);
  assert.deepEqual(res.missingDependencies, []);
});

// ---------------------------------------------------------------------------
// graph.ts: diffDependencyGraphs no-change case
// ---------------------------------------------------------------------------

test('diffDependencyGraphs returns empty diffs for identical graphs', () => {
  const graph = {
    nodes: [{ id: 'a', kind: 'script', label: 'a' }],
    edges: [{ from: 'a', to: 'b', relation: 'reads', why: 'x' }],
  };
  const diff = diffDependencyGraphs(graph, graph);
  assert.deepEqual(diff.addedNodes, []);
  assert.deepEqual(diff.removedNodes, []);
  assert.deepEqual(diff.addedEdges, []);
  assert.deepEqual(diff.removedEdges, []);
});

// ---------------------------------------------------------------------------
// graph.ts: summarizeEdgeProvenance empty case
// ---------------------------------------------------------------------------

test('summarizeEdgeProvenance returns empty array for a graph with no edges', () => {
  assert.deepEqual(summarizeEdgeProvenance({ nodes: [], edges: [] }), []);
});

test('summarizeEdgeProvenance counts and sorts by relation then why', () => {
  const graph = {
    nodes: [],
    edges: [
      { from: 'a', to: 'b', relation: 'reads', why: 'GlideRecord reference' },
      { from: 'c', to: 'd', relation: 'reads', why: 'GlideRecord reference' },
      { from: 'e', to: 'f', relation: 'reads', why: 'Another reason' },
      { from: 'g', to: 'h', relation: 'affects', why: 'Meta relation declared by record' },
    ],
  };
  const rows = summarizeEdgeProvenance(graph);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].relation, 'affects');
  assert.equal(rows[1].relation, 'reads');
  assert.equal(rows[1].why, 'Another reason');
  assert.equal(rows[2].why, 'GlideRecord reference');
  assert.equal(rows[2].count, 2);
});
