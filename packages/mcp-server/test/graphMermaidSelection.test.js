// SPDX-License-Identifier: GPL-3.0-or-later
//
// `renderDependencyGraphMermaid` keeps the `limit` most-referenced nodes and
// drops every edge with an endpoint outside that selection. It used to carry
// three "missing alias" guards that no input could reach (every selected node
// gets an alias, and edges were pre-filtered to the selection). Node's coverage
// merge drops a never-executed range nested in a block some other test process
// did not enter, so those dead guards surfaced as uncovered lines in some gate
// runs and not in others (443-444 and 466-467 of dist/analysis/graph.js).
//
// The guards are gone. What is left is pinned here by executing it: the one
// lookup that can miss (an edge leaving the selection) and the label fallback.
const test = require('node:test');
const assert = require('node:assert/strict');

const { renderDependencyGraphMermaid } = require('../dist/analysis/graph.js');

const CLASS_DEFS = [
  '  classDef script fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a;',
  '  classDef table fill:#dcfce7,stroke:#15803d,color:#14532d;',
  '  classDef api fill:#fed7aa,stroke:#c2410c,color:#7c2d12;',
  '  classDef update_set fill:#f3f4f6,stroke:#4b5563,color:#111827;',
  '  classDef record fill:#f3f4f6,stroke:#4b5563,color:#111827;',
  '  classDef scheduled_job fill:#ede9fe,stroke:#6d28d9,color:#4c1d95;',
  '  classDef external_scope fill:#fecaca,stroke:#b91c1c,color:#7f1d1d;',
];

test('edges with an endpoint outside the node limit are dropped, kept nodes still link', () => {
  // Inbound counts: table:incident 2, script:y 1, script:x 0. A limit of 2 keeps
  // incident and y, so both edges leaving script:x must disappear.
  const graph = {
    nodes: [
      { id: 'script:x', kind: 'script', label: 'X' },
      { id: 'script:y', kind: 'script', label: 'Y' },
      { id: 'table:incident', kind: 'table', label: 'incident' },
    ],
    edges: [
      { from: 'script:x', to: 'table:incident', relation: 'reads', why: '' },
      { from: 'script:x', to: 'script:y', relation: 'calls', why: '' },
      { from: 'script:y', to: 'table:incident', relation: 'writes', why: '' },
    ],
  };

  assert.equal(
    renderDependencyGraphMermaid(graph, 2),
    [
      'flowchart TD',
      '  n0["Y"]',
      '  n1["incident"]',
      '  n0 -->|writes| n1',
      ...CLASS_DEFS,
      '  class n0 script',
      '  class n1 table',
    ].join('\n')
  );
});

test('a node without a label is drawn with its id, and same-kind nodes share one class line', () => {
  const graph = {
    nodes: [
      { id: 'script:b', kind: 'script', label: '' },
      { id: 'script:a', kind: 'script', label: 'A' },
    ],
    edges: [{ from: 'script:a', to: 'script:b', relation: 'calls', why: '' }],
  };

  assert.equal(
    renderDependencyGraphMermaid(graph),
    [
      'flowchart TD',
      '  n0["A"]',
      '  n1["script:b"]',
      '  n0 -->|calls| n1',
      ...CLASS_DEFS,
      '  class n0,n1 script',
    ].join('\n')
  );
});
