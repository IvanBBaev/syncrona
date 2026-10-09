// SPDX-License-Identifier: GPL-3.0-or-later
// The sn_cicd calls cap redirects at 20, the limit the native fetch (undici)
// behind `sync_cicd_run` enforces; follow-redirects (axios) would otherwise
// allow 21. Runs against a real local HTTP server so the real axios and the
// real fetch follow the same chain.
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { CICD_MAX_REDIRECTS, snClient } from "../snClient.js";

type Target = { server: Server; port: number; sockets: Set<Socket>; hits: string[] };

// `/api/sn_cicd/hop/N/progress/x` redirects N times, then answers JSON;
// `/api/sn_cicd/self` redirects to itself, and `/api/sn_cicd/a` and `/b` to each other.
async function startRedirectServer(): Promise<Target> {
  const sockets = new Set<Socket>();
  const hits: string[] = [];
  const loops: Record<string, string> = {
    "/api/sn_cicd/self": "/api/sn_cicd/self",
    "/api/sn_cicd/a": "/api/sn_cicd/b",
    "/api/sn_cicd/b": "/api/sn_cicd/a",
  };
  const server = createServer((req, res) => {
    const path = (req.url || "").split("?")[0];
    hits.push(path);
    if (loops[path]) {
      res.writeHead(302, { Location: loops[path] });
      res.end();
      return;
    }
    const match = /^\/api\/sn_cicd\/hop\/(\d+)\/(.*)$/.exec(path);
    if (match && Number(match[1]) > 0) {
      res.writeHead(302, { Location: `/api/sn_cicd/hop/${Number(match[1]) - 1}/${match[2]}` });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: { status: "2" } }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, sockets, hits };
}

async function stopServer(target: Target): Promise<void> {
  for (const socket of target.sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => target.server.close(() => resolve()));
}

describe("sn_cicd redirect cap (parity with sync_cicd_run's fetch)", () => {
  let target: Target;
  beforeAll(async () => {
    target = await startRedirectServer();
  });
  afterAll(async () => {
    await stopServer(target);
  });

  it("is 20", () => {
    expect(CICD_MAX_REDIRECTS).toBe(20);
  });

  it("follows a chain of 20 redirects and rejects a chain of 21, as fetch does", async () => {
    const base = `http://127.0.0.1:${target.port}/`;
    const client = snClient(base, "u", "p");

    const followed = await client.cicdGet<{ result: { status: string } }>("hop/20/progress/x");
    expect(followed.status).toBe(200);
    expect(followed.data.result.status).toBe("2");
    await expect(client.cicdGet("hop/21/progress/x")).rejects.toMatchObject({
      code: "ERR_FR_TOO_MANY_REDIRECTS",
    });
    await expect(client.cicdPost("hop/21/testsuite/run", { a: "b" })).rejects.toMatchObject({
      code: "ERR_FR_TOO_MANY_REDIRECTS",
    });

    // The same chains through the native fetch the MCP tool uses.
    const ok = await fetch(`${base}api/sn_cicd/hop/20/progress/x`);
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();
    await expect(fetch(`${base}api/sn_cicd/hop/21/progress/x`)).rejects.toThrow();
  }, 15000);

  it.each([
    ["a self-redirect", "self"],
    ["an A→B→A loop", "a"],
    ["a 22-hop chain", "hop/22/progress/x"],
  ])("gives up on %s after the same number of requests as fetch", async (_label, path) => {
    const base = `http://127.0.0.1:${target.port}/`;
    const client = snClient(base, "u", "p");

    target.hits.length = 0;
    await expect(client.cicdGet(path)).rejects.toMatchObject({ code: "ERR_FR_TOO_MANY_REDIRECTS" });
    const axiosHits = target.hits.length;

    target.hits.length = 0;
    await expect(fetch(`${base}api/sn_cicd/${path}`)).rejects.toThrow();
    const fetchHits = target.hits.length;

    // The first request plus the 20 redirects followed, on both clients.
    expect(axiosHits).toBe(CICD_MAX_REDIRECTS + 1);
    expect(fetchHits).toBe(axiosHits);
  }, 15000);
});
