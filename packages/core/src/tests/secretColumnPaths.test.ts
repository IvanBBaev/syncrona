// One secret fixture, every manifest path. Secret-column handling has been
// patched per call site three times; this matrix runs init, refresh and
// download over the Table API manifest against the same instance and asserts
// the same outcome for each: the field files written, the manifest's record
// files, the warnings, and what the bulk record read names. Every path decides through
// metaFields.classifyColumn, so a divergence here is a missed call site.
//
// The fixture:
//   - x_demo_cred.u_token  — an `includes` entry whose dictionary type is
//                            password2 (unsafe: never listed, never written);
//   - x_demo_cred.u_ghost  — an `includes` entry with no dictionary row
//                            (kept, with a warning that the type is unknown);
//   - sys_properties x_demo.api_key  — a password2 property (value withheld);
//   - sys_properties x_demo.endpoint — a string property (value written);
//   - x_demo_cred metaFields ["u_token", "u_notes", "name"] — an explicit
//                            sidecar list naming the password2 column and a
//                            journal column: both dropped with a warning,
//                            `name` kept.
// repair runs over a project a refresh built, after the string value is deleted.
// No instance is contacted: the client is a fake injected through snClient.
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

type Row = Record<string, string>;

const SECRET = "S3CR3T-PROPERTY-VALUE";
const ENDPOINT = "https://example.test";
const TOKEN = "T0KEN-PASSWORD2-VALUE";
const NOTES = "J0URNAL-ENTRY-VALUE";
const SCRIPT = "gs.info('cred');";
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
const SCOPE_ID = "d".repeat(32);

const ok = (result: unknown) => Promise.resolve({ status: 200, data: { result } }) as Promise<never>;

// The instance's rows. u_ghost has no dictionary row and is not a column of the
// table, so the Table API never returns a value for it.
const ROWS: Record<string, Row[]> = {
  sys_properties: [
    { sys_id: A, name: "x_demo.api_key", type: "password2", value: SECRET },
    { sys_id: B, name: "x_demo.endpoint", type: "string", value: ENDPOINT },
  ],
  x_demo_cred: [{ sys_id: C, name: "cred-one", script: SCRIPT, u_token: TOKEN, u_notes: NOTES }],
};
const DICTIONARY: Record<string, Row[]> = {
  sys_properties: [
    { element: "name", internal_type: "string" },
    { element: "type", internal_type: "string" },
    { element: "value", internal_type: "string" },
  ],
  x_demo_cred: [
    { element: "name", internal_type: "string" },
    { element: "script", internal_type: "script_plain" },
    { element: "u_token", internal_type: "password2" },
    { element: "u_notes", internal_type: "journal" },
  ],
};
const NAME_OF: Record<string, string> = { [A]: "x_demo.api_key", [B]: "x_demo.endpoint", [C]: "cred-one" };

const tablesIn = (query: string): string[] => {
  const name = /(?:^|\^)name=([^^]+)/.exec(query);
  if (name) return [name[1]];
  const names = /(?:^|\^)nameIN([^^]+)/.exec(query);
  return names ? names[1].split(",") : Object.keys(DICTIONARY);
};

const dictionaryRows = (query: string): Row[] => {
  const tables = tablesIn(query);
  const elements = /elementIN([^^]+)/.exec(query)?.[1].split(",");
  // The file-field query names its types as `internal_type=a^ORinternal_type=b`.
  const typeTerms = [...query.matchAll(/internal_type=([^^]+)/g)].map((m) => m[1]);
  const types = typeTerms.length > 0 ? typeTerms : undefined;
  return tables.flatMap((table) =>
    (DICTIONARY[table] ?? [])
      .filter((row) => !elements || elements.includes(row.element))
      .filter((row) => !types || types.includes(row.internal_type))
      .map((row) => ({ ...row, name: table }))
  );
};

