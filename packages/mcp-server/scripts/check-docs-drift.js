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
const DOC_TOOL_REGEX = /\b(?:sync_[a-z0-9_]+|sn_[a-z0-9_]+|jira_[a-z0-9_]+|run_workspace_command|run_node_code)\b/g;

function parseToolNamesFromSchemas(raw) {
  return [...new Set([...raw.matchAll(TOOL_NAME_REGEX)].map((m) => m[1]))].sort();
}

function parseToolNamesFromDocs(raw) {
  return [...new Set([...raw.matchAll(DOC_TOOL_REGEX)].map((m) => m[0]))].sort();
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
  const catalogTools = parseToolNamesFromDocs(catalogRaw);
  const readmeTools = parseToolNamesFromDocs(readmeRaw);

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
    out.error('  Missing in docs:');
    for (const name of drift.missingInDocs) {
      out.error(`  - ${name}`);
    }
  }
  if (drift.extraInDocs.length > 0) {
    out.error('  Extra in docs (not in schema):');
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
  parseToolNamesFromDocs,
  parseToolNamesFromSchemas,
  runCli,
  parseRuntimeOverrides,
  DEFAULT_TOOL_SOURCE,
  DEFAULT_CATALOG_SOURCE,
  DEFAULT_README_SOURCE,
};
