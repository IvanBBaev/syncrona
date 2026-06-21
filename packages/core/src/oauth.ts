// The OAuth token manager now lives in @syncro-now-ai/sn-transport so the CLI and
// the MCP server share one implementation (ARCH-001). Re-exported here so
// existing core imports (`./oauth`) keep working unchanged.
export {
  createTokenManager,
  oauthFormBody,
  OAUTH_TOKEN_PATH,
} from "@syncro-now-ai/sn-transport";
export type {
  OAuthConfig,
  OAuthTokenResponse,
  TokenPoster,
  TokenManager,
} from "@syncro-now-ai/sn-transport";
