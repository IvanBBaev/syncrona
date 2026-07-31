// SPDX-License-Identifier: GPL-3.0-or-later
//
// scopePaths turns a model-supplied scope code — and, in two functions, a
// model-supplied table name or simulation id — into filesystem paths that other
// handlers then write to. Every fallback in it exists so a hostile or empty value
// cannot produce a path the caller did not intend, which makes the fallbacks the
// part most worth pinning: they are exactly the branches no happy-path test hits.
//
// The gate found them the hard way. `dist/scopePaths.js` sat at 97.73% line /
// 80.00% branch with the empty-scope fallback never executed, and the per-file
// floor was recorded at 99 — a floor no run could satisfy. Covering the fallbacks
// is the honest fix; lowering the floor to 97 would have been the other one.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  normalizeScopeCode,
  getScopeKnowledgePaths,
  getScopeDocsPaths,
  getScopeTableDocsPaths,
  getScopeTableDocPath,
  getTableDependencyReportPaths,
  getWorkflowSimulationReportPaths,
  resolveContainedPath,
} = require('../dist/scopePaths.js');

// scopePaths captures process.cwd() at module load, so every expected path below
// is built from the same base rather than from a literal.
const PROJECT_DIR = process.cwd();
const MCP_DIR = path.join(PROJECT_DIR, '.syncrona-mcp');

test('normalizeScopeCode folds case and collapses everything outside [a-z0-9_]', () => {
  assert.equal(normalizeScopeCode('X_My_Scope'), 'x_my_scope');
  // A run of unsafe characters collapses to a single underscore — the value is
  // about to become a filename, so path separators, spaces and dots must not
  // survive it.
  assert.equal(normalizeScopeCode('x my/scope..1'), 'x_my_scope_1');
  assert.equal(normalizeScopeCode('  x_padded  '), 'x_padded');
});

test('an empty or whitespace-only scope code becomes unknown_scope, not an empty path', () => {
  // The fallback the gate caught as unexecuted. Without it the joins below
  // produce ".syncrona-mcp/scopes/.md" — a dotfile that reads as a bug report
  // about the tool rather than about the missing scope.
  assert.equal(normalizeScopeCode(''), 'unknown_scope');
  assert.equal(normalizeScopeCode('   \t\n '), 'unknown_scope');
  // ...and a value made ENTIRELY of unsafe characters is not empty after trim, so
  // it takes the substitution path instead: underscores, never a bare directory.
  assert.equal(normalizeScopeCode('///'), '_');
});

test('the knowledge, docs and report paths all stay under .syncrona-mcp', () => {
  const knowledge = getScopeKnowledgePaths('X_My_Scope');
  assert.equal(knowledge.dir, path.join(MCP_DIR, 'scopes'));
  assert.equal(knowledge.markdownPath, path.join(MCP_DIR, 'scopes', 'x_my_scope.md'));
  assert.equal(knowledge.jsonPath, path.join(MCP_DIR, 'scopes', 'x_my_scope.json'));

  const docs = getScopeDocsPaths('X_My_Scope');
  assert.equal(docs.dir, path.join(MCP_DIR, 'docs', 'x_my_scope'));
  assert.equal(docs.readmePath, path.join(MCP_DIR, 'docs', 'x_my_scope', 'README.md'));

  const tableDocs = getScopeTableDocsPaths('X_My_Scope');
  assert.equal(tableDocs.dir, path.join(MCP_DIR, 'scopes', 'x_my_scope'));
  assert.equal(tableDocs.tablesDir, path.join(MCP_DIR, 'scopes', 'x_my_scope', 'tables'));

  const report = getTableDependencyReportPaths('X_My_Scope');
  assert.equal(report.dir, path.join(MCP_DIR, 'reports'));
  assert.equal(
    report.markdownPath,
    path.join(MCP_DIR, 'reports', 'x_my_scope-table-dependencies.md')
  );
  assert.equal(
    report.jsonPath,
    path.join(MCP_DIR, 'reports', 'x_my_scope-table-dependencies.json')
  );
});

