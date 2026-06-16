const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getMetadataConfig,
  normalizeMetadataRow,
  buildMetadataUpdatePayload,
  extractReferencesFromScript,
  buildDependencyGraph,
  renderDependencyGraphMermaid,
  renderTableRelationshipMermaid,
  detectGraphCycles,
  summarizeGraphHotspots,
  rankImpact,
  summarizeBlastRadius,
  formatWhyLines,
  applyFindingSuppressions,
  parseAnalysisPolicy,
  resolveActiveSuppressions,
  buildRiskSummary,
  buildRiskSummaryWithPolicy,
  buildSymbolCrossReference,
  summarizeEdgeProvenance,
  pruneMetricsOlderThan,
  hashToolContract,
  diffDependencyGraphs,
  computeMetricTrend,
  buildFullScriptAnalysisReport,
  renderFullAnalysisMarkdown,
  buildDriftReport,
  validateChangePackage,
  extractSymbolsFromCode,
  buildSemanticIndexFromWorkspace,
  searchSemanticIndex,
  buildTableApiCoverageMatrix,
  rankMinimalFootprintTargets,
  buildScopeKnowledgeIndex,
  buildTableFieldMarkdownDocs,
  validateScopeKnowledgeIndex,
  renderScopeKnowledgeMarkdown,
  buildOnboardingPlan,
  analyzeArchitecture,
  analyzeSecurity,
  analyzePerformance,
  runAutonomousRemediation,
  summarizeMetricsWindows,
  summarizeMetrics,
  rotateAuditLogByLines,
  suggestAtfTest,
  diffInstanceVsLocal,
} = require('../dist/analysis.js');

test('metadata config and row normalization work for business rules', () => {
  const cfg = getMetadataConfig('business_rule');
  assert.equal(cfg.table, 'sys_script');

  const row = normalizeMetadataRow('business_rule', {
    sys_id: 'br1',
    name: 'BR Sample',
    active: true,
    collection: 'incident',
    script: 'var gr = new GlideRecord("incident");',
  });

  assert.equal(row.sysId, 'br1');
  assert.equal(row.name, 'BR Sample');
  assert.equal(row.tableName, 'incident');
});

test('metadata config and row normalization work for scheduled jobs', () => {
  const cfg = getMetadataConfig('scheduled_job');
  assert.equal(cfg.table, 'sys_trigger');

  const row = normalizeMetadataRow('scheduled_job', {
    sys_id: 'job1',
    name: 'Nightly Rebuild',
    active: 'true',
    script: 'gs.info("run");',
  });

  assert.equal(row.sysId, 'job1');
  assert.equal(row.name, 'Nightly Rebuild');
  assert.equal(row.active, true);
  assert.equal(row.script, 'gs.info("run");');
});

test('metadata config and row normalization work for ui scripts', () => {
  const cfg = getMetadataConfig('ui_script');
  assert.equal(cfg.table, 'sys_ui_script');

  const row = normalizeMetadataRow('ui_script', {
    sys_id: 'uis1',
    name: 'Client Helper',
    active: true,
    script: 'var ga = new GlideAjax("x_nuvo.HelperAjax");',
  });

  assert.equal(row.sysId, 'uis1');
  assert.equal(row.name, 'Client Helper');
  assert.equal(row.script, 'var ga = new GlideAjax("x_nuvo.HelperAjax");');
});

test('metadata config and row normalization work for ui actions', () => {
  const cfg = getMetadataConfig('ui_action');
  assert.equal(cfg.table, 'sys_ui_action');

  const row = normalizeMetadataRow('ui_action', {
    sys_id: 'uia1',
    name: 'Close Incident',
    table: 'incident',
    script: 'new IncidentActionUtil();',
  });

  assert.equal(row.sysId, 'uia1');
  assert.equal(row.name, 'Close Incident');
  assert.equal(row.tableName, 'incident');
  assert.equal(row.script, 'new IncidentActionUtil();');
});

test('metadata config and row normalization work for ui formatters', () => {
  const cfg = getMetadataConfig('ui_formatter');
  assert.equal(cfg.table, 'sys_ui_formatter');

  const row = normalizeMetadataRow('ui_formatter', {
    sys_id: 'uif1',
    name: 'formatter.incident.summary',
    table: 'incident',
    formatter: 'incident_summary_formatter',
  });

  assert.equal(row.sysId, 'uif1');
  assert.equal(row.name, 'formatter.incident.summary');
  assert.equal(row.tableName, 'incident');
  assert.equal(row.script, '');
});

test('metadata config and row normalization work for dictionary records', () => {
  const cfg = getMetadataConfig('dictionary');
  assert.equal(cfg.table, 'sys_dictionary');

  const row = normalizeMetadataRow('dictionary', {
    sys_id: 'dict1',
    name: 'x_demo_table',
    element: 'u_customer',
    internal_type: 'reference',
    reference: 'core_company',
  });

  assert.equal(row.sysId, 'dict1');
  assert.equal(row.name, 'u_customer');
  assert.equal(row.tableName, 'x_demo_table');
});

