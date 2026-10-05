// The sys_properties record secret rule on the paths beyond `refresh`:
//   - `init` (wizard downloadApp) takes file CONTENTS from the scoped manifest
//     endpoint, which knows nothing about the rule, so the password property's
//     value must be withheld before the manifest is written to disk;
//   - `repair` must converge on a workspace where that value is absent by design.
// No instance is contacted: the client is a fake injected through snClient.
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

const SECRET = "S3CR3T-FROM-SCOPED-ENDPOINT";
const ENDPOINT = "https://example.test";
const A = "a".repeat(32);
const B = "b".repeat(32);
const ok = (result: unknown) =>
  Promise.resolve({ status: 200, data: { result } }) as Promise<never>;

const valueFile = (content: string, withContent: boolean) => ({
  name: "value",
  type: "txt",
  ...(withContent ? { content } : {}),
});

const scopedManifest = (withFiles: boolean) => ({
  scope: "x_demo",
  tables: {
    sys_properties: {
      records: {
        "x_demo.api_key": {
          sys_id: A,
          name: "x_demo.api_key",
          files: [valueFile(SECRET, withFiles)],
        },
        "x_demo.endpoint": {
          sys_id: B,
          name: "x_demo.endpoint",
          files: [valueFile(ENDPOINT, withFiles)],
        },
      },
    },
  },
});

const PROPS = [
  { sys_id: A, name: "x_demo.api_key", type: "password2", value: SECRET },
  { sys_id: B, name: "x_demo.endpoint", type: "string", value: ENDPOINT },
];

const fake = {
  getManifest: jest.fn((_scope: string, _config: unknown, withFiles = false) =>
    ok(scopedManifest(Boolean(withFiles)))
  ),
  // The scoped missing-files endpoint ignores the rule and returns both values.
  getMissingFiles: jest.fn(() => ok(scopedManifest(true).tables)),
  tableAPIGet: jest.fn((table: string, query: string) => {
    if (table === "sys_app" || table === "sys_scope") return ok([{ sys_id: "c".repeat(32) }]);
    if (table === "sys_properties") {
      const q = String(query);
      if (q.startsWith("sys_idIN")) {
        const ids = q.slice("sys_idIN".length).split("^")[0].split(",");
        return ok(PROPS.filter((p) => ids.includes(p.sys_id)));
      }
      return ok(PROPS);
    }
    return ok([]);
  }),
};

const actual = await import("../snClient.js");
jest.unstable_mockModule("../snClient.js", () => ({ ...actual, defaultClient: () => fake }));

const { downloadApp } = await import("../wizard.js");
const { syncManifest, applyRecordSecretRulesToContent } = await import("../downloadPipeline.js");
const { repairCommand } = await import("../repairCommand.js");
const ConfigManager = await import("../config.js");
const { logger } = await import("../Logger.js");

const walk = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    : [];

