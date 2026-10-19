// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTableFieldMarkdownDocs,
  renderScopeKnowledgeMarkdown,
} = require('../dist/analysis/scopeKnowledge.js');

const field = {
  field: 'u_owner',
  label: 'Owner',
  type: 'string',
  maxLength: '40',
  required: false,
  reference: '',
  defaultValue: "javascript:current.u_a || 'x';\ngs.getUserID()",
};

function tableRows(markdown) {
  return markdown.split('\n').filter((line) => line.startsWith('| u_owner'));
}

test('table field docs keep a pipe or line break in a default value inside its cell', () => {
  const [doc] = buildTableFieldMarkdownDocs({ tableFields: [{ tableName: 'x_t', fields: [field] }] });
  const rows = tableRows(doc.markdown);
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0],
    "| u_owner | Owner | string(40) | no | - | javascript:current.u_a \\|\\| 'x'; gs.getUserID() |"
  );
  assert.equal(doc.markdown.includes('\ngs.getUserID()'), false);
});

test('scope knowledge Markdown escapes dictionary cells and flattens scheduled-job excerpts', () => {
  const md = renderScopeKnowledgeMarkdown({
    scope: 'x_demo',
    entities: [
      {
        id: 'sysauto_script:1',
        name: 'Nightly',
        metadataType: 'scheduled_job',
        script: "var gr = new GlideRecord('x');\n# not a heading\ngr.query();",
      },
    ],
    tableFields: [{ tableName: 'x_t', fields: [{ ...field, label: 'Owner | lead' }] }],
  });
  assert.equal(tableRows(md)[0], '| u_owner | Owner \\| lead | string(40) | no | - |');
  assert.equal(md.split('\n').includes('# not a heading'), false);
  assert.ok(
    md.includes("- Script excerpt: var gr = new GlideRecord('x'); # not a heading gr.query();")
  );
});

test('scope knowledge Markdown keeps object headings and Mermaid edge labels on one line', () => {
  const md = renderScopeKnowledgeMarkdown({
    scope: 'x_demo',
    entities: [
      { id: 'sys_script:1', name: 'Rule\n## forged', metadataType: 'business_rule' },
      { id: 'sys_script_include:2', name: 'Helper', metadataType: 'script_include' },
    ],
    dependencies: [{ from: 'sys_script:1', to: 'sys_script_include:2', relation: 'calls\nend' }],
  });
  const lines = md.split('\n');
  assert.ok(lines.includes('### Rule ## forged'));
  assert.equal(lines.includes('## forged'), false);
  assert.ok(lines.some((line) => line.includes('-->|calls end|')));
  assert.equal(lines.some((line) => line.trim() === 'end|' || line.startsWith('end')), false);
});
