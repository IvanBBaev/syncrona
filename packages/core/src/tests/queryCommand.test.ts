// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import type { Arguments } from "yargs";
import type { AxiosResponse } from "axios";

// R8: `syncrona query <table>`. The command takes its client through a deps
// seam, so every test drives a fake `tableAPIGet` — no request leaves the test.

let queryCommand: typeof import("../queryCommand.js").queryCommand;
let runQuery: typeof import("../queryCommand.js").runQuery;
let buildQueryParams: typeof import("../queryCommand.js").buildQueryParams;
let NonApiResponseError: typeof import("../snClient.js").NonApiResponseError;
let logger: typeof import("../Logger.js").logger;
let CLI_COMMANDS: typeof import("../cliCommands.js").CLI_COMMANDS;
let initCommands: typeof import("../commander.js").initCommands;

type QueryArgs = import("../queryCommand.js").QueryCmdArgs;

beforeAll(async () => {
  ({ queryCommand, runQuery, buildQueryParams } = await import("../queryCommand.js"));
  ({ NonApiResponseError } = await import("../snClient.js"));
  ({ logger } = await import("../Logger.js"));
  ({ CLI_COMMANDS } = await import("../cliCommands.js"));
  ({ initCommands } = await import("../commander.js"));
});

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ sys_id: `id${i}`, number: `INC${i}` }));

const respond = (data: unknown, headers: Record<string, string> = {}) =>
  ({ data, headers, status: 200, statusText: "OK", config: {} }) as unknown as AxiosResponse;

const makeClient = (impl: () => Promise<AxiosResponse>) => {
  const tableAPIGet = jest.fn(impl);
  return { tableAPIGet, client: { tableAPIGet } as never };
};

const baseArgs = (over: Partial<QueryArgs> = {}): QueryArgs =>
  ({ table: "incident", query: "active=true", logLevel: "info", ...over }) as QueryArgs;

let prevExit: typeof process.exitCode;
beforeEach(() => {
  prevExit = process.exitCode;
  jest.spyOn(logger, "info").mockImplementation(() => undefined);
  jest.spyOn(logger, "routeAllToStderr").mockImplementation(() => undefined);
});
afterEach(() => {
  process.exitCode = prevExit;
  jest.restoreAllMocks();
});

describe("runQuery", () => {
  it("AT-R8-2: asks for limit + 1 rows and reports hasMore/nextOffset from the extra row", async () => {
    const { tableAPIGet, client } = makeClient(async () => respond({ result: rows(11) }));
    const envelope = await runQuery(client, baseArgs({ limit: 10, offset: 20 }));

    expect(tableAPIGet).toHaveBeenCalledWith("incident", "active=true", "", 11, 20, {
      params: { sysparm_display_value: "false", sysparm_exclude_reference_link: "true" },
      timeout: 30000,
    });
    expect(envelope.hasMore).toBe(true);
    expect(envelope.nextOffset).toBe(30);
    expect(envelope.records).toHaveLength(10);
    expect(envelope.records[9]).toEqual({ sys_id: "id9", number: "INC9" });
  });

  it("reports the last page with hasMore false and nextOffset null", async () => {
    const { tableAPIGet, client } = makeClient(async () => respond({ result: rows(3) }));
    const envelope = await runQuery(client, baseArgs());

    expect(tableAPIGet.mock.calls[0][3]).toBe(101); // default limit 100 + 1
    expect(envelope).toEqual({ ok: true, hasMore: false, nextOffset: null, records: rows(3) });
  });

  it("passes fields and the full sysparm surface through", async () => {
    const { tableAPIGet, client } = makeClient(async () => respond({ result: [] }));
    await runQuery(
      client,
      baseArgs({
        fields: "sys_id,number",
        displayValue: "all",
        excludeReferenceLink: false,
        count: false,
        view: "ess",
        queryCategory: "list",
        queryNoDomain: true,
        timeout: 5000,
      })
    );
    expect(tableAPIGet).toHaveBeenCalledWith("incident", "active=true", "sys_id,number", 101, 0, {
      params: {
        sysparm_display_value: "all",
        sysparm_exclude_reference_link: "false",
        sysparm_no_count: "true",
        sysparm_view: "ess",
        sysparm_query_category: "list",
        sysparm_query_no_domain: "true",
      },
      timeout: 5000,
    });
  });

  it("treats noCount: true like --no-count", () => {
    expect(buildQueryParams(baseArgs({ noCount: true })).sysparm_no_count).toBe("true");
    expect(buildQueryParams(baseArgs({ count: true }))).not.toHaveProperty("sysparm_no_count");
  });

  it.each([
    [{ limit: 0 }, /--limit must be an integer >= 1/],
    [{ limit: 2.5 }, /--limit must be an integer >= 1/],
    [{ offset: -1 }, /--offset must be an integer >= 0/],
    [{ timeout: Number.NaN }, /--timeout must be an integer >= 1/],
    [{ timeout: 0 }, /--timeout must be an integer >= 1/],
    [{ table: "incident/../sys_user" }, /"incident\/\.\.\/sys_user" is not a table name/],
    [{ table: "incident?sysparm_limit=1" }, /is not a table name/],
    [{ table: "inc%2Fident" }, /is not a table name/],
    [{ table: "  " }, /table name is required/],
    [{ query: undefined }, /--query \(-q\) is required/],
  ])("refuses %p before any request", async (over, message) => {
    const { tableAPIGet, client } = makeClient(async () => respond({ result: [] }));
    await expect(runQuery(client, baseArgs(over as Partial<QueryArgs>))).rejects.toThrow(message);
    expect(tableAPIGet).not.toHaveBeenCalled();
  });

  it("names an HTML login/hibernation page instead of crashing on it", async () => {
    const { client } = makeClient(async () =>
      respond("<html>  Instance hibernating </html>", { "content-type": "text/html" })
    );
    const err = await runQuery(client, baseArgs()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NonApiResponseError);
    expect((err as Error).message).toContain("content-type: text/html");
    expect((err as Error).message).toContain("Instance hibernating");
  });

  it("rejects a JSON body whose result is not an array", async () => {
    const { client } = makeClient(async () => respond({ result: { sys_id: "x" } }));
    await expect(runQuery(client, baseArgs())).rejects.toBeInstanceOf(NonApiResponseError);
  });
});

