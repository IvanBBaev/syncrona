// SPDX-License-Identifier: GPL-3.0-or-later
//
// Structural-parse hardening for three governance gates.
//
// GATE-2 (REV-102): check-tool-contract.js, check-docs-drift.js and
//   check-claims-drift.js each read the MCP tool set with a whole-file
//   `name: "..."` regex. That scan cannot tell a real declaration from a
//   `name: "..."` inside a comment, a description string, or an object literal
//   outside the schema array — any of which inflates the declared set and lets a
//   bogus contract entry (or a masked deletion) slip through. The fix scopes the
//   read to the `BASE_MCP_TOOLS` array via generate-tool-reference.js's
//   extractToolBlocks, falling back to the whole-file scan only when the array is
//   absent (bare `name:`-only fixtures).
//
// GATE-5 (REV-105): the "NN CLI commands" claim is parsed by name. A duplicate
//   registration (collapsed by the name set's dedup) or a command value the name
//   parser cannot read (a template literal) would silently drop an entry from the
//   count. An independent structural entry count, cross-checked against the parsed
//   names, turns that silent drop into a gate failure.
//
// GATE-6 (REV-106): check-docs-drift.js counted a tool as documented on ANY
//   whole-file mention, so a tool dropped from the command table still read as
//   "documented" while its name lingered in a sentence or changelog paragraph.
//   The fix scopes the mention to a declaration line (bullet, table row, heading).
const test = require('node:test');
const assert = require('node:assert/strict');

const contract = require('../scripts/check-tool-contract.js');
const docs = require('../scripts/check-docs-drift.js');
const claims = require('../scripts/check-claims-drift.js');

// A schema source with a `name: "..."` in a top-level comment, in a helper const
// OUTSIDE the array, and in a description STRING after the real name — none of
// which are genuine tool declarations. Also exercises single-quote and backtick
// name literals, which the double-quote-only scan of the past dropped.
const SCHEMA_WITH_DECOYS = [
  '// A stray reference in a comment: name: "comment_ghost"',
  'const HELPER = { name: "helper_ghost" };',
  'export const BASE_MCP_TOOLS = [',
  '  { name: "real_one", description: "mentions name: \\"nested_ghost\\" in prose" },',
  "  { name: 'real_two', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },",
  '  { name: `real_three` },',
  '];',
].join('\n');

const REAL_NAMES = ['real_one', 'real_two', 'real_three'];

// --- GATE-2: structural scoping to BASE_MCP_TOOLS -----------------------------

test('GATE-2: check-tool-contract reads only the array, not comments/strings/outsiders', () => {
  assert.deepEqual(contract.declaredToolNamesFromBlocks(SCHEMA_WITH_DECOYS), REAL_NAMES);
  assert.deepEqual(contract.parseDeclaredToolNames(SCHEMA_WITH_DECOYS), REAL_NAMES);
});

test('GATE-2: check-docs-drift reads only genuine tool declarations', () => {
  // parseToolNamesFromSchemas returns a sorted, de-duplicated set.
  assert.deepEqual(docs.parseToolNamesFromSchemas(SCHEMA_WITH_DECOYS), [...REAL_NAMES].sort());
});

test('GATE-2: check-claims-drift counts only genuine tool declarations', () => {
  assert.deepEqual(claims.parseToolNamesFromSchemas(SCHEMA_WITH_DECOYS), REAL_NAMES);
});

test('GATE-2: none of the decoy names ever enters the declared set', () => {
  for (const parsed of [
    contract.parseDeclaredToolNames(SCHEMA_WITH_DECOYS),
    docs.parseToolNamesFromSchemas(SCHEMA_WITH_DECOYS),
    claims.parseToolNamesFromSchemas(SCHEMA_WITH_DECOYS),
  ]) {
    assert.ok(!parsed.includes('comment_ghost'), 'a name in a comment is not a declaration');
    assert.ok(!parsed.includes('helper_ghost'), 'a name in an outside object is not a declaration');
    assert.ok(!parsed.includes('nested_ghost'), 'a name in a description string is not a declaration');
  }
});