const recordRows = (table: string, query: string, fields: string): Row[] => {
  const ids = /sys_idIN([^^]+)/.exec(query)?.[1].split(",");
  const wanted = fields ? fields.split(",") : undefined;
  return (ROWS[table] ?? [])
    .filter((row) => !ids || ids.includes(row.sys_id))
    .map((row) =>
      wanted ? Object.fromEntries(Object.entries(row).filter(([key]) => wanted.includes(key))) : row
    );
};

const fake = {
  tableAPIGet: jest.fn((table: string, query: string, fields = "") => {
    const q = String(query ?? "");
    if (table === "sys_app" || table === "sys_scope") return ok([{ sys_id: SCOPE_ID, scope: "x_demo" }]);
    if (table === "sys_metadata") {
      return ok([{ sys_class_name: "x_demo_cred" }, { sys_class_name: "sys_properties" }]);
    }
    if (table === "sys_db_object") {
      // A readable root table for the parent lookup; nothing for the scope
      // enumeration (the build falls back to sys_metadata).
      const name = /^name=([^^]+)$/.exec(q)?.[1];
      return ok(name ? [{ name }] : []);
    }
    if (table === "sys_dictionary") return ok(dictionaryRows(q));
    return ok(recordRows(table, q, String(fields ?? "")));
  }),
};

const actual = await import("../snClient.js");
jest.unstable_mockModule("../snClient.js", () => ({ ...actual, defaultClient: () => fake }));

const { downloadApp } = await import("../wizard.js");
const { syncManifest } = await import("../downloadPipeline.js");
const { downloadCommand } = await import("../commands.js");
const ConfigManager = await import("../config.js");
const { logger } = await import("../Logger.js");
const { repairCommand } = await import("../repairCommand.js");

const walk = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    : [];

type Command = "init" | "refresh" | "download";

const run: Record<Command, () => Promise<unknown>> = {
  init: () => downloadApp("x_demo", fake as never),
  refresh: async () => {
    fs.writeFileSync("sync.manifest.json", JSON.stringify({ scope: "x_demo", tables: {} }));
    await ConfigManager.loadConfigs();
    return syncManifest();
  },
  download: () => downloadCommand({ logLevel: "info", scope: "x_demo", ci: true } as never),
};

// The message family every include judgement logs in (manifestBuilder
// warnUnsafeInclude / warnUntypedIncludes).
const isIncludeWarning = (message: string): boolean =>
  message.includes("ignoring the includes entry") ||
  message.includes("could not read the dictionary type of included column");

const UNSAFE_WARNING =
  'Table x_demo_cred: ignoring the includes entry for column "u_token" — its dictionary type is ' +
  "password2, and a value of that type is never written to the working tree.";
const metaFieldsWarning = (column: string, type: string): string =>
  `Table x_demo_cred: ignoring the metaFields entry for column "${column}" — its dictionary type is ` +
  `${type}, and a value of that type is never written to the working tree.`;
const UNTYPED_WARNING =
  "Table x_demo_cred: could not read the dictionary type of included column(s) u_ghost " +
  "(no dictionary row or an empty internal_type); they are kept without the unsafe-type check.";

// One temp project per test, with the fixture's includes in its config.
type Fixture = {
  tmp: string;
  warn: jest.SpiedFunction<typeof logger.warn>;
  error: jest.SpiedFunction<typeof logger.error>;
};
const originalCwd = process.cwd();

const enterFixture = async (): Promise<Fixture> => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "secret-paths-")));
  const config = ConfigManager.getDefaultConfigFile("src").replace(
    "includes: {}",
    "includes:{ sys_properties: { value: { type: \"txt\" } }, " +
      'x_demo_cred: { u_token: { type: "txt" }, u_ghost: { type: "txt" } } }'
  ).replace(
    "tableOptions: {}",
    'tableOptions:{ x_demo_cred: { metaFields: ["u_token", "u_notes", "name"] } }'
  );
  fs.writeFileSync(path.join(tmp, "sync.config.js"), config);
  fs.mkdirSync(path.join(tmp, "src"));
  process.chdir(tmp);
  ConfigManager.resetConfigState();
  await ConfigManager.loadConfigs();
  for (const level of ["info", "debug", "success"] as const) {
    jest.spyOn(logger, level).mockImplementation((() => undefined) as never);
  }
  const warn = jest.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
  const error = jest.spyOn(logger, "error").mockImplementation((() => undefined) as never);
  fake.tableAPIGet.mockClear();
  process.exitCode = undefined;
  return { tmp, warn, error };
};

