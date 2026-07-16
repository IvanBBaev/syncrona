// SPDX-License-Identifier: GPL-3.0-or-later
// Canonical MCP tool response shape returned by every tool handler. Kept in a
// leaf module (no imports) so handlers, the dispatch pipeline, and the public
// API barrel all share one definition instead of redeclaring it — previously
// this identical type was copy-pasted in 11 handlers plus toolDispatch, which
// could silently drift.
export type ToolResponse = {
  isError: boolean;
  content: Array<{ type: string; text: string }>;
  // Optional machine-readable mirror of the JSON text payload (MCP
  // structuredContent). When present it must be a plain JSON object equal to
  // JSON.parse of the first text block, so text and structured consumers see
  // the same data. Tools that declare an outputSchema must set this on every
  // success result; error results (isError: true) are exempt per the MCP spec.
  structuredContent?: Record<string, unknown>;
};