test('GATE-2: the old whole-file scan WOULD have swallowed the decoys (contrast)', () => {
  // Proves the scoping does real work: a naive whole-file `name: "..."` scan sees
  // the comment and the outside-object ghosts the structural read rejects.
  const wholeFileHits = [...SCHEMA_WITH_DECOYS.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(wholeFileHits.includes('comment_ghost'));
  assert.ok(wholeFileHits.includes('helper_ghost'));
});

test('GATE-2: a bare `name:`-only source (no array) falls back to the whole-file scan', () => {
  // The structural reader returns null when BASE_MCP_TOOLS is absent, so the
  // fallback keeps existing bare-fixture tests (and every quote style) working.
  const bare = 'name: "a"\nname: \'b\'\nname: `c`';
  assert.equal(contract.declaredToolNamesFromBlocks(bare), null);
  assert.deepEqual(contract.parseDeclaredToolNames(bare), ['a', 'b', 'c']);
  assert.deepEqual(claims.parseToolNamesFromSchemas(bare), ['a', 'b', 'c']);
  assert.deepEqual(docs.parseToolNamesFromSchemas(bare), ['a', 'b', 'c']);
});

// --- GATE-5: independent CLI command entry count cross-check -------------------

const CLEAN_CLI_REGISTRY = [
  'const commands = [',
  '  { command: "download <scope>", handler: h },',
  '  { command: ["dev", "d"], handler: h },',
  "  { command: 'push', handler: h },",
  '];',
].join('\n');

test('GATE-5: a well-formed registry has entries === names', () => {
  const result = claims.crossCheckCliCommands(CLEAN_CLI_REGISTRY);
  assert.deepEqual(result, { ok: true, entries: 3, names: 3 });
});

test('GATE-5: a duplicate command registration is caught (dedup shrinks the name set)', () => {
  const dup = [
    'const commands = [',
    '  { command: "status", handler: h },',
    '  { command: "status", handler: h },',
    '];',
  ].join('\n');
  const result = claims.crossCheckCliCommands(dup);
  assert.equal(result.ok, false, 'two entries collapsing to one name must fail the cross-check');
  assert.equal(result.entries, 2);
  assert.equal(result.names, 1);
});

test('GATE-5: a command value the name parser cannot read (template literal) is caught', () => {
  // The entry regex accepts the backtick form the name regex deliberately rejects,
  // so a template-literal command still counts as an entry with no matching name.
  const tmpl = [
    'const commands = [',
    '  { command: "status", handler: h },',
    '  { command: `deploy`, handler: h },',
    '];',
  ].join('\n');
  const result = claims.crossCheckCliCommands(tmpl);
  assert.equal(result.ok, false, 'an unreadable command value must not vanish from the count');
  assert.equal(result.entries, 2);
  assert.equal(result.names, 1);
  assert.equal(claims.countCliCommandEntries(tmpl), 2);
  assert.deepEqual(claims.parseCliCommandNames(tmpl), ['status']);
});

// --- GATE-6: docs mention scoped to a declaration line ------------------------

test('GATE-6: a tool named only in prose is NOT counted as documented', () => {
  const prose = 'The push flow calls sync_push under the hood before uploading.';
  assert.equal(
    docs.mentionsToolName(prose, 'sync_push'),
    false,
    'a name mentioned in a sentence is not a table entry'
  );
});

test('GATE-6: a tool named on a bullet, table row, or heading IS counted', () => {
  assert.equal(docs.mentionsToolName('- `sync_push` pushes local files.', 'sync_push'), true);
  assert.equal(docs.mentionsToolName('| sync_push | Pushes files |', 'sync_push'), true);
  assert.equal(docs.mentionsToolName('### sync_push', 'sync_push'), true);
});

test('GATE-6: a declaration-line mention still respects word boundaries', () => {
  // A longer tool name on a declaration line must not satisfy a shorter one.
  assert.equal(
    docs.mentionsToolName('- `sync_push_extra` does more.', 'sync_push'),
    false,
    'sync_push_extra is a different tool, not a mention of sync_push'
  );
});
