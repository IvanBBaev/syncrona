// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_TOOL_SOURCE = path.resolve(__dirname, '..', 'src', 'toolSchemas.ts');
const DEFAULT_OUTPUT_TARGET = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'docs',
  'MCP_TOOLS.md'
);
const GENERATOR_COMMAND = 'node packages/mcp-server/scripts/generate-tool-reference.js';

const TOOL_NAME_REGEX = /name:\s*"([^"]+)"/;
const FALLBACK_DESCRIPTION_REGEX = /description:\s*"([^"]*)"/;
const FALLBACK_PARAM_REGEX = /^\s{8}([A-Za-z_$][A-Za-z0-9_$]*):\s*\{/gm;
const FALLBACK_REQUIRED_REGEX = /required:\s*\[([^\]]*)\]/;

const SIMPLE_ESCAPES = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  v: '\v',
  0: '\0',
};

function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function skipTriviaAt(source, startPos) {
  let pos = startPos;
  while (pos < source.length) {
    const ch = source[pos];
    if (isWhitespace(ch)) {
      pos += 1;
      continue;
    }
    if (ch === '/' && source[pos + 1] === '/') {
      while (pos < source.length && source[pos] !== '\n') {
        pos += 1;
      }
      continue;
    }
    if (ch === '/' && source[pos + 1] === '*') {
      pos += 2;
      while (pos < source.length && !(source[pos] === '*' && source[pos + 1] === '/')) {
        pos += 1;
      }
      pos += 2;
      continue;
    }
    break;
  }
  return pos;
}

// Structural scan over a `{...}` or `[...]` block, skipping strings and comments.
// Returns the index just past the matching closing bracket.
function scanBalancedBlock(source, startPos) {
  let depth = 0;
  let pos = startPos;
  while (pos < source.length) {
    const ch = source[pos];
    if (ch === '"' || ch === "'" || ch === '`') {
      pos += 1;
      while (pos < source.length && source[pos] !== ch) {
        if (source[pos] === '\\') {
          pos += 1;
        }
        pos += 1;
      }
      pos += 1;
      continue;
    }
    if (ch === '/' && source[pos + 1] === '/') {
      while (pos < source.length && source[pos] !== '\n') {
        pos += 1;
      }
      continue;
    }
    if (ch === '/' && source[pos + 1] === '*') {
      pos += 2;
      while (pos < source.length && !(source[pos] === '*' && source[pos + 1] === '/')) {
        pos += 1;
      }
      pos += 2;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) {
        return pos + 1;
      }
    }
    pos += 1;
  }
  throw new Error('Unbalanced brackets while scanning schema block.');
}

