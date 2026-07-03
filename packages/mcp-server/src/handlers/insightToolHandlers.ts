// SPDX-License-Identifier: GPL-3.0-or-later
// #44: this file was a ~1000-line "god module" bundling eight unrelated insight
// tools. It is now a thin re-export barrel plus the dispatcher, one cohesive
// sibling module per tool family so both named importers (tests) and the
// registration seam (toolModules.ts) keep working unchanged:
//   - insightShared:            shared response/query helpers + tool context
//   - insightRecentChanges:     sync_list_recent_changes
//   - insightScriptSearch:      sn_search_scripts
//   - insightRecordHistory:     sn_get_record_history
//   - insightReleaseNotes:      sync_generate_release_notes
//   - insightAtfTests:          sync_run_atf_tests (E1)
//   - insightValidateBeforePush: sync_validate_before_push (E2)
//   - insightCompareInstances:  sync_compare_instances (E5)
//   - insightExportUpdateSet:   sync_export_update_set (E7)
export * from "./insightShared";
export * from "./insightRecentChanges";
export * from "./insightScriptSearch";
export * from "./insightRecordHistory";
export * from "./insightReleaseNotes";
export * from "./insightAtfTests";
export * from "./insightValidateBeforePush";
export * from "./insightCompareInstances";
export * from "./insightExportUpdateSet";

import type { ToolResponse } from "../toolResponse";
import type { InsightToolContext } from "./insightShared";
import { handleListRecentChanges } from "./insightRecentChanges";
import { handleSearchScripts } from "./insightScriptSearch";
import { handleRecordHistory } from "./insightRecordHistory";
import { handleGenerateReleaseNotes } from "./insightReleaseNotes";
import { handleRunAtfTests } from "./insightAtfTests";
import { handleValidateBeforePush } from "./insightValidateBeforePush";
import { handleCompareInstances } from "./insightCompareInstances";
import { handleExportUpdateSet } from "./insightExportUpdateSet";

export async function handleInsightTool(
  toolName: string,
  args: Record<string, unknown>,
  context: InsightToolContext
): Promise<ToolResponse | null> {
  const { timeoutMs } = context;

  switch (toolName) {
    case "sync_list_recent_changes":
      return handleListRecentChanges(args, timeoutMs);
    case "sn_search_scripts":
      return handleSearchScripts(args, timeoutMs);
    case "sn_get_record_history":
      return handleRecordHistory(args, timeoutMs);
    case "sync_generate_release_notes":
      return handleGenerateReleaseNotes(args, timeoutMs);
    case "sync_run_atf_tests":
      return handleRunAtfTests(args, context);
    case "sync_validate_before_push":
      return handleValidateBeforePush(args, timeoutMs);
    case "sync_compare_instances":
      return handleCompareInstances(args, timeoutMs);
    case "sync_export_update_set":
      return handleExportUpdateSet(args, timeoutMs);
    default:
      return null;
  }
}
