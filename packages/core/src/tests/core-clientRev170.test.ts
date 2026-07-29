// SPDX-License-Identifier: GPL-3.0-or-later
// Regression suite for the snClient transport guards:
//   REV-170 — the data-path axios client had no `timeout`, so a blackholed
//             socket never settled and parked a download/push pool slot forever.
//   REV-171 — the OAuth token client had no `timeout` either; because every
//             request awaits getToken() in the request interceptor, one hung
//             /oauth_token.do stalled the whole command.
//   REV-172 — buildClientAuth returned `{}` when the selected method's material
//             was incomplete, which the factory reads as "Basic auth", silently
//             downgrading an explicit api-key / JWT opt-out to password auth.
//
// The timeout cases run against real local HTTP servers (real axios, real
// sockets) — against the old code they never settle and the test times out.
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  REQUEST_TIMEOUT_ENV,
  buildClientAuth,
  resolveRequestTimeout,
  snClient,
  type SNCredentials,
} from "../snClient.js";

type Blackhole = { server: Server; port: number; sockets: Set<Socket> };

async function startServer(
  handler: (url: string, respond: (body: string) => void) => void
): Promise<Blackhole> {
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    handler(req.url || "", (body: string) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, sockets };
}

async function stopServer(target: Blackhole): Promise<void> {
  for (const socket of target.sockets) {
    socket.destroy();
  }
  target.sockets.clear();
  await new Promise<void>((resolve) => target.server.close(() => resolve()));
}

function isTimeoutError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string } | null;
  if (!candidate || typeof candidate !== "object") {
    return false;
  }
  return (
    candidate.code === "ECONNABORTED" ||
    candidate.code === "ETIMEDOUT" ||
    /timeout/i.test(String(candidate.message || ""))
  );
}

const creds = (overrides: Partial<SNCredentials>): SNCredentials => ({
  user: "svc",
  password: "hunter2",
  instance: "example.service-now.com",
  ...overrides,
});

describe("REV-170/171: every snClient request is time-bounded", () => {
  const originalTimeout = process.env[REQUEST_TIMEOUT_ENV];

  afterEach(() => {
    if (originalTimeout === undefined) {
      delete process.env[REQUEST_TIMEOUT_ENV];
    } else {
      process.env[REQUEST_TIMEOUT_ENV] = originalTimeout;
    }
  });

  it("resolves a bounded default timeout, honours the env override and rejects junk", () => {
    delete process.env[REQUEST_TIMEOUT_ENV];
    expect(resolveRequestTimeout()).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);

    process.env[REQUEST_TIMEOUT_ENV] = "1500";
    expect(resolveRequestTimeout()).toBe(1500);

    // Junk and negatives must not silently disable the bound.
    process.env[REQUEST_TIMEOUT_ENV] = "not-a-number";
    expect(resolveRequestTimeout()).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    process.env[REQUEST_TIMEOUT_ENV] = "-1";
    expect(resolveRequestTimeout()).toBe(DEFAULT_REQUEST_TIMEOUT_MS);

    // 0 is the documented escape hatch for a very large pull.
    process.env[REQUEST_TIMEOUT_ENV] = "0";
    expect(resolveRequestTimeout()).toBe(0);
  });

  it("REV-170: a data-path request against a socket that never answers rejects instead of hanging", async () => {
    // Accepts the connection, then never responds — the VPN/load-balancer
    // blackhole from the report.
    const target = await startServer(() => {
      /* intentionally no response */
    });
    try {
      process.env[REQUEST_TIMEOUT_ENV] = "300";
      const client = snClient(`http://127.0.0.1:${target.port}/`, "u", "p");
      const started = Date.now();
      let caught: unknown;
      try {
        await client.getScopeId("x_test_scope");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      expect(isTimeoutError(caught)).toBe(true);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await stopServer(target);
    }
  }, 15000);

  it("REV-171: a hung OAuth token endpoint rejects instead of stalling every request", async () => {
    // Only /oauth_token.do is blackholed; the Table API answers normally, so the
    // only way this test can hang is the unbounded token leg.
    const target = await startServer((url, respond) => {
      if (url.includes("oauth_token.do")) {
        return;
      }
      respond(JSON.stringify({ result: [{ sys_id: "abc" }] }));
    });
    try {
      process.env[REQUEST_TIMEOUT_ENV] = "300";
      const client = snClient(`http://127.0.0.1:${target.port}/`, "u", "p", {
        clientId: "cid",
        clientSecret: "secret",
        grantType: "password",
      });
      const started = Date.now();
      let caught: unknown;
      try {
        await client.getScopeId("x_test_scope");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      expect(isTimeoutError(caught)).toBe(true);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await stopServer(target);
    }
  }, 15000);
});

describe("REV-172: incomplete auth material fails instead of falling back to Basic", () => {
  it("throws for an api-key method with no key rather than returning a Basic descriptor", () => {
    expect(() => buildClientAuth(creds({ authMethod: "api-key", apiKey: "" }))).toThrow(
      /api-key.*incomplete.*API key/is
    );
  });

  it("throws for a jwt-bearer method missing the signing key", () => {
    expect(() =>
      buildClientAuth(
        creds({ authMethod: "oauth-jwt-bearer", clientId: "cid", clientSecret: "secret" })
      )
    ).toThrow(/JWT signing key/i);
  });

  it("throws for an OAuth method missing the client id and secret, naming both", () => {
    let message = "";
    try {
      buildClientAuth(creds({ authMethod: "oauth-client-credentials" }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/client id/i);
    expect(message).toMatch(/client secret/i);
  });

  it("still returns an empty descriptor for basic auth (Basic needs no descriptor)", () => {
    expect(buildClientAuth(creds({ authMethod: "basic" }))).toEqual({});
    expect(buildClientAuth(creds({}))).toEqual({});
  });
});