describe("queryCommand output", () => {
  const capture = (impl: () => Promise<AxiosResponse>) => {
    const lines: string[] = [];
    const { tableAPIGet, client } = makeClient(impl);
    const getClient = jest.fn(() => client);
    return { lines, tableAPIGet, getClient, deps: { getClient, write: (l: string) => lines.push(l) } };
  };

  it("AT-R8-1: -o json prints exactly the now-sdk envelope on stdout", async () => {
    const io = capture(async () => respond({ result: rows(3) }));
    await queryCommand(baseArgs({ output: "json", limit: 2, instanceProfile: "dev" }), io.deps);

    expect(io.getClient).toHaveBeenCalledWith("dev");
    expect(logger.routeAllToStderr).toHaveBeenCalled();
    expect(io.lines).toHaveLength(1);
    expect(JSON.parse(io.lines[0])).toMatchInlineSnapshot(`
{
  "hasMore": true,
  "nextOffset": 2,
  "ok": true,
  "records": [
    {
      "number": "INC0",
      "sys_id": "id0",
    },
    {
      "number": "INC1",
      "sys_id": "id1",
    },
  ],
}
`);
    expect(Object.keys(JSON.parse(io.lines[0]))).toEqual(["ok", "hasMore", "nextOffset", "records"]);
  });

  it("-o raw prints the same compact envelope (no --select to unquote)", async () => {
    const io = capture(async () => respond({ result: rows(1) }));
    await queryCommand(baseArgs({ output: "raw" }), io.deps);
    expect(io.lines).toEqual([JSON.stringify({ ok: true, hasMore: false, nextOffset: null, records: rows(1) })]);
  });

  it("human mode logs a summary and prints the records as pretty JSON", async () => {
    const io = capture(async () => respond({ result: rows(2) }));
    const result = await queryCommand(baseArgs({ limit: 1 }), io.deps);

    expect(logger.routeAllToStderr).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("Retrieved 1 record(s) from table 'incident'");
    expect(logger.info).toHaveBeenCalledWith("More records available. Use --offset 1 to fetch the next page");
    expect(io.lines).toEqual([JSON.stringify(rows(1), null, 2)]);
    expect(result).toMatchObject({ ok: true, hasMore: true });
  });

  it("human mode does not mention a next page on the last one", async () => {
    const io = capture(async () => respond({ result: [] }));
    await queryCommand(baseArgs(), io.deps);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(io.lines).toEqual(["[]"]);
  });

  it("human mode rethrows so commander logs the error and exits 1", async () => {
    const io = capture(async () => Promise.reject(new Error("socket hang up")));
    await expect(queryCommand(baseArgs(), io.deps)).rejects.toThrow("socket hang up");
    expect(io.lines).toEqual([]);
  });

  it("machine mode prints the failure envelope with the HTTP status and the Table API reason", async () => {
    const io = capture(async () =>
      Promise.reject(
        Object.assign(new Error("Request failed with status code 400"), {
          response: { status: 400, data: { error: { message: "Invalid table nope" }, status: "failure" } },
        })
      )
    );
    const result = await queryCommand(baseArgs({ table: "nope", output: "json" }), io.deps);

    const expected = {
      ok: false,
      error: { message: "Request failed with status code 400: Invalid table nope", status: 400, table: "nope" },
    };
    expect(JSON.parse(io.lines[0])).toEqual(expected);
    expect(result).toEqual(expected);
    expect(process.exitCode).toBe(1);
  });

  it("machine mode omits status for a non-HTTP failure and handles non-Error throws", async () => {
    const io = capture(async () => Promise.reject("boom"));
    await queryCommand(baseArgs({ output: "json" }), io.deps);
    expect(JSON.parse(io.lines[0])).toEqual({ ok: false, error: { message: "boom", table: "incident" } });
  });

  it("machine mode reports a validation failure as an envelope too", async () => {
    const io = capture(async () => respond({ result: [] }));
    await queryCommand(baseArgs({ output: "json", limit: 0 }), io.deps);
    expect(JSON.parse(io.lines[0]).error.message).toMatch(/--limit must be/);
    expect(io.tableAPIGet).not.toHaveBeenCalled();
  });
});

