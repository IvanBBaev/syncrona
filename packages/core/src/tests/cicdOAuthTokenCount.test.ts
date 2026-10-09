// SPDX-License-Identifier: GPL-3.0-or-later
// A rejected OAuth token costs the same token requests on core's sn_cicd calls
// as on `sync_cicd_run`: a token endpoint 401 while getting the first token is
// one POST (the data request is never sent), and a data 401 is one forced
// refresh (a refresh_token POST, then its fallback grant). Runs against a real
// local HTTP server, so the real axios interceptors are exercised.
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { snClient } from "../snClient.js";

type Target = { server: Server; port: number; sockets: Set<Socket>; token: number; data: number };

/** `grants` answers the token POSTs in order (the last repeats); data requests get `dataStatus`. */
async function startServer(grants: number[], dataStatus: number): Promise<Target> {
  const sockets = new Set<Socket>();
  const target = { sockets, token: 0, data: 0 } as Target;
  target.server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if ((req.url || "").includes("oauth_token.do")) {
        const status = grants[Math.min(target.token, grants.length - 1)];
        target.token += 1;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            status === 200
              ? { access_token: "at", refresh_token: "rt", expires_in: 1800 }
              : { error: "invalid_client" }
          )
        );
        return;
      }
      target.data += 1;
      res.writeHead(dataStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: { status: "2" } }));
    });
  });
  target.server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => target.server.listen(0, "127.0.0.1", resolve));
  target.port = (target.server.address() as AddressInfo).port;
  return target;
}

async function stopServer(target: Target): Promise<void> {
  for (const socket of target.sockets) socket.destroy();
  await new Promise<void>((resolve) => target.server.close(() => resolve()));
}

const client = (target: Target) =>
  snClient(`http://127.0.0.1:${target.port}/`, "u", "p", {
    clientId: "cid",
    clientSecret: "secret",
    grantType: "password",
  });

describe("cicd OAuth token request counts match sync_cicd_run", () => {
  it("a token endpoint 401 on the first token is one token POST, and the dispatch is never sent", async () => {
    const target = await startServer([401], 200);
    try {
      await expect(client(target).cicdPost("app_repo/install", { scope: "x_a" })).rejects.toMatchObject({
        response: { status: 401 },
      });
      expect(target.token).toBe(1);
      expect(target.data).toBe(0);
    } finally {
      await stopServer(target);
    }
  });

  it("a data 401 forces one refresh: the refresh POST and its fallback grant, and no re-sent request", async () => {
    const target = await startServer([200, 401], 401);
    try {
      await expect(client(target).cicdGet("progress/p1")).rejects.toMatchObject({ response: { status: 401 } });
      expect(target.token).toBe(3);
      expect(target.data).toBe(1);
    } finally {
      await stopServer(target);
    }
  });
});
