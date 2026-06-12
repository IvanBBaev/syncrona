import http from "http";
import { AddressInfo } from "net";
import { snClient } from "../snClient";
import { buildManifestFromTableAPI } from "../manifestBuilder";

// G11 network slice: drives the REAL snClient (axios, basic auth, rate
// limiter) against a local mock ServiceNow Table API over actual sockets —
// no jest mocks anywhere in the request path. Catches breakage the unit
// tests with mocked clients cannot (URL building, params serialization,
// auth headers, response unwrapping).
describe("e2e network smoke (real HTTP against a mock ServiceNow)", () => {
  let server: http.Server;
  let baseURL: string;
  const seenAuthHeaders: string[] = [];
  let lastPatch: { url: string; body: Record<string, unknown> } | null = null;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seenAuthHeaders.push(req.headers.authorization || "");
      const url = new URL(req.url || "/", "http://localhost");
      const respond = (payload: unknown) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(payload));
      };

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
});