test('an empty scope code still yields a named file rather than a dotfile', () => {
  const knowledge = getScopeKnowledgePaths('');
  assert.equal(path.basename(knowledge.markdownPath), 'unknown_scope.md');
  assert.equal(path.basename(getScopeDocsPaths('').dir), 'unknown_scope');
  assert.equal(
    path.basename(getTableDependencyReportPaths('').markdownPath),
    'unknown_scope-table-dependencies.md'
  );
});

test('a table name that normalizes to nothing usable falls back to "table"', () => {
  const scope = 'x_my_scope';
  assert.equal(
    getScopeTableDocPath(scope, 'x_my_scope_order'),
    path.join(MCP_DIR, 'scopes', scope, 'tables', 'x_my_scope_order.md')
  );
  // Leading and trailing underscores are stripped, so "!!!" -> "_" -> "" and the
  // literal fallback is what keeps the join from producing ".md".
  assert.equal(
    getScopeTableDocPath(scope, '!!!'),
    path.join(MCP_DIR, 'scopes', scope, 'tables', 'table.md')
  );
  assert.equal(
    getScopeTableDocPath(scope, '  '),
    // A blank name normalizes to "unknown_scope", which strips to itself: the
    // fallback is for names that are unsafe, not for names that are missing.
    path.join(MCP_DIR, 'scopes', scope, 'tables', 'unknown_scope.md')
  );
  // Surrounding separators are trimmed rather than left as a leading underscore.
  assert.equal(
    getScopeTableDocPath(scope, '/incident/'),
    path.join(MCP_DIR, 'scopes', scope, 'tables', 'incident.md')
  );
});

test('a missing or unusable simulation id falls back to "default"', () => {
  const named = getWorkflowSimulationReportPaths('X_My_Scope', 'Sim 1');
  assert.equal(
    named.markdownPath,
    path.join(MCP_DIR, 'reports', 'x_my_scope-workflow-simulation-sim_1.md')
  );
  assert.equal(
    named.jsonPath,
    path.join(MCP_DIR, 'reports', 'x_my_scope-workflow-simulation-sim_1.json')
  );

  // Two distinct fallbacks guard this one value: `simulationId || 'default'` for a
  // missing id, and the post-strip `|| 'default'` for one made only of separators.
  for (const id of ['', '___', '///']) {
    const fallback = getWorkflowSimulationReportPaths('X_My_Scope', id);
    assert.equal(
      fallback.markdownPath,
      path.join(MCP_DIR, 'reports', 'x_my_scope-workflow-simulation-default.md'),
      `simulation id ${JSON.stringify(id)} should fall back to "default"`
    );
  }
});

test('resolveContainedPath accepts a path inside the base and the base itself', () => {
  const base = path.join(MCP_DIR, 'docs', 'x_my_scope');
  assert.equal(resolveContainedPath(base, 'README.md'), path.join(base, 'README.md'));
  assert.equal(
    resolveContainedPath(base, path.join('tables', 'incident.md')),
    path.join(base, 'tables', 'incident.md')
  );
  // The `target !== resolvedBase` half of the guard: writing the base directory
  // itself is contained, so it must not be refused by the startsWith test.
  assert.equal(resolveContainedPath(base, '.'), base);
  // A path that climbs and comes back is judged after resolution, not by shape.
  assert.equal(resolveContainedPath(base, 'tables/../README.md'), path.join(base, 'README.md'));
});

test('resolveContainedPath refuses every way out of the base directory', () => {
  const base = path.join(MCP_DIR, 'docs', 'x_my_scope');
  for (const escape of [
    '../other_scope/README.md',
    '../../../../etc/passwd',
    path.join(path.sep, 'etc', 'passwd'),
    // A sibling whose name merely starts with the base name — the guard appends a
    // separator precisely so this is not mistaken for containment.
    path.join('..', `${path.basename(base)}_evil`, 'README.md'),
  ]) {
    assert.throws(
      () => resolveContainedPath(base, escape),
      /Refusing to write outside the docs bundle/,
      `${JSON.stringify(escape)} must be refused`
    );
  }
});
