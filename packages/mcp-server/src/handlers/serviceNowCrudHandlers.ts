// SPDX-License-Identifier: GPL-3.0-or-later
import { toJsonText, trimOutput } from "../runtimeUtils";
import { evaluateCreateTablePolicy } from "../createTablePolicy";
import { isSafeRemoteEndpoint } from "../endpointPolicy";
import {
  describeNonRecordPayload,
  runBackgroundScript,
  snRequest,
  summarizeRows,
  toTableResultRows,
} from "../servicenowCore";

import type { ToolResponse } from "../toolResponse";
import { describeNonTablePayload } from "./insightShared";

type ServiceNowCrudContext = {
  timeoutMs: number;
  dryRun: boolean;
  startedAt: number;
  createAndSyncScriptInclude: (
    params: {
      name: string;
      apiName?: string;
      script?: string;
      active?: boolean;
      clientCallable?: boolean;
      refreshAfterCreate?: boolean;
    },
    timeoutMs: number
  ) => Promise<Record<string, unknown>>;
  makeDryRunAuditResponse: (
    toolName: string,
    args: Record<string, unknown>,
    details: Record<string, unknown>
  ) => ToolResponse;
  auditMutatingTool: (
    toolName: string,
    args: Record<string, unknown>,
    outcome: Record<string, unknown>,
    durationMs?: number
  ) => void;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
}