test('metadata update payload keeps only allowed fields', () => {
  const payload = buildMetadataUpdatePayload('client_script', {
    name: 'Client A',
    script: 'function onLoad(){}',
    active: true,
    sys_id: 'not_allowed',
  });

  assert.equal(payload.name, 'Client A');
  assert.equal(payload.script, 'function onLoad(){}');
  assert.equal(payload.active, true);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'sys_id'), false);
});

test('reference extraction finds tables, apis, and includes', () => {
  const refs = extractReferencesFromScript(
    'var gr = new GlideRecord("incident"); var rm = new sn_ws.RESTMessageV2("x_api", "get"); var u = new MyUtil();'
  );

  assert.deepEqual(refs.tables, ['incident']);
  assert.deepEqual(refs.apis, ['x_api']);
  assert.deepEqual(refs.includes, ['MyUtil']);
});

test('reference extraction finds script include names from GlideAjax calls', () => {
  const refs = extractReferencesFromScript(
    'var ga = new GlideAjax("x_nuvo.HelperAjax"); ga.addParam("sysparm_name", "run");'
  );

  assert.deepEqual(refs.includes, ['x_nuvo.HelperAjax']);
});

test('dependency graph and impact ranking return linked nodes', () => {
  const graph = buildDependencyGraph([
    {
      id: 'script:MainRule',
      name: 'MainRule',
      table: 'incident',
      script: 'new GlideRecord("task"); new HelperUtil();',
      updateSet: 'US001',
    },
  ]);

  assert.equal(graph.nodes.length > 1, true);
  assert.equal(graph.edges.length > 1, true);

  const impact = rankImpact(graph, 'script:MainRule');
  assert.equal(impact.length > 0, true);
  assert.equal(['high', 'medium', 'low'].includes(impact[0].severity), true);

  const blast = summarizeBlastRadius(graph, impact);
  assert.equal(blast.totalImpacted >= 1, true);
});

test('dependency graph supports meta relations with dedup', () => {
  const graph = buildDependencyGraph([
    {
      id: 'script:MetaRule',
      name: 'MetaRule',
      script: '',
      metaRelations: ['table:incident', { type: 'table', target: 'incident' }, 'include:SharedUtil'],
      affectsTables: ['task'],
      callsIncludes: ['SharedUtil'],
    },
  ]);

  const affectsIncident = graph.edges.filter((e) => e.to === 'table:incident' && e.relation === 'affects');
  const includeDeps = graph.edges.filter((e) => e.to === 'script:SharedUtil' && e.relation === 'depends_on');
  assert.equal(affectsIncident.length, 1);
  assert.equal(includeDeps.length, 1);
});

test('dependency graph marks scheduled_job nodes by kind', () => {
  const graph = buildDependencyGraph([
    {
      id: 'record:job1',
      name: 'Nightly Rebuild',
      metadataType: 'scheduled_job',
      script: 'new GlideRecord("incident");',
    },
  ]);

  const node = graph.nodes.find((item) => item.id === 'record:job1');
  assert.equal(Boolean(node), true);
  assert.equal(node.kind, 'scheduled_job');
});

test('dependency graph marks ui_script include relations as calls', () => {
  const graph = buildDependencyGraph([
    {
      id: 'record:ui1',
      name: 'UI Script 1',
      metadataType: 'ui_script',
      script: 'var ga = new GlideAjax("x_nuvo.HelperAjax");',
    },
  ]);

  const callEdge = graph.edges.find((edge) => edge.from === 'record:ui1' && edge.to === 'script:x_nuvo.HelperAjax');
  assert.equal(Boolean(callEdge), true);
  assert.equal(callEdge.relation, 'calls');
});

test('dependency graph marks ui_action table and include relations', () => {
  const graph = buildDependencyGraph([
    {
      id: 'record:uia1',
      name: 'Close Incident',
      metadataType: 'ui_action',
      tableName: 'incident',
      script: 'new IncidentActionUtil();',
    },
  ]);

  const tableEdge = graph.edges.find((edge) => edge.from === 'record:uia1' && edge.to === 'table:incident');
  const includeEdge = graph.edges.find((edge) => edge.from === 'record:uia1' && edge.to === 'script:IncidentActionUtil');
  assert.equal(Boolean(tableEdge), true);
  assert.equal(Boolean(includeEdge), true);
  assert.equal(tableEdge.relation, 'affects');
  assert.equal(includeEdge.relation, 'calls');
});

