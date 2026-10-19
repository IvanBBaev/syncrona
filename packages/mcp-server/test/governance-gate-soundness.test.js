// SPDX-License-Identifier: GPL-3.0-or-later
//
// Soundness tests for the governance gates themselves: each case is a drift the
// gate is supposed to catch, asserted to actually BE caught. A gate that returns
// a clean verdict on dirty input is worse than no gate, because the green check
// is taken as evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  parseMetadata,
  generateToolReference,
  runCli: runToolReferenceCli,
} = require('../scripts/generate-tool-reference.js');
const {
  checkToolContract,
  parseDeclaredToolNames,
} = require('../scripts/check-tool-contract.js');
const {
  parseCliCommandNames,
  parseToolNamesFromSchemas: parseClaimsToolNames,
} = require('../scripts/check-claims-drift.js');
const {
  parseToolNamesFromSchemas: parseDocsDriftToolNames,
} = require('../scripts/check-docs-drift.js');
const {
  parseReportedFiles,
  findUnreportedModules,
  isTypeOnlyEmit,
  globToRegExp,
} = require('../scripts/check-coverage-gate.js');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function captureCli({ toolSource, outputTarget, args = [] }) {
  const errors = [];
  const logs = [];
  const code = runToolReferenceCli({
    toolSource,
    outputTarget,
    args,
    console: {
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    },
  });
  return { code, errors: errors.join('\n'), logs: logs.join('\n') };
}

// --- Fix A: unparseable tool metadata must fail, not degrade to `{}` ---------

// The mini-parser cannot resolve a spread element, a computed key or a reference
// to another constant. Degrading to `{}` renders a self-consistent but WRONG
// reference: deprecations vanish and overridden versions regress to the default.
const UNPARSEABLE_OVERRIDES = [
  { label: 'spread element', body: '  ...SHARED_METADATA,' },
  { label: 'referenced constant', body: '  run_node_code: SHARED_METADATA,' },
  { label: 'computed key', body: '  [TOOL_NAME]: { version: "2.0.0" },' },
];

function schemaSourceWithOverrides(overridesBody) {
  return [
    'const DEFAULT_TOOL_METADATA: ToolLifecycleMetadata = {',
    '  version: "1.0.0",',
    '  deprecated: false,',
    '};',
    '',
    'const TOOL_METADATA_OVERRIDES: Record<string, Partial<ToolLifecycleMetadata>> = {',
    overridesBody,
    '};',
    '',
    'export const BASE_MCP_TOOLS = [',
    '  {',
    '    name: "run_node_code",',
    '    description: "Runs node code.",',
    '    inputSchema: { type: "object", properties: {}, required: [] },',
    '  },',
    '];',
    '',
  ].join('\n');
}

for (const { label, body } of UNPARSEABLE_OVERRIDES) {
  test(`tool metadata with a ${label} is reported instead of silently dropped`, () => {
    const { overrides, errors } = parseMetadata(schemaSourceWithOverrides(body));
    assert.deepEqual(overrides, {}, 'unparseable block still yields no overrides');
    assert.ok(
      errors.some((message) => message.includes('TOOL_METADATA_OVERRIDES')),
      `expected a reported error for the ${label}, got: ${JSON.stringify(errors)}`
    );
  });
}

test('a missing metadata constant is reported rather than assumed empty', () => {
  const raw = schemaSourceWithOverrides('  run_node_code: { version: "2.0.0" },').replace(
    'const TOOL_METADATA_OVERRIDES',
    'const RENAMED_TOOL_METADATA_OVERRIDES'
  );
  const { errors } = parseMetadata(raw);
  assert.ok(
    errors.some((message) => message.includes('TOOL_METADATA_OVERRIDES')),
    'a renamed/removed constant must be an error, not an empty override map'
  );
});

test('parseable metadata reports no errors and still resolves overrides', () => {
  const { defaults, overrides, errors } = parseMetadata(
    schemaSourceWithOverrides('  run_node_code: { version: "2.0.0" },')
  );
  assert.deepEqual(errors, []);
  assert.equal(defaults.version, '1.0.0');
  assert.equal(overrides.run_node_code.version, '2.0.0');
});

