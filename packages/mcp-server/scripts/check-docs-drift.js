// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TOOL_SOURCE = path.resolve(__dirname, '..', 'src', 'toolSchemas.ts');
const DEFAULT_CATALOG_SOURCE = path.resolve(
  __dirname,
  '..',
  'docs',
  'ai-context',
  'tools-catalog.md'
);
const DEFAULT_README_SOURCE = path.resolve(__dirname, '..', 'README.md');

const TOOL_NAME_REGEX = /name:\s*"([^"]+)"/g;

// A doc declares a tool at the start of a bullet, a table cell, or a heading,
// optionally wrapped in backticks. Prose is deliberately not a declaration site:
// a ServiceNow table name such as `sn_hr_core_case` mentioned in a sentence must
// not be mistaken for a tool that vanished from the schemas.
const DECLARATION_PREFIX = String.raw`^[ \t]*(?:[-*+][ \t]+|\|[ \t]*|#{1,6}[ \t]+)`;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseToolNamesFromSchemas(raw) {
  return [...new Set([...raw.matchAll(TOOL_NAME_REGEX)].map((m) => m[1]))].sort();
}

// Family prefixes ("sync_", "sn_", ...) come from the schema names themselves, so
// introducing a tool family never requires editing a hardcoded shape here — and
// never turns this gate into a check the docs cannot satisfy.
function deriveToolPrefixes(schemaTools) {
  const prefixes = new Set();
  for (const name of schemaTools) {
    const separator = name.indexOf('_');
    if (separator > 0) {
      prefixes.add(name.slice(0, separator + 1));
    }
  }
  return [...prefixes].sort();
}

// A doc declaration site (bullet, table cell, or heading start) whose leading
// token has the generic shape of a tool name (`family_member`) is treated as a
// documented tool, regardless of whether that family still survives in the current
// schema. Deriving the accepted shape from the surviving schema families alone hid
// a class of drift: when the LAST tool of a family was removed, that family's
// prefix vanished from the derived set, so a stale doc entry for the removed tool
// was no longer extracted and the gate passed on real drift. Matching the generic
// identifier shape keeps removed-last-of-family entries detectable, while the
// leading declaration marker still excludes tool-shaped table names in prose.
const DECLARATION_TOOL_REGEX = new RegExp(
  `${DECLARATION_PREFIX}\`?([a-z][a-z0-9]*_[a-z0-9_]+)\`?`,
  'gm'
);

// Word-boundary match on `_`-bearing identifiers: `sn_query` must not match
// inside `sn_query_table`.
function mentionsToolName(raw, name) {
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`).test(raw);
}

// Names known to the schemas are searched for literally; anything else is picked
// up only from a declaration site whose leading token has a generic tool-name
// shape, so a stale doc entry survives even after its family leaves the schema.
function parseToolNamesFromDocs(raw, schemaTools = []) {
  const found = new Set(schemaTools.filter((name) => mentionsToolName(raw, name)));

  for (const match of raw.matchAll(DECLARATION_TOOL_REGEX)) {
    found.add(match[1]);
  }

  return [...found].sort();
}

function compareToolSets(schemaTools, docTools) {
  const schema = new Set(schemaTools);
  const docs = new Set(docTools);

  const missingInDocs = schemaTools.filter((name) => !docs.has(name));
  const extraInDocs = docTools.filter((name) => !schema.has(name));

  return {
    missingInDocs,
    extraInDocs,
  };
}

function checkDocsDrift(opts = {}) {
  const toolSource = opts.toolSource || DEFAULT_TOOL_SOURCE;
  const catalogSource = opts.catalogSource || DEFAULT_CATALOG_SOURCE;
  const readmeSource = opts.readmeSource || DEFAULT_README_SOURCE;

  const toolRaw = fs.readFileSync(toolSource, 'utf-8');
  const catalogRaw = fs.readFileSync(catalogSource, 'utf-8');
  const readmeRaw = fs.readFileSync(readmeSource, 'utf-8');

  const schemaTools = parseToolNamesFromSchemas(toolRaw);
  const catalogTools = parseToolNamesFromDocs(catalogRaw, schemaTools);
  const readmeTools = parseToolNamesFromDocs(readmeRaw, schemaTools);

  const catalogDrift = compareToolSets(schemaTools, catalogTools);
  const readmeDrift = compareToolSets(schemaTools, readmeTools);

  const ok =
    catalogDrift.missingInDocs.length === 0 &&
    catalogDrift.extraInDocs.length === 0 &&
    readmeDrift.missingInDocs.length === 0 &&
    readmeDrift.extraInDocs.length === 0;

  return {
    ok,
    schemaToolCount: schemaTools.length,
    schemaTools,
    catalog: {
      source: catalogSource,
      toolCount: catalogTools.length,
      ...catalogDrift,
    },
    readme: {
      source: readmeSource,
      toolCount: readmeTools.length,
      ...readmeDrift,
    },
  };
}

function printDrift(out, label, drift) {
  if (drift.missingInDocs.length === 0 && drift.extraInDocs.length === 0) {
    out.log(`${label}: no drift detected.`);
    return;
  }

  out.error(`${label}: drift detected.`);
  if (drift.missingInDocs.length > 0) {
    out.error('  Declared in toolSchemas.ts but not documented:');
    for (const name of drift.missingInDocs) {
      out.error(`  - ${name}`);
    }
  }
  if (drift.extraInDocs.length > 0) {
    out.error('  Documented but not declared in toolSchemas.ts:');
    for (const name of drift.extraInDocs) {
      out.error(`  - ${name}`);
    }
  }
}

function runCli(opts = {}) {
  const out = opts.console || console;
  const result = checkDocsDrift(opts);

  if (!result.ok) {
    out.error(`Docs drift check failed (schema tools: ${result.schemaToolCount}).`);
    printDrift(out, 'tools-catalog', result.catalog);
    printDrift(out, 'mcp-readme', result.readme);
    return 1;
  }

  out.log(
    `Docs drift check passed (schema tools: ${result.schemaToolCount}, docs aligned).`
  );
  return 0;
}

function parseRuntimeOverrides(env = process.env) {
  const toolSource = typeof env.SYNC_DOCS_DRIFT_TOOL_SOURCE === 'string'
    ? env.SYNC_DOCS_DRIFT_TOOL_SOURCE.trim()
    : '';
  const catalogSource = typeof env.SYNC_DOCS_DRIFT_CATALOG_SOURCE === 'string'
    ? env.SYNC_DOCS_DRIFT_CATALOG_SOURCE.trim()
    : '';
  const readmeSource = typeof env.SYNC_DOCS_DRIFT_README_SOURCE === 'string'
    ? env.SYNC_DOCS_DRIFT_README_SOURCE.trim()
    : '';

  return {
    toolSource: toolSource || undefined,
    catalogSource: catalogSource || undefined,
    readmeSource: readmeSource || undefined,
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
  checkDocsDrift,
  compareToolSets,
  deriveToolPrefixes,
  parseToolNamesFromDocs,
  parseToolNamesFromSchemas,
  runCli,
  parseRuntimeOverrides,
  DEFAULT_TOOL_SOURCE,
  DEFAULT_CATALOG_SOURCE,
  DEFAULT_README_SOURCE,
};
