// SPDX-License-Identifier: GPL-3.0-or-later
//
// The instance scan checks: ColumnTypeCheck() → scan_column_type_check,
// LinterCheck() → scan_linter_check, ScriptOnlyCheck() → scan_script_only_check
// and TableCheck() → scan_table_check. They share every field but the ones
// ColumnTypeCheck() and TableCheck() add.

import { CData, type FieldValue } from "../record";
import type { ArtefactSpec, BuildContext, Options } from "./shared";

const COMMON = [
  "name",
  "active",
  "category",
  "priority",
  "script",
  "shortDescription",
  "description",
  "resolutionDetails",
  "documentationUrl",
  "scoreMin",
  "scoreMax",
  "scoreScale",
  "runCondition",
  "findingType",
];

function check(table: string, extra: readonly string[], fields: (o: Options, ctx: BuildContext) => Record<string, FieldValue>): ArtefactSpec {
  return {
    properties: [...COMMON, ...extra],
    build(o, ctx) {
      return ctx.factory.createRecord({
        table,
        source: o.call.loc,
        installCategory: o.installCategory,
        explicitId: o.explicitId(),
        fields: {
          name: o.requiredString("name"),
          active: o.boolean("active") ?? true,
          category: o.requiredString("category"),
          priority: o.requiredString("priority"),
          script: new CData(o.string("script") ?? ""),
          short_description: o.requiredString("shortDescription"),
          description: o.string("description") ?? "",
          resolution_details: o.string("resolutionDetails") ?? "",
          documentation_url: o.string("documentationUrl") ?? "",
          score_min: o.number("scoreMin") ?? 0,
          score_max: o.number("scoreMax") ?? 100,
          score_scale: o.number("scoreScale") ?? 1,
          run_condition: o.string("runCondition") ?? "",
          finding_type: o.string("findingType") ?? "scan_finding",
          ...fields(o, ctx),
        },
      });
    },
  };
}

export const columnTypeCheck = check("scan_column_type_check", ["columnType"], (o) => ({
  column_type: o.requiredString("columnType"),
}));

export const linterCheck = check("scan_linter_check", [], () => ({}));

export const scriptOnlyCheck = check("scan_script_only_check", [], () => ({}));

export const tableCheck = check("scan_table_check", ["table", "advanced", "conditions", "useManifest"], (o, ctx) => {
  const table = o.requiredString("table");
  ctx.dictionary.refer("TableCheck", table, o.get("table")!.loc);
  return {
    table,
    advanced: o.boolean("advanced") ?? false,
    conditions: o.string("conditions") ?? "",
    use_manifest: o.boolean("useManifest") ?? false,
  };
});