// Minimal recursive-descent parser for the object-literal subset used in
// toolSchemas.ts: double/single-quoted strings, numbers, booleans, null,
// arrays, and nested objects with identifier or string keys.
function parseLiteral(source) {
  let pos = 0;

  function fail(message) {
    throw new Error(`${message} at offset ${pos}`);
  }

  function skipTrivia() {
    pos = skipTriviaAt(source, pos);
  }

  function parseString() {
    const quote = source[pos];
    pos += 1;
    let value = '';
    while (pos < source.length) {
      const ch = source[pos];
      if (ch === '\\') {
        const next = source[pos + 1];
        // `\uXXXX`, `\u{XXXXX}` and `\xNN` carry their payload past the escape
        // pair; consuming only two characters would leak the hex digits into the
        // rendered description.
        if (next === 'u' && source[pos + 2] === '{') {
          const close = source.indexOf('}', pos + 3);
          const hex = close === -1 ? '' : source.slice(pos + 3, close);
          if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) {
            return fail('Invalid unicode code point escape');
          }
          value += String.fromCodePoint(Number.parseInt(hex, 16));
          pos = close + 1;
          continue;
        }
        if (next === 'u' || next === 'x') {
          const width = next === 'u' ? 4 : 2;
          const hex = source.slice(pos + 2, pos + 2 + width);
          if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) {
            return fail(`Invalid \\${next} escape`);
          }
          value += String.fromCharCode(Number.parseInt(hex, 16));
          pos += 2 + width;
          continue;
        }
        value += hasOwn(SIMPLE_ESCAPES, next) ? SIMPLE_ESCAPES[next] : next;
        pos += 2;
        continue;
      }
      if (ch === quote) {
        pos += 1;
        return value;
      }
      value += ch;
      pos += 1;
    }
    return fail('Unterminated string literal');
  }

  function parseNumber() {
    const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(pos, pos + 64));
    if (!match) {
      return fail('Invalid number literal');
    }
    pos += match[0].length;
    return Number(match[0]);
  }

  function parseIdentifier() {
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(pos, pos + 256));
    if (!match) {
      return fail('Expected identifier');
    }
    pos += match[0].length;
    return match[0];
  }

  function parseArray() {
    pos += 1;
    const items = [];
    for (;;) {
      skipTrivia();
      if (source[pos] === ']') {
        pos += 1;
        return items;
      }
      items.push(parseValue());
      skipTrivia();
      if (source[pos] === ',') {
        pos += 1;
        continue;
      }
      if (source[pos] === ']') {
        pos += 1;
        return items;
      }
      return fail('Expected "," or "]" in array literal');
    }
  }

  function parseObject() {
    pos += 1;
    const value = Object.create(null);
    for (;;) {
      skipTrivia();
      if (source[pos] === '}') {
        pos += 1;
        return value;
      }
      const key = source[pos] === '"' || source[pos] === "'" ? parseString() : parseIdentifier();
      skipTrivia();
      if (source[pos] !== ':') {
        return fail(`Expected ":" after key "${key}"`);
      }
      pos += 1;
      value[key] = parseValue();
      skipTrivia();
      if (source[pos] === ',') {
        pos += 1;
        continue;
      }
      if (source[pos] === '}') {
        pos += 1;
        return value;
      }
      return fail('Expected "," or "}" in object literal');
    }
  }

  function parseValue() {
    skipTrivia();
    const ch = source[pos];
    if (ch === '"' || ch === "'") {
      return parseString();
    }
    if (ch === '{') {
      return parseObject();
    }
    if (ch === '[') {
      return parseArray();
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      return parseNumber();
    }
    const word = parseIdentifier();
    if (word === 'true') {
      return true;
    }
    if (word === 'false') {
      return false;
    }
    if (word === 'null') {
      return null;
    }
    return fail(`Unsupported bare token "${word}"`);
  }

  const result = parseValue();
  skipTrivia();
  return result;
}

function extractAssignedBlock(raw, constName, openBracket) {
  const anchor = raw.indexOf(`const ${constName}`);
  if (anchor === -1) {
    return '';
  }
  const assignPos = raw.indexOf('=', anchor);
  if (assignPos === -1) {
    return '';
  }
  const blockStart = raw.indexOf(openBracket, assignPos);
  if (blockStart === -1) {
    return '';
  }
  const blockEnd = scanBalancedBlock(raw, blockStart);
  return raw.slice(blockStart, blockEnd);
}

// Splits the BASE_MCP_TOOLS array source into one raw text block per tool.
function extractToolBlocks(raw) {
  const arrayText = extractAssignedBlock(raw, 'BASE_MCP_TOOLS', '[');
  if (!arrayText) {
    throw new Error('BASE_MCP_TOOLS array not found in tool schema source.');
  }
  const blocks = [];
  let pos = skipTriviaAt(arrayText, 1);
  while (pos < arrayText.length && arrayText[pos] !== ']') {
    if (arrayText[pos] !== '{') {
      const snippet = arrayText.slice(pos, pos + 32).replace(/\s+/g, ' ').trim();
      if (arrayText.startsWith('...', pos)) {
        throw new Error(
          'BASE_MCP_TOOLS must stay a flat array of object literals, but a spread element ' +
            `was found ("${snippet}"). This generator reads the array textually and cannot ` +
            'resolve the spread; inline the tools instead.'
        );
      }
      throw new Error(
        `Expected a tool object literal in BASE_MCP_TOOLS at offset ${pos}, found "${snippet}".`
      );
    }
    const end = scanBalancedBlock(arrayText, pos);
    blocks.push(arrayText.slice(pos, end));
    pos = skipTriviaAt(arrayText, end);
    if (arrayText[pos] === ',') {
      pos = skipTriviaAt(arrayText, pos + 1);
    }
  }
  return blocks;
}

