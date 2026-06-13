// Canonical MCP tool response shape returned by every tool handler. Kept in a
// leaf module (no imports) so handlers, the dispatch pipeline, and the public
// API barrel all share one definition instead of redeclaring it — previously
// this identical type was copy-pasted in 11 handlers plus toolDispatch, which
// could silently drift.
export type ToolResponse = {
  isError: boolean;
  content: Array<{ type: string; text: string }>;
};
