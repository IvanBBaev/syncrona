// SPDX-License-Identifier: GPL-3.0-or-later
//
// Bridge from a syncrona credential to the ServiceNow SDK's credential resolver.
//
// The SDK wraps the resolver in its own `LazyCredential`, which caches the
// result for a TTL and calls `invalidate()` + re-resolves after an instance
// 401. So this resolver deliberately does NOT memoize: every call logs in (or
// asks the token manager) afresh, which is exactly what a re-resolve after a
// 401 needs. The SDK supplies the caching.

import type { SN } from "@syncrona/types";
import { FetchLike, FluentLoginError, loginUiSession } from "./uiSession";

/** Endpoints only a UI session can reach; named in every refusal so the user knows why. */
export const SESSION_ONLY_ENDPOINTS = [
  "sn_appclient_upload_processor.do",
  "xmlhttp.do",
  "fluent_update_set_export.do",
] as const;

export interface FluentAuthDeps {
  fetch?: FetchLike;
}

export function createFluentAuthResolver(
  instanceUrl: string,
  input: SN.FluentCredentialInput,
  deps: FluentAuthDeps = {},
): SN.FluentAuthResolver {
  switch (input.kind) {
    case "basic": {
      const { username, password } = input;
      return () => loginUiSession(instanceUrl, username, password, deps.fetch);
    }
    case "oauth": {
      const { getToken } = input;
      return async () => ({ type: "oauth", token: await getToken() });
    }
    case "unsupported":
    default: {
      const method = (input as { method?: string }).method ?? "unknown";
      return async () => {
        throw new FluentLoginError(
          `The ${method} authentication method cannot drive the ServiceNow SDK: it needs a ` +
            `Basic (UI session) or OAuth profile for ${SESSION_ONLY_ENDPOINTS.join(", ")}.`,
          "FLUENT_AUTH_UNSUPPORTED",
        );
      };
    }
  }
}