test('dependency graph emits cross-scope and global dependency edges', () => {
  const graph = buildDependencyGraph([
    {
      id: 'record:ui2',
      name: 'UI Script cross scope',
      metadataType: 'ui_script',
      scopeCode: 'x_nuvo_cs',
      script: [
        'var ga = new GlideAjax("x_other_app.HelperAjax");',
        'var gr = new GlideRecord("x_other_app_task");',
        'new GlobalUtil();',
      ].join('\n'),
    },
  ]);

  const externalNode = graph.nodes.find((n) => n.id === 'external_scope:x_other_app');
  const globalNode = graph.nodes.find((n) => n.id === 'external_scope:global');
  const crossEdges = graph.edges.filter((e) => e.from === 'record:ui2' && e.relation === 'cross_scope_dependency');
  const globalEdge = graph.edges.find((e) => e.from === 'record:ui2' && e.relation === 'global_dependency');

  assert.equal(Boolean(externalNode), true);
  assert.equal(externalNode.kind, 'external_scope');
  assert.equal(Boolean(globalNode), true);
  assert.equal(crossEdges.length >= 1, true);
  assert.equal(Boolean(globalEdge), true);
});

test('mermaid dependency renderer outputs flowchart and external scope styling', () => {
  const graph = {
    nodes: [
      { id: 'record:ui2', kind: 'script', label: 'UI Script cross scope' },
      { id: 'external_scope:x_other_app', kind: 'external_scope', label: 'x_other_app' },
    ],
    edges: [
      { from: 'record:ui2', to: 'external_scope:x_other_app', relation: 'cross_scope_dependency', why: 'cross scope' },
    ],
  };

  const mermaid = renderDependencyGraphMermaid(graph, 30);
  assert.equal(mermaid.includes('flowchart TD'), true);
  assert.equal(mermaid.includes('classDef external_scope'), true);
  assert.equal(mermaid.includes('cross_scope_dependency'), true);
});

test('table relationship mermaid renderer outputs erDiagram with inheritance and references', () => {
  const graph = {
    nodes: [
      { id: 'table:task', kind: 'table', label: 'task' },
      { id: 'table:incident', kind: 'table', label: 'incident' },
      { id: 'table:core_company', kind: 'table', label: 'core_company' },
    ],
    edges: [
      { from: 'table:task', to: 'table:incident', relation: 'depends_on', why: 'ServiceNow table inheritance' },
      { from: 'table:incident', to: 'table:core_company', relation: 'depends_on', why: 'Dictionary reference (u_company:reference)' },
    ],
  };

  const mermaid = renderTableRelationshipMermaid(graph, 40);
  assert.equal(mermaid.includes('erDiagram'), true);
  assert.equal(mermaid.includes('TASK ||--|| INCIDENT : inherits'), true);
  assert.equal(mermaid.includes('INCIDENT }o--|| CORE_COMPANY : references'), true);
});

test('cycle detection and hotspot ranking work', () => {
  const graph = {
    nodes: [
      { id: 'script:A', kind: 'script', label: 'A' },
      { id: 'script:B', kind: 'script', label: 'B' },
      { id: 'script:C', kind: 'script', label: 'C' },
    ],
    edges: [
      { from: 'script:A', to: 'script:B', relation: 'depends_on', why: 'x' },
      { from: 'script:B', to: 'script:C', relation: 'depends_on', why: 'x' },
      { from: 'script:C', to: 'script:A', relation: 'depends_on', why: 'x' },
    ],
  };

  const cycles = detectGraphCycles(graph);
  assert.equal(cycles.length > 0, true);

  const hotspots = summarizeGraphHotspots(graph, 2);
  assert.equal(hotspots.length, 2);
  assert.equal(hotspots[0].outDegree >= hotspots[1].outDegree, true);
});

test('drift report identifies missing and changed records', () => {
  const drift = buildDriftReport(
    [
      { key: 'a', hash: '1' },
      { key: 'b', hash: '2' },
    ],
    [
      { key: 'a', hash: '9' },
      { key: 'c', hash: '3' },
    ],
    'us1'
  );

  assert.equal(drift.summary.changed, 1);
  assert.equal(drift.summary.missingRemote, 1);
  assert.equal(drift.summary.missingLocal, 1);
});

test('change package validator reports missing dependencies', () => {
  const graph = {
    nodes: [
      { id: 'script:A', kind: 'script', label: 'A' },
      { id: 'table:incident', kind: 'table', label: 'incident' },
    ],
    edges: [
      { from: 'script:A', to: 'table:incident', relation: 'reads', why: 'GlideRecord reference' },
    ],
  };

  const res = validateChangePackage(['script:A'], graph);
  assert.equal(res.valid, false);
  assert.equal(res.missingDependencies.length, 1);
});

test('semantic index extracts and searches symbols', () => {
  const symbols = extractSymbolsFromCode(
    'function alpha(){}\nclass Beta {}\nconst gamma = 1;',
    'x.js'
  );
  assert.equal(symbols.length, 3);

  const filtered = searchSemanticIndex(symbols, 'bet');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].name, 'Beta');
});