test('tool reference --check fails when metadata cannot be read', () => {
  const dir = tempDir('sync-toolref-meta-');
  const toolSource = path.join(dir, 'toolSchemas.ts');
  const outputTarget = path.join(dir, 'MCP_TOOLS.md');

  // Generate the reference from a source whose metadata parses cleanly.
  fs.writeFileSync(
    toolSource,
    schemaSourceWithOverrides('  run_node_code: { version: "2.0.0" },'),
    'utf-8'
  );
  const generated = captureCli({ toolSource, outputTarget });
  assert.equal(generated.code, 0, generated.errors);
  assert.match(
    fs.readFileSync(outputTarget, 'utf-8'),
    /2\.0\.0/,
    'the override must reach the committed reference'
  );

  // Now break ONLY the metadata block. Degrading to `{}` renders a reference that
  // is internally consistent but WRONG (the 2.0.0 override regresses to 1.0.0),
  // and --check would then bless it. The gate must fail on the unreadable
  // metadata itself.
  fs.writeFileSync(toolSource, schemaSourceWithOverrides('  ...SHARED_METADATA,'), 'utf-8');
  const checked = captureCli({ toolSource, outputTarget, args: ['--check'] });
  assert.equal(checked.code, 1, 'unreadable metadata must fail --check');
  assert.match(checked.errors, /metadata could not be read/i);
});

test('tool reference generation fails when metadata cannot be read', () => {
  const dir = tempDir('sync-toolref-gen-');
  const toolSource = path.join(dir, 'toolSchemas.ts');
  const outputTarget = path.join(dir, 'MCP_TOOLS.md');
  fs.writeFileSync(toolSource, schemaSourceWithOverrides('  ...SHARED_METADATA,'), 'utf-8');
  const generated = captureCli({ toolSource, outputTarget });
  assert.equal(generated.code, 1, 'generation must not emit a reference with dropped metadata');
  assert.equal(
    fs.existsSync(outputTarget),
    false,
    'a wrong reference must never be written to disk'
  );
});

test('generateToolReference surfaces metadata errors to callers', () => {
  const dir = tempDir('sync-toolref-api-');
  const toolSource = path.join(dir, 'toolSchemas.ts');
  fs.writeFileSync(toolSource, schemaSourceWithOverrides('  ...SHARED_METADATA,'), 'utf-8');
  const result = generateToolReference({ toolSource });
  assert.ok(result.metadataErrors.length > 0, 'metadataErrors must be exposed on the result');
});

// --- Fix C: the contract floor must see every quote style -------------------

test('tool declarations are found regardless of quote style', () => {
  const raw = [
    'export const BASE_MCP_TOOLS = [',
    '  { name: "double_quoted" },',
    "  { name: 'single_quoted' },",
    '  { name: `backtick_quoted` },',
    '];',
  ].join('\n');
  assert.deepEqual(parseDeclaredToolNames(raw), [
    'double_quoted',
    'single_quoted',
    'backtick_quoted',
  ]);
});

test('a single-quoted tool cannot bypass the contract floor', () => {
  // The tool IS declared, so it must be reported as unpinned unless REQUIRED_TOOLS
  // pins it. Keying on double quotes alone made it invisible: absent from
  // `declared`, it never entered the two-way check and shipped unpinned.
  const dir = tempDir('sync-contract-quotes-');
  const source = path.join(dir, 'toolSchemas.ts');
  fs.writeFileSync(
    source,
    ["export const BASE_MCP_TOOLS = [", "  { name: 'sneaky_tool' },", '];'].join('\n'),
    'utf-8'
  );

  const result = checkToolContract(source, []);
  assert.deepEqual(result.unpinned, ['sneaky_tool'], 'declared-but-unpinned must be caught');
  assert.equal(result.ok, false);
});

test('a single-quoted tool satisfies a required-tool pin', () => {
  const dir = tempDir('sync-contract-quotes-req-');
  const source = path.join(dir, 'toolSchemas.ts');
  fs.writeFileSync(
    source,
    ['export const BASE_MCP_TOOLS = [', "  { name: 'pinned_tool' },", '];'].join('\n'),
    'utf-8'
  );

  const result = checkToolContract(source, ['pinned_tool']);
  assert.deepEqual(result.missing, [], 'a declared tool must not be reported missing');
  assert.equal(result.ok, true);
});

