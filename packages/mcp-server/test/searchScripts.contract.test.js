// SPDX-License-Identifier: GPL-3.0-or-later
// REV-198: sn_search_scripts silently dropped any table name it did not recognise, so
// `tables: ["sys_ui_action"]` — a real script-bearing table that is simply not one of the
// six this tool covers — searched NOTHING and still answered `searchComplete: true,
// matchCount: 0`. That is the "clean search" verdict a caller acts on ("this identifier is
// unused, safe to delete"), reached from a search that never ran.
//
// The fix has two halves that must stay in step: the handler reports unknown names in
// `unknownTables` and withholds `searchComplete`, and the input schema enumerates the
// supported names so a client can avoid the mistake up front. toolSchemas.ts is
// deliberately dependency-free (the tool-contract gate and generate-tool-reference.js load
// it for its literals alone) so the enum is spelled out there rather than imported —
// which is exactly the kind of duplication that drifts. This test is what stops it.
const test = require('node:test');
const assert = require('node:assert/strict');

const { MCP_TOOLS } = require('../dist/toolSchemas.js');
const { SCRIPT_SEARCH_TABLES } = require('../dist/handlers/insightShared.js');

const searchScripts = MCP_TOOLS.find((tool) => tool.name === 'sn_search_scripts');

test('REV-198: sn_search_scripts is still in the tool contract', () => {
  assert.ok(searchScripts, 'sn_search_scripts must exist');
});

test('REV-198: the tables enum equals the tables the handler can actually search', () => {
  const declared = searchScripts.inputSchema.properties.tables.items.enum;
  assert.deepEqual(
    [...declared].sort(),
    Object.keys(SCRIPT_SEARCH_TABLES).sort(),
    'the schema enum and SCRIPT_SEARCH_TABLES have drifted: a name in the enum that the ' +
      'handler cannot search comes back in unknownTables, and a searchable table missing ' +
      'from the enum is undiscoverable'
    );
});

test('REV-198: the tables description tells the caller unknown names are not ignored', () => {
  const description = searchScripts.inputSchema.properties.tables.description;
  assert.match(description, /unknownTables/);
  assert.match(description, /searchComplete/);
});
