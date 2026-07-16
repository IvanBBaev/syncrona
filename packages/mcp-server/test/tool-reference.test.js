// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  extractToolBlocks,
  parseToolBlock,
  parseMetadata,
  buildToolDoc,
  normalizeParameter,
  generateToolReference,
  runCli: runToolReferenceCli,
} = require('../scripts/generate-tool-reference.js');

// A minimal stand-in for src/toolSchemas.ts. The generator reads the file
// textually, so the fixture only has to be shaped like the real source.
function toolSchemasFixture(toolLiterals, { overrides = '' } = {}) {
  return [
    'const DEFAULT_TOOL_METADATA: ToolLifecycleMetadata = {',
    '  version: "1.0.0",',
    '  deprecated: false,',
    '};',
    '',
    'const TOOL_METADATA_OVERRIDES: Record<string, Partial<ToolLifecycleMetadata>> = {',
    overrides,
    '};',
    '',
    'const BASE_MCP_TOOLS: Array<Record<string, unknown>> = [',
    toolLiterals,
    '];',
    '',
  ].join('\n');
}

function writeFixture(contents) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-tool-reference-'));
  const toolSource = path.join(tempDir, 'toolSchemas.ts');
  fs.writeFileSync(toolSource, contents, 'utf-8');
  return { tempDir, toolSource };
}

const SIMPLE_TOOL = [
  '  {',
  '    name: "sync_status",',
  '    description: "Reports project status.",',
  '    inputSchema: {',
  '      type: "object",',
  '      properties: {',
  '        scope: {',
  '          type: "string",',
  '          description: "Scope name.",',
  '        },',
  '        verbose: {',
  '          type: "boolean",',
  '          description: "Print extended diagnostics.",',
  '          default: false,',
  '        },',
  '      },',
  '      required: ["scope"],',
  '    },',
  '  },',
].join('\n');

test('generator extracts one block per tool and parses it semantically', () => {
  const { toolSource } = writeFixture(toolSchemasFixture(SIMPLE_TOOL));
  const raw = fs.readFileSync(toolSource, 'utf-8');

  const blocks = extractToolBlocks(raw);
  assert.equal(blocks.length, 1);

  const { tool, parseFailed } = parseToolBlock(blocks[0]);
  assert.equal(parseFailed, false);
  assert.equal(tool.name, 'sync_status');
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['scope', 'verbose']);
});

test('generator resolves tool metadata from defaults and overrides', () => {
  const { toolSource } = writeFixture(
    toolSchemasFixture(SIMPLE_TOOL, {
      overrides: '  sync_status: {\n    version: "1.1.0",\n  },',
    })
  );
  const { defaults, overrides } = parseMetadata(fs.readFileSync(toolSource, 'utf-8'));

  assert.deepEqual(defaults, { version: '1.0.0', deprecated: false });
  // Parsed object literals carry a null prototype; spread to compare by value.
  assert.deepEqual({ ...overrides.sync_status }, { version: '1.1.0' });
});

