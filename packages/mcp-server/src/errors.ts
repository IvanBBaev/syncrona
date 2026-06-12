export type McpErrorCode =
  | "INVALID_ARGUMENTS"
  | "POLICY_VIOLATION"
  | "SHUTTING_DOWN"
  | "TOOL_EXECUTION"
  | "UNKNOWN";

export type McpErrorOptions = {
  code: McpErrorCode;
  details?: Record<string, unknown>;
  cause?: unknown;
};

export class McpError extends Error {
  code: McpErrorCode;
  details: Record<string, unknown>;
  cause?: unknown;

  constructor(message: string, options: McpErrorOptions) {
    super(message);
    this.name = "McpError";
    this.code = options.code;
    this.details = options.details || {};
    this.cause = options.cause;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

export function normalizeMcpError(error: unknown): McpError {
  if (error instanceof McpError) {
    return error;
  }

  if (error instanceof Error) {
    return new McpError(error.message, {
      code: "TOOL_EXECUTION",
      details: {},
      cause: error,
    });
  }

  if (typeof error === "string") {
    return new McpError(error, {
      code: "UNKNOWN",
      details: {},
      cause: error,
    });
  }

  const rec = asRecord(error);
  const message = typeof rec.message === "string" ? rec.message : "Unknown error";
  return new McpError(message, {
    code: "UNKNOWN",
    details: rec,
    cause: error,
  });
}
