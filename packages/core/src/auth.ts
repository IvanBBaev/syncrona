/**
 * Credential store for the Syncrona CLI.
 *
 * The implementation lives in the shared `@syncrona/credential-store` package
 * so the CLI and the MCP server never diverge on crypto format, key derivation,
 * file naming, or on-disk layout. This module re-exports that package's public
 * API (the async read/write functions plus the `StoredCredentials` type) that
 * the CLI consumes.
 */
export * from "@syncrona/credential-store";
