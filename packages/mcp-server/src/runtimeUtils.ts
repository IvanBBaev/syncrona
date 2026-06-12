type CmdResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type McpErrorPayload = {
  code?: string;
  details?: Record<string, unknown>;
};

const MAX_OUTPUT_CHARS = 20000;

export function trimOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) {
    return output;
  }

  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n...<trimmed>`;
}

export function toJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function commandResultToText(result: CmdResult): string {
  const parts: string[] = [];
  parts.push(`exitCode: ${result.exitCode}`);
  parts.push(`timedOut: ${result.timedOut}`);

  if (result.stdout.trim()) {
    parts.push("stdout:");
    parts.push(trimOutput(result.stdout));
  }

  if (result.stderr.trim()) {
    parts.push("stderr:");
    parts.push(trimOutput(result.stderr));
  }

  return parts.join("\n");
}

export function formatToolError(message: string): {
  isError: true;
  content: Array<{ type: string; text: string }>;
} {
  return {
    isError: true,
    content: [{ type: "text", text: `Tool execution failed: ${message}` }],
  };
}

export function formatStructuredToolError(
  message: string,
  payload: McpErrorPayload = {}
): {
  isError: true;
  content: Array<{ type: string; text: string }>;
} {
  const code = typeof payload.code === "string" && payload.code.trim() ? payload.code.trim() : "TOOL_EXECUTION";
  const details = payload.details && typeof payload.details === "object" ? payload.details : {};
  return {
    isError: true,
    content: [{
      type: "text",
      text: `Tool execution failed [${code}]: ${message}\n${toJsonText({ code, details })}`,
    }],
  };
}

export function isDryRunRequested(args: Record<string, unknown>): boolean {
  return args.dryRun === true;
}