test('semantic index builder scans workspace js/ts files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-semantic-'));
  fs.writeFileSync(path.join(tempDir, 'a.js'), 'function one(){}\nconst two = 2;');
  fs.mkdirSync(path.join(tempDir, 'sub'));
  fs.writeFileSync(path.join(tempDir, 'sub', 'b.ts'), 'class Three {}');

  const idx = buildSemanticIndexFromWorkspace(tempDir);
  const names = idx.map((s) => s.name).sort();
  assert.deepEqual(names, ['Three', 'one', 'two'].sort());
});

test('analysis packs return findings and remediation', () => {
  const script = [
    'gs.log("debug");',
    'var gr = new GlideRecord("incident");',
    'gr.addEncodedQuery("active=true^" + input);',
    'while (gr.next()) { var x = new GlideRecord("task"); }',
  ].join('\n');

  const arch = analyzeArchitecture(script);
  const sec = analyzeSecurity(script);
  const perf = analyzePerformance(script);

  assert.equal(arch.findings.length > 0, true);
  assert.equal(sec.findings.length > 0, true);
  assert.equal(perf.findings.length > 0, true);
  assert.deepEqual([...arch.why].sort(), arch.why);
  assert.deepEqual([...sec.why].sort(), sec.why);
  assert.deepEqual([...perf.why].sort(), perf.why);
});

test('formatWhyLines deduplicates and sorts explainability', () => {
  const lines = formatWhyLines([
    { id: 'b', message: 'two' },
    { id: 'a', message: 'one' },
    { id: 'b', message: 'two' },
  ]);
  assert.deepEqual(lines, ['a: one', 'b: two']);
});

test('finding suppression and weighted risk summary work together', () => {
  const findings = [
    { id: 'a', level: 'high', message: 'x', remediation: 'r' },
    { id: 'b', level: 'medium', message: 'y', remediation: 'r' },
    { id: 'c', level: 'low', message: 'z', remediation: 'r' },
  ];

  const suppression = applyFindingSuppressions(findings, ['b']);
  assert.equal(suppression.active.length, 2);
  assert.equal(suppression.suppressed.length, 1);

  const risk = buildRiskSummary(suppression.active);
  assert.equal(risk.score, 6);
  assert.equal(risk.distribution.high, 1);
  assert.equal(risk.distribution.medium, 0);
  assert.equal(risk.distribution.low, 1);
});

test('symbol cross-reference groups symbol usage across files', () => {
  const rows = buildSymbolCrossReference([
    { name: 'A', kind: 'function', file: '/x/a.js', line: 1 },
    { name: 'A', kind: 'const', file: '/x/b.js', line: 2 },
    { name: 'B', kind: 'class', file: '/x/b.js', line: 3 },
  ]);

  assert.equal(rows.length, 2);
  const a = rows.find((r) => r.name === 'A');
  assert.equal(a.occurrences, 2);
  assert.equal(a.fileCount, 2);
});

test('edge provenance summary is deterministic', () => {
  const graph = {
    nodes: [],
    edges: [
      { from: 'a', to: 'b', relation: 'reads', why: 'GlideRecord reference' },
      { from: 'c', to: 'd', relation: 'reads', why: 'GlideRecord reference' },
      { from: 'a', to: 'x', relation: 'affects', why: 'Meta relation declared by record' },
    ],
  };

  const rows = summarizeEdgeProvenance(graph);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].relation, 'affects');
  assert.equal(rows[1].count, 2);
});

test('metrics pruning keeps events after cutoff', () => {
  const pruned = pruneMetricsOlderThan([
    { tool: 'a', ok: true, latencyMs: 1, timestamp: '2025-01-01T00:00:00.000Z' },
    { tool: 'a', ok: true, latencyMs: 1, timestamp: '2026-01-01T00:00:00.000Z' },
  ], '2025-06-01T00:00:00.000Z');

  assert.equal(pruned.length, 1);
  assert.equal(pruned[0].timestamp, '2026-01-01T00:00:00.000Z');
});

test('tool contract hash is stable regardless of order', () => {
  const a = hashToolContract(['b', 'a', 'c']);
  const b = hashToolContract(['c', 'b', 'a']);
  assert.equal(a, b);
});

test('full analysis report provides suppressions and risk summaries', () => {
  const script = [
    'gs.log("debug");',
    'var gr = new GlideRecord("incident");',
    'gr.addEncodedQuery("active=true^" + input);',
  ].join('\n');

  const report = buildFullScriptAnalysisReport(script, {
    suppressedIds: ['arch.logging.noise'],
  });

  assert.equal(report.findings.active.length >= 1, true);
  assert.equal(report.findings.suppressed.length, 1);
  assert.equal(report.risk.total.score >= report.risk.active.score, true);
});