// Regex fallback used when a tool block cannot be parsed semantically:
// keeps the tool and its parameter names visible with type "unknown".
function buildFallbackTool(block) {
  const nameMatch = TOOL_NAME_REGEX.exec(block);
  const descriptionMatch = FALLBACK_DESCRIPTION_REGEX.exec(block);
  const properties = Object.create(null);
  for (const match of block.matchAll(FALLBACK_PARAM_REGEX)) {
    properties[match[1]] = null;
  }
  const requiredMatch = FALLBACK_REQUIRED_REGEX.exec(block);
  const required = requiredMatch
    ? [...requiredMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    : [];
  return {
    name: nameMatch ? nameMatch[1] : '(unparsed tool)',
    description: descriptionMatch ? descriptionMatch[1] : '',
    inputSchema: { type: 'object', properties, required },
  };
}

function parseToolBlock(block) {
  try {
    const tool = parseLiteral(block);
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
      throw new Error('Tool block did not parse to an object.');
    }
    return { tool, parseFailed: false };
  } catch {
    return { tool: buildFallbackTool(block), parseFailed: true };
  }
}

// Reads one metadata object literal. A block the mini-parser cannot resolve
// (spread element, computed key, referenced constant) must be reported rather
// than swallowed: silently falling back to `{}` drops real version/deprecation
// metadata from the reference while every gate stays green.
function parseMetadataBlock(raw, constName, errors) {
  const block = extractAssignedBlock(raw, constName, '{');
  if (!block) {
    errors.push(
      `${constName} object literal not found in tool schema source. The reference is ` +
        'generated from that constant; a rename or removal silently drops all tool ' +
        'lifecycle metadata.'
    );
    return null;
  }
  try {
    const parsed = parseLiteral(block);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('block did not parse to an object literal');
    }
    return parsed;
  } catch (error) {
    errors.push(
      `${constName} could not be parsed (${error.message}). This generator reads the ` +
        'constant textually and cannot resolve spread elements, computed keys or ' +
        'referenced constants; inline the metadata as a plain object literal.'
    );
    return null;
  }
}

