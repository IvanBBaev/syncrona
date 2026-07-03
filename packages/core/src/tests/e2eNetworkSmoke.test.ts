// SPDX-License-Identifier: GPL-3.0-or-later
import http from "http";
import { AddressInfo } from "net";
import { snClient } from "../snClient.js";
import { buildManifestFromTableAPI } from "../manifestBuilder.js";

// G11 network slice: drives the REAL snClient (axios, basic auth, rate
// limiter) against a local mock ServiceNow Table API over actual sockets —
// no jest mocks anywhere in the request path. Catches breakage the unit
// tests with mocked clients cannot (URL building, params serialization,
// auth headers, response unwrapping).
describe("e2e network smoke (real HTTP against a mock ServiceNow)", () => {
  let server: http.Server;
  let baseURL: string;
  const seenAuthHeaders: string[] = [];
  const tokenRequests: string[] = [];
  let lastPatch: { url: string; body: Record<string, unknown> } | null = null;
  // #17: when set, the very next non-oauth API request answers 401 (then clears
  // itself) so the negative auth path is exercised over the real socket.
  let failNextWith401 = false;
  // #58: when set, the FIRST scoped/table API request answers 401 to force the
  // OAuth response interceptor to forceRefresh() + retry once (a stateful,
  // 401-once route). Subsequent requests succeed with the refreshed token.
  let oauth401Once = false;
  let oauth401Fired = false;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seenAuthHeaders.push(req.headers.authorization || "");
      const url = new URL(req.url || "/", "http://localhost");
      const respond = (payload: unknown, status = 200) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(payload));
      };

      if (url.pathname.endsWith("oauth_token.do") && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          tokenRequests.push(body);
          // Hand out a distinct token per grant so the retry can be observed to
          // carry the REFRESHED bearer, not the stale one.
          const token = body.includes("grant_type=refresh_token")
            ? "tok-refreshed"
            : "tok-123";
          respond({ access_token: token, refresh_token: "ref-123", expires_in: 1800 });
        });
        return;
      }

      // #17: one-shot 401 for the Basic-auth negative-path slice.
      if (failNextWith401) {
        failNextWith401 = false;
        return respond({ error: { message: "User Not Authenticated" } }, 401);
      }

      // #58: 401-once for the OAuth re-auth slice. Fires on the first API hit
      // after the token was obtained, then never again.
      if (oauth401Once && !oauth401Fired && req.headers.authorization) {
        oauth401Fired = true;
        return respond({ error: { message: "Expired token" } }, 401);
      }

      if (req.method === "PATCH") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          lastPatch = { url: url.pathname, body: JSON.parse(body) };
          respond({ result: { sys_id: "rec-1" } });
        });
        return;
      }

      const table = url.pathname.replace("/api/now/table/", "");
      if (table === "sys_app") {
        return respond({
          result: [{ sys_id: "scope-1", scope: "x_smoke", name: "Smoke App" }],
        });
      }
      if (table === "sys_metadata") {
        return respond({
          result: [{ sys_id: "meta-1", sys_class_name: "sys_script_include" }],
        });
      }
      if (table === "sys_dictionary") {
        return respond({
          result: [{ element: "script", internal_type: "script_plain" }],
        });
      }
      if (table === "sys_script_include") {
        return respond({
          result: [
            { sys_id: "rec-1", name: "Smoke Include", script: "gs.info('smoke');" },
          ],
        });
      }
      return respond({ result: [] });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseURL = `http://127.0.0.1:${port}/`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("downloads a scope manifest over the wire with basic auth", async () => {
    const client = snClient(baseURL, "smoke.user", "smoke.pass");

    const manifest = await buildManifestFromTableAPI("x_smoke", client, {
      includes: {},
      excludes: {},
      tableOptions: {},
    });

    expect(manifest.scope).toBe("x_smoke");
    expect(manifest.tables.sys_script_include.records["Smoke Include"].sys_id).toBe(
      "rec-1"
    );
    expect(
      manifest.tables.sys_script_include.records["Smoke Include"].files
    ).toEqual([{ name: "script", type: "js" }]);

    const expectedAuth =
      "Basic " + Buffer.from("smoke.user:smoke.pass").toString("base64");
    expect(seenAuthHeaders).toContain(expectedAuth);
  });

  it("pushes a record update over the wire (PATCH api/now/table)", async () => {
    const client = snClient(baseURL, "smoke.user", "smoke.pass");

    const res = await client.updateRecord("sys_script_include", "rec-1", {
      script: "gs.info('updated');",
    });

    expect(res.status).toBe(200);
    expect(lastPatch).toEqual({
      url: "/api/now/table/sys_script_include/rec-1",
      body: { script: "gs.info('updated');" },
    });
  });

  // G1: OAuth mode exchanges username/password at oauth_token.do and sends the
  // access token as a Bearer header on every Table API request (no Basic auth).
  it("uses OAuth Bearer over the wire when an OAuth client is configured", async () => {
    tokenRequests.length = 0;
    const before = seenAuthHeaders.length;
    const client = snClient(baseURL, "smoke.user", "smoke.pass", {
      clientId: "my-client",
      clientSecret: "my-secret",
    });

    const manifest = await buildManifestFromTableAPI("x_smoke", client, {
      includes: {},
      excludes: {},
      tableOptions: {},
    });
    expect(manifest.scope).toBe("x_smoke");

    // Token endpoint was hit with the password grant + client credentials.
    expect(tokenRequests.length).toBeGreaterThan(0);
    expect(tokenRequests[0]).toContain("grant_type=password");
    expect(tokenRequests[0]).toContain("client_id=my-client");

    // Every Table API request after client creation carried the Bearer token,
    // and none used Basic auth.
    const apiAuthHeaders = seenAuthHeaders.slice(before).filter((h) => h !== "");
    expect(apiAuthHeaders.length).toBeGreaterThan(0);
    expect(apiAuthHeaders.every((h) => h === "Bearer tok-123")).toBe(true);
    expect(apiAuthHeaders.some((h) => h.startsWith("Basic "))).toBe(false);
  });

  // #58: a stateful 401-ONCE route. The first Table API request after the OAuth
  // token is minted answers 401; the snClient response interceptor must call
  // tokens.forceRefresh() (a refresh_token grant), then RETRY the same request
  // with the refreshed Bearer and succeed. This is the only slice that drives
  // the live re-auth loop end to end over a real socket — mocked-client unit
  // tests can't prove the retried request actually carries the new token.
  it("re-authenticates and retries once when the API returns 401 (OAuth interceptor)", async () => {
    tokenRequests.length = 0;
    const before = seenAuthHeaders.length;
    oauth401Once = true;
    oauth401Fired = false;
    try {
      const client = snClient(baseURL, "smoke.user", "smoke.pass", {
        clientId: "my-client",
        clientSecret: "my-secret",
      });

      const manifest = await buildManifestFromTableAPI("x_smoke", client, {
        includes: {},
        excludes: {},
        tableOptions: {},
      });
      // The manifest still resolves despite the mid-flight 401 -> the retry
      // recovered it.
      expect(manifest.scope).toBe("x_smoke");
    } finally {
      oauth401Once = false;
    }

    // Two token grants happened: the initial password grant, then a
    // refresh_token grant triggered by the 401.
    expect(oauth401Fired).toBe(true);
    expect(tokenRequests.some((b) => b.includes("grant_type=password"))).toBe(true);
    expect(tokenRequests.some((b) => b.includes("grant_type=refresh_token"))).toBe(
      true
    );

    // The retried (and all subsequent) API requests carried the REFRESHED
    // bearer, proving the interceptor swapped the token before retrying.
    const apiAuthHeaders = seenAuthHeaders.slice(before).filter((h) => h !== "");
    expect(apiAuthHeaders).toContain("Bearer tok-refreshed");
  });

  // #17: negative-path slice #1 — the server rejects with 401 and the client
  // must SURFACE the failure (reject), not silently swallow it. Basic-auth mode
  // has no re-auth interceptor, so the 401 propagates straight to the caller.
  it("surfaces a 401 auth failure to the caller (no OAuth re-auth path)", async () => {
    const client = snClient(baseURL, "smoke.user", "wrong.pass");
    failNextWith401 = true;

    await expect(
      client.tableAPIGet("sys_script_include", "", "sys_id", 1)
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  // #17: negative-path slice #2 — a genuine transport failure (connection
  // refused). Point the client at a closed port and confirm the error is
  // raised with a network-shaped code rather than hanging or returning a body.
  it("surfaces a connection failure when the instance is unreachable", async () => {
    // Bind then immediately release a port so it is guaranteed closed.
    const probe = http.createServer();
    const closedPort: number = await new Promise((resolve) => {
      probe.listen(0, "127.0.0.1", () => {
        const p = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });

    const client = snClient(
      `http://127.0.0.1:${closedPort}/`,
      "smoke.user",
      "smoke.pass"
    );

    await expect(
      client.tableAPIGet("sys_script_include", "", "sys_id", 1)
    ).rejects.toMatchObject({
      code: expect.stringMatching(/ECONNREFUSED|ECONNRESET|EADDRNOTAVAIL/),
    });
  });
});