test('analysis policy parser applies defaults and custom values', () => {
  const parsed = parseAnalysisPolicy({
    weights: { high: 7 },
    suppressions: [{ id: 'a' }, { id: 'b', expiresAt: '2030-01-01T00:00:00.000Z' }],
  });

  assert.equal(parsed.weights.high, 7);
  assert.equal(parsed.weights.medium, 3);
  assert.equal(parsed.weights.low, 1);
  assert.equal(parsed.suppressions.length, 2);
});

test('suppression expiry resolution keeps only active suppressions', () => {
  const active = resolveActiveSuppressions([
    { id: 'a' },
    { id: 'b', expiresAt: '2030-01-01T00:00:00.000Z' },
    { id: 'c', expiresAt: '2020-01-01T00:00:00.000Z' },
  ], '2026-01-01T00:00:00.000Z');

  assert.deepEqual(active.sort(), ['a', 'b']);
});

test('policy-aware risk summary uses custom weights', () => {
  const risk = buildRiskSummaryWithPolicy([
    { id: 'a', level: 'high', message: 'x', remediation: 'r' },
    { id: 'b', level: 'medium', message: 'y', remediation: 'r' },
  ], { high: 10, medium: 2, low: 1 });

  assert.equal(risk.score, 12);
});

test('graph diff reports deterministic added/removed sections', () => {
  const diff = diffDependencyGraphs(
    {
      nodes: [{ id: 'a', kind: 'script', label: 'a' }],
      edges: [{ from: 'a', to: 'b', relation: 'reads', why: 'x' }],
    },
    {
      nodes: [{ id: 'a', kind: 'script', label: 'a' }, { id: 'c', kind: 'table', label: 'c' }],
      edges: [{ from: 'a', to: 'c', relation: 'affects', why: 'y' }],
    }
  );

  assert.deepEqual(diff.addedNodes, ['c']);
  assert.deepEqual(diff.removedNodes, []);
  assert.equal(diff.addedEdges.length, 1);
  assert.equal(diff.removedEdges.length, 1);
});

test('metric trend computes deltas between windows', () => {
  const trend = computeMetricTrend(
    { failureRatio: 0.1, avgLatencyMs: 20 },
    { failureRatio: 0.3, avgLatencyMs: 35 }
  );

  assert.equal(Math.abs(trend.failureRatioDelta - 0.2) < 1e-9, true);
  assert.equal(trend.avgLatencyDeltaMs, 15);
});

test('full analysis markdown renderer is deterministic', () => {
  const report = buildFullScriptAnalysisReport('gs.log("x");', {
    policy: {
      weights: { high: 9, medium: 4, low: 2 },
      suppressions: [{ id: 'arch.logging.noise', expiresAt: '2030-01-01T00:00:00.000Z' }],
    },
    nowIso: '2026-01-01T00:00:00.000Z',
  });

  const md = renderFullAnalysisMarkdown(report);
  assert.equal(md.startsWith('# Full Script Analysis'), true);
  assert.equal(md.includes('Suppressed findings: 1'), true);
});

test('autonomous remediation supports dry-run and apply paths', () => {
  const script = 'gs.log("test");';
  const dry = runAutonomousRemediation(script, { apply: true, dryRun: true });
  assert.equal(dry.applied, false);

  const applied = runAutonomousRemediation(script, { apply: true, dryRun: false });
  assert.equal(applied.applied, true);
  assert.equal(String(applied.patchedScript).includes('gs.info('), true);
});

test('metric summarization groups tool stats and keeps timeline', () => {
  const summary = summarizeMetrics([
    { tool: 'a', ok: true, latencyMs: 10, timestamp: 't1' },
    { tool: 'a', ok: false, latencyMs: 30, timestamp: 't2' },
    { tool: 'b', ok: true, latencyMs: 50, timestamp: 't3' },
  ]);

  assert.equal(summary.tools.a.total, 2);
  assert.equal(summary.tools.a.ok, 1);
  assert.equal(summary.tools.a.error, 1);
  assert.equal(summary.tools.b.total, 1);
  assert.equal(summary.timeline.length, 3);
  assert.equal(Array.isArray(summary.windows), true);
  assert.equal(summary.windows.length > 0, true);
});

test('metrics window summary includes failure ratio and averages', () => {
  const windows = summarizeMetricsWindows([
    { tool: 'a', ok: true, latencyMs: 10, timestamp: 't1' },
    { tool: 'a', ok: false, latencyMs: 30, timestamp: 't2' },
    { tool: 'b', ok: true, latencyMs: 50, timestamp: 't3' },
  ], 2);

  assert.equal(windows.length, 2);
  assert.equal(windows[0].total, 2);
  assert.equal(windows[0].failureRatio, 0.5);
});

