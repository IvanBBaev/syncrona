// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { extractToolBlocks, parseToolBlock } = require('../scripts/generate-tool-reference.js');

const HANDLERS_DIR = path.resolve(__dirname, '..', 'src', 'handlers');
const TOOL_SCHEMAS_SOURCE = path.resolve(__dirname, '..', 'src', 'toolSchemas.ts');

// A tool that refuses to run without `confirmDestructive=true` but never declares the
// parameter in its input schema is unusable through MCP: the client strips the unknown
// argument and the call fails forever. This file is the gate that keeps the runtime
// guard and the declared schema from drifting apart in either direction.

// Every handler module is a single `switch (toolName)` whose cases sit at four spaces
// of indentation and end at a `default:` arm. That fixed shape is what makes a textual
// scan exact here; the "one case per declared tool" test below fails loudly if a nested
// switch or a re-indented case ever breaks the assumption.
const CASE_LINE = /^ {4}case "([a-z0-9_]+)":/gm;
const CASE_TERMINATOR = /^ {4}(?:case "|default:)/m;
const NESTED_CASE = /^ {4}case "/m;
const FUNCTION_DECL = /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)\(/gm;
const CALL_EXPRESSION = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

// The gate is a read of the incoming argument. Prose that merely names the parameter --
// an error message, a comment -- is not a guard and must not be counted as one.
const GATE_MARKER = 'args.confirmDestructive';

function sliceCaseBodies(source) {
  const bodies = new Map();
  for (const match of source.matchAll(CASE_LINE)) {
    const rest = source.slice(match.index + match[0].length);
    const end = rest.search(CASE_TERMINATOR);
    bodies.set(match[1], end === -1 ? rest : rest.slice(0, end));
  }
  return bodies;
}

// A case may gate inline, or delegate to a handler that gates on its behalf --
// `sync_run_atf_tests` hands off to `handleRunAtfTests` in another module. Dispatcher
// functions are excluded: they physically contain every case body, so counting them
// would mark each of their tools as gated.
function parseGatingFunctions(source) {
  const gating = new Set();
  const declarations = [...source.matchAll(FUNCTION_DECL)];
  for (let i = 0; i < declarations.length; i += 1) {
    const start = declarations[i].index;
    const end = i + 1 < declarations.length ? declarations[i + 1].index : source.length;
    const body = source.slice(start, end);
    if (body.includes(GATE_MARKER) && !NESTED_CASE.test(body)) {
      gating.add(declarations[i][1]);
    }
  }
  return gating;
}

function collectGatedTools(sources) {
  const gatingFunctions = new Set();
  for (const source of sources) {
    for (const name of parseGatingFunctions(source)) {
      gatingFunctions.add(name);
    }
  }

  const gated = new Set();
  for (const source of sources) {
    for (const [tool, body] of sliceCaseBodies(source)) {
      if (body.includes(GATE_MARKER)) {
        gated.add(tool);
        continue;
      }
      for (const call of body.matchAll(CALL_EXPRESSION)) {
        if (gatingFunctions.has(call[1])) {
          gated.add(tool);
        }
      }
    }
  }
  return [...gated].sort();
}

function collectHandlerCases(sources) {
  const tools = [];
  for (const source of sources) {
    tools.push(...sliceCaseBodies(source).keys());
  }
  return tools.sort();
}

function parseSchemaTools(raw) {
  return extractToolBlocks(raw).map((block) => parseToolBlock(block).tool);
}

function schemaConfirmDestructive(tool) {
  const properties = tool && tool.inputSchema && tool.inputSchema.properties;
  if (!properties || typeof properties !== 'object') {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(properties, 'confirmDestructive')
    ? properties.confirmDestructive
    : undefined;
}

function readHandlerSources() {
  return fs
    .readdirSync(HANDLERS_DIR)
    .filter((file) => file.endsWith('.ts'))
    .sort()
    .map((file) => fs.readFileSync(path.join(HANDLERS_DIR, file), 'utf8'));
}

function dispatcher(name, cases) {
  const arms = cases.map(([tool, body]) => `    case "${tool}": {\n${body}\n    }`);
  return [
    `export async function ${name}(toolName: string, args: Record<string, unknown>) {`,
    '  switch (toolName) {',
    ...arms,
    '    default:',
    '      return null;',
    '  }',
    '}',
    '',
  ].join('\n');
}

test('destructive gate scanner keeps each case body separate from the next', () => {
  const source = dispatcher('handleThing', [
    ['sync_push', '      const confirmDestructive = args.confirmDestructive === true;\n      return push(confirmDestructive);'],
    ['sync_status', '      return status();'],
  ]);

  const bodies = sliceCaseBodies(source);
  assert.deepEqual([...bodies.keys()], ['sync_push', 'sync_status']);
  assert.match(bodies.get('sync_push'), /args\.confirmDestructive/);
  assert.doesNotMatch(bodies.get('sync_status'), /confirmDestructive/);
  assert.deepEqual(collectGatedTools([source]), ['sync_push']);
});

test('destructive gate scanner stops the final case body at the default arm', () => {
  const source = dispatcher('handleThing', [['sync_status', '      return status();']]).concat(
    'async function unrelated(args: Record<string, unknown>) {\n' +
      '  return args.confirmDestructive === true;\n' +
      '}\n'
  );

  assert.doesNotMatch(sliceCaseBodies(source).get('sync_status'), /confirmDestructive/);
  assert.deepEqual(collectGatedTools([source]), []);
});

test('destructive gate scanner resolves a case that delegates to a gating handler', () => {
  const delegate = [
    'export async function handleRunAtfTests(args: Record<string, unknown>) {',
    '  if (args.confirmDestructive !== true) {',
    '    return errorResponse("Re-run with confirmDestructive=true.");',
    '  }',
    '  return run();',
    '}',
    '',
  ].join('\n');
  const caller = dispatcher('handleInsightTool', [
    ['sync_run_atf_tests', '      return handleRunAtfTests(args);'],
    ['sync_search_scripts', '      return handleSearchScripts(args);'],
  ]);

  assert.deepEqual(collectGatedTools([delegate, caller]), ['sync_run_atf_tests']);
});

test('destructive gate scanner ignores the dispatcher that contains the case bodies', () => {
  const source = dispatcher('handleWorkspaceTool', [
    ['sync_push', '      const confirmDestructive = args.confirmDestructive === true;\n      return push(confirmDestructive);'],
    // Calls the dispatcher recursively; without the dispatcher exclusion this case
    // would inherit the gate of its sibling.
    ['sync_status', '      return handleWorkspaceTool("sync_push", args);'],
  ]);

  assert.deepEqual([...parseGatingFunctions(source)], []);
  assert.deepEqual(collectGatedTools([source]), ['sync_push']);
});

test('destructive gate scanner does not mistake a mention of the parameter for a guard', () => {
  const source = dispatcher('handleThing', [
    [
      'sync_status',
      [
        '      // Unlike sync_push this tool needs no confirmDestructive flag.',
        '      return text("Pass confirmDestructive=true to sync_push instead.");',
      ].join('\n'),
    ],
  ]);

  assert.deepEqual(collectGatedTools([source]), []);
});

test('destructive gate scanner surfaces a handler guard the schema never declares', () => {
  // This is finding D-1 reproduced on a fixture: the runtime refuses to run without
  // confirmDestructive, yet the tool never offers the caller a way to pass it.
  const handler = dispatcher('handleThing', [
    ['sync_push', '      if (args.confirmDestructive !== true) {\n        return refuse();\n      }\n      return push();'],
  ]);
  const schema = [
    'const BASE_MCP_TOOLS: Array<Record<string, unknown>> = [',
    '  {',
    '    name: "sync_push",',
    '    description: "Push local files.",',
    '    inputSchema: {',
    '      type: "object",',
    '      properties: { scope: { type: "string" } },',
    '      required: ["scope"],',
    '    },',
    '  },',
    '];',
  ].join('\n');

  const gatedInHandlers = collectGatedTools([handler]);
  const gatedInSchema = parseSchemaTools(schema)
    .filter((tool) => schemaConfirmDestructive(tool))
    .map((tool) => tool.name);

  assert.deepEqual(gatedInHandlers, ['sync_push']);
  assert.deepEqual(gatedInSchema, []);
  assert.notDeepEqual(gatedInHandlers, gatedInSchema);
});

test('handler switches expose exactly one case per declared MCP tool', () => {
  const handlerTools = collectHandlerCases(readHandlerSources());
  const schemaTools = parseSchemaTools(fs.readFileSync(TOOL_SCHEMAS_SOURCE, 'utf8')).map(
    (tool) => tool.name
  );

  assert.equal(
    handlerTools.length,
    new Set(handlerTools).size,
    'Two handler cases claim the same tool name.'
  );
  assert.deepEqual(handlerTools, [...schemaTools].sort());
});

test('every handler that gates on confirmDestructive declares it in toolSchemas.ts', () => {
  const gatedInHandlers = collectGatedTools(readHandlerSources());
  const gatedInSchema = parseSchemaTools(fs.readFileSync(TOOL_SCHEMAS_SOURCE, 'utf8'))
    .filter((tool) => schemaConfirmDestructive(tool))
    .map((tool) => tool.name)
    .sort();

  assert.ok(gatedInHandlers.length > 0, 'Expected at least one destructive tool.');
  assert.deepEqual(
    gatedInHandlers,
    gatedInSchema,
    'A tool gates on confirmDestructive without declaring it, or declares it without gating on it.'
  );
});

test('no declared confirmDestructive parameter arms itself by default', () => {
  const tools = parseSchemaTools(fs.readFileSync(TOOL_SCHEMAS_SOURCE, 'utf8'));

  for (const tool of tools) {
    const property = schemaConfirmDestructive(tool);
    if (!property) {
      continue;
    }
    assert.equal(property.type, 'boolean', `${tool.name}.confirmDestructive must be a boolean.`);
    // A default of `true` would hand the confirmation to the schema instead of the
    // caller, turning the guard into decoration.
    assert.notEqual(
      property.default,
      true,
      `${tool.name}.confirmDestructive must not default to true.`
    );
  }
});