export async function handleServiceNowCrudTool(
  toolName: string,
  args: Record<string, unknown>,
  context: ServiceNowCrudContext
): Promise<ToolResponse | null> {
  const { timeoutMs, dryRun, startedAt } = context;

  switch (toolName) {
    case "sn_query_records": {
      const table = typeof args.table === "string" ? args.table.trim() : "";
      if (!table) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing required field: table" }],
        };
      }

      const query = typeof args.query === "string" ? args.query : "";
      const fields = Array.isArray(args.fields)
        ? args.fields.filter((item): item is string => typeof item === "string")
        : [];
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.min(Math.max(Math.floor(args.limit), 1), 500)
          : 50;
      // Offset is plumbed like limit: a non-negative integer forwarded as
      // sysparm_offset; anything invalid is ignored rather than rejected.
      const offset =
        typeof args.offset === "number" && Number.isFinite(args.offset) && args.offset > 0
          ? Math.floor(args.offset)
          : 0;
      const analyzeField =
        typeof args.analyzeField === "string" ? args.analyzeField.trim() : "";

      // One row past the limit is requested so a result that fills the limit
      // exactly is told apart from one that was cut off at it.
      const params = new URLSearchParams();
      params.set("sysparm_query", query);
      params.set("sysparm_limit", String(limit + 1));
      if (offset > 0) {
        params.set("sysparm_offset", String(offset));
      }
      if (fields.length > 0) {
        // sysparm_fields limits the returned columns, so a grouping field left out
        // of the list would never be fetched and every row would count as empty.
        const requestedFields =
          analyzeField && !fields.includes(analyzeField) ? [...fields, analyzeField] : fields;
        params.set("sysparm_fields", requestedFields.join(","));
      }

      const response = await snRequest(
        "GET",
        `/api/now/table/${table}?${params.toString()}`,
        undefined,
        timeoutMs
      );

      // A login or maintenance page served with a 2xx carries no rows; read as
      // an empty result it would answer the query with "nothing matched".
      const statusOk = response.status >= 200 && response.status <= 299;
      const badPayload = statusOk ? describeNonTablePayload(response.status, response.data) : null;
      if (badPayload) {
        return {
          isError: true,
          content: [{ type: "text", text: `Query on ${table} returned ${badPayload}.` }],
        };
      }

      const allRows = toTableResultRows(response.data);
      const truncated = allRows.length > limit;
      const rows = truncated ? allRows.slice(0, limit) : allRows;
      const payload: Record<string, unknown> = {
        status: response.status,
        table,
        rowCount: rows.length,
        truncated,
        rows,
      };

      if (analyzeField) {
        payload.analysis = {
          field: analyzeField,
          counts: summarizeRows(rows, analyzeField),
        };
      }

      return {
        isError: response.status < 200 || response.status > 299,
        content: [{ type: "text", text: toJsonText(payload) }],
      };
    }

    case "sn_create_record": {
      const table = typeof args.table === "string" ? args.table.trim() : "";
      const record = asRecord(args.record);
      const confirmDestructive = args.confirmDestructive === true;

      if (!table) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing required field: table" }],
        };
      }

      // The table policy fires before the dry-run short-circuit and before the
      // confirmDestructive gate: a policy violation is an error even as a
      // rehearsal, so a dry run can never make a refused table look creatable.
      const tablePolicy = evaluateCreateTablePolicy(table);
      if (!tablePolicy.allowed) {
        return {
          isError: true,
          content: [{ type: "text", text: tablePolicy.reason }],
        };
      }

      if (!confirmDestructive) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Creating records modifies instance state. Re-run with confirmDestructive=true.",
            },
          ],
        };
      }

      if (dryRun) {
        return context.makeDryRunAuditResponse(toolName, args, {
          table,
          record,
        });
      }

      const response = await snRequest(
        "POST",
        `/api/now/table/${table}`,
        record,
        timeoutMs
      );

      const createOk = response.status >= 200 && response.status <= 299;
      const badPayload = createOk ? describeNonRecordPayload(response.status, response.data) : null;

      context.auditMutatingTool(
        toolName,
        args,
        { status: response.status, table, ...(badPayload ? { error: badPayload } : {}) },
        Date.now() - startedAt
      );

      return {
        isError: !createOk || badPayload !== null,
        content: [
          {
            type: "text",
            text: toJsonText({
              status: response.status,
              table,
              ...(badPayload
                ? { error: `No record is known to have been created: ${badPayload}.` }
                : {}),
              result: response.data,
            }),
          },
        ],
      };
    }

    case "sn_execute_background_script": {
      const script = typeof args.script === "string" ? args.script : "";
      const endpointPath =
        typeof args.endpointPath === "string" ? args.endpointPath.trim() : "";
      const confirmDestructive = args.confirmDestructive === true;

      if (!script.trim()) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing required field: script" }],
        };
      }

      // endpointPath is model-controlled and becomes the background-script POST
      // URL; constrain it the same way the unified-workflow remote path is so it
      // cannot be pointed at an arbitrary path (traversal / protocol-relative).
      if (endpointPath && !isSafeRemoteEndpoint(endpointPath)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "Unsafe endpointPath: must be a rooted API path with no '..' segments.",
            },
          ],
        };
      }

      if (!confirmDestructive) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "Background scripts can modify data. Re-run with confirmDestructive=true.",
            },
          ],
        };
      }

      if (dryRun) {
        return context.makeDryRunAuditResponse(toolName, args, {
          endpointPath,
          scriptLength: script.length,
        });
      }

      const response = await runBackgroundScript(script, timeoutMs, endpointPath);
      context.auditMutatingTool(toolName, args, {
        status: response.status,
        usedEndpoint: response.usedEndpoint,
      }, Date.now() - startedAt);
      return {
        isError: response.status < 200 || response.status > 299,
        content: [
          {
            type: "text",
            text: toJsonText({
              status: response.status,
              usedEndpoint: response.usedEndpoint,
              data: response.data,
              text: trimOutput(response.text),
            }),
          },
        ],
      };
    }

    case "sync_create_script_include": {
      const confirmDestructive = args.confirmDestructive === true;
      if (!confirmDestructive) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "Creating Script Includes modifies instance state. Re-run with confirmDestructive=true.",
            },
          ],
        };
      }

      const name = typeof args.name === "string" ? args.name.trim() : "";
      const apiName = typeof args.apiName === "string" ? args.apiName : "";
      const script = typeof args.script === "string" ? args.script : "";
      const active = args.active !== false;
      const clientCallable = args.clientCallable === true;
      const refreshAfterCreate = args.refreshAfterCreate !== false;

      if (!name) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing required field: name" }],
        };
      }

      if (dryRun) {
        return context.makeDryRunAuditResponse(toolName, args, {
          name,
          apiName,
          active,
          clientCallable,
          refreshAfterCreate,
          scriptLength: script.length,
        });
      }

      const flow = await context.createAndSyncScriptInclude(
        {
          name,
          apiName,
          script,
          active,
          clientCallable,
          refreshAfterCreate,
        },
        timeoutMs
      );

      context.auditMutatingTool(toolName, args, flow, Date.now() - startedAt);

      return {
        isError: flow.isFailure === true,
        content: [
          {
            type: "text",
            text: toJsonText(flow),
          },
        ],
      };
    }

    case "sync_create_script_include_and_sync": {
      const confirmDestructive = args.confirmDestructive === true;
      if (!confirmDestructive) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "Creating Script Includes modifies instance state. Re-run with confirmDestructive=true.",
            },
          ],
        };
      }

      const name = typeof args.name === "string" ? args.name.trim() : "";
      const apiName = typeof args.apiName === "string" ? args.apiName : "";
      const script = typeof args.script === "string" ? args.script : "";
      const active = args.active !== false;
      const clientCallable = args.clientCallable === true;

      if (!name) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing required field: name" }],
        };
      }

      if (dryRun) {
        return context.makeDryRunAuditResponse(toolName, args, {
          name,
          apiName,
          active,
          clientCallable,
          refreshAfterCreate: true,
          scriptLength: script.length,
        });
      }

      const flow = await context.createAndSyncScriptInclude(
        {
          name,
          apiName,
          script,
          active,
          clientCallable,
          refreshAfterCreate: true,
        },
        timeoutMs
      );

      context.auditMutatingTool(toolName, args, flow, Date.now() - startedAt);

      return {
        isError: flow.isFailure === true,
        content: [
          {
            type: "text",
            text: toJsonText(flow),
          },
        ],
      };
    }

    default:
      return null;
  }
}