test('audit retention rotates logs over threshold', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-audit-'));
  const file = path.join(tempDir, 'audit.log');
  fs.writeFileSync(file, ['1', '2', '3', '4', '5'].join('\n') + '\n');

  const res = rotateAuditLogByLines(file, 4, 2);
  assert.equal(res.rotated, true);
  assert.equal(res.beforeLines, 5);
  assert.equal(res.afterLines, 2);

  const kept = fs.readFileSync(file, 'utf-8').trim().split('\n');
  assert.deepEqual(kept, ['4', '5']);
});

test('table api coverage matrix returns metadata coverage rows', () => {
  const rows = buildTableApiCoverageMatrix();
  assert.equal(rows.length >= 6, true);
  assert.equal(rows.every((r) => r.via === 'table_api'), true);
  assert.equal(rows.every((r) => Array.isArray(r.supportedOperations)), true);
});

test('minimal-footprint planner ranks task-relevant targets first', () => {
  const graph = {
    nodes: [
      { id: 'script:IncidentHandler', kind: 'script', label: 'IncidentHandler' },
      { id: 'script:TaskUtil', kind: 'script', label: 'TaskUtil' },
      { id: 'table:incident', kind: 'table', label: 'incident' },
    ],
    edges: [
      { from: 'script:IncidentHandler', to: 'table:incident', relation: 'reads', why: 'x' },
      { from: 'script:TaskUtil', to: 'table:incident', relation: 'reads', why: 'x' },
    ],
  };

  const ranked = rankMinimalFootprintTargets('fix incident handler', graph, 2);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].id, 'script:IncidentHandler');
});

test('minimal-footprint planner ranks multi-word task input', () => {
  const graph = {
    nodes: [
      { id: 'script:ValidateIncident', kind: 'script', label: 'ValidateIncident' },
      { id: 'script:TaskUtil', kind: 'script', label: 'TaskUtil' },
    ],
    edges: [],
  };

  const ranked = rankMinimalFootprintTargets('fix validate incident', graph, 1);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, 'script:ValidateIncident');
});

test('scope knowledge index validates and markdown renders required sections', () => {
  const graph = {
    nodes: [
      { id: 'script:A', kind: 'script', label: 'A' },
      { id: 'table:task', kind: 'table', label: 'task' },
    ],
    edges: [
      { from: 'script:A', to: 'table:incident', relation: 'reads', why: 'x' },
      { from: 'script:A', to: 'table:task', relation: 'belongs_to', why: 'x' },
      { from: 'table:task', to: 'table:incident', relation: 'depends_on', why: 'ServiceNow table inheritance' },
    ],
  };

  const index = buildScopeKnowledgeIndex({
    scope: 'x_nuvo_sync',
    entities: [{ id: 'script:A', name: 'A' }],
    graph,
    recommendedEditTargets: [{ id: 'script:A', label: 'A', risk: 'low' }],
  });

  const valid = validateScopeKnowledgeIndex(index);
  assert.equal(valid.valid, true);

  const md = renderScopeKnowledgeMarkdown(index);
  assert.equal(md.includes('## Scope Overview'), true);
  assert.equal(md.includes('flowchart TD'), true);
  assert.equal(md.includes('## Table Relationship Diagram'), true);
  assert.equal(md.includes('erDiagram'), true);
  assert.equal(md.includes('## Table-to-Table Impact Paths (with confidence)'), true);
  assert.equal(md.includes('## Where To Modify'), true);
});

test('scope knowledge markdown renders scheduled job per-object details', () => {
  const graph = {
    nodes: [
      { id: 'record:job1', kind: 'scheduled_job', label: 'Nightly Rebuild' },
      { id: 'table:incident', kind: 'table', label: 'incident' },
    ],
    edges: [
      { from: 'record:job1', to: 'table:incident', relation: 'reads', why: 'GlideRecord reference' },
    ],
  };

  const index = buildScopeKnowledgeIndex({
    scope: 'x_nuvo_sync',
    entities: [{
      id: 'record:job1',
      name: 'Nightly Rebuild',
      metadataType: 'scheduled_job',
      runType: 'daily',
      runPeriod: '1',
      runTime: '02:00:00',
      script: 'var gr = new GlideRecord("incident");',
    }],
    graph,
  });

  const md = renderScopeKnowledgeMarkdown(index);
  assert.equal(md.includes('## Scheduled Jobs'), true);
  assert.equal(md.includes('### Nightly Rebuild'), true);
  assert.equal(md.includes('run_type=daily'), true);
  assert.equal(md.includes('Affected tables: incident'), true);
  assert.equal(md.includes('Script excerpt: var gr = new GlideRecord("incident");'), true);
});