test('generator renders a tool section with required, default and safety details', () => {
  const { toolSource } = writeFixture(toolSchemasFixture(SIMPLE_TOOL));
  const result = generateToolReference({ toolSource });

  assert.equal(result.toolCount, 1);
  assert.deepEqual(result.toolNames, ['sync_status']);
  assert.deepEqual(result.degradedTools, []);
  assert.match(result.markdown, /### sync_status/);
  assert.match(result.markdown, /Reports project status\./);
  assert.match(result.markdown, /Total tools: \*\*1\*\*\./);
  // Required and optional parameters render distinctly, and the default shows up.
  assert.match(result.markdown, /\| `scope` \| `string` \| yes \|  \| Scope name\. \|/);
  assert.match(
    result.markdown,
    /\| `verbose` \| `boolean` \| no \| `false` \| Print extended diagnostics\. \|/
  );
  // A read-only tool declares neither confirmDestructive nor dryRun, so the
  // generator omits the safety line entirely.
  assert.doesNotMatch(result.markdown, /- Safety:/);
});

test('generator omits the Output section for a tool without an outputSchema', () => {
  const { toolSource } = writeFixture(toolSchemasFixture(SIMPLE_TOOL));
  const result = generateToolReference({ toolSource });

  assert.doesNotMatch(result.markdown, /Output \(`structuredContent`/);
});

test('generator renders an Output section from a declared outputSchema', () => {
  const tool = [
    '  {',
    '    name: "sync_list_scopes",',
    '    description: "Lists scopes.",',
    '    inputSchema: {',
    '      type: "object",',
    '      properties: {},',
    '      required: [],',
    '    },',
    '    outputSchema: {',
    '      type: "object",',
    '      description: "Scope listing.",',
    '      properties: {',
    '        count: {',
    '          type: "number",',
    '          description: "Number of rows returned.",',
    '        },',
    '        rows: {',
    '          type: "array",',
    '          items: { type: "object" },',
    '          description: "Scope records.",',
    '        },',
    '        correlationId: {',
    '          type: "string",',
    '          description: "Request correlation id.",',
    '        },',
    '      },',
    '      required: ["count", "rows"],',
    '      additionalProperties: false,',
    '    },',
    '  },',
  ].join('\n');
  const { toolSource } = writeFixture(toolSchemasFixture(tool));

  const result = generateToolReference({ toolSource });

  assert.match(result.markdown, /Output \(`structuredContent` on success results\):/);
  assert.match(result.markdown, /Scope listing\./);
  assert.match(result.markdown, /\| Field \| Type \| Always present \| Description \|/);
  // required entries render "yes"; the optional correlationId renders "no".
  assert.match(result.markdown, /\| `count` \| `number` \| yes \| Number of rows returned\. \|/);
  assert.match(result.markdown, /\| `rows` \| `array<object>` \| yes \| Scope records\. \|/);
  assert.match(
    result.markdown,
    /\| `correlationId` \| `string` \| no \| Request correlation id\. \|/
  );
});

test('buildToolDoc summarizes an outputSchema without documented fields', () => {
  const doc = buildToolDoc(
    {
      name: 'sync_status',
      description: 'Reports project status.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      outputSchema: { type: 'object', properties: {}, additionalProperties: true },
    },
    { version: '1.0.0', deprecated: false },
    false
  );

  assert.deepEqual(doc.output, { description: '', fields: [] });
});

test('buildToolDoc leaves output null when no outputSchema is declared', () => {
  const doc = buildToolDoc(
    {
      name: 'sync_status',
      description: 'Reports project status.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    { version: '1.0.0', deprecated: false },
    false
  );

  assert.equal(doc.output, null);
});

test('normalizeParameter composes an enum with numeric bounds', () => {
  const row = normalizeParameter(
    'limit',
    { type: 'number', enum: [10, 20], minimum: 10, maximum: 20 },
    []
  );

  // Bounds used to overwrite the enum rather than compose with it.
  assert.equal(row.type, 'number (one of: 10, 20, min 10, max 20)');
});

test('normalizeParameter keeps bounds on an integer parameter', () => {
  // `integer` is as valid a JSON Schema type as `number`; its bounds were dropped.
  assert.equal(
    normalizeParameter('limit', { type: 'integer', minimum: 1, maximum: 500 }, []).type,
    'integer (min 1, max 500)'
  );
  assert.equal(
    normalizeParameter('ratio', { type: 'number', minimum: 0 }, []).type,
    'number (min 0)'
  );
  // Bounds on a non-numeric type stay out of the rendered type.
  assert.equal(
    normalizeParameter('name', { type: 'string', minimum: 1 }, []).type,
    'string'
  );
});

test('normalizeParameter reports arrays, requiredness and defaults', () => {
  const row = normalizeParameter(
    'scopes',
    { type: 'array', items: { type: 'string' }, default: [], description: 'Scopes to sync.' },
    ['scopes']
  );

  assert.equal(row.type, 'array<string>');
  assert.equal(row.required, true);
  assert.equal(row.hasDefault, true);
  assert.equal(row.default, '[]');
  assert.equal(row.description, 'Scopes to sync.');
});

test('generator decodes unicode and hex escapes in descriptions', () => {
  const tool = [
    '  {',
    '    name: "sync_docs",',
    '    description: "Uses an em\\u2014dash, a caf\\xe9 and a \\u{1F600} emoji.",',
    '    inputSchema: {',
    '      type: "object",',
    '      properties: {},',
    '      required: [],',
    '    },',
    '  },',
  ].join('\n');
  const { toolSource } = writeFixture(toolSchemasFixture(tool));

  const { tool: parsed, parseFailed } = parseToolBlock(extractToolBlocks(fs.readFileSync(toolSource, 'utf-8'))[0]);

  assert.equal(parseFailed, false);
  // The escape used to be consumed two characters at a time, leaking "2014".
  assert.equal(parsed.description, 'Uses an em—dash, a caf\xe9 and a \u{1F600} emoji.');
  assert.doesNotMatch(parsed.description, /2014|u2014|xe9/);
});

test('generator still decodes the simple escape sequences', () => {
  const tool = [
    '  {',
    '    name: "sync_docs",',
    '    description: "line\\nbreak\\ttab\\\\slash\\"quote",',
    '    inputSchema: { type: "object", properties: {}, required: [] },',
    '  },',
  ].join('\n');
  const { toolSource } = writeFixture(toolSchemasFixture(tool));

  const { tool: parsed } = parseToolBlock(extractToolBlocks(fs.readFileSync(toolSource, 'utf-8'))[0]);

  assert.equal(parsed.description, 'line\nbreak\ttab\\slash"quote');
});

test('generator rejects a spread element in BASE_MCP_TOOLS with a targeted message', () => {
  const { toolSource } = writeFixture(
    toolSchemasFixture([SIMPLE_TOOL, '  ...EXTRA_MCP_TOOLS,'].join('\n'))
  );
  const raw = fs.readFileSync(toolSource, 'utf-8');

  assert.throws(() => extractToolBlocks(raw), (error) => {
    assert.match(error.message, /flat array of object literals/);
    assert.match(error.message, /spread element/);
    assert.match(error.message, /\.\.\.EXTRA_MCP_TOOLS/);
    return true;
  });
});

test('generator reports a missing BASE_MCP_TOOLS array', () => {
  const { toolSource } = writeFixture('const OTHER = [];\n');

  assert.throws(
    () => extractToolBlocks(fs.readFileSync(toolSource, 'utf-8')),
    /BASE_MCP_TOOLS array not found/
  );
});

test('generator degrades to regex fallback instead of dropping an unparsable tool', () => {
  // A computed value the literal parser cannot evaluate.
  const tool = [
    '  {',
    '    name: "sync_status",',
    '    description: "Reports project status.",',
    '    inputSchema: {',
    '      type: "object",',
    '      properties: {',
    '        scope: {',
    '          type: SCOPE_TYPE_CONSTANT,',
    '        },',
    '      },',
    '      required: ["scope"],',
    '    },',
    '  },',
  ].join('\n');
  const { toolSource } = writeFixture(toolSchemasFixture(tool));

  const result = generateToolReference({ toolSource });

  assert.deepEqual(result.degradedTools, ['sync_status']);
  assert.deepEqual(result.toolNames, ['sync_status']);
  assert.match(result.markdown, /### sync_status/);
});

test('generator marks a confirmDestructive tool as gated', () => {
  const tool = [
    '  {',
    '    name: "run_node_code",',
    '    description: "Runs Node.js code.",',
    '    inputSchema: {',
    '      type: "object",',
    '      properties: {',
    '        code: { type: "string", description: "Source to run." },',
    '        confirmDestructive: { type: "boolean", default: false },',
    '      },',
    '      required: ["code"],',
    '    },',
    '  },',
  ].join('\n');
  const { toolSource } = writeFixture(toolSchemasFixture(tool));

  const result = generateToolReference({ toolSource });

  assert.match(result.markdown, /- Safety: mutating - gated by `confirmDestructive`/);
  assert.match(result.markdown, /\| `confirmDestructive` \|/);
});

test('buildToolDoc flags confirmDestructive and dryRun affordances', () => {
  const doc = buildToolDoc(
    {
      name: 'sync_push',
      description: 'Pushes files.',
      inputSchema: {
        type: 'object',
        properties: {
          confirmDestructive: { type: 'boolean' },
          dryRun: { type: 'boolean' },
        },
        required: ['confirmDestructive'],
      },
    },
    { version: '1.0.0', deprecated: false },
    false
  );

  assert.equal(doc.hasConfirmDestructive, true);
  assert.equal(doc.confirmDestructiveRequired, true);
  assert.equal(doc.hasDryRun, true);
});

test('tool reference CLI writes the file and then passes --check against it', () => {
  const { tempDir, toolSource } = writeFixture(toolSchemasFixture(SIMPLE_TOOL));
  const outputTarget = path.join(tempDir, 'MCP_TOOLS.md');

  const logs = [];
  const errors = [];
  const console_ = { log: (m) => logs.push(m), error: (m) => errors.push(m) };

  assert.equal(runToolReferenceCli({ toolSource, outputTarget, args: [], console: console_ }), 0);
  assert.match(logs[0], /Tool reference generated \(1 tools\)/);
  assert.equal(errors.length, 0);

  assert.equal(
    runToolReferenceCli({ toolSource, outputTarget, args: ['--check'], console: console_ }),
    0
  );
  assert.match(logs[1], /Tool reference check passed \(1 tools, MCP_TOOLS\.md is up to date\)\./);
});

test('tool reference CLI --check returns 1 when the committed file is stale', () => {
  const { tempDir, toolSource } = writeFixture(toolSchemasFixture(SIMPLE_TOOL));
  const outputTarget = path.join(tempDir, 'MCP_TOOLS.md');
  fs.writeFileSync(outputTarget, '# Stale reference\n', 'utf-8');

  const logs = [];
  const errors = [];
  const exitCode = runToolReferenceCli({
    toolSource,
    outputTarget,
    args: ['--check'],
    console: { log: (m) => logs.push(m), error: (m) => errors.push(m) },
  });

  assert.equal(exitCode, 1);
  assert.equal(logs.length, 0);
  assert.match(errors.join('\n'), /Tool reference check failed: .*MCP_TOOLS\.md is out of date\./);
  assert.match(errors.join('\n'), /Run `node packages\/mcp-server\/scripts\/generate-tool-reference\.js`/);
});

test('tool reference CLI refuses to generate or bless a degraded tool block', () => {
  // A computed value the literal parser cannot evaluate degrades the block: its
  // Output section and parameter types silently vanish from the doc. The CLI
  // must refuse rather than emit — or, in --check, quietly accept — an
  // incomplete reference, matching extractToolBlocks' fatal spread handling.
  const tool = [
    '  {',
    '    name: "sync_status",',
    '    description: "Reports project status.",',
    '    inputSchema: {',
    '      type: "object",',
    '      properties: { scope: { type: SCOPE_TYPE_CONSTANT } },',
    '      required: ["scope"],',
    '    },',
    '  },',
  ].join('\n');
  const { tempDir, toolSource } = writeFixture(toolSchemasFixture(tool));
  const outputTarget = path.join(tempDir, 'MCP_TOOLS.md');

  // generate mode: fails and never writes the degraded doc.
  const genErrors = [];
  assert.equal(
    runToolReferenceCli({
      toolSource,
      outputTarget,
      args: [],
      console: { log: () => {}, error: (m) => genErrors.push(m) },
    }),
    1
  );
  assert.match(genErrors.join('\n'), /generation failed: .*degraded to fallback parsing \(sync_status\)/);
  assert.equal(fs.existsSync(outputTarget), false);

  // --check mode: even a committed doc that matches the degraded markdown fails,
  // closing the "regenerate-and-commit the degraded copy" hole in the gate.
  fs.writeFileSync(outputTarget, generateToolReference({ toolSource }).markdown, 'utf-8');
  const checkErrors = [];
  assert.equal(
    runToolReferenceCli({
      toolSource,
      outputTarget,
      args: ['--check'],
      console: { log: () => {}, error: (m) => checkErrors.push(m) },
    }),
    1
  );
  assert.match(checkErrors.join('\n'), /check failed: .*degraded to fallback parsing/);
});

test('tool reference CLI --check returns 1 when the output file is absent', () => {
  const { tempDir, toolSource } = writeFixture(toolSchemasFixture(SIMPLE_TOOL));
  const outputTarget = path.join(tempDir, 'MCP_TOOLS.md');

  const errors = [];
  const exitCode = runToolReferenceCli({
    toolSource,
    outputTarget,
    args: ['--check'],
    console: { log: () => {}, error: (m) => errors.push(m) },
  });

  assert.equal(exitCode, 1);
  assert.match(errors.join('\n'), /does not exist/);
});
