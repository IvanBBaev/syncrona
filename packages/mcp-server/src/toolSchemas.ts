export type ToolLifecycleMetadata = {
  version: string;
  deprecated: boolean;
  replacedBy?: string;
  deprecationReason?: string;
  sunsetDate?: string;
};

const DEFAULT_TOOL_METADATA: ToolLifecycleMetadata = {
  version: "1.0.0",
  deprecated: false,
};

const TOOL_METADATA_OVERRIDES: Record<string, Partial<ToolLifecycleMetadata>> = {
  run_workspace_command: {
    version: "1.1.0",
  },
  run_node_code: {
    version: "1.1.0",
  },
};

function buildToolMetadata(toolName: string): ToolLifecycleMetadata {
  const overrides = TOOL_METADATA_OVERRIDES[toolName] || {};
  return {
    ...DEFAULT_TOOL_METADATA,
    ...overrides,
  };
}

function withToolLifecycleMetadata(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return tools.map((tool) => {
    const name = typeof tool.name === "string" ? tool.name : "";
    return {
      ...tool,
      metadata: buildToolMetadata(name),
    };
  });
}

const BASE_MCP_TOOLS: Array<Record<string, unknown>> = [
  {
    name: "sync_status",
    description:
      "Show connected ServiceNow instance, scope and user from current SyncroNow AI project.",
    inputSchema: {
      type: "object",
      properties: {
        logLevel: {
          type: "string",
          enum: ["error", "warn", "info", "debug", "silly"],
          default: "info",
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
    },
  },
  {
    name: "sync_get_session_context",
    description:
      "Get current ServiceNow session context: active scope and active update set for current user.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
    },
  },
  {
    name: "sync_set_scope",
    description:
      "Set current ServiceNow scope for the current user session using scope code (for example x_nuvo_sinc).",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "sync_list_scopes",
    description:
      "List available scopes from sys_scope. Use optional encoded query to filter.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          default: "",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 500,
          default: 100,
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
    },
  },
  {
    name: "sync_set_update_set",
    description:
      "Set current ServiceNow update set for current user by name or sys_id. Optionally create missing set by name.",
    inputSchema: {
      type: "object",
      properties: {
        updateSetName: {
          type: "string",
          default: "",
        },
        updateSetSysId: {
          type: "string",
          default: "",
        },
        createIfMissing: {
          type: "boolean",
          default: true,
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
    },
  },
  {
    name: "sync_list_update_sets",
    description:
      "List update sets from sys_update_set. Use optional encoded query to filter.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          default: "",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 500,
          default: 100,
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
    },
  },
  {
    name: "sync_prepare_session",
    description:
      "Ensure expected scope and update set are active. It reads current context, applies changes when needed, and returns final context.",
    inputSchema: {
      type: "object",
      properties: {
        expectedScope: {
          type: "string",
          default: "",
        },
        expectedUpdateSetName: {
          type: "string",
          default: "",
        },
        expectedUpdateSetSysId: {
          type: "string",
          default: "",
        },
        createUpdateSetIfMissing: {
          type: "boolean",
          default: true,
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
    },
  },
  {
    name: "sync_preflight_check",
    description:
      "Validate current scope/update-set against guardrail expectations in sync.mcp.guardrails.json or provided overrides.",
    inputSchema: {
      type: "object",
      properties: {
        expectedScope: {
          type: "string",
          default: "",
        },
        expectedUpdateSetName: {
          type: "string",
          default: "",
        },
        expectedUpdateSetSysId: {
          type: "string",
          default: "",
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
    },
  },
  {
    name: "sync_check_instance_capabilities",
    description:
      "Check whether SyncroNow AI scoped-app endpoints are available in the target ServiceNow instance.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description:
            "Optional scope code for manifest check. Defaults to current session scope.",
          default: "",
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
    },
  },
  {
    name: "sync_refresh",
    description: "Refresh local SyncroNow AI manifest from the target instance.",
    inputSchema: {
      type: "object",
      properties: {
        logLevel: {
          type: "string",
          enum: ["error", "warn", "info", "debug", "silly"],
          default: "info",
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
    },
  },
  {
    name: "sync_build",
    description: "Build local files with SyncroNow AI.",
    inputSchema: {
      type: "object",
      properties: {
        diff: {
          type: "string",
          description: "Optional branch name for --diff build",
          default: "",
        },
        logLevel: {
          type: "string",
          enum: ["error", "warn", "info", "debug", "silly"],
          default: "info",
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
    },
  },
  {
    name: "sync_push",
    description:
      "Push files to ServiceNow instance using SyncroNow AI. Destructive action.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Optional encoded target path(s)",
          default: "",
        },
        diff: {
          type: "string",
          description: "Optional branch name for --diff",
          default: "",
        },
        scopeSwap: {
          type: "boolean",
          default: false,
        },
        updateSet: {
          type: "string",
          default: "",
        },
        logLevel: {
          type: "string",
          enum: ["error", "warn", "info", "debug", "silly"],
          default: "info",
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
        confirmDestructive: {
          type: "boolean",
          description: "Must be true to execute push.",
          default: false,
        },
        dryRun: {
          type: "boolean",
          default: false,
        },
      },
      required: ["confirmDestructive"],
    },
  },
  {
    name: "run_workspace_command",
    description:
      "Run a local command in the SyncroNow AI workspace for automation tasks.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Executable name (for example: node, npm, npx)",
        },
        args: {
          type: "array",
          items: { type: "string" },
          default: [],
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
        confirmDestructive: {
          type: "boolean",
          description:
            "Set true if running potentially destructive commands such as deploy/download.",
          default: false,
        },
      },
      required: ["command"],
    },
  },
  {
    name: "run_node_code",
    description: "Execute JavaScript code with Node.js in the project workspace.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
      required: ["code"],
    },
  },
  {
    name: "sn_query_records",
    description:
      "Query records from a ServiceNow table using sysparm_query and optionally analyze grouped counts.",
    inputSchema: {
      type: "object",
      properties: {
        table: {
          type: "string",
        },
        query: {
          type: "string",
          default: "",
        },
        fields: {
          type: "array",
          items: { type: "string" },
          default: [],
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 500,
          default: 50,
        },
        analyzeField: {
          type: "string",
          description: "Optional field name for grouped count analysis",
          default: "",
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
      required: ["table"],
    },
  },
  {
    name: "sn_create_record",
    description: "Create a record in any ServiceNow table.",
    inputSchema: {
      type: "object",
      properties: {
        table: {
          type: "string",
        },
        record: {
          type: "object",
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
        confirmDestructive: {
          type: "boolean",
          default: false,
        },
        dryRun: {
          type: "boolean",
          default: false,
        },
      },
      required: ["table", "record", "confirmDestructive"],
    },
  },
  {
    name: "sn_execute_background_script",
    description:
      "Execute ServiceNow background script and return raw output/result for analysis.",
    inputSchema: {
      type: "object",
      properties: {
        script: {
          type: "string",
        },
        endpointPath: {
          type: "string",
          description:
            "Optional API path for custom script execution endpoint. Default: /api/x_nuvo_sinc/sinc/runBackgroundScript",
          default: "",
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
        confirmDestructive: {
          type: "boolean",
          default: false,
        },
        dryRun: {
          type: "boolean",
          default: false,
        },
      },
      required: ["script", "confirmDestructive"],
    },
  },
  {
    name: "sync_create_script_include",
    description:
      "Create sys_script_include record, then optionally run sync refresh so the file is downloaded locally.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
        },
        apiName: {
          type: "string",
          default: "",
        },
        script: {
          type: "string",
          default: "",
        },
        active: {
          type: "boolean",
          default: true,
        },
        clientCallable: {
          type: "boolean",
          default: false,
        },
        refreshAfterCreate: {
          type: "boolean",
          default: true,
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
        confirmDestructive: {
          type: "boolean",
          default: false,
        },
        dryRun: {
          type: "boolean",
          default: false,
        },
      },
      required: ["name", "confirmDestructive"],
    },
  },
  {
    name: "sync_create_script_include_and_sync",
    description:
      "Create Script Include, refresh manifest/files, and return local candidate file paths for immediate editing.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
        },
        apiName: {
          type: "string",
          default: "",
        },
        script: {
          type: "string",
          default: "",
        },
        active: {
          type: "boolean",
          default: true,
        },
        clientCallable: {
          type: "boolean",
          default: false,
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
        confirmDestructive: {
          type: "boolean",
          default: false,
        },
        dryRun: {
          type: "boolean",
          default: false,
        },
      },
      required: ["name", "confirmDestructive"],
    },
  },
  {
    name: "sn_list_metadata_records",
    description:
      "List key ServiceNow metadata records with normalized schema (BR, Client Script, ACL, Dictionary, UI Policy, Scripted REST).",
    inputSchema: {
      type: "object",
      properties: {
        recordType: {
          type: "string",
          enum: ["business_rule", "client_script", "ui_script", "ui_action", "ui_formatter", "acl", "dictionary", "ui_policy", "scripted_rest", "scheduled_job"],
        },
        query: {
          type: "string",
          default: "",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 500,
          default: 100,
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
      required: ["recordType"],
    },
  },
  {
    name: "sn_get_metadata_record",
    description: "Get one metadata record by sys_id and normalize output.",
    inputSchema: {
      type: "object",
      properties: {
        recordType: {
          type: "string",
          enum: ["business_rule", "client_script", "ui_script", "ui_action", "ui_formatter", "acl", "dictionary", "ui_policy", "scripted_rest", "scheduled_job"],
        },
        sysId: {
          type: "string",
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
      required: ["recordType", "sysId"],
    },
  },
  {
    name: "sn_update_metadata_record",
    description: "Controlled update for core metadata records with dry-run and confirmation gate.",
    inputSchema: {
      type: "object",
      properties: {
        recordType: {
          type: "string",
          enum: ["business_rule", "client_script", "ui_script", "ui_action", "ui_formatter", "acl", "dictionary", "ui_policy", "scripted_rest", "scheduled_job"],
        },
        sysId: {
          type: "string",
        },
        updates: {
          type: "object",
        },
        confirmDestructive: {
          type: "boolean",
          default: false,
        },
        dryRun: {
          type: "boolean",
          default: false,
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
      required: ["recordType", "sysId", "updates", "confirmDestructive"],
    },
  },
  {
    name: "sn_build_dependency_graph",
    description: "Build dependency graph from script/metadata records and inferred references.",
    inputSchema: {
      type: "object",
      properties: {
        records: {
          type: "array",
          items: { type: "object" },
          default: [],
        },
      },
    },
  },
  {
    name: "sn_analyze_impact",
    description: "Return ranked impact if target graph node changes.",
    inputSchema: {
      type: "object",
      properties: {
        graph: {
          type: "object",
        },
        targetId: {
          type: "string",
        },
      },
      required: ["graph", "targetId"],
    },
  },
  {
    name: "sn_diff_dependency_graphs",
    description: "Compare before/after dependency graphs and return deterministic added/removed nodes and edges.",
    inputSchema: {
      type: "object",
      properties: {
        beforeGraph: { type: "object" },
        afterGraph: { type: "object" },
      },
      required: ["beforeGraph", "afterGraph"],
    },
  },
  {
    name: "sync_detect_drift",
    description: "Compare local and instance record states and report drift summary with actions.",
    inputSchema: {
      type: "object",
      properties: {
        localRecords: {
          type: "array",
          items: { type: "object" },
          default: [],
        },
        instanceRecords: {
          type: "array",
          items: { type: "object" },
          default: [],
        },
        updateSetSysId: {
          type: "string",
          default: "",
        },
      },
    },
  },
  {
    name: "sync_validate_change_package",
    description: "Validate that selected records include required dependencies.",
    inputSchema: {
      type: "object",
      properties: {
        selectedIds: {
          type: "array",
          items: { type: "string" },
          default: [],
        },
        graph: {
          type: "object",
        },
      },
      required: ["selectedIds", "graph"],
    },
  },
  {
    name: "sync_build_semantic_index",
    description: "Build semantic symbol index from local source files.",
    inputSchema: {
      type: "object",
    },
  },
  {
    name: "sync_search_semantic_index",
    description: "Search current semantic symbol index.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          default: "",
        },
      },
    },
  },
  {
    name: "sync_symbol_cross_reference",
    description: "Summarize semantic symbol cross-references by symbol name, files, and occurrences.",
    inputSchema: {
      type: "object",
    },
  },
  {
    name: "sn_analyze_script_architecture",
    description: "Run architecture anti-pattern analysis for a script.",
    inputSchema: {
      type: "object",
      properties: {
        script: {
          type: "string",
        },
      },
      required: ["script"],
    },
  },
  {
    name: "sn_analyze_script_security",
    description: "Run security-focused static analysis for a script.",
    inputSchema: {
      type: "object",
      properties: {
        script: {
          type: "string",
        },
      },
      required: ["script"],
    },
  },
  {
    name: "sn_analyze_script_performance",
    description: "Run performance-focused static analysis for a script.",
    inputSchema: {
      type: "object",
      properties: {
        script: {
          type: "string",
        },
      },
      required: ["script"],
    },
  },
  {
    name: "sn_analyze_script_full",
    description: "Unified architecture/security/performance script analysis with suppression and weighted risk summary.",
    inputSchema: {
      type: "object",
      properties: {
        script: {
          type: "string",
        },
        suppressedIds: {
          type: "array",
          items: { type: "string" },
          default: [],
        },
        policy: {
          type: "object",
          default: {},
        },
        nowIso: {
          type: "string",
          default: "",
        },
      },
      required: ["script"],
    },
  },
  {
    name: "sn_autonomous_remediation_workflow",
    description: "Detect, propose patch, dry-run/apply, and validate script remediations with approval gate.",
    inputSchema: {
      type: "object",
      properties: {
        script: {
          type: "string",
        },
        apply: {
          type: "boolean",
          default: false,
        },
        dryRun: {
          type: "boolean",
          default: true,
        },
        confirmDestructive: {
          type: "boolean",
          default: false,
        },
      },
      required: ["script"],
    },
  },
  {
    name: "sync_health_check",
    description: "Return MCP health, endpoint diagnostics timeline, and per-tool reliability metrics.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
    },
  },
  {
    name: "sync_metrics_trend",
    description: "Compute trend deltas between previous and current diagnostics windows.",
    inputSchema: {
      type: "object",
    },
  },
  {
    name: "sync_tool_contract_info",
    description: "Return tool-contract version, declared tool list, and deterministic contract hash for capability negotiation.",
    inputSchema: {
      type: "object",
    },
  },
  {
    name: "sync_table_api_coverage_matrix",
    description: "Return current metadata/object coverage matrix and supported operations via Table API.",
    inputSchema: {
      type: "object",
    },
  },
  {
    name: "sync_plan_minimal_footprint",
    description: "Rank where-to-modify targets for a task using graph context and minimal-footprint scoring.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        graph: { type: "object" },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 20,
          default: 5,
        },
      },
      required: ["task", "graph"],
    },
  },
  {
    name: "sync_ai_next_actions",
    description: "Generate prioritized AI next actions and recommended tool calls from a natural-language objective.",
    inputSchema: {
      type: "object",
      properties: {
        objective: {
          type: "string",
        },
        maxSteps: {
          type: "number",
          minimum: 1,
          maximum: 10,
          default: 5,
        },
        currentContext: {
          type: "object",
          default: {},
        },
        constraints: {
          type: "object",
          default: {},
        },
      },
      required: ["objective"],
    },
  },
  {
    name: "sync_generate_scope_knowledge",
    description: "Generate scope knowledge artifacts (md + json) and optionally write them under .syncrona-mcp/scopes/.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", default: "" },
        entities: {
          type: "array",
          items: { type: "object" },
          default: [],
        },
        graph: { type: "object", default: {} },
        risks: {
          type: "array",
          items: { type: "object" },
          default: [],
        },
        suppressions: {
          type: "array",
          items: { type: "object" },
          default: [],
        },
        updateSetContext: { type: "object", default: {} },
        task: { type: "string", default: "" },
        writeFiles: { type: "boolean", default: false },
        trigger: {
          type: "string",
          enum: ["manual", "init", "refresh", "successful_change", "drift"],
          default: "manual",
        },
        dryRun: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "sync_generate_scope_docs",
    description: "Generate full scope documentation bundle under .syncrona-mcp/docs/{scope}/ with overview, dependencies, table relationships, and per-object docs.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", default: "" },
        entities: {
          type: "array",
          items: { type: "object" },
          default: [],
        },
        graph: { type: "object", default: {} },
        task: { type: "string", default: "scope docs" },
        includeFields: { type: "boolean", default: true },
        includeDiagrams: { type: "boolean", default: true },
        includeScheduledJobs: { type: "boolean", default: true },
        includeCrossScope: { type: "boolean", default: true },
        writeFiles: { type: "boolean", default: false },
        dryRun: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "sync_validate_scope_knowledge",
    description: "Validate scope knowledge json payload against required schema fields.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "object" },
      },
      required: ["index"],
    },
  },
  {
    name: "sync_scope_knowledge_auto_update",
    description: "Run trigger-based scope knowledge update contract for init/refresh/successful_change/drift.",
    inputSchema: {
      type: "object",
      properties: {
        trigger: {
          type: "string",
          enum: ["init", "refresh", "successful_change", "drift"],
        },
        scope: { type: "string", default: "" },
        entities: {
          type: "array",
          items: { type: "object" },
          default: [],
        },
        graph: { type: "object", default: {} },
        task: { type: "string", default: "" },
        writeFiles: { type: "boolean", default: false },
        dryRun: { type: "boolean", default: false },
      },
      required: ["trigger"],
    },
  },
  {
    name: "sync_generate_table_dependency_report",
    description: "One-command table dependency report generation with deterministic output paths under .syncrona-mcp/reports/.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", default: "" },
        task: { type: "string", default: "table dependencies report" },
        writeFiles: { type: "boolean", default: false },
        dryRun: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "sync_analyze_scope_relations",
    description: "Analyze scope tables and relations (explicit, hidden, inferred) from ServiceNow metadata and local workspace evidence.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", default: "" },
        includeWorkspace: { type: "boolean", default: true },
        includeServiceNow: { type: "boolean", default: true },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
    },
  },
  {
    name: "sync_onboarding_bootstrap",
    description: "Return onboarding wizard/checklist with sensible defaults and quickstart guidance.",
    inputSchema: {
      type: "object",
    },
  },
  {
    name: "sn_render_analysis_markdown",
    description: "Render unified full analysis report as deterministic markdown output.",
    inputSchema: {
      type: "object",
      properties: {
        report: {
          type: "object",
        },
      },
      required: ["report"],
    },
  },
  {
    name: "sync_unified_change_workflow",
    description:
      "Run one-command workflow shell: preflight, deep analysis, minimal-footprint check, approval gate, and optional apply.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
        },
        script: {
          type: "string",
          default: "",
        },
        taskType: {
          type: "string",
          enum: ["script", "metadata", "hybrid"],
          default: "hybrid",
        },
        executionMode: {
          type: "string",
          enum: ["mocked", "remote"],
          default: "mocked",
        },
        allowRemoteApply: {
          type: "boolean",
          default: false,
        },
        remoteScript: {
          type: "string",
          default: "",
        },
        remoteEndpoint: {
          type: "string",
          default: "",
        },
        proposedChanges: {
          type: "array",
          items: { type: "object" },
          default: [],
        },
        footprintBudget: {
          type: "object",
          default: {},
        },
        riskLevel: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
        },
        approval: {
          type: "object",
          default: {},
        },
        rollbackEvidence: {
          type: "object",
          default: {},
        },
        policy: {
          type: "object",
          default: {},
        },
        apply: {
          type: "boolean",
          default: false,
        },
        confirmDestructive: {
          type: "boolean",
          default: false,
        },
        writeSimulationReport: {
          type: "boolean",
          default: false,
        },
        simulationId: {
          type: "string",
          default: "",
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
      required: ["task"],
    },
  },
  {
    name: "sync_list_recent_changes",
    description:
      "List recent changes in a scope from sys_update_xml since a timestamp (default 24h), grouped by record.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description: "Scope code to filter changes (for example x_nuvo_sinc).",
        },
        since: {
          type: "string",
          description: "ISO timestamp lower bound. Defaults to 24 hours ago.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 200,
          default: 50,
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "sn_search_scripts",
    description:
      "Full-text search across ServiceNow script tables (script includes, business rules, client scripts, UI scripts, scripted REST, transform scripts) and return matches with excerpts.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text to search for inside script fields.",
        },
        scope: {
          type: "string",
          description: "Optional scope code to restrict the search.",
        },
        tables: {
          type: "array",
          items: { type: "string" },
          description: "Optional subset of script tables to search.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 100,
          default: 20,
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "sn_get_record_history",
    description:
      "Get the change history (sys_audit) for a single record, including field-level old/new values.",
    inputSchema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          description: "Table name of the audited record.",
        },
        sysId: {
          type: "string",
          description: "sys_id of the record to inspect.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 200,
          default: 20,
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
      required: ["table", "sysId"],
    },
  },
  {
    name: "sync_generate_release_notes",
    description:
      "Generate release notes from an Update Set's sys_update_xml records, grouped by table, in markdown or json.",
    inputSchema: {
      type: "object",
      properties: {
        updateSetSysId: {
          type: "string",
          description: "sys_id of the update set. Provide this or updateSetName.",
        },
        updateSetName: {
          type: "string",
          description: "Name of the update set. Used when updateSetSysId is not supplied.",
        },
        format: {
          type: "string",
          enum: ["markdown", "json"],
          default: "markdown",
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
    },
  },
  {
    name: "sync_run_atf_tests",
    description:
      "Trigger ATF test execution in the instance (a single test, a suite, or all suites in a scope) and poll for pass/fail results per step.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description: "Scope code that owns the ATF tests (for example x_nuvo_sinc).",
        },
        suiteId: {
          type: "string",
          description: "sys_id of an ATF test suite to run.",
        },
        testId: {
          type: "string",
          description: "sys_id of a single ATF test to run.",
        },
        runAll: {
          type: "boolean",
          default: false,
          description: "Run all ATF suites in the scope. Used when suiteId and testId are omitted.",
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "sync_validate_before_push",
    description:
      "Pre-push validation pipeline: runs security/architecture analysis on a scope's scripts, checks for recent conflicting changes, and reports ready or blocked per record.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description: "Scope code to validate (for example x_nuvo_sinc).",
        },
        tables: {
          type: "array",
          items: { type: "string" },
          description: "Optional subset of script tables to validate.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 200,
          default: 50,
        },
        conflictWindowHours: {
          type: "number",
          minimum: 1,
          maximum: 720,
          default: 24,
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "sync_compare_instances",
    description:
      "Compare a scope's script records between two stored instance profiles (for example dev vs prod) and report records that are only in one side or differ by content.",
    inputSchema: {
      type: "object",
      properties: {
        profileA: {
          type: "string",
          description: "First stored instance profile name (as saved by syncro-now-ai login).",
        },
        profileB: {
          type: "string",
          description: "Second stored instance profile name.",
        },
        scope: {
          type: "string",
          description: "Scope code to compare.",
        },
        tables: {
          type: "array",
          items: { type: "string" },
          description: "Optional subset of script tables to compare.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 500,
          default: 200,
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
      required: ["profileA", "profileB", "scope"],
    },
  },
  {
    name: "sync_export_update_set",
    description:
      "Export an Update Set as XML via the export_update_set processor and return the XML plus metadata; optionally writes it under .syncrona-mcp/exports.",
    inputSchema: {
      type: "object",
      properties: {
        updateSetSysId: {
          type: "string",
          description: "sys_id of the update set. Provide this or updateSetName.",
        },
        updateSetName: {
          type: "string",
          description: "Name of the update set. Used when updateSetSysId is not supplied.",
        },
        writeFiles: {
          type: "boolean",
          default: false,
          description: "When true, write the XML to .syncrona-mcp/exports/{name}.xml.",
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
    },
  },
  {
    name: "sync_suggest_tests",
    description:
      "Generate an ATF (Automated Test Framework) server-side test skeleton from a Script Include. Fetches the Script Include script from the instance (unless script is provided inline), analyzes its public methods, and returns a ready-to-paste ATF test script plus import instructions.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description: "Scope code of the Script Include (for example x_nuvo_sinc). Defaults to current session scope.",
        },
        scriptIncludeName: {
          type: "string",
          description: "Name of the Script Include to generate tests for.",
        },
        scriptIncludeSysId: {
          type: "string",
          description: "Optional sys_id of the Script Include. Used instead of scriptIncludeName when provided.",
        },
        script: {
          type: "string",
          description: "Optional Script Include source. When provided, the instance is not queried and this source is analyzed directly.",
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
      required: ["scriptIncludeName"],
    },
  },
  {
    name: "sync_diff_instance_vs_local",
    description:
      "Compare local scoped files against the records on the instance. Fetches records from the given table/scope, compares them with the local copies, and reports changed, added (local-only) and removed (instance-only) records with a diff summary and race-condition warnings.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description: "Scope code to compare (for example x_nuvo_sinc). Defaults to current session scope.",
        },
        tableName: {
          type: "string",
          description: "Table to compare. Defaults to sys_script_include.",
        },
        recordName: {
          type: "string",
          description: "Optional single record name to limit the comparison to.",
        },
        timeoutMs: {
          type: "number",
          minimum: 1000,
          maximum: 900000,
        },
      },
    },
  },
];

export const MCP_TOOLS: Array<Record<string, unknown>> = withToolLifecycleMetadata(BASE_MCP_TOOLS);

const TOOL_METADATA_BY_NAME: Map<string, ToolLifecycleMetadata> = new Map(
  BASE_MCP_TOOLS
    .map((tool) => (typeof tool.name === "string" ? tool.name : ""))
    .filter((name) => name.length > 0)
    .map((name) => [name, buildToolMetadata(name)] as const)
);

export function getToolLifecycleMetadata(toolName: string): ToolLifecycleMetadata | undefined {
  return TOOL_METADATA_BY_NAME.get(toolName);
}
