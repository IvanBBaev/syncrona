/**
 * Credential store for the SyncroNow AI CLI.
 *
 * The implementation lives in the shared `@syncro-now-ai/credential-store` package
 * so the CLI and the MCP server never diverge on crypto format, key derivation,
 * file naming, or on-disk layout. This module re-exports that package's public
 * API (the async read/write functions plus the `StoredCredentials` type) that
 * the CLI consumes.
 */
export * from "@syncro-now-ai/credential-store";
