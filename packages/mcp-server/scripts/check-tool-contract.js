const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TOOL_SOURCE = path.resolve(__dirname, '..', 'src', 'toolSchemas.ts');
const REQUIRED_TOOLS = [
  'sync_preflight_check',
  'sn_list_metadata_records',
  'sn_update_metadata_record',
  'sn_build_dependency_graph',
  'sn_analyze_impact',
  'sn_diff_dependency_graphs',
  'sync_detect_drift',
  'sync_validate_change_package',
  'sync_build_semantic_index',
  'sync_symbol_cross_reference',
  'sn_analyze_script_security',
  'sn_analyze_script_full',
  'sync_table_api_coverage_matrix',
  'sync_plan_minimal_footprint',
  'sync_generate_scope_knowledge',
  'sync_generate_scope_docs',
  'sync_validate_scope_knowledge',
  'sync_scope_knowledge_auto_update',
  'sync_generate_table_dependency_report',
  'sync_analyze_scope_relations',
  'sync_onboarding_bootstrap',
  'sn_render_analysis_markdown',
  'sn_autonomous_remediation_workflow',
  'sync_unified_change_workflow',
  'sync_health_check',
  'sync_metrics_trend',
];

function hashToolContract(toolNames) {
  const sorted = [...toolNames].sort();
  const text = sorted.join('|');
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) + text.charCodeAt(i);
    hash >>>= 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function checkToolContract(sourceFilePath, requiredTools) {
  const raw = fs.readFileSync(sourceFilePath, 'utf-8');
  const missing = requiredTools.filter((tool) => !raw.includes(`name: "${tool}"`));
  const declared = [...raw.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const duplicates = [];
  for (const name of declared) {
    if (seen.has(name) && !duplicates.includes(name)) {
      duplicates.push(name);
    }
    seen.add(name);
  }
  return {
    ok: missing.length === 0 && duplicates.length === 0,
    missing,
    duplicates,
    checked: requiredTools.length,
    contractHash: hashToolContract(requiredTools),
  };
}

function runCli(opts = {}) {
  const sourceFilePath = opts.sourceFilePath || opts.indexFilePath || DEFAULT_TOOL_SOURCE;
  const requiredTools = Array.isArray(opts.requiredTools) ? opts.requiredTools : REQUIRED_TOOLS;
  const out = opts.console || console;

  const result = checkToolContract(sourceFilePath, requiredTools);
  if (!result.ok) {
    out.error('Tool contract check failed. Missing tools:');
    for (const tool of result.missing) {
      out.error(`- ${tool}`);
    }
    if (result.duplicates.length > 0) {
      out.error('Duplicate tool declarations:');
      for (const tool of result.duplicates) {
        out.error(`- ${tool}`);
      }
    }
    return 1;
  }

  out.log(`Tool contract check passed (${result.checked} tools, hash=${result.contractHash}).`);
  return 0;
}

function parseRuntimeOverrides(env = process.env) {
  const sourceFilePath = typeof env.SYNC_TOOL_CONTRACT_SOURCE === 'string'
    ? env.SYNC_TOOL_CONTRACT_SOURCE.trim()
    : '';
  const indexFilePath = typeof env.SYNC_TOOL_CONTRACT_INDEX === 'string'
    ? env.SYNC_TOOL_CONTRACT_INDEX.trim()
    : '';
  const rawRequired = typeof env.SYNC_TOOL_CONTRACT_REQUIRED === 'string'
    ? env.SYNC_TOOL_CONTRACT_REQUIRED
    : '';
  const requiredTools = rawRequired
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return {
    sourceFilePath: sourceFilePath || indexFilePath || undefined,
    indexFilePath: indexFilePath || undefined,
    requiredTools: requiredTools.length > 0 ? requiredTools : undefined,
  };
}

if (require.main === module) {
  const runtimeOpts = parseRuntimeOverrides();
  const exitCode = runCli(runtimeOpts);
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

module.exports = {
  checkToolContract,
  hashToolContract,
  runCli,
  parseRuntimeOverrides,
  DEFAULT_TOOL_SOURCE,
  DEFAULT_INDEX: DEFAULT_TOOL_SOURCE,
  REQUIRED_TOOLS,
};
