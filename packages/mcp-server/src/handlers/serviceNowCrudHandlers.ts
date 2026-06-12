import { toJsonText, trimOutput } from "../runtimeUtils";
import { runBackgroundScript, snRequest, summarizeRows, toTableResultRows } from "../servicenowCore";

type ToolResponse = {
  isError: boolean;
  content: Array<{ type: string; text: string }>;
};

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
      const analyzeField =
        typeof args.analyzeField === "string" ? args.analyzeField.trim() : "";

      const params = new URLSearchParams();
      params.set("sysparm_query", query);
      params.set("sysparm_limit", String(limit));
      if (fields.length > 0) {
        params.set("sysparm_fields", fields.join(","));
      }

      const response = await snRequest(
        "GET",
        `/api/now/table/${table}?${params.toString()}`,
        undefined,
        timeoutMs
      );

      const rows = toTableResultRows(response.data);
      const payload: Record<string, unknown> = {
        status: response.status,
        table,
        rowCount: rows.length,
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

      context.auditMutatingTool(toolName, args, { status: response.status, table }, Date.now() - startedAt);

      return {
        isError: response.status < 200 || response.status > 299,
        content: [
          {
            type: "text",
            text: toJsonText({
              status: response.status,
              table,
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