// --- Fix C/D: docs and claims gates must see every quote style --------------

test('claims-drift and docs-drift both parse single-quoted tool names', () => {
  const raw = ["export const BASE_MCP_TOOLS = [", "  { name: 'quoted_tool' },", '];'].join('\n');
  assert.ok(
    parseClaimsToolNames(raw).includes('quoted_tool'),
    'claims-drift must see the tool'
  );
  assert.ok(
    parseDocsDriftToolNames(raw).includes('quoted_tool'),
    'docs-drift must see the tool'
  );
});

// --- Fix D: the CLI registry parser must not key on indentation -------------

function registrySource(entries, indent) {
  const body = entries
    .map((entry) => {
      const value = Array.isArray(entry)
        ? `[${entry.map((alias) => `"${alias}"`).join(', ')}]`
        : `"${entry}"`;
      return `${indent}{\n${indent}  command: ${value},\n${indent}  describe: "Does a thing.",\n${indent}},`;
    })
    .join('\n');
  return `export const cliCommands = [\n${body}\n];\n`;
}

test('CLI commands are counted at any indentation', () => {
  const entries = ['init', ['dev', 'd'], 'download <scope>'];
  // Two spaces deeper than the current file's layout: still a registry entry,
  // and previously invisible to a parser anchored at exactly four spaces.
  for (const indent of ['  ', '    ', '      ', '\t']) {
    const names = parseCliCommandNames(registrySource(entries, indent));
    assert.deepEqual(
      names,
      ['dev', 'download', 'init'],
      `indent ${JSON.stringify(indent)} must not hide registry entries`
    );
  }
});

test('a nested registry entry cannot slip past the CLI command gate', () => {
  const source = [
    'export const cliCommands = [',
    '  {',
    '    command: "init",',
    '  },',
    '  ...(flag',
    '    ? [',
    '        {',
    '          command: "hidden",',
    '        },',
    '      ]',
    '    : []),',
    '];',
  ].join('\n');
  assert.deepEqual(parseCliCommandNames(source), ['hidden', 'init']);
});

test('the command type declaration is not mistaken for a command', () => {
  const source = [
    'export interface CliCommand {',
    '  command: string | string[];',
    '  describe: string;',
    '}',
    'export const cliCommands = [',
    '  { command: "init" },',
    '];',
  ].join('\n');
  assert.deepEqual(parseCliCommandNames(source), ['init']);
});

test('a subcommand property is not mistaken for a command', () => {
  const source = ['export const cliCommands = [', '  { subcommand: "nope", command: "init" },', '];'].join(
    '\n'
  );
  assert.deepEqual(parseCliCommandNames(source), ['init']);
});

test('single-quoted CLI commands are visible to the registry parser', () => {
  const source = ['export const cliCommands = [', "  { command: 'init' },", '];'].join('\n');
  assert.deepEqual(parseCliCommandNames(source), ['init']);
});

// --- The CLAUDE docs gate must not depend on the caller's cwd ---------------

test('CLAUDE docs drift gate finds the CLI registry from any cwd', () => {
  // The registry path is repo-root-relative. Resolved against the CALLER's cwd it
  // only worked from the repo root and reported the registry as missing anywhere
  // else — a gate that passes or fails by cwd is not a gate.
  const script = path.join(__dirname, '..', 'scripts', 'check-claude-docs-drift.js');
  for (const cwd of [path.join(__dirname, '..'), os.tmpdir()]) {
    const result = spawnSync(process.execPath, [script], { cwd, encoding: 'utf-8' });
    const output = `${result.stdout}${result.stderr}`;
    assert.doesNotMatch(
      output,
      /Missing required docs file/,
      `gate lost track of its own sources when run from ${cwd}: ${output}`
    );
    assert.equal(result.status, 0, `gate must pass from ${cwd}: ${output}`);
  }
});

// --- Fix B: an untested module must fail the gate, not vanish ---------------

