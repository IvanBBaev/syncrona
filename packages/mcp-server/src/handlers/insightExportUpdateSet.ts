// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { escapeQueryValue } from "../runtimeUtils";
import { snRequest, toTableResultRows } from "../servicenowCore";

import type { ToolResponse } from "../toolResponse";
import {
  describeNonTablePayload,
  errorResponse,
  resolveUpdateSetSysId,
  textResponse,
} from "./insightShared";

// --- E7: sync_export_update_set ------------------------------------------

// Update set records counted for the summary; more are flagged, not counted.
const RECORD_COUNT_LIMIT = 1000;

// export_update_set.do answers an XML unload; anything else (a login or
// maintenance page served with a 2xx, for instance) is not the update set.
function isUnloadXml(body: string): boolean {
  return /^\s*(?:<\?xml|<unload\b)/.test(body);
}

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
  const statusOk = exportResponse.status >= 200 && exportResponse.status <= 299;
  const notUnload = statusOk && !!xml.trim() && !isUnloadXml(xml);
  const isError = !statusOk || !xml.trim() || notUnload;

  const countParams = new URLSearchParams();
  countParams.set("sysparm_query", `update_set=${escapeQueryValue(resolved.sysId)}`);
  // One row past the limit tells a full count from a capped one.
  countParams.set("sysparm_limit", String(RECORD_COUNT_LIMIT + 1));
  countParams.set("sysparm_fields", "sys_id");
  const countResponse = await snRequest(
    "GET",
    `/api/now/table/sys_update_xml?${countParams.toString()}`,
    undefined,
    timeoutMs
  );
  // A count query that failed or answered a non-Table-API body counted nothing:
  // report the count as unknown rather than zero.
  const countOk =
    countResponse.status >= 200 &&
    countResponse.status <= 299 &&
    !describeNonTablePayload(countResponse.status, countResponse.data);
  const countedRows = countOk ? toTableResultRows(countResponse.data).length : 0;
  const recordCountTruncated = countedRows > RECORD_COUNT_LIMIT;
  const recordCount = countOk ? Math.min(countedRows, RECORD_COUNT_LIMIT) : null;
  const exportError = notUnload
    ? `Export returned HTTP ${exportResponse.status} with a body that is not an update set unload; ` +
      "the instance may be serving a login or maintenance page"
    : undefined;

  let savedTo: string | null = null;
  // A rejected export answers an error page, not the update set: never save it.
  if (args.writeFiles === true && !isError) {
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
          recordCountTruncated,
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
      recordCountTruncated,
      byteLength: Buffer.byteLength(xml, "utf8"),
      ...(exportError ? { error: exportError } : {}),
      savedTo,
      xml,
    },
    isError
  );
}