describe("query CLI surface", () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  const parse = async (argv: string[]): Promise<Arguments | null> => {
    const entry = CLI_COMMANDS.find((mod) => String(mod.command).startsWith("query "));
    if (!entry) throw new Error("query is not registered");
    const original = entry.handler;
    let seen: Arguments | null = null;
    entry.handler = (args: Arguments): unknown => {
      seen = args;
      return undefined;
    };
    try {
      await initCommands(argv);
      await flush();
    } catch (_) {
      // a refused parse leaves `seen` null
    } finally {
      entry.handler = original;
    }
    return seen;
  };

  beforeEach(() => {
    jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("parses the now-sdk flag set with its defaults", async () => {
    const args = await parse(["query", "incident", "-q", "active=true", "-f", "sys_id", "--no-count", "-o", "json"]);
    expect(args).toMatchObject({
      table: "incident",
      query: "active=true",
      fields: "sys_id",
      count: false,
      output: "json",
      limit: 100,
      offset: 0,
      displayValue: "false",
      excludeReferenceLink: true,
      timeout: 30000,
      queryNoDomain: false,
    });
  });

  it("accepts the kebab spellings and an empty query", async () => {
    const args = await parse([
      "query", "sys_user", "--query", "", "--display-value", "all",
      "--no-exclude-reference-link", "--limit", "5", "--offset", "10", "--view", "ess",
    ]);
    expect(args).toMatchObject({
      query: "",
      displayValue: "all",
      excludeReferenceLink: false,
      limit: 5,
      offset: 10,
      view: "ess",
    });
  });

  it("AT-R8-3: refuses a run without -q", async () => {
    expect(await parse(["query", "incident"])).toBeNull();
  });

  it("refuses an unknown output format and --dry-run", async () => {
    expect(await parse(["query", "incident", "-q", "", "-o", "csv"])).toBeNull();
    expect(await parse(["query", "incident", "-q", "", "--dry-run"])).toBeNull();
  });
});

describe("nodeQueryClient", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("refuses with an actionable message when no instance is configured", async () => {
    const { nodeQueryClient } = await import("../queryCommand.js");
    // SN_USER without SN_INSTANCE: credentials are present, so nothing falls back
    // to the credential store, and the query has nowhere to go.
    delete process.env.SN_INSTANCE;
    process.env.SN_USER = "admin";
    process.env.SN_PASSWORD = "s3cr3t";
    expect(() => nodeQueryClient()).toThrow(/No ServiceNow instance is configured/);
  });
});
