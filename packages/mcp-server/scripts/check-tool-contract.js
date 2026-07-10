// SPDX-License-Identifier: GPL-3.0-or-later
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
  'jira_get_issue',
  // Mutating and code-execution tools are the highest-risk part of the surface;
  // pin them explicitly so a rename/removal that silently drops a side-effecting
  // tool from the manifest is caught here, not in the field.
  'sync_set_scope',
  'sync_set_update_set',
  'sync_prepare_session',
  'sync_push',
  'sn_create_record',
  'sn_execute_background_script',
  'sync_create_script_include',
  'sync_create_script_include_and_sync',
  'sync_run_atf_tests',
  'run_node_code',
  'run_workspace_command',
  // Full-surface floor: the entries above pinned only part of the manifest, so a
  // deletion of any *unpinned* tool passed this gate silently. Every remaining
  // declared tool is pinned here so the floor covers the complete contract. The
  // gate also fails on declared-but-unpinned tools (see checkToolContract), so
  // adding a new tool to toolSchemas.ts requires extending this list in the same
  // change — the contract can neither shrink nor grow unnoticed.
  'sn_analyze_script_architecture',
  'sn_analyze_script_performance',
  'sn_get_metadata_record',
  'sn_get_record_history',
  'sn_query_records',
  'sn_search_scripts',
  'sync_ai_next_actions',
  'sync_build',
  'sync_check_instance_capabilities',
  'sync_compare_instances',
  'sync_diff_instance_vs_local',
  'sync_export_update_set',
  'sync_generate_release_notes',
  'sync_get_session_context',
  'sync_list_recent_changes',
  'sync_list_scopes',
  'sync_list_update_sets',
  'sync_refresh',
  'sync_search_semantic_index',
  'sync_status',
  'sync_suggest_tests',
  'sync_tool_contract_info',
  'sync_validate_before_push',
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
  // Parse the actual `name: "..."` tool declarations and match required tools
  // against that exact set. Substring matching (`raw.includes('name: "x"')`)
  // is brittle: it can be satisfied by an unrelated literal and does not model
  // "this tool is declared". Exact-set membership is precise and also feeds the
  // duplicate check below.
  const declared = [...raw.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const duplicates = [];
  for (const name of declared) {
    if (seen.has(name) && !duplicates.includes(name)) {
      duplicates.push(name);
    }
    seen.add(name);
  }
  const declaredSet = seen;
  const missing = requiredTools.filter((tool) => !declaredSet.has(tool));
  // Two-way contract: the declared set is derived from the source itself, and
  // any declared tool absent from the required floor fails the gate. Without
  // this, a newly added tool would stay unpinned forever and its later removal
  // would go unnoticed by the membership check above.
  const requiredSet = new Set(requiredTools);
  const unpinned = [...declaredSet].filter((tool) => !requiredSet.has(tool)).sort();
  return {
    ok: missing.length === 0 && duplicates.length === 0 && unpinned.length === 0,
    missing,
    duplicates,
    unpinned,
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
    if (result.missing.length > 0) {
      out.error('Tool contract check failed. Missing tools:');
      for (const tool of result.missing) {
        out.error(`- ${tool}`);
      }
    } else {
      out.error('Tool contract check failed.');
    }
    if (result.duplicates.length > 0) {
      out.error('Duplicate tool declarations:');
      for (const tool of result.duplicates) {
        out.error(`- ${tool}`);
      }
    }
    if (result.unpinned.length > 0) {
      out.error('Declared tools not pinned in the contract floor (add to REQUIRED_TOOLS):');
      for (const tool of result.unpinned) {
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
