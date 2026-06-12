import { toJsonText } from "../runtimeUtils";
import {
  getSessionContext,
  listScopes,
  listUpdateSets,
  setCurrentScope,
  setCurrentUpdateSet,
} from "../sessionContext";

type ToolResponse = {
  isError: boolean;
  content: Array<{ type: string; text: string }>;
};

type SessionToolContext = {
  timeoutMs: number;
  dryRun: boolean;
  startedAt: number;
  buildPreflightReport: (
    timeoutMs: number,
    overrideConfig?: {
      expectedScope?: string;
      expectedUpdateSetName?: string;
      expectedUpdateSetSysId?: string;
    }
  ) => Promise<Record<string, unknown>>;
  checkSyncronaCapabilities: (
    timeoutMs: number,
    scopeCode?: string
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

function toStringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function handleSessionTool(
  toolName: string,
  args: Record<string, unknown>,
  context: SessionToolContext
): Promise<ToolResponse | null> {
  const { timeoutMs, dryRun, startedAt } = context;

  switch (toolName) {
    case "sync_preflight_check": {
      const expectedScope =
        typeof args.expectedScope === "string" ? args.expectedScope.trim() : "";
      const expectedUpdateSetName =
        typeof args.expectedUpdateSetName === "string"
          ? args.expectedUpdateSetName.trim()
          : "";
      const expectedUpdateSetSysId =
        typeof args.expectedUpdateSetSysId === "string"
          ? args.expectedUpdateSetSysId.trim()
          : "";

      const report = await context.buildPreflightReport(timeoutMs, {
        expectedScope,
        expectedUpdateSetName,
        expectedUpdateSetSysId,
      });
      const checks = asRecord(report.checks);
      return {
        isError: checks.allOk !== true,
        content: [{ type: "text", text: toJsonText(report) }],
      };
    }

    case "sync_get_session_context": {
      const sessionContext = await getSessionContext(timeoutMs);
      return {
        isError: false,
        content: [{ type: "text", text: toJsonText(sessionContext) }],
      };
    }

    case "sync_set_scope": {
      const scope = typeof args.scope === "string" ? args.scope.trim() : "";
      if (!scope) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing required field: scope" }],
        };
      }

      if (dryRun) {
        return context.makeDryRunAuditResponse(toolName, args, { scope });
      }

      const result = await setCurrentScope(scope, timeoutMs);
      context.auditMutatingTool(toolName, args, result, Date.now() - startedAt);
      return {
        isError: false,
        content: [{ type: "text", text: toJsonText(result) }],
      };
    }

    case "sync_list_scopes": {
      const query = typeof args.query === "string" ? args.query : "";
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.min(Math.max(Math.floor(args.limit), 1), 500)
          : 100;
      const result = await listScopes(timeoutMs, query, limit);
      return {
        isError: false,
        content: [{ type: "text", text: toJsonText({ count: result.length, rows: result }) }],
      };
    }

    case "sync_set_update_set": {
      const updateSetName =
        typeof args.updateSetName === "string" ? args.updateSetName.trim() : "";
      const updateSetSysId =
        typeof args.updateSetSysId === "string" ? args.updateSetSysId.trim() : "";
      const createIfMissing = args.createIfMissing !== false;

      if (!updateSetName && !updateSetSysId) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Provide at least one of updateSetName or updateSetSysId.",
            },
          ],
        };
      }

      if (dryRun) {
        return context.makeDryRunAuditResponse(toolName, args, {
          updateSetName,
          updateSetSysId,
          createIfMissing,
        });
      }

      const result = await setCurrentUpdateSet(
        {
          updateSetName,
          updateSetSysId,
          createIfMissing,
        },
        timeoutMs
      );

      context.auditMutatingTool(toolName, args, result, Date.now() - startedAt);

      return {
        isError: false,
        content: [{ type: "text", text: toJsonText(result) }],
      };
    }

    case "sync_list_update_sets": {
      const query = typeof args.query === "string" ? args.query : "";
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.min(Math.max(Math.floor(args.limit), 1), 500)
          : 100;
      const result = await listUpdateSets(timeoutMs, query, limit);
      return {
        isError: false,
        content: [{ type: "text", text: toJsonText({ count: result.length, rows: result }) }],
      };
    }

    case "sync_prepare_session": {
      const expectedScope =
        typeof args.expectedScope === "string" ? args.expectedScope.trim() : "";
      const expectedUpdateSetName =
        typeof args.expectedUpdateSetName === "string"
          ? args.expectedUpdateSetName.trim()
          : "";
      const expectedUpdateSetSysId =
        typeof args.expectedUpdateSetSysId === "string"
          ? args.expectedUpdateSetSysId.trim()
          : "";
      const createUpdateSetIfMissing = args.createUpdateSetIfMissing !== false;

      if (dryRun) {
        return context.makeDryRunAuditResponse(toolName, args, {
          expectedScope,
          expectedUpdateSetName,
          expectedUpdateSetSysId,
          createUpdateSetIfMissing,
        });
      }

      const initialContext = await getSessionContext(timeoutMs);
      const actions: string[] = [];

      const initialScope = toStringField(asRecord(initialContext.scope).scope);
      if (expectedScope && initialScope !== expectedScope) {
        await setCurrentScope(expectedScope, timeoutMs);
        actions.push(`scope changed: ${initialScope || "<empty>"} -> ${expectedScope}`);
      }

      if (expectedUpdateSetName || expectedUpdateSetSysId) {
        const initialUpdateSetSysId = toStringField(
          asRecord(initialContext.updateSet).sysId
        );
        const needsChange =
          (expectedUpdateSetSysId && initialUpdateSetSysId !== expectedUpdateSetSysId) ||
          (!!expectedUpdateSetName && !expectedUpdateSetSysId);

        if (needsChange) {
          const updateRes = await setCurrentUpdateSet(
            {
              updateSetName: expectedUpdateSetName,
              updateSetSysId: expectedUpdateSetSysId,
              createIfMissing: createUpdateSetIfMissing,
            },
            timeoutMs
          );
          const target = asRecord(updateRes.targetUpdateSet);
          actions.push(
            `update set changed: ${initialUpdateSetSysId || "<empty>"} -> ${toStringField(
              target.sysId
            )}`
          );
        }
      }

      const finalContext = await getSessionContext(timeoutMs);

      const resultPayload = {
        actions,
        changed: actions.length > 0,
        initialContext,
        finalContext,
      };

      context.auditMutatingTool(toolName, args, resultPayload, Date.now() - startedAt);

      return {
        isError: false,
        content: [
          {
            type: "text",
            text: toJsonText(resultPayload),
          },
        ],
      };
    }

    case "sync_check_instance_capabilities": {
      const scope = typeof args.scope === "string" ? args.scope.trim() : "";
      const capabilityResults = await context.checkSyncronaCapabilities(
        timeoutMs,
        scope || undefined
      );
      const records = Object.values(capabilityResults).filter(
        (value): value is Record<string, unknown> => !!value && typeof value === "object"
      );
      const hasFailures = records.some((value) => value.ok !== true);
      return {
        isError: hasFailures,
        content: [{ type: "text", text: toJsonText(capabilityResults) }],
      };
    }

    default:
      return null;
  }
}