test('scope knowledge markdown renders external dependency section', () => {
  const graph = {
    nodes: [
      { id: 'record:ui2', kind: 'script', label: 'UI Script cross scope' },
      { id: 'external_scope:x_other_app', kind: 'external_scope', label: 'x_other_app' },
      { id: 'external_scope:global', kind: 'external_scope', label: 'global' },
    ],
    edges: [
      { from: 'record:ui2', to: 'external_scope:x_other_app', relation: 'cross_scope_dependency', why: 'cross scope' },
      { from: 'record:ui2', to: 'external_scope:global', relation: 'global_dependency', why: 'global include' },
    ],
  };

  const index = buildScopeKnowledgeIndex({
    scope: 'x_nuvo_sync',
    entities: [{ id: 'record:ui2', name: 'UI Script cross scope' }],
    graph,
  });

  const md = renderScopeKnowledgeMarkdown(index);
  assert.equal(md.includes('## External Dependencies'), true);
  assert.equal(md.includes('External scope x_other_app: 1 dependency edge(s) [risk: medium]'), true);
  assert.equal(md.includes('Global scope dependencies: 1 edge(s) [risk: medium]'), true);
});

test('scope knowledge markdown renders impact mini-diagrams for major objects', () => {
  const graph = {
    nodes: [
      { id: 'record:br1', kind: 'script', label: 'Validate Incident' },
      { id: 'record:si1', kind: 'script', label: 'IncidentUtils' },
      { id: 'table:incident', kind: 'table', label: 'incident' },
      { id: 'table:task', kind: 'table', label: 'task' },
    ],
    edges: [
      { from: 'record:br1', to: 'table:incident', relation: 'reads', why: 'GlideRecord reference' },
      { from: 'record:br1', to: 'record:si1', relation: 'calls', why: 'Script Include call' },
      { from: 'record:si1', to: 'table:task', relation: 'writes', why: 'GlideRecord update' },
    ],
  };

  const index = buildScopeKnowledgeIndex({
    scope: 'x_nuvo_sync',
    entities: [
      { id: 'record:br1', name: 'Validate Incident', metadataType: 'business_rule' },
      { id: 'record:si1', name: 'IncidentUtils', metadataType: 'script_include' },
    ],
    graph,
  });

  const md = renderScopeKnowledgeMarkdown(index);
  assert.equal(md.includes('## Impact Mini-Diagrams'), true);
  assert.equal(md.includes('### Validate Incident'), true);
  assert.equal(md.includes('### IncidentUtils'), true);
  assert.equal(md.includes('flowchart LR'), true);
});

test('scope knowledge markdown renders grouped dictionary field inventory', () => {
  const graph = {
    nodes: [
      { id: 'table:x_demo_table', kind: 'table', label: 'x_demo_table' },
    ],
    edges: [],
  };

  const index = buildScopeKnowledgeIndex({
    scope: 'x_nuvo_sync',
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
      {
        id: 'record:dict2',
        name: 'u_notes',
        metadataType: 'dictionary',
        tableName: 'x_demo_table',
        fieldName: 'u_notes',
        columnLabel: 'Notes',
        internalType: 'string',
        maxLength: '255',
        mandatory: false,
        reference: '',
      },
    ],
    graph,
  });

  assert.equal(Array.isArray(index.tableFields), true);
  assert.equal(index.tableFields.length, 1);

  const md = renderScopeKnowledgeMarkdown(index);
  assert.equal(md.includes('## Dictionary Field Inventory'), true);
  assert.equal(md.includes('### x_demo_table'), true);
  assert.equal(md.includes('| u_customer | Customer | reference(40) | yes | core_company |'), true);
  assert.equal(md.includes('| u_notes | Notes | string(255) | no | - |'), true);
  assert.equal(md.includes('## Referenced Tables Index'), true);
  assert.equal(md.includes('| core_company | external | 1 | 1 | 0 |'), true);
});

test('scope knowledge index keeps referenced table index for out-of-scope targets', () => {
  const graph = {
    nodes: [
      { id: 'table:x_demo_table', kind: 'table', label: 'x_demo_table' },
      { id: 'table:core_company', kind: 'table', label: 'core_company' },
    ],
    edges: [
      { from: 'table:x_demo_table', to: 'table:core_company', relation: 'depends_on', why: 'Dictionary reference (u_customer:reference)' },
    ],
  };

  const index = buildScopeKnowledgeIndex({
    scope: 'x_nuvo_sync',
    entities: [
      {
        id: 'record:dict1',
        name: 'u_customer',
        metadataType: 'dictionary',
        tableName: 'x_demo_table',
        fieldName: 'u_customer',
        internalType: 'reference',
        reference: 'core_company',
      },
    ],
    graph,
  });

  assert.equal(Array.isArray(index.referencedTables), true);
  assert.equal(index.referencedTables.length > 0, true);
  assert.equal(index.referencedTables[0].targetTable, 'core_company');
  assert.equal(index.referencedTables[0].inScope, false);
});

