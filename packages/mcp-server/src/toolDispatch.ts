/**
 * Pure tool-dispatch primitives for the MCP CallTool handler.
 *
 * The CallTool handler builds an ordered pipeline of handler invocations and
 * returns the first non-null response, falling back to an "unknown tool"
 * response when no handler claims the call. That decision logic is extracted
 * here as a small, dependency-free, unit-testable function so it no longer
 * lives inside the coverage-disabled live-wiring block in index.ts.
 */

export type ToolHandlerResponse = {
  isError: boolean;
  content: Array<{ type: string; text: string }>;
};

export type ToolHandlerInvocation = () =>
  | Promise<ToolHandlerResponse | null>
  | ToolHandlerResponse
  | null;

/**
 * Runs the handler pipeline in order and returns the first non-null response.
 * If every handler declines (returns null/undefined), the provided fallback
 * builder is invoked to produce the terminal response (e.g. "Unknown tool").
 */
export async function dispatchToolPipeline(
  pipeline: ReadonlyArray<ToolHandlerInvocation>,
  buildFallbackResponse: () => ToolHandlerResponse
): Promise<ToolHandlerResponse> {
  for (const invokeHandler of pipeline) {
    const handlerResponse = await invokeHandler();
    if (handlerResponse) {
      return handlerResponse;
    }
  }
  return buildFallbackResponse();
}