const leaveFixture = (fixture: Fixture): void => {
  jest.restoreAllMocks();
  process.chdir(originalCwd);
  ConfigManager.resetConfigState();
  fs.rmSync(fixture.tmp, { recursive: true, force: true });
  process.exitCode = undefined;
};

const writtenHolding = (tmp: string, needle: string): string[] =>
  walk(path.join(tmp, "src"))
    .filter((file) => fs.readFileSync(file, "utf8").includes(needle))
    .map((file) => path.relative(tmp, file).split(path.sep).join("/"));

// Every column a bulk record read (a `sys_idIN` query) selected, as
// `table.record.column`.
const bulkReadRequest = (): string[] =>
  fake.tableAPIGet.mock.calls.flatMap(([table, query, fields]) => {
    const ids = /^sys_idIN([^^]+)/.exec(String(query ?? ""))?.[1].split(",");
    if (!ids || !fields) return [];
    const columns = String(fields)
      .split(",")
      .filter((column) => column !== "sys_id" && column !== "name" && column !== "type");
    return ids.flatMap((sysId) => columns.map((column) => `${table}.${NAME_OF[sysId]}.${column}`));
  });

describe.each<[Command]>([["init"], ["refresh"], ["download"]])("secret columns: %s", (command) => {
  let fixture: Fixture;
  let tmp: string;
  let warn: Fixture["warn"];
  let error: Fixture["error"];

  beforeEach(async () => {
    fixture = await enterFixture();
    ({ tmp, warn, error } = fixture);
  });

  afterEach(() => leaveFixture(fixture));

  const listed = (table: string, record: string): string[] => {
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, "sync.manifest.json"), "utf8")) as {
      tables: Record<string, { records: Record<string, { files: Array<{ name: string }> }> }>;
    };
    return manifest.tables[table].records[record].files.map((file) => file.name);
  };

  it("writes, lists, warns and requests the same as every other path", async () => {
    await run[command]();

    // Errors: the only error is the untyped include — the instance has no
    // such column, so no read returns a value for it and a fetching command
    // reports that table incomplete. Kept rather than dropped: "no dictionary row" is also
    // what a row-level sys_dictionary ACL answers for a real column.
    const errors = error.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message !== "Error processing server response" && message !== "Not Found");
    expect(errors).toEqual(
      command === "init"
        ? []
        : [
            command === "refresh"
              ? "Refresh incomplete: 1 table(s) could not be fully fetched: x_demo_cred. " +
                "Check read access for the named field(s) and re-run."
              : "Download incomplete: 1 table(s) could not be fetched: x_demo_cred. " +
                "Re-run to retry — the completed tables are checkpointed.",
          ]
    );

    // Field files written: the string property's value, never the password
    // property's value or the password2 include.
    expect(writtenHolding(tmp, ENDPOINT)).toEqual(["src/sys_properties/x_demo.endpoint/value.txt"]);
    expect(writtenHolding(tmp, SECRET)).toEqual([]);
    expect(writtenHolding(tmp, TOKEN)).toEqual([]);
    expect(writtenHolding(tmp, NOTES)).toEqual([]);
    // Nothing that was withheld reaches the manifest on disk either.
    const manifestText = fs.readFileSync(path.join(tmp, "sync.manifest.json"), "utf8");
    expect(manifestText).not.toContain(SECRET);
    expect(manifestText).not.toContain(TOKEN);

    // The explicit metaFields list keeps its safe column and loses the
    // password2 and journal ones. init writes no sidecar (it writes the
    // content the manifest carries).
    const sidecarPath = path.join(tmp, "src/x_demo_cred/cred-one/.meta.json");
    expect(fs.existsSync(sidecarPath)).toBe(command !== "init");
    if (command !== "init") {
      expect(JSON.parse(fs.readFileSync(sidecarPath, "utf8"))).toEqual({ name: "cred-one" });
    }
    const manifestTables = (JSON.parse(manifestText) as { tables: Record<string, { metaFields?: string[] }> })
      .tables;
    expect(manifestTables.x_demo_cred.metaFields).toEqual(["name"]);
    const metaWarnings = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes("the metaFields entry"));
    expect(metaWarnings).toEqual([
      metaFieldsWarning("u_token", "password2"),
      metaFieldsWarning("u_notes", "journal"),
    ]);

    // Manifest record files: the unsafe include is never listed; the untyped
    // one is kept (it has no value anywhere, so nothing is written for it).
    expect(listed("x_demo_cred", "cred-one")).toEqual(
      expect.arrayContaining(["script", "u_ghost"])
    );
    expect(listed("x_demo_cred", "cred-one")).not.toContain("u_token");
    expect(listed("sys_properties", "x_demo.endpoint")).toContain("value");
    // The build reads each property's `type` with the record and drops the
    // password property's `value` from its listing.
    expect(listed("sys_properties", "x_demo.api_key")).not.toContain("value");

    // Warnings: one line per include judgement, same wording on every path.
    const includeWarnings = warn.mock.calls.map((call) => String(call[0])).filter(isIncludeWarning);
    expect(includeWarnings).toEqual([UNSAFE_WARNING, UNTYPED_WARNING]);

    // The bulk record read never names the unsafe include. A governed column
    // is read with its classifier and withheld afterwards, so its request is
    // not asserted here — the files written above are.
    const request = bulkReadRequest();
    expect(request.filter((entry) => entry.endsWith(".u_token"))).toEqual([]);
    if (command !== "init") {
      expect(request).toEqual(expect.arrayContaining(["x_demo_cred.cred-one.u_ghost"]));
    }
  });
});