test('table field markdown docs are generated per table', () => {
  const index = {
    tableFields: [
      {
        tableName: 'x_demo_table',
        fields: [
          {
            field: 'u_customer',
            label: 'Customer',
            type: 'reference',
            maxLength: '40',
            required: true,
            reference: 'core_company',
            defaultValue: '',
          },
        ],
      },
    ],
  };

  const docs = buildTableFieldMarkdownDocs(index);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].tableName, 'x_demo_table');
  assert.equal(docs[0].markdown.includes('# Table: x_demo_table'), true);
  assert.equal(docs[0].markdown.includes('## Fields'), true);
  assert.equal(
    docs[0].markdown.includes('| u_customer | Customer | reference(40) | yes | core_company | - |'),
    true
  );
});

test('onboarding plan reports readiness when prerequisites are present', () => {
  const plan = buildOnboardingPlan({
    hasEnv: true,
    hasGuardrails: true,
    hasScopeKnowledge: true,
  });

  assert.equal(plan.readyForFirstChange, true);
  assert.equal(plan.completed, 3);
  assert.equal(Array.isArray(plan.steps), true);
});

test('suggestAtfTest detects Class.create methods and builds skeleton', () => {
  const script = [
    'var IncidentUtils = Class.create();',
    'IncidentUtils.prototype = {',
    '  initialize: function() {},',
    '  getActive: function(table) { return new GlideRecord(table); },',
    '  _private: function() {},',
    '  type: "IncidentUtils"',
    '};',
  ].join('\n');

  const suggestion = suggestAtfTest({ scriptIncludeName: 'IncidentUtils', script });

  assert.equal(suggestion.className, 'IncidentUtils');
  assert.equal(suggestion.isClass, true);
  const methodNames = suggestion.methods.map((m) => m.name).sort();
  assert.deepEqual(methodNames, ['getActive']);
  assert.equal(suggestion.methods[0].args[0], 'table');
  assert.equal(suggestion.atfTestScript.includes('var subject = new IncidentUtils();'), true);
  assert.equal(suggestion.atfTestScript.includes('subject.getActive('), true);
  assert.equal(suggestion.atfTestScript.includes('assertEqual('), true);
  assert.equal(suggestion.instructions.length > 0, true);
});

test('suggestAtfTest handles ES6 class methods', () => {
  const script = [
    'class Helper {',
    '  constructor() {}',
    '  compute(a, b) { return a + b; }',
    '}',
  ].join('\n');

  const suggestion = suggestAtfTest({ scriptIncludeName: 'Helper', script });
  assert.equal(suggestion.className, 'Helper');
  const names = suggestion.methods.map((m) => m.name);
  assert.equal(names.includes('compute'), true);
  assert.equal(names.includes('constructor'), false);
});

test('suggestAtfTest falls back to script include name when no class found', () => {
  const suggestion = suggestAtfTest({ scriptIncludeName: 'Loose', script: 'var x = 1;' });
  assert.equal(suggestion.className, 'Loose');
  assert.equal(suggestion.isClass, false);
  assert.equal(suggestion.methods.length, 0);
  assert.equal(suggestion.atfTestScript.includes('No public methods detected'), true);
});

test('diffInstanceVsLocal classifies changed, added, and removed records', () => {
  const report = diffInstanceVsLocal({
    local: [
      { name: 'Same', value: 'line1\nline2' },
      { name: 'Changed', value: 'local v2\nshared' },
      { name: 'LocalOnly', value: 'new local content' },
    ],
    instance: [
      { name: 'Same', value: 'line1\nline2' },
      { name: 'Changed', value: 'instance v1\nshared' },
      { name: 'InstanceOnly', value: 'remote content' },
    ],
  });

  assert.equal(report.summary.unchanged, 1);
  assert.equal(report.summary.changed, 1);
  assert.equal(report.summary.added, 1);
  assert.equal(report.summary.removed, 1);
  assert.equal(report.changed[0].name, 'Changed');
  assert.equal(report.changed[0].addedLines, 1);
  assert.equal(report.changed[0].removedLines, 1);
  assert.equal(report.added[0].name, 'LocalOnly');
  assert.equal(report.removed[0].name, 'InstanceOnly');
});

test('diffInstanceVsLocal emits race-condition warning when instance is newer', () => {
  const report = diffInstanceVsLocal({
    local: [{ name: 'Risky', value: 'local', updatedOn: '2026-01-01 00:00:00' }],
    instance: [{ name: 'Risky', value: 'remote', updatedOn: '2026-02-01 00:00:00' }],
    localSyncedAt: '2026-01-15 00:00:00',
  });

  assert.equal(report.changed.length, 1);
  assert.equal(typeof report.changed[0].raceWarning, 'string');
  assert.equal(report.changed[0].raceWarning.includes('overwrite'), true);
});

test('diffInstanceVsLocal treats whitespace-only trailing differences as unchanged', () => {
  const report = diffInstanceVsLocal({
    local: [{ name: 'Trim', value: 'content   ' }],
    instance: [{ name: 'Trim', value: 'content' }],
  });

  assert.equal(report.summary.unchanged, 1);
  assert.equal(report.summary.changed, 0);
});

