---
"@syncrona/sn-transport": minor
"syncrona": minor
"@syncrona/mcp-server": minor
---

- New `bearer` auth method for a pre-issued OAuth access token, the counterpart of now-sdk's `SN_SDK_SESSION_BEARER_TOKEN`. Set `SN_BEARER_TOKEN` (optionally with `SN_AUTH_METHOD=bearer`, aliases `bearer-token` and `access-token`), and the CLI, the MCP server and the Fluent tier send `Authorization: Bearer <token>`. Like the SDK, a token in the environment is inferred ahead of every other method unless `SN_AUTH_METHOD` names a different one. The token is environment-only: `syncrona login` refuses `--auth-method bearer` and clears a stale `SN_BEARER_TOKEN` from `.env` on a re-login, and syncrona never refreshes the token. The per-profile `SN_BEARER_TOKEN_<PROFILE>` suffix works like every other auth variable.
