// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { escapeQueryValue } from "../runtimeUtils";
import { snRequest, toTableResultRows } from "../servicenowCore";

import type { ToolResponse } from "../toolResponse";
import { errorResponse, resolveUpdateSetSysId, textResponse } from "./insightShared";

// --- E7: sync_export_update_set ------------------------------------------

export function buildUpdateSetExportPath(name: string): string {
  const safe = (name || "").replace(/[^a-zA-Z0-9._-]/g, "_") || "update_set";
  return path.join(".syncrona-mcp", "exports", `${safe}.xml`);
}

export async function handleExportUpdateSet(
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<ToolResponse> {
  const resolved = await resolveUpdateSetSysId(args, timeoutMs);
  if ("error" in resolved) {
    return errorResponse(resolved.error);
  }

  const exportResponse = await snRequest(
    "GET",
    `/export_update_set.do?sysparm_sys_id=${encodeURIComponent(resolved.sysId)}`,
    undefined,
    timeoutMs
  );

  const xml = typeof exportResponse.text === "string" ? exportResponse.text : "";
  const isError = exportResponse.status < 200 || exportResponse.status > 299 || !xml.trim();

  const countParams = new URLSearchParams();
  countParams.set("sysparm_query", `update_set=${escapeQueryValue(resolved.sysId)}`);
  countParams.set("sysparm_limit", "1000");
  countParams.set("sysparm_fields", "type");
  const countResponse = await snRequest(
    "GET",
    `/api/now/table/sys_update_xml?${countParams.toString()}`,
    undefined,
    timeoutMs
  );
  const recordCount = toTableResultRows(countResponse.data).length;

  let savedTo: string | null = null;
  if (args.writeFiles === true && xml.trim()) {
    const relativePath = buildUpdateSetExportPath(resolved.label);
    const absolutePath = path.join(process.cwd(), relativePath);
    try {
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, xml, "utf8");
      savedTo = relativePath;
    } catch (error) {
      savedTo = null;
      return textResponse(
        {
          status: exportResponse.status,
          updateSet: resolved.label,
          sysId: resolved.sysId,
          recordCount,
          byteLength: Buffer.byteLength(xml, "utf8"),
          writeError: error instanceof Error ? error.message : String(error),
          xml,
        },
        true
      );
    }
  }

  return textResponse(
    {
      status: exportResponse.status,
      updateSet: resolved.label,
      sysId: resolved.sysId,
      recordCount,
      byteLength: Buffer.byteLength(xml, "utf8"),
      savedTo,
      xml,
    },
    isError
  );
}