function parseMetadata(raw) {
  const errors = [];
  const defaults = { version: '1.0.0', deprecated: false };
  const parsedDefaults = parseMetadataBlock(raw, 'DEFAULT_TOOL_METADATA', errors);
  if (parsedDefaults) {
    Object.assign(defaults, parsedDefaults);
  }
  const parsedOverrides = parseMetadataBlock(raw, 'TOOL_METADATA_OVERRIDES', errors);
  return { defaults, overrides: parsedOverrides || {}, errors };
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeParameter(name, propSchema, requiredNames) {
  const row = {
    name,
    type: 'unknown',
    required: requiredNames.includes(name),
    hasDefault: false,
    default: '',
    description: '',
  };
  if (!propSchema || typeof propSchema !== 'object' || Array.isArray(propSchema)) {
    return row;
  }
  const baseType = typeof propSchema.type === 'string' ? propSchema.type : 'unknown';
  let type = baseType;
  if (baseType === 'array') {
    const itemsType =
      propSchema.items &&
      typeof propSchema.items === 'object' &&
      typeof propSchema.items.type === 'string'
        ? propSchema.items.type
        : 'unknown';
    type = `array<${itemsType}>`;
  }
  // Qualifiers compose: a bounded enum renders both, and `integer` carries bounds
  // just like `number` does.
  const qualifiers = [];
  if (Array.isArray(propSchema.enum) && propSchema.enum.length > 0) {
    qualifiers.push(`one of: ${propSchema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  if (baseType === 'number' || baseType === 'integer') {
    if (typeof propSchema.minimum === 'number') {
      qualifiers.push(`min ${propSchema.minimum}`);
    }
    if (typeof propSchema.maximum === 'number') {
      qualifiers.push(`max ${propSchema.maximum}`);
    }
  }
  if (qualifiers.length > 0) {
    type = `${type} (${qualifiers.join(', ')})`;
  }
  row.type = type;
  if (hasOwn(propSchema, 'default')) {
    row.hasDefault = true;
    row.default = JSON.stringify(propSchema.default);
  }
  if (typeof propSchema.description === 'string') {
    row.description = propSchema.description;
  }
  return row;
}

// Output-schema summary for the rendered "Output" section, or null when the
// tool does not declare an outputSchema. Fields reuse normalizeParameter, so
// `required` here means "always present on success results".
function normalizeOutput(outputSchema) {
  if (!outputSchema || typeof outputSchema !== 'object' || Array.isArray(outputSchema)) {
    return null;
  }
  const properties =
    outputSchema.properties && typeof outputSchema.properties === 'object'
      ? outputSchema.properties
      : {};
  const requiredNames = Array.isArray(outputSchema.required)
    ? outputSchema.required.filter((entry) => typeof entry === 'string')
    : [];
  return {
    description:
      typeof outputSchema.description === 'string' ? outputSchema.description : '',
    fields: Object.keys(properties).map((key) =>
      normalizeParameter(key, properties[key], requiredNames)
    ),
  };
}

function buildToolDoc(tool, metadata, parseFailed) {
  const name = typeof tool.name === 'string' ? tool.name : '(unnamed tool)';
  const description = typeof tool.description === 'string' ? tool.description : '';
  const schema =
    tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {};
  const properties =
    schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const requiredNames = Array.isArray(schema.required)
    ? schema.required.filter((entry) => typeof entry === 'string')
    : [];
  const parameters = Object.keys(properties).map((key) =>
    normalizeParameter(key, properties[key], requiredNames)
  );
  return {
    name,
    description,
    parameters,
    output: normalizeOutput(tool.outputSchema),
    hasConfirmDestructive: hasOwn(properties, 'confirmDestructive'),
    confirmDestructiveRequired: requiredNames.includes('confirmDestructive'),
    hasDryRun: hasOwn(properties, 'dryRun'),
    metadata,
    parseFailed,
  };
}

function familyOf(toolName) {
  const idx = toolName.indexOf('_');
  return idx === -1 ? toolName : toolName.slice(0, idx + 1);
}

function slugifyHeading(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\- ]/g, '')
    .replace(/ /g, '-');
}

function escapeTableCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function renderSafetyLine(doc) {
  if (!doc.hasConfirmDestructive && !doc.hasDryRun) {
    return '';
  }
  const parts = [];
  if (doc.hasConfirmDestructive) {
    parts.push(
      doc.confirmDestructiveRequired
        ? 'mutating - requires `confirmDestructive: true`'
        : 'mutating - gated by `confirmDestructive`'
    );
  }
  if (doc.hasDryRun) {
    parts.push('supports `dryRun`');
  }
  return `- Safety: ${parts.join('; ')}`;
}

function renderToolSection(doc) {
  const lines = [`### ${doc.name}`, ''];
  if (doc.description) {
    lines.push(doc.description, '');
  }
  lines.push(`- Version: \`${doc.metadata.version}\``);
  if (doc.metadata.deprecated) {
    const replacedBy = doc.metadata.replacedBy ? ` - replaced by \`${doc.metadata.replacedBy}\`` : '';
    const reason = doc.metadata.deprecationReason ? ` (${doc.metadata.deprecationReason})` : '';
    lines.push(`- Deprecated: yes${replacedBy}${reason}`);
  }
  const safetyLine = renderSafetyLine(doc);
  if (safetyLine) {
    lines.push(safetyLine);
  }
  if (doc.parseFailed) {
    lines.push(
      '- Note: schema block could not be fully parsed; parameter details degraded to `unknown`.'
    );
  }
  lines.push('');
  if (doc.parameters.length === 0) {
    lines.push('This tool has no input parameters.', '');
  } else {
    lines.push(
      '| Parameter | Type | Required | Default | Description |',
      '| --- | --- | --- | --- | --- |'
    );
    for (const param of doc.parameters) {
      const cells = [
        `\`${escapeTableCell(param.name)}\``,
        `\`${escapeTableCell(param.type)}\``,
        param.required ? 'yes' : 'no',
        param.hasDefault ? `\`${escapeTableCell(param.default)}\`` : '',
        escapeTableCell(param.description),
      ];
      lines.push(`| ${cells.join(' | ')} |`);
    }
    lines.push('');
  }
  lines.push(...renderOutputSection(doc));
  return lines;
}

// "Output" section for a tool that declares an outputSchema: success results
// carry `structuredContent` matching the schema, so the section documents the
// top-level fields the same way the parameter table documents inputs.
function renderOutputSection(doc) {
  if (!doc.output) {
    return [];
  }
  const lines = ['Output (`structuredContent` on success results):', ''];
  if (doc.output.description) {
    lines.push(doc.output.description, '');
  }
  if (doc.output.fields.length === 0) {
    lines.push('The output is a JSON object without documented fields.', '');
    return lines;
  }
  lines.push(
    '| Field | Type | Always present | Description |',
    '| --- | --- | --- | --- |'
  );
  for (const field of doc.output.fields) {
    const cells = [
      `\`${escapeTableCell(field.name)}\``,
      `\`${escapeTableCell(field.type)}\``,
      field.required ? 'yes' : 'no',
      escapeTableCell(field.description),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push('');
  return lines;
}

function renderMarkdown(toolDocs) {
  const families = [];
  const byFamily = new Map();
  for (const doc of toolDocs) {
    const family = familyOf(doc.name);
    if (!byFamily.has(family)) {
      byFamily.set(family, []);
      families.push(family);
    }
    byFamily.get(family).push(doc);
  }

  const lines = [
    '# SyncroNow AI MCP Tool Reference',
    '',
    '<!-- GENERATED FILE. Do not edit by hand. -->',
    `<!-- Regenerate with: ${GENERATOR_COMMAND} -->`,
    '',
    'This reference is generated from `packages/mcp-server/src/toolSchemas.ts`.',
    `Do not edit it manually; regenerate with \`${GENERATOR_COMMAND}\`.`,
    '',
    `Total tools: **${toolDocs.length}**.`,
    '',
    '## Contents',
    '',
  ];

  for (const family of families) {
    const docs = byFamily.get(family);
    const heading = `${family} tools`;
    lines.push(`- [${heading} (${docs.length})](#${slugifyHeading(heading)})`);
    for (const doc of docs) {
      lines.push(`  - [${doc.name}](#${slugifyHeading(doc.name)})`);
    }
  }
  lines.push('');

  for (const family of families) {
    const docs = byFamily.get(family);
    lines.push(`## ${family} tools`, '');
    for (const doc of docs) {
      lines.push(...renderToolSection(doc));
    }
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return `${lines.join('\n')}\n`;
}

function generateToolReference(opts = {}) {
  const toolSource = opts.toolSource || DEFAULT_TOOL_SOURCE;
  const raw = fs.readFileSync(toolSource, 'utf-8');
  const { defaults, overrides, errors: metadataErrors } = parseMetadata(raw);
  const blocks = extractToolBlocks(raw);
  const toolDocs = blocks.map((block) => {
    const { tool, parseFailed } = parseToolBlock(block);
    const metadata = { ...defaults, ...(overrides[tool.name] || {}) };
    return buildToolDoc(tool, metadata, parseFailed);
  });
  return {
    markdown: renderMarkdown(toolDocs),
    toolCount: toolDocs.length,
    toolNames: toolDocs.map((doc) => doc.name),
    degradedTools: toolDocs.filter((doc) => doc.parseFailed).map((doc) => doc.name),
    metadataErrors,
  };
}

function summarizeDiff(out, expected, actual) {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const max = Math.max(expectedLines.length, actualLines.length);
  let shown = 0;
  for (let i = 0; i < max && shown < 5; i += 1) {
    if (expectedLines[i] !== actualLines[i]) {
      out.error(`  line ${i + 1}:`);
      out.error(`    expected: ${(expectedLines[i] ?? '<missing>').slice(0, 120)}`);
      out.error(`    actual:   ${(actualLines[i] ?? '<missing>').slice(0, 120)}`);
      shown += 1;
    }
  }
  out.error(
    `  generated ${expectedLines.length} lines vs committed ${actualLines.length} lines.`
  );
}

function runCli(opts = {}) {
  const out = opts.console || console;
  const args = opts.args || process.argv.slice(2);
  const checkMode = args.includes('--check');
  const outputTarget = opts.outputTarget || DEFAULT_OUTPUT_TARGET;

  const result = generateToolReference(opts);
  if (result.metadataErrors.length > 0) {
    // The metadata blocks resolve every tool's version/deprecation lines. A block
    // this reader cannot resolve used to degrade to `{}`, which renders a
    // self-consistent but WRONG reference (deprecations vanish, overridden
    // versions regress to the default) that `--check` then blesses. Fail in every
    // mode, matching the degraded-tool and array-spread guards.
    out.error(
      `Tool reference ${checkMode ? 'check' : 'generation'} failed: tool lifecycle ` +
        'metadata could not be read.'
    );
    for (const message of result.metadataErrors) {
      out.error(`- ${message}`);
    }
    return 1;
  }
  if (result.degradedTools.length > 0) {
    // A degraded block means a tool schema could not be parsed, so its Output
    // section and parameter types are silently dropped from the reference.
    // Treat that as fatal in every mode — consistent with extractToolBlocks,
    // which throws on array-level spreads — so neither a fresh generate nor a
    // --check pass can quietly bless an incomplete doc.
    out.error(
      `Tool reference ${checkMode ? 'check' : 'generation'} failed: ` +
        `${result.degradedTools.length} tool block(s) degraded to fallback parsing ` +
        `(${result.degradedTools.join(', ')}). Their Output section and parameter ` +
        'types are dropped. Every tool schema must be an inline object literal — ' +
        'replace any shared or bare-identifier reference with the literal shape.'
    );
    return 1;
  }

  if (!checkMode) {
    fs.writeFileSync(outputTarget, result.markdown);
    out.log(
      `Tool reference generated (${result.toolCount} tools) at ${path.relative(process.cwd(), outputTarget)}.`
    );
    return 0;
  }

  if (!fs.existsSync(outputTarget)) {
    out.error(`Tool reference check failed: ${outputTarget} does not exist.`);
    out.error(`Run \`${GENERATOR_COMMAND}\` to generate it.`);
    return 1;
  }
  const committed = fs.readFileSync(outputTarget, 'utf-8');
  if (committed === result.markdown) {
    out.log(
      `Tool reference check passed (${result.toolCount} tools, ${path.basename(outputTarget)} is up to date).`
    );
    return 0;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-tool-reference-'));
  const tmpFile = path.join(tmpDir, 'MCP_TOOLS.md');
  fs.writeFileSync(tmpFile, result.markdown);
  out.error(`Tool reference check failed: ${outputTarget} is out of date.`);
  summarizeDiff(out, result.markdown, committed);
  out.error(`Freshly generated copy written to ${tmpFile}.`);
  out.error(`Run \`${GENERATOR_COMMAND}\` to regenerate.`);
  return 1;
}

function parseRuntimeOverrides(env = process.env) {
  const toolSource = typeof env.SYNC_TOOL_REFERENCE_TOOL_SOURCE === 'string'
    ? env.SYNC_TOOL_REFERENCE_TOOL_SOURCE.trim()
    : '';
  const outputTarget = typeof env.SYNC_TOOL_REFERENCE_OUTPUT === 'string'
    ? env.SYNC_TOOL_REFERENCE_OUTPUT.trim()
    : '';

  return {
    toolSource: toolSource || undefined,
    outputTarget: outputTarget || undefined,
  };
}

if (require.main === module) {
  const opts = parseRuntimeOverrides();
  const exitCode = runCli(opts);
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

module.exports = {
  extractToolBlocks,
  parseToolBlock,
  parseMetadata,
  buildToolDoc,
  normalizeParameter,
  renderMarkdown,
  generateToolReference,
  runCli,
  parseRuntimeOverrides,
  DEFAULT_TOOL_SOURCE,
  DEFAULT_OUTPUT_TARGET,
};