describe("sys_properties record secret rule on init and repair", () => {
  const originalCwd = process.cwd();
  let tmp: string;
  let info: jest.SpiedFunction<typeof logger.info>;
  let success: jest.SpiedFunction<typeof logger.success>;
  let error: jest.SpiedFunction<typeof logger.error>;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "secret-rule-init-")));
    // `includes` makes `value` a field file of every property — the shape in
    // which the scoped endpoint hands back its content.
    const config = ConfigManager.getDefaultConfigFile("src").replace(
      "includes:{}",
      'includes:{ sys_properties: { value: { type: "txt" } } }'
    );
    fs.writeFileSync(path.join(tmp, "sync.config.js"), config);
    fs.mkdirSync(path.join(tmp, "src"));
    process.chdir(tmp);
    ConfigManager.resetConfigState();
    for (const level of ["warn", "debug"] as const) {
      jest.spyOn(logger, level).mockImplementation((() => undefined) as never);
    }
    info = jest.spyOn(logger, "info").mockImplementation((() => undefined) as never);
    success = jest.spyOn(logger, "success").mockImplementation((() => undefined) as never);
    error = jest.spyOn(logger, "error").mockImplementation((() => undefined) as never);
    fake.getManifest.mockClear();
    fake.getMissingFiles.mockClear();
    fake.tableAPIGet.mockClear();
    process.exitCode = undefined;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.chdir(originalCwd);
    ConfigManager.resetConfigState();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  const written = () => {
    const files = walk(path.join(tmp, "src"));
    const holding = (needle: string) =>
      files.filter((f) => fs.readFileSync(f, "utf8").includes(needle)).map((f) => path.relative(tmp, f));
    return { files, holding };
  };

  it("init (downloadApp) withholds the password property's value from the scoped endpoint", async () => {
    await ConfigManager.loadConfigs();

    await downloadApp("x_demo", fake as never);

    const { holding } = written();
    expect(holding(SECRET)).toEqual([]);
    // The non-secret property keeps its value file, filled from the Table API.
    const endpointFiles = holding(ENDPOINT);
    expect(endpointFiles).toHaveLength(1);
    expect(path.basename(endpointFiles[0])).toBe("value.txt");
    // The governed values were re-read by sys_id, with the classifier column.
    const ruleReads = fake.tableAPIGet.mock.calls.filter(
      (c) => c[0] === "sys_properties" && String(c[1]).startsWith("sys_idIN")
    );
    expect(ruleReads.length).toBeGreaterThan(0);
    expect(String(ruleReads[0][1])).toContain(A);
    // Nothing the scoped manifest held for the secret record survives in the
    // manifest written to disk.
    const manifestText = fs.readFileSync(path.join(tmp, "sync.manifest.json"), "utf8");
    expect(manifestText).not.toContain(SECRET);
  });

  it("refresh (syncManifest) withholds the same value", async () => {
    fs.writeFileSync(path.join(tmp, "sync.manifest.json"), JSON.stringify({ scope: "x_demo", tables: {} }));
    await ConfigManager.loadConfigs();

    await syncManifest();

    expect(written().holding(SECRET)).toEqual([]);
    expect(written().holding(ENDPOINT)).toHaveLength(1);
  });

  it("repair converges after refresh: the withheld value is not reported missing", async () => {
    fs.writeFileSync(path.join(tmp, "sync.manifest.json"), JSON.stringify({ scope: "x_demo", tables: {} }));
    await ConfigManager.loadConfigs();
    await syncManifest();

    const rounds: Array<{ report?: string; success: string[]; exitCode: number | undefined }> = [];
    for (const apply of [false, true, false]) {
      info.mockClear();
      success.mockClear();
      process.exitCode = undefined;
      await repairCommand({ logLevel: "info", ci: true, apply } as never);
      rounds.push({
        report: info.mock.calls.map((c) => String(c[0])).find((m) => m.startsWith("Repair report")),
        success: success.mock.calls.map((c) => String(c[0])),
        exitCode: process.exitCode as number | undefined,
      });
    }

    for (const round of rounds) {
      expect(round.report).toContain("0 missing file(s)");
      expect(round.exitCode).toBeUndefined();
      expect(round.success.join("\n")).toContain("Nothing to repair");
    }
    expect(error).not.toHaveBeenCalled();
    expect(written().holding(SECRET)).toEqual([]);
  });

  it("repair --apply restores a deleted non-secret value while the password one stays absent", async () => {
    fs.writeFileSync(path.join(tmp, "sync.manifest.json"), JSON.stringify({ scope: "x_demo", tables: {} }));
    await ConfigManager.loadConfigs();
    await syncManifest();
    const [endpointFile] = written().holding(ENDPOINT);
    expect(endpointFile).toBeDefined();
    fs.rmSync(path.join(tmp, endpointFile));

    const infoLines = () => info.mock.calls.map((c) => String(c[0]));
    const report = () => infoLines().find((m) => m.startsWith("Repair report"));

    // Report only: the count is unchanged (governed columns are not counted),
    // and the "Not counted" line points at `--apply`.
    info.mockClear();
    await repairCommand({ logLevel: "info", ci: true } as never);
    expect(report()).toContain("0 missing file(s)");
    expect(infoLines().find((m) => m.startsWith("Not counted: 2 field file(s)"))).toContain(
      "`--apply`"
    );
    expect(fs.existsSync(path.join(tmp, endpointFile))).toBe(false);

    info.mockClear();
    success.mockClear();
    await repairCommand({ logLevel: "info", ci: true, apply: true } as never);
    expect(fs.readFileSync(path.join(tmp, endpointFile), "utf8")).toBe(ENDPOINT);
    expect(written().holding(SECRET)).toEqual([]);
    expect(infoLines()).toContain(
      "Restored 1 of 2 field file(s) a record secret rule governs (non-secret values)."
    );
    expect(success.mock.calls.map((c) => String(c[0]))).toEqual(["Repair complete. ✅"]);
    expect(process.exitCode).toBeUndefined();
    expect(error).not.toHaveBeenCalled();

    // The next run converges: only the withheld secret is left uncounted.
    info.mockClear();
    success.mockClear();
    await repairCommand({ logLevel: "info", ci: true, apply: true } as never);
    expect(infoLines().find((m) => m.startsWith("Not counted:"))).toMatch(/^Not counted: 1 field file/);
    expect(success.mock.calls.map((c) => String(c[0])).join("\n")).toContain("Nothing to repair");
    expect(written().holding(SECRET)).toEqual([]);
  });
});