// A real report from `node --test --experimental-test-coverage`. It is a TREE:
// one space of indent per level, directory rows carry empty percentage cells,
// and a module no test loaded is absent entirely.
const SAMPLE_REPORT = [
  '# start of coverage report',
  '# --------------------------------------------------------------',
  '# file          | line % | branch % | funcs % | uncovered lines',
  '# --------------------------------------------------------------',
  '# dist          |        |          |         | ',
  '#  a.js         | 100.00 |    66.67 |  100.00 | ',
  '#  handlers     |        |          |         | ',
  '#   deep.js     | 100.00 |    66.67 |  100.00 | ',
  '# --------------------------------------------------------------',
  '# all files     | 100.00 |    71.43 |  100.00 | ',
  '# --------------------------------------------------------------',
  '# end of coverage report',
].join('\n');

test('coverage report tree is flattened into real module paths', () => {
  const reported = parseReportedFiles(SAMPLE_REPORT);
  assert.deepEqual([...reported].sort(), ['dist/a.js', 'dist/handlers/deep.js']);
});

test('directory rows and the all-files row are not mistaken for modules', () => {
  const reported = parseReportedFiles(SAMPLE_REPORT);
  assert.ok(!reported.has('dist'), 'a directory row is not a module');
  assert.ok(!reported.has('dist/handlers'), 'a nested directory row is not a module');
  assert.ok(!reported.has('all files'), 'the summary row is not a module');
});

test('a module no test loaded is reported as a coverage hole', () => {
  const dir = tempDir('sync-coverage-hole-');
  fs.mkdirSync(path.join(dir, 'dist', 'handlers'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'a.js'), 'module.exports = 1;\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'dist', 'handlers', 'deep.js'), 'module.exports = 2;\n', 'utf-8');
  // On disk, exercised by nothing, therefore absent from SAMPLE_REPORT.
  fs.writeFileSync(
    path.join(dir, 'dist', 'handlers', 'never.js'),
    'function nope(a) {\n  return a ? 1 : 2;\n}\nmodule.exports = { nope };\n',
    'utf-8'
  );

  const missing = findUnreportedModules(SAMPLE_REPORT, dir);
  assert.deepEqual(
    missing,
    ['dist/handlers/never.js'],
    'a zero-test module must score as a hole, not be invisible'
  );
});

test('an excluded module is not treated as a coverage hole', () => {
  const dir = tempDir('sync-coverage-excluded-');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'a.js'), 'module.exports = 1;\n', 'utf-8');
  fs.writeFileSync(
    path.join(dir, 'dist', 'toolSchemas.js'),
    'module.exports = { tools: [] };\n',
    'utf-8'
  );
  assert.deepEqual(findUnreportedModules(SAMPLE_REPORT, dir), []);
});

test('a type-only emit is not treated as a coverage hole', () => {
  const dir = tempDir('sync-coverage-typeonly-');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'a.js'), 'module.exports = 1;\n', 'utf-8');
  fs.writeFileSync(
    path.join(dir, 'dist', 'types.js'),
    [
      '"use strict";',
      'Object.defineProperty(exports, "__esModule", { value: true });',
      '//# sourceMappingURL=types.js.map',
      '',
    ].join('\n'),
    'utf-8'
  );
  assert.deepEqual(
    findUnreportedModules(SAMPLE_REPORT, dir),
    [],
    'a stub with no executable body cannot be covered and is not a hole'
  );
});

test('type-only emit detection distinguishes stubs from real code', () => {
  assert.equal(
    isTypeOnlyEmit(
      '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\n'
    ),
    true
  );
  assert.equal(
    isTypeOnlyEmit(
      '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.x = 1;\n'
    ),
    false,
    'a module with a real statement is coverable code'
  );
});

test('an unparseable report makes every module a hole rather than passing', () => {
  const dir = tempDir('sync-coverage-noreport-');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'a.js'), 'module.exports = 1;\n', 'utf-8');
  assert.deepEqual(
    findUnreportedModules('no report here at all', dir),
    ['dist/a.js'],
    'a missing report must fail loudly, never silently pass'
  );
});

test('glob translation matches the coverage exclude patterns', () => {
  const re = globToRegExp('**/toolSchemas.js');
  assert.ok(re.test('dist/toolSchemas.js'));
  assert.ok(re.test('toolSchemas.js'));
  assert.ok(re.test('dist/nested/toolSchemas.js'));
  assert.ok(!re.test('dist/toolSchemasHelper.js'));
});