// repair over a project a refresh built: the string property's value file is
// deleted, then repair runs report-only and --apply.
describe("secret columns: repair", () => {
  let fixture: Fixture;
  const endpointValue = (): string => path.join(fixture.tmp, "src/sys_properties/x_demo.endpoint/value.txt");

  beforeEach(async () => {
    fixture = await enterFixture();
    await run.refresh();
    fs.rmSync(endpointValue());
    fake.tableAPIGet.mockClear();
    fixture.warn.mockClear();
    process.exitCode = undefined;
  });

  afterEach(() => leaveFixture(fixture));

  it("report-only fetches nothing and writes nothing", async () => {
    await repairCommand({ logLevel: "info", ci: true } as never);

    expect(bulkReadRequest()).toEqual([]);
    expect(fs.existsSync(endpointValue())).toBe(false);
    expect(writtenHolding(fixture.tmp, SECRET)).toEqual([]);
    expect(writtenHolding(fixture.tmp, TOKEN)).toEqual([]);
    expect(writtenHolding(fixture.tmp, NOTES)).toEqual([]);
  });

  it("--apply restores the non-secret value and never writes or requests a secret", async () => {
    await repairCommand({ logLevel: "info", ci: true, apply: true } as never);

    expect(fs.readFileSync(endpointValue(), "utf8")).toBe(ENDPOINT);
    expect(writtenHolding(fixture.tmp, ENDPOINT)).toEqual(["src/sys_properties/x_demo.endpoint/value.txt"]);
    expect(writtenHolding(fixture.tmp, SECRET)).toEqual([]);
    expect(writtenHolding(fixture.tmp, TOKEN)).toEqual([]);
    expect(writtenHolding(fixture.tmp, NOTES)).toEqual([]);
    const manifestText = fs.readFileSync(path.join(fixture.tmp, "sync.manifest.json"), "utf8");
    expect(manifestText).not.toContain(SECRET);
    expect(manifestText).not.toContain(TOKEN);

    const request = bulkReadRequest();
    expect(request.filter((entry) => entry.endsWith(".u_token"))).toEqual([]);
  });
});