describe("applyRecordSecretRulesToContent", () => {
  beforeEach(() => fake.tableAPIGet.mockClear());

  const manifestOf = (tables: Record<string, unknown>) =>
    ({ scope: "x_demo", tables }) as never as Parameters<typeof applyRecordSecretRulesToContent>[0];

  it("costs no request when no record lists a governed column", async () => {
    const manifest = manifestOf({
      sys_script: {
        records: { r: { sys_id: A, name: "r", files: [{ name: "value", type: "txt", content: "kept" }] } },
      },
      sys_properties: {
        records: { p: { sys_id: B, name: "p", files: [{ name: "description", type: "txt", content: "kept" }] } },
      },
    });

    await applyRecordSecretRulesToContent(manifest, fake as never, {});

    expect(fake.tableAPIGet).not.toHaveBeenCalled();
    // Only a governed column of a governed table is ever touched.
    expect(JSON.stringify(manifest)).toContain('"content":"kept"');
  });

  it("keeps the endpoint content of a non-secret record, drops a secret one, and leaves an unreturned record empty", async () => {
    const C = "c".repeat(32);
    const manifest = manifestOf({
      sys_properties: {
        records: {
          secret: { sys_id: A, name: "secret", files: [{ name: "value", type: "txt", content: SECRET }] },
          plain: {
            sys_id: B,
            name: "plain",
            files: [
              { name: "value", type: "txt", content: "stale" },
              { name: "description", type: "txt", content: "untouched" },
            ],
          },
          gone: { sys_id: C, name: "gone", files: [{ name: "value", type: "txt", content: "endpoint-only" }] },
        },
      },
    });

    await applyRecordSecretRulesToContent(manifest, fake as never, {});

    const records = (manifest as unknown as {
      tables: Record<string, { records: Record<string, { files: Array<{ name: string; content?: string }> }> }>;
    }).tables.sys_properties.records;
    const contentOf = (key: string, name: string) => records[key].files.find((f) => f.name === name);
    expect(contentOf("secret", "value")).not.toHaveProperty("content");
    expect(contentOf("plain", "value")?.content).toBe(ENDPOINT);
    expect(contentOf("plain", "description")?.content).toBe("untouched");
    // The Table API did not return this record, so the endpoint's value is not trusted.
    expect(contentOf("gone", "value")).not.toHaveProperty("content");
    expect(JSON.stringify(manifest)).not.toContain(SECRET);
  });
});
