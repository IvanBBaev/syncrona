// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import type { SN } from "@syncrona/types";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
export {};

// `syncrona fluent` owns only the CLI boundary of the Fluent tier: flag-to-call
// mapping, project discovery, credential bridging, consent for `install`, and
// exit codes. The engine is `@syncrona/fluent`'s own test surface, so it is a
// recording fake here; no case loads the ServiceNow SDK or touches the network
// (the one OAuth case answers the token POST from a stubbed `fetch`).

let fluentCommand: typeof import("../fluentCommand.js").fluentCommand;
let planFluentAction: typeof import("../fluentCommand.js").planFluentAction;
let loadFluentModule: typeof import("../fluentCommand.js").loadFluentModule;
let FLUENT_INSTALL_HINT: string;
let logger: typeof import("../Logger.js").logger;

type Deps = NonNullable<Parameters<typeof fluentCommand>[1]>;

const AUTH_ENV_VARS = [
  "SN_INSTANCE",
  "SN_USER",
  "SN_PASSWORD",
  "SN_AUTH_METHOD",
  "SN_API_KEY",
  "SN_API_KEY_HEADER",
  "SN_OAUTH_CLIENT_ID",
  "SN_OAUTH_CLIENT_SECRET",
  "SN_INSTANCE_PROFILE",
  "SN_CLIENT_CERT",
] as const;

const PROJECT = path.resolve("/work/app");
const CONFIG_FILE = path.join(PROJECT, "now.config.json");

interface Recorder {
  calls: Array<{ method: string; options?: unknown }>;
  engineOptions: SN.FluentEngineOptions[];
  authInputs: Array<{ instanceUrl: string; input: SN.FluentCredentialInput }>;
  written: string[];
  prompts: string[];
  generated: Array<{ profile?: string; options: unknown }>;
  outputs: Record<string, string>;
}

const TABLE_TOPIC: SN.FluentDocTopic = { name: "table", tags: ["fluent", "table"], summary: "Tables." };
const RULE_TOPIC: SN.FluentDocTopic = { name: "business-rule", tags: [], summary: "Rules." };
const GLOBAL_CONFIG = { [CONFIG_FILE]: JSON.stringify({ scope: "global", scopeId: "abc" }) };

const NATIVE_RESULT = { content: "export interface Tables {}\n", tableCount: 2, fieldCount: 5 };

function fakeEngine(rec: Recorder, overrides: Partial<SN.FluentEngine> = {}): SN.FluentEngine {
  const record =
    <T>(method: string, result: T) =>
    async (options?: unknown) => {
      rec.calls.push({ method, options });
      return result;
    };
  return {
    build: record("build", { success: true, errors: [], warnings: ["w1"] }),
    transform: record("transform", { changedFiles: ["src/a.now.ts"], handledPaths: ["a.js"] }),
    pack: record("pack", "/work/app/target/app.zip"),
    install: record("install", { trackerId: "trk", rollbackId: "rb" }),
    installStatus: record("installStatus", { finished: true, id: "inst-1" }),
    types: record("types", undefined),
    addDependency: record("addDependency", undefined),
    run: record("run", undefined),
    createProject: record("createProject", undefined),
    createProjectFromApp: record("createProjectFromApp", undefined),
    explain: record("explain", { kind: "topic", topic: TABLE_TOPIC, body: "# Table\n\nTables." }),
    moveToApp: record("moveToApp", { moved: true, changedFiles: ["src/claimed.now.ts"], handledPaths: ["claimed.xml"] }),
    sdkVersion: async () => "4.13.3",
    ...overrides,
  } as SN.FluentEngine;
}

const ID_A = "a1".padEnd(32, "0");
const ID_B = "b2".padEnd(32, "0");

function harness(
  options: {
    engine?: Partial<SN.FluentEngine>;
    credential?: SN.FluentCredentialInput;
    confirm?: boolean;
    files?: Record<string, string>;
    cwd?: string;
  } = {}
): { rec: Recorder; deps: Partial<Deps> } {
  const rec: Recorder = {
    calls: [],
    engineOptions: [],
    authInputs: [],
    written: [],
    prompts: [],
    generated: [],
    outputs: {},
  };
  const files: Record<string, string> = options.files ?? {
    [CONFIG_FILE]: JSON.stringify({ scope: "x_acme_app" }),
  };
  const deps: Partial<Deps> = {
    cwd: options.cwd ?? path.join(PROJECT, "src", "fluent"),
    loadFluent: async () => ({
      createFluentEngine: (engineOptions: SN.FluentEngineOptions) => {
        rec.engineOptions.push(engineOptions);
        return fakeEngine(rec, options.engine);
      },
      createFluentAuthResolver: (instanceUrl: string, input: SN.FluentCredentialInput) => {
        rec.authInputs.push({ instanceUrl, input });
        return async () => ({ type: "oauth", token: "t" });
      },
    }),
    resolveCredential: async () => ({
      instanceUrl: "https://dev1.service-now.com/",
      input: options.credential ?? { kind: "basic", username: "admin", password: "pw" },
    }),
    confirm: async (message: string) => {
      rec.prompts.push(message);
      return options.confirm ?? true;
    },
    exists: async (file: string) => file in files,
    readFile: async (file: string) => {
      if (!(file in files)) throw new Error(`ENOENT ${file}`);
      return files[file];
    },
    write: (line: string) => {
      rec.written.push(line);
    },
    interactive: () => true,
    getClient: (profile?: string) => ({ profile }) as never,
    generateTypes: async (client: unknown, generateOptions: unknown) => {
      rec.generated.push({ profile: (client as { profile?: string }).profile, options: generateOptions });
      return NATIVE_RESULT;
    },
    writeFile: async (file: string, content: string) => {
      rec.outputs[file] = content;
    },
  };
  return { rec, deps };
}

async function run(args: Record<string, unknown>, deps: Partial<Deps>): Promise<number> {
  process.exitCode = undefined;
  await fluentCommand({ logLevel: "info", ...args } as never, deps);
  const code = typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = undefined;
  return code;
}

let infos: string[];
let warnings: string[];
let errors: string[];
let savedEnv: Record<string, string | undefined>;
const roots: string[] = [];

beforeAll(async () => {
  ({ fluentCommand, planFluentAction, loadFluentModule, FLUENT_INSTALL_HINT } = await import(
    "../fluentCommand.js"
  ));
  ({ logger } = await import("../Logger.js"));
});

beforeEach(() => {
  savedEnv = Object.fromEntries(AUTH_ENV_VARS.map((name) => [name, process.env[name]]));
  for (const name of AUTH_ENV_VARS) delete process.env[name];
  infos = [];
  warnings = [];
  errors = [];
  jest.spyOn(logger, "info").mockImplementation((m: unknown) => {
    infos.push(String(m));
  });
  jest.spyOn(logger, "success").mockImplementation((m: unknown) => {
    infos.push(String(m));
  });
  jest.spyOn(logger, "warn").mockImplementation((m: unknown) => {
    warnings.push(String(m));
  });
  jest.spyOn(logger, "error").mockImplementation((m: unknown) => {
    errors.push(String(m));
  });
  jest.spyOn(logger, "debug").mockImplementation(() => {});
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  jest.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("planFluentAction (flag mapping)", () => {
  it("maps init to createProject, passing only the flags given", () => {
    expect(planFluentAction("init", { name: "App", scope: "x_a" } as never)).toEqual({
      method: "createProject",
      options: { name: "App", scope: "x_a" },
      instance: false,
    });
    expect(
      planFluentAction("init", {
        name: "App",
        scope: "x_a",
        packageName: "app",
        description: "d",
        template: "base",
      } as never).options
    ).toEqual({ name: "App", scope: "x_a", packageName: "app", description: "d", templateId: "base" });
  });

  it("maps init --from to createProjectFromApp, which needs the instance", () => {
    expect(planFluentAction("init", { from: "abc" } as never)).toEqual({
      method: "createProjectFromApp",
      options: { scopeId: "abc" },
      instance: true,
    });
    expect(planFluentAction("init", { from: "abc", packageName: "p" } as never).options).toEqual({
      scopeId: "abc",
      packageName: "p",
    });
  });

  it("refuses init without --name or --scope", () => {
    expect(() => planFluentAction("init", { scope: "x" } as never)).toThrow("fluent init needs --name");
    expect(() => planFluentAction("init", { name: "x" } as never)).toThrow("fluent init needs --scope");
  });

  it("maps build flags", () => {
    expect(planFluentAction("build", {} as never).options).toEqual({});
    expect(
      planFluentAction("build", { frozenKeys: true, errorOnConflict: true, skipClean: true } as never).options
    ).toEqual({ frozenKeys: true, errorOnConflict: true, skipClean: true });
  });

  it("maps the four transform modes", () => {
    expect(planFluentAction("transform", { paths: "a.js, b.js", table: "sys_script", force: true } as never)).toEqual({
      method: "transform",
      options: { mode: "paths", paths: ["a.js", "b.js"], tables: ["sys_script"], force: true },
      instance: false,
    });
    expect(planFluentAction("transform", { paths: "a.js" } as never).options).toEqual({
      mode: "paths",
      paths: ["a.js"],
    });
    expect(planFluentAction("transform", { updateSet: "us1" } as never)).toEqual({
      method: "transform",
      options: { mode: "update-set", updateSetId: "us1" },
      instance: true,
    });
    expect(planFluentAction("transform", { incremental: true } as never).options).toEqual({ mode: "incremental" });
    expect(planFluentAction("transform", {} as never).options).toEqual({ mode: "complete" });
  });

  it("maps pack and install flags", () => {
    expect(planFluentAction("pack", {} as never).options).toEqual({});
    expect(planFluentAction("pack", { out: "x.zip" } as never).options).toEqual({ packagePath: "x.zip" });
    expect(planFluentAction("install", { demoData: true } as never).options).toEqual({});
    expect(
      planFluentAction("install", {
        reinstall: true,
        store: true,
        sync: true,
        demoData: false,
        skipFlowActivation: true,
      } as never).options
    ).toEqual({
      clean: true,
      installAsStoreApp: true,
      installAsync: false,
      demoData: false,
      skipFlowActivation: true,
    });
  });

  it("maps types: no flag passes {}, one flag turns the other off", () => {
    expect(planFluentAction("types", {} as never).options).toEqual({});
    expect(planFluentAction("types", { scripts: true } as never).options).toEqual({
      downloadScripts: true,
      downloadFluent: false,
    });
    expect(planFluentAction("types", { fluent: true } as never).options).toEqual({
      downloadScripts: false,
      downloadFluent: true,
    });
  });

  it("maps types --native to the native generator and refuses SDK-only flags with it", () => {
    expect(planFluentAction("types", { native: true } as never)).toEqual({
      method: "nativeTypes",
      options: {},
      instance: true,
    });
    expect(
      planFluentAction("types", { native: true, scope: "x_s", table: "a, b", out: "t.d.ts" } as never).options
    ).toEqual({ scope: "x_s", tables: ["a", "b"], out: "t.d.ts" });
    expect(() => planFluentAction("types", { native: true, scripts: true } as never)).toThrow("--scripts or --fluent");
    expect(() => planFluentAction("types", { native: true, fluent: true } as never)).toThrow("--scripts or --fluent");
  });

  it("maps dependencies with and without --table", () => {
    expect(planFluentAction("dependencies", {} as never)).toEqual({ method: "types", options: {}, instance: true });
    expect(planFluentAction("dependencies", { table: "sys_db_object", ids: "a,b", scope: "global" } as never)).toEqual({
      method: "addDependency",
      options: { table: "sys_db_object", ids: ["a", "b"], scope: "global" },
      instance: true,
    });
    expect(planFluentAction("dependencies", { table: "t", scope: "global" } as never).options).toEqual({
      table: "t",
      ids: [],
      scope: "global",
    });
    expect(() => planFluentAction("dependencies", { table: "t" } as never)).toThrow("needs --scope");
  });

  it("maps run and status", () => {
    expect(planFluentAction("run", { script: "seed" } as never)).toEqual({
      method: "run",
      options: { script: "seed" },
      instance: false,
    });
    expect(() => planFluentAction("run", {} as never)).toThrow("fluent run needs --script");
    expect(planFluentAction("status", {} as never)).toEqual({ method: "installStatus", options: {}, instance: true });
  });

  it("maps explain locally, passing only the flags given", () => {
    expect(planFluentAction("explain", {} as never)).toEqual({ method: "explain", options: {}, instance: false });
    expect(planFluentAction("explain", { topic: "  " } as never).options).toEqual({});
    expect(planFluentAction("explain", { topic: " flow ", list: true, peek: true } as never).options).toEqual({
      topic: "flow",
      list: true,
      peek: true,
    });
  });

  it("maps move-to-app to an instance call and requires at least one sys_id", () => {
    expect(planFluentAction("move-to-app", { ids: `${ID_A}, ${ID_B},` } as never)).toEqual({
      method: "moveToApp",
      options: { sysIds: [ID_A, ID_B] },
      instance: true,
    });
    expect(() => planFluentAction("move-to-app", {} as never)).toThrow("fluent move-to-app needs --ids");
    expect(() => planFluentAction("move-to-app", { ids: " , " } as never)).toThrow("fluent move-to-app needs --ids");
    expect(() => planFluentAction("install", { topic: "prod", ci: true } as never)).toThrow(
      'fluent install takes no positional argument (got "prod"); only `fluent explain <topic>` does.'
    );
    expect(planFluentAction("build", { topic: "  " } as never).method).toBe("build");
  });
});

describe("fluentCommand: dispatch and exit codes", () => {
  it("rejects an unknown action with exit 1", async () => {
    const { deps } = harness();
    expect(await run({ action: "deploy" }, deps)).toBe(1);
    expect(errors.join("\n")).toContain('Unknown fluent action "deploy"');
    expect(await run({}, deps)).toBe(1);
  });

  it("prints the planned call on --dry-run, only probing the adapter and never prompting", async () => {
    const { rec, deps } = harness();
    const loadFluent = jest.fn(deps.loadFluent!);
    const resolveCredential = jest.fn(deps.resolveCredential!);
    expect(
      await run({ action: "install", dryRun: true, reinstall: true }, { ...deps, loadFluent, resolveCredential })
    ).toBe(0);
    // The probe resolves the adapter and the SDK as the real run does, and calls nothing else.
    expect(loadFluent).toHaveBeenCalledWith(PROJECT);
    expect(rec.engineOptions).toEqual([{ projectDir: PROJECT, logger: expect.anything() }]);
    expect(rec.calls).toEqual([]);
    expect(rec.authInputs).toEqual([]);
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(rec.prompts).toEqual([]);
    expect(rec.written).toEqual([
      '[dry-run] fluent install → engine.install({"clean":true}) against the active instance',
    ]);
    expect(await run({ action: "build", dryRun: true }, deps)).toBe(0);
    expect(rec.written[1]).toBe("[dry-run] fluent build → engine.build({}) (local only)");
  });

  it("builds from the nearest now.config.json and passes no credential for a local action", async () => {
    const { rec, deps } = harness();
    expect(await run({ action: "build", frozenKeys: true }, deps)).toBe(0);
    expect(rec.calls).toEqual([{ method: "build", options: { frozenKeys: true } }]);
    expect(rec.engineOptions[0].projectDir).toBe(PROJECT);
    expect(rec.engineOptions[0].auth).toBeUndefined();
    expect(rec.engineOptions[0].instanceUrl).toBeUndefined();
    expect(rec.authInputs).toEqual([]);
    expect(warnings).toContain("w1");
    expect(infos).toContain("Fluent build complete.");
    // The engine logger forwards to core's logger.
    rec.engineOptions[0].logger.info("i");
    rec.engineOptions[0].logger.warn("w");
    rec.engineOptions[0].logger.debug("d");
    expect(infos).toContain("i");
    expect(warnings).toContain("w");
  });

  it("exits 2 when the build reports errors", async () => {
    const { deps } = harness({
      engine: { build: async () => ({ success: false, errors: ["e1", "e2"], warnings: [] }) },
    });
    expect(await run({ action: "build" }, deps)).toBe(2);
    expect(errors).toEqual(["e1", "e2", "Fluent build failed with 2 error(s)."]);
  });

  it("emits JSON for a build with --json", async () => {
    const { rec, deps } = harness();
    expect(await run({ action: "build", json: true }, deps)).toBe(0);
    expect(JSON.parse(rec.written[0])).toEqual({
      command: "fluent build",
      exitCode: 0,
      success: true,
      errors: [],
      warnings: ["w1"],
    });
  });

  it("refuses when no now.config.json exists up the tree", async () => {
    const { deps } = harness({ files: {} });
    expect(await run({ action: "pack" }, deps)).toBe(1);
    expect(errors[0]).toContain("No now.config.json found");
  });

  it("honours --project and refuses a directory that is not a Fluent project", async () => {
    const { rec, deps } = harness({ cwd: "/elsewhere" });
    expect(await run({ action: "pack", project: PROJECT, out: "x.zip" }, deps)).toBe(0);
    expect(rec.calls).toEqual([{ method: "pack", options: { packagePath: "x.zip" } }]);
    expect(infos).toContain("Packed /work/app/target/app.zip");
    expect(await run({ action: "pack", project: "/nope" }, deps)).toBe(1);
    expect(errors[0]).toContain("it is not a Fluent project");
  });

  it("transforms locally and reports the changed files", async () => {
    const { rec, deps } = harness();
    expect(await run({ action: "transform", paths: "a.js" }, deps)).toBe(0);
    expect(rec.calls[0]).toEqual({ method: "transform", options: { mode: "paths", paths: ["a.js"] } });
    expect(rec.authInputs).toEqual([]);
    expect(infos).toContain("  src/a.now.ts");
    expect(infos).toContain("Transformed 1 source(s); 1 file(s) changed.");
  });

  it("hands the resolved credential to the adapter for an instance action", async () => {
    const { rec, deps } = harness({ credential: { kind: "basic", username: "admin", password: "pw" } });
    expect(await run({ action: "transform" }, deps)).toBe(0);
    expect(rec.authInputs).toEqual([
      { instanceUrl: "https://dev1.service-now.com/", input: { kind: "basic", username: "admin", password: "pw" } },
    ]);
    expect(rec.engineOptions[0].instanceUrl).toBe("https://dev1.service-now.com/");
    expect(typeof rec.engineOptions[0].auth).toBe("function");
  });

  it("refuses an API-key or mutual-TLS profile, naming the session-only endpoints", async () => {
    const { rec, deps } = harness({ credential: { kind: "unsupported", method: "api-key" } });
    expect(await run({ action: "status" }, deps)).toBe(1);
    expect(rec.calls).toEqual([]);
    expect(errors[0]).toContain("cannot use a api-key profile");
    expect(errors[0]).toContain("sn_appclient_upload_processor.do");
  });

  it("runs types, dependencies and run", async () => {
    const { rec, deps } = harness();
    expect(await run({ action: "types", scripts: true }, deps)).toBe(0);
    expect(await run({ action: "dependencies", table: "t", ids: "a", scope: "global" }, deps)).toBe(0);
    expect(await run({ action: "dependencies" }, deps)).toBe(0);
    expect(await run({ action: "run", script: "seed" }, deps)).toBe(0);
    expect(rec.calls.map((c) => c.method)).toEqual(["types", "addDependency", "types", "run"]);
    expect(infos).toContain("Added 1 t dependency record(s).");
    expect(infos).toContain("Ran seed.");
  });

  it("emits JSON for the remaining actions", async () => {
    const { rec, deps } = harness();
    for (const args of [
      { action: "transform", paths: "a.js" },
      { action: "pack" },
      { action: "install", ci: true },
      { action: "types" },
      { action: "dependencies", table: "t", ids: "a", scope: "g" },
      { action: "run", script: "s" },
      { action: "status" },
    ]) {
      expect(await run({ ...args, json: true }, deps)).toBe(0);
    }
    const parsed = rec.written.map((line) => JSON.parse(line) as { command: string; exitCode: number });
    expect(parsed.map((p) => p.command)).toEqual([
      "fluent transform",
      "fluent pack",
      "fluent install",
      "fluent types",
      "fluent dependencies",
      "fluent run",
      "fluent status",
    ]);
    expect(parsed.every((p) => p.exitCode === 0)).toBe(true);
    expect(parsed[6]).toMatchObject({ sdkVersion: "4.13.3", finished: true, id: "inst-1" });
  });
});

describe("fluentCommand: types --native", () => {
  const DEFAULT_OUT = path.join(PROJECT, "@types", "syncrona", "tables.d.ts");

  it("generates the project's scope into the default file without loading the adapter", async () => {
    const { rec, deps } = harness();
    expect(await run({ action: "types", native: true }, deps)).toBe(0);
    expect(rec.engineOptions).toEqual([]);
    expect(rec.generated).toEqual([{ profile: undefined, options: { scope: "x_acme_app" } }]);
    expect(rec.outputs).toEqual({ [DEFAULT_OUT]: NATIVE_RESULT.content });
    expect(infos).toContain(`Wrote 2 table type(s) with 5 field(s) to ${DEFAULT_OUT}.`);
  });

  it("needs no credential bridge, so an API-key profile works", async () => {
    const { rec, deps } = harness({ credential: { kind: "unsupported", method: "api-key" } });
    expect(await run({ action: "types", native: true, instanceProfile: "dev2" }, deps)).toBe(0);
    expect(rec.generated[0].profile).toBe("dev2");
  });

  it("takes --scope, --table and --out over the project's defaults", async () => {
    const { rec, deps } = harness();
    expect(await run({ action: "types", native: true, scope: "x_other", out: "types/t.d.ts" }, deps)).toBe(0);
    expect(rec.generated[0].options).toEqual({ scope: "x_other" });
    expect(Object.keys(rec.outputs)).toEqual([path.resolve(PROJECT, "src", "fluent", "types/t.d.ts")]);

    expect(await run({ action: "types", native: true, table: "incident,task" }, deps)).toBe(0);
    // The generator ignores a scope next to --table, so the project's scope is not read for it.
    expect(rec.generated[1].options).toEqual({ tables: ["incident", "task"] });
  });

  it("runs outside a project when --out and a scope or tables are given", async () => {
    const { rec, deps } = harness({ files: {}, cwd: path.resolve("/elsewhere") });
    expect(await run({ action: "types", native: true, table: "incident", out: "t.d.ts" }, deps)).toBe(0);
    expect(rec.generated[0].options).toEqual({ tables: ["incident"] });
    expect(Object.keys(rec.outputs)).toEqual([path.resolve("/elsewhere", "t.d.ts")]);

    expect(await run({ action: "types", native: true, out: "t.d.ts" }, deps)).toBe(1);
    expect(errors[0]).toContain("No now.config.json found");
  });

  it("refuses when neither the flags nor now.config.json name a scope", async () => {
    const { rec, deps } = harness({ files: { [CONFIG_FILE]: "{}" } });
    expect(await run({ action: "types", native: true }, deps)).toBe(1);
    expect(errors[0]).toContain("needs a scope");
    expect(rec.generated).toEqual([]);
  });

  it("treats a whitespace-only scope in now.config.json as none", async () => {
    const { rec, deps } = harness({ files: { [CONFIG_FILE]: JSON.stringify({ scope: "   " }) } });
    expect(await run({ action: "types", native: true }, deps)).toBe(1);
    expect(errors[0]).toContain("needs a scope");
    expect(rec.generated).toEqual([]);
  });

  it("reads the scope from a now.config.json with a BOM, comments and trailing commas", async () => {
    // Starts with a byte-order mark, written as an escape so it stays visible.
    const content = '\uFEFF{\n  // generated by the SDK\n  "scope": " x_acme_app ", /* id */ "scopeId": "abc",\n}';
    const { rec, deps } = harness({ files: { [CONFIG_FILE]: content } });
    expect(await run({ action: "types", native: true }, deps)).toBe(0);
    expect(rec.generated[0].options).toEqual({ scope: "x_acme_app" });
  });

  it("warns when the scope has no tables, and emits the JSON result", async () => {
    const { rec, deps } = harness();
    const empty = { content: "", tableCount: 0, fieldCount: 0 };
    expect(await run({ action: "types", native: true }, { ...deps, generateTypes: async () => empty })).toBe(0);
    expect(warnings).toEqual(["No tables found for scope x_acme_app; wrote an empty type file."]);

    expect(await run({ action: "types", native: true, json: true }, deps)).toBe(0);
    expect(JSON.parse(rec.written[0])).toEqual({
      command: "fluent types",
      exitCode: 0,
      mode: "native",
      file: DEFAULT_OUT,
      scope: "x_acme_app",
      tableCount: 2,
      fieldCount: 5,
    });
    expect(await run({ action: "types", native: true, json: true, table: "a" }, deps)).toBe(0);
    expect(JSON.parse(rec.written[1])).toMatchObject({ tables: ["a"] });
    expect(JSON.parse(rec.written[1])).not.toHaveProperty("scope");
  });

  it("describes the reads on --dry-run without touching the instance", async () => {
    const { rec, deps } = harness();
    expect(await run({ action: "types", native: true, table: "incident", dryRun: true }, deps)).toBe(0);
    expect(rec.written).toEqual([
      '[dry-run] fluent types --native → read sys_db_object, sys_dictionary and sys_choice ({"tables":["incident"]}) against the active instance',
    ]);
    expect(rec.generated).toEqual([]);
  });

  it("--dry-run fails where the real run would: no scope, or no project", async () => {
    const noScope = harness({ files: { [CONFIG_FILE]: "{}" } });
    expect(await run({ action: "types", native: true, dryRun: true }, noScope.deps)).toBe(1);
    expect(errors[0]).toContain("needs a scope");
    expect(noScope.rec.written).toEqual([]);

    const noProject = harness({ files: {}, cwd: path.resolve("/elsewhere") });
    expect(await run({ action: "types", native: true, out: "t.d.ts", dryRun: true, json: true }, noProject.deps)).toBe(1);
    expect(errors[1]).toContain("No now.config.json found");
    expect(noProject.rec.written).toEqual([]);

    // The real run's own exemption holds too: --out plus --table needs no project.
    expect(
      await run({ action: "types", native: true, table: "incident", out: "t.d.ts", dryRun: true }, noProject.deps)
    ).toBe(0);
    expect(noProject.rec.generated).toEqual([]);
    expect(noProject.rec.outputs).toEqual({});
  });

  it("refuses an unparseable now.config.json in the run and the dry run alike when it needs the scope", async () => {
    for (const dryRun of [false, true]) {
      const { rec, deps } = harness({ files: { [CONFIG_FILE]: "{oops" } });
      expect(await run({ action: "types", native: true, dryRun }, deps)).toBe(1);
      expect(rec.generated).toEqual([]);
      expect(rec.written).toEqual([]);
    }
    expect(errors).toHaveLength(2);
    for (const error of errors) expect(error).toContain(`${CONFIG_FILE} is not valid JSON`);
  });

  it("does not read now.config.json when --table or --scope makes its scope unnecessary", async () => {
    for (const flags of [{ table: "incident" }, { scope: "x_other" }]) {
      for (const dryRun of [false, true]) {
        const { rec, deps } = harness({ files: { [CONFIG_FILE]: "{oops" } });
        const readFile = jest.fn(deps.readFile!);
        expect(await run({ action: "types", native: true, ...flags, dryRun }, { ...deps, readFile })).toBe(0);
        expect(readFile).not.toHaveBeenCalled();
        if (dryRun) expect(rec.generated).toEqual([]);
        else {
          expect(rec.generated[0].options).toEqual("table" in flags ? { tables: ["incident"] } : { scope: "x_other" });
          expect(Object.keys(rec.outputs)).toEqual([path.join(PROJECT, "@types", "syncrona", "tables.d.ts")]);
        }
      }
    }
    expect(errors).toEqual([]);
  });

  it("a plain types --table falls back to native without reading a malformed now.config.json", async () => {
    const { FluentNotInstalledError } = await import("../fluentCommand.js");
    for (const dryRun of [false, true]) {
      const { rec, deps } = harness({ files: { [CONFIG_FILE]: "{oops" } });
      const loadFluent = async () => Promise.reject(new FluentNotInstalledError());
      expect(await run({ action: "types", table: "incident", dryRun }, { ...deps, loadFluent })).toBe(0);
      if (!dryRun) expect(rec.generated[0].options).toEqual({ tables: ["incident"] });
    }
    expect(errors).toEqual([]);
  });

  it("--dry-run --json prints the native plan as JSON", async () => {
    const { rec, deps } = harness();
    expect(await run({ action: "types", native: true, table: "incident", dryRun: true, json: true }, deps)).toBe(0);
    expect(JSON.parse(rec.written[0])).toEqual({
      command: "fluent types",
      exitCode: 0,
      dryRun: true,
      method: "nativeTypes",
      options: { tables: ["incident"] },
      instance: true,
    });
  });

  it("refuses --native with --scripts as a usage error", async () => {
    const { rec, deps } = harness();
    expect(await run({ action: "types", native: true, scripts: true }, deps)).toBe(1);
    expect(errors[0]).toContain("cannot combine with --scripts or --fluent");
    expect(rec.generated).toEqual([]);
  });

  it("surfaces a generator failure as exit 1", async () => {
    const { deps } = harness();
    const failing = async () => {
      throw new Error("No sys_db_object record for table(s): nope.");
    };
    expect(await run({ action: "types", native: true }, { ...deps, generateTypes: failing })).toBe(1);
    expect(errors).toEqual(["No sys_db_object record for table(s): nope."]);
  });
});

describe("fluentCommand: types falls back to native without the SDK", () => {
  it("keeps the SDK path when it is installed, and says so in JSON", async () => {
    const { rec, deps } = harness();
    expect(await run({ action: "types", json: true }, deps)).toBe(0);
    expect(rec.calls.map((c) => c.method)).toEqual(["types"]);
    expect(rec.generated).toEqual([]);
    expect(JSON.parse(rec.written[0])).toMatchObject({ mode: "sdk" });
  });

  it("generates natively when the adapter is not installed", async () => {
    const { FluentNotInstalledError } = await import("../fluentCommand.js");
    const { rec, deps } = harness();
    const loadFluent = async () => Promise.reject(new FluentNotInstalledError());
    expect(await run({ action: "types", table: "incident" }, { ...deps, loadFluent })).toBe(0);
    // --table names the tables outright; the project's scope is not read for it.
    expect(rec.generated[0].options).toEqual({ tables: ["incident"] });
    expect(infos[0]).toContain("@servicenow/sdk is not installed; generating table types natively");
    expect(errors).toEqual([]);
  });

  it("generates natively when the adapter reports the SDK missing", async () => {
    const { rec, deps } = harness({
      engine: {
        types: async () => {
          throw Object.assign(new Error("sdk missing"), { code: "FLUENT_SDK_MISSING" });
        },
      },
    });
    expect(await run({ action: "types" }, deps)).toBe(0);
    expect(rec.generated).toHaveLength(1);
  });

  it("keeps the install hint when --scripts or --fluent needs the SDK", async () => {
    const { FluentNotInstalledError } = await import("../fluentCommand.js");
    const { rec, deps } = harness({
      engine: {
        types: async () => {
          throw Object.assign(new Error("sdk missing"), { code: "FLUENT_SDK_MISSING" });
        },
      },
    });
    expect(await run({ action: "types", scripts: true }, deps)).toBe(1);
    const loadFluent = async () => Promise.reject(new FluentNotInstalledError());
    expect(await run({ action: "types", fluent: true }, { ...deps, loadFluent })).toBe(1);
    expect(await run({ action: "dependencies" }, { ...deps, loadFluent })).toBe(1);
    expect(errors).toEqual([FLUENT_INSTALL_HINT, FLUENT_INSTALL_HINT, FLUENT_INSTALL_HINT]);
    expect(rec.generated).toEqual([]);
  });

  it("rethrows any other SDK failure from types", async () => {
    const { rec, deps } = harness({
      engine: {
        types: async () => {
          throw new Error("types failed");
        },
      },
    });
    expect(await run({ action: "types" }, deps)).toBe(1);
    expect(errors).toEqual(["types failed"]);
    expect(rec.generated).toEqual([]);
  });

  it("points an unsupported profile at --native for plain types only", async () => {
    const { deps } = harness({ credential: { kind: "unsupported", method: "api-key" } });
    expect(await run({ action: "types" }, deps)).toBe(1);
    expect(errors[0]).toContain("or pass --native to generate table types without the SDK.");
    expect(await run({ action: "types", scripts: true }, deps)).toBe(1);
    expect(errors[1]).not.toContain("--native");
  });

  it("--dry-run reports the native generator when the adapter is not installed, without credentials", async () => {
    const { FluentNotInstalledError } = await import("../fluentCommand.js");
    const { rec, deps } = harness();
    const resolveCredential = jest.fn(deps.resolveCredential!);
    const loadFluent = jest.fn(async () => Promise.reject(new FluentNotInstalledError()));
    expect(
      await run({ action: "types", table: "incident", dryRun: true, json: true }, { ...deps, loadFluent, resolveCredential })
    ).toBe(0);
    expect(JSON.parse(rec.written[0])).toEqual({
      command: "fluent types",
      exitCode: 0,
      dryRun: true,
      method: "nativeTypes",
      options: { tables: ["incident"] },
      instance: true,
    });
    expect(loadFluent).toHaveBeenCalledWith(PROJECT);
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(rec.generated).toEqual([]);
    expect(rec.outputs).toEqual({});
  });

  it("--dry-run reports the native generator when the adapter reports the SDK missing", async () => {
    const { rec, deps } = harness({
      engine: {
        sdkVersion: async () => {
          throw Object.assign(new Error("sdk missing"), { code: "FLUENT_SDK_MISSING" });
        },
      },
    });
    const resolveCredential = jest.fn(deps.resolveCredential!);
    expect(await run({ action: "types", dryRun: true }, { ...deps, resolveCredential })).toBe(0);
    expect(rec.written).toEqual([
      "[dry-run] fluent types → @servicenow/sdk is not installed; read sys_db_object, sys_dictionary and sys_choice " +
        "({}) against the active instance",
    ]);
    expect(rec.engineOptions).toEqual([{ projectDir: PROJECT, logger: expect.anything() }]);
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(rec.calls).toEqual([]);
  });

  it("--dry-run keeps engine.types when the SDK is present, without credentials", async () => {
    const { rec, deps } = harness();
    const resolveCredential = jest.fn(deps.resolveCredential!);
    expect(await run({ action: "types", dryRun: true }, { ...deps, resolveCredential })).toBe(0);
    expect(rec.written).toEqual(["[dry-run] fluent types → engine.types({}) against the active instance"]);
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(rec.calls).toEqual([]);
  });

  it("--dry-run without the SDK fails where the native fallback would: no scope", async () => {
    const { FluentNotInstalledError } = await import("../fluentCommand.js");
    const { rec, deps } = harness({ files: { [CONFIG_FILE]: "{}" } });
    const loadFluent = async () => Promise.reject(new FluentNotInstalledError());
    expect(await run({ action: "types", dryRun: true }, { ...deps, loadFluent })).toBe(1);
    expect(errors[0]).toContain("needs a scope");
    expect(rec.written).toEqual([]);
  });

  it("--dry-run with an SDK-only flag never falls back: it probes the SDK and plans engine.types", async () => {
    const { rec, deps } = harness();
    const loadFluent = jest.fn(deps.loadFluent!);
    expect(await run({ action: "types", scripts: true, dryRun: true }, { ...deps, loadFluent })).toBe(0);
    expect(rec.written[0]).toContain("engine.types(");
    expect(loadFluent).toHaveBeenCalledWith(PROJECT);
    expect(rec.calls).toEqual([]);
  });

  it.each([
    ["build", {}],
    ["types --scripts", { action: "types", scripts: true }],
    ["types --fluent", { action: "types", fluent: true }],
    ["dependencies", { action: "dependencies" }],
    ["transform", { action: "transform" }],
    ["explain", { action: "explain", topic: "flow" }],
    ["pack", { action: "pack" }],
    ["status", { action: "status" }],
    ["install --ci", { action: "install", ci: true }],
  ])("--dry-run of %s without the adapter exits 1 with the install hint, as the real run does", async (_label, extra) => {
    const { FluentNotInstalledError } = await import("../fluentCommand.js");
    const args = { action: "build", ...extra } as Record<string, unknown>;
    const { rec, deps } = harness();
    const loadFluent = async () => Promise.reject(new FluentNotInstalledError());
    expect(await run(args, { ...deps, loadFluent })).toBe(1);
    expect(await run({ ...args, dryRun: true }, { ...deps, loadFluent })).toBe(1);
    expect(errors).toEqual([FLUENT_INSTALL_HINT, FLUENT_INSTALL_HINT]);
    expect(rec.written).toEqual([]);
    expect(rec.generated).toEqual([]);
  });

  it("--dry-run of build exits 1 with the install hint when the adapter reports the SDK missing", async () => {
    const sdkMissingError = () => Object.assign(new Error("sdk missing"), { code: "FLUENT_SDK_MISSING" });
    const { rec, deps } = harness({
      engine: {
        sdkVersion: async () => {
          throw sdkMissingError();
        },
        build: async () => {
          throw sdkMissingError();
        },
      },
    });
    expect(await run({ action: "build" }, deps)).toBe(1);
    expect(await run({ action: "build", dryRun: true }, deps)).toBe(1);
    expect(errors).toEqual([FLUENT_INSTALL_HINT, FLUENT_INSTALL_HINT]);
    expect(rec.written).toEqual([]);
  });

  it("--dry-run without the adapter still fails its local checks first, as the real run does", async () => {
    const { FluentNotInstalledError } = await import("../fluentCommand.js");
    const { deps } = harness({ files: {}, cwd: path.resolve("/elsewhere") });
    const loadFluent = jest.fn(async () => Promise.reject(new FluentNotInstalledError()));
    expect(await run({ action: "build", dryRun: true }, { ...deps, loadFluent })).toBe(1);
    expect(errors[0]).toContain("No now.config.json found");
    expect(loadFluent).not.toHaveBeenCalled();
  });

  it("--dry-run surfaces any other adapter failure, as the real run would", async () => {
    const { rec, deps } = harness();
    const loadFluent = async () => Promise.reject(new Error("adapter is broken"));
    expect(await run({ action: "types", dryRun: true }, { ...deps, loadFluent })).toBe(1);
    expect(errors).toEqual(["adapter is broken"]);
    expect(rec.written).toEqual([]);
  });

  it("--dry-run surfaces any other SDK load failure, as the real run would", async () => {
    const { rec, deps } = harness({
      engine: {
        sdkVersion: async () => {
          throw new Error("sdk is broken");
        },
      },
    });
    expect(await run({ action: "types", dryRun: true }, deps)).toBe(1);
    expect(errors).toEqual(["sdk is broken"]);
    expect(rec.written).toEqual([]);
  });
});

describe("fluentCommand: init", () => {
  it("creates a project in the current directory", async () => {
    const { rec, deps } = harness({ files: {}, cwd: "/new/app" });
    expect(await run({ action: "init", name: "App", scope: "x_a" }, deps)).toBe(0);
    expect(rec.calls).toEqual([{ method: "createProject", options: { name: "App", scope: "x_a" } }]);
    expect(rec.engineOptions[0].projectDir).toBe(path.resolve("/new/app"));
    expect(infos.join("\n")).toContain("Fluent project created in");
  });

  it("refuses to overwrite an existing project", async () => {
    const { rec, deps } = harness({ cwd: PROJECT });
    expect(await run({ action: "init", name: "App", scope: "x_a" }, deps)).toBe(1);
    expect(rec.calls).toEqual([]);
    expect(errors[0]).toContain("already holds a Fluent project");
  });

  it("converts an instance application with --from into --project", async () => {
    const { rec, deps } = harness({ files: {}, cwd: "/new" });
    expect(await run({ action: "init", from: "scope-id", project: "app" }, deps)).toBe(0);
    expect(rec.calls).toEqual([{ method: "createProjectFromApp", options: { scopeId: "scope-id" } }]);
    expect(rec.engineOptions[0].projectDir).toBe(path.resolve("/new/app"));
    expect(rec.authInputs).toHaveLength(1);
    expect(infos.join("\n")).toContain("from the instance application");
  });
});

describe("fluentCommand: install consent", () => {
  it("asks before installing and names the scope and instance", async () => {
    const { rec, deps } = harness();
    expect(await run({ action: "install" }, deps)).toBe(0);
    expect(rec.prompts).toEqual(["Install x_acme_app to https://dev1.service-now.com/?"]);
    expect(rec.calls).toEqual([{ method: "install", options: {} }]);
    expect(infos).toContain("Tracker: trk");
    expect(infos).toContain("Rollback context: rb");
  });

  it("does nothing and exits 0 when the prompt is declined", async () => {
    const { rec, deps } = harness({ confirm: false });
    expect(await run({ action: "install" }, deps)).toBe(0);
    expect(rec.calls).toEqual([]);
    expect(infos).toContain("fluent install cancelled.");
  });

  it("warns that --reinstall uninstalls first, and --ci skips the prompt", async () => {
    const { rec, deps } = harness({ engine: { install: async () => ({}) } });
    expect(await run({ action: "install", reinstall: true, ci: true }, deps)).toBe(0);
    expect(rec.prompts).toEqual([]);
    expect(warnings[0]).toContain("--reinstall uninstalls x_acme_app");
  });

  it("prompts Reinstall with the project's scope", async () => {
    const { rec, deps } = harness();
    expect(await run({ action: "install", reinstall: true }, deps)).toBe(0);
    expect(rec.prompts[0]).toBe("Reinstall x_acme_app to https://dev1.service-now.com/?");
  });

  it.each([false, true])(
    "refuses an unparseable now.config.json, naming the file (dry run: %s)",
    async (dryRun) => {
      const { rec, deps } = harness({ files: { [CONFIG_FILE]: "not json" } });
      const loadFluent = jest.fn(deps.loadFluent!);
      expect(await run({ action: "install", dryRun }, { ...deps, loadFluent })).toBe(1);
      expect(errors[0]).toContain(`${CONFIG_FILE} is not valid JSON`);
      expect(rec.prompts).toEqual([]);
      expect(rec.calls).toEqual([]);
      expect(rec.written).toEqual([]);
      expect(loadFluent).not.toHaveBeenCalled();
    }
  );

  it("refuses a now.config.json that exists but cannot be read, naming the file", async () => {
    const { rec, deps } = harness();
    const readFile = async () => Promise.reject(new Error("EACCES: permission denied"));
    expect(await run({ action: "install", dryRun: true }, { ...deps, readFile })).toBe(1);
    expect(errors[0]).toBe(`Cannot read ${CONFIG_FILE}: EACCES: permission denied`);
    expect(rec.written).toEqual([]);
  });

  it.each([
    ["no scope key", "{}"],
    ["an empty scope", JSON.stringify({ scope: "" })],
    ["a whitespace-only scope", JSON.stringify({ scope: "  \t " })],
    ["a non-string scope", JSON.stringify({ scope: 7 })],
    ["a JSON array", "[]"],
  ])("refuses a now.config.json with %s, naming the file", async (_label, content) => {
    for (const dryRun of [false, true]) {
      const { rec, deps } = harness({ files: { [CONFIG_FILE]: content } });
      expect(await run({ action: "install", dryRun }, deps)).toBe(1);
      expect(rec.prompts).toEqual([]);
      expect(rec.calls).toEqual([]);
      expect(rec.written).toEqual([]);
    }
    expect(errors).toHaveLength(2);
    for (const error of errors) {
      expect(error).toContain(CONFIG_FILE);
      expect(error).toContain('"scope"');
    }
  });

  it.each([
    ["a byte-order mark", '\uFEFF{"scope": "x_acme_app"}'],
    ["line and block comments", '// app\n{\n  /* the scope */ "scope": "x_acme_app" // trailing\n}'],
    ["trailing commas", '{"scope": "x_acme_app", "deps": ["a", "b",],}'],
    ["a BOM, comments and trailing commas together", '\uFEFF{\n  // c\n  "scope": "x_acme_app",\n}\n'],
    ["comment markers inside strings", '{"scope": "x_acme_app", "url": "https://x/*y*/", "n": "a // b"}'],
    ["a scope padded with whitespace", JSON.stringify({ scope: "  x_acme_app " })],
  ])("reads a now.config.json with %s as the SDK does", async (_label, content) => {
    for (const dryRun of [false, true]) {
      const { rec, deps } = harness({ files: { [CONFIG_FILE]: content } });
      expect(await run({ action: "install", reinstall: true, dryRun }, deps)).toBe(0);
      if (!dryRun) expect(rec.prompts[0]).toBe("Reinstall x_acme_app to https://dev1.service-now.com/?");
    }
    expect(errors).toEqual([]);
  });

  it("still refuses JSON5 syntax beyond comments and trailing commas, naming the file", async () => {
    const { rec, deps } = harness({ files: { [CONFIG_FILE]: "{scope: 'x_acme_app'}" } });
    expect(await run({ action: "install", dryRun: true }, deps)).toBe(1);
    expect(errors[0]).toContain(`${CONFIG_FILE} is not valid JSON`);
    expect(rec.written).toEqual([]);
  });
});

describe("fluentCommand: stripJsonExtensions", () => {
  it("keeps strings verbatim and leaves plain JSON unchanged", async () => {
    const { stripJsonExtensions } = await import("../fluentCommand.js");
    const plain = '{"a": "x, }", "b": "\\"//\\"", "c": [1, 2]}';
    expect(stripJsonExtensions(plain)).toBe(plain);
    expect(JSON.parse(stripJsonExtensions('{"a": "\\"/*", /* c */ "b": 1,}'))).toEqual({ a: '"/*', b: 1 });
  });
});

describe("fluentCommand: install without a terminal", () => {
  it.each([
    ["no terminal", { interactive: () => false }, {}, "this session has no terminal"],
    ["--json", {}, { json: true }, "--json output"],
  ])("refuses with %s instead of prompting, and asks for --ci", async (_label, extraDeps, extraArgs, reason) => {
    const { rec, deps } = harness();
    expect(await run({ action: "install", ...extraArgs }, { ...deps, ...extraDeps })).toBe(1);
    expect(rec.prompts).toEqual([]);
    expect(rec.calls).toEqual([]);
    expect(rec.written).toEqual([]);
    expect(errors[0]).toContain(reason);
    expect(errors[0]).toContain("Pass --ci to install without asking.");
  });

  it.each([
    ["no terminal", { interactive: () => false }, {}, "this session has no terminal"],
    ["--json", {}, { json: true }, "--json output"],
  ])("--dry-run refuses with %s too, as the real run would", async (_label, extraDeps, extraArgs, reason) => {
    const { rec, deps } = harness();
    const loadFluent = jest.fn(deps.loadFluent!);
    expect(await run({ action: "install", dryRun: true, ...extraArgs }, { ...deps, ...extraDeps, loadFluent })).toBe(1);
    expect(errors[0]).toContain(reason);
    expect(errors[0]).toContain("Pass --ci to preview without a prompt; a dry run installs nothing.");
    expect(errors[0]).not.toContain("install without asking");
    expect(rec.written).toEqual([]);
    expect(loadFluent).not.toHaveBeenCalled();
  });

  it("--dry-run --ci --json prints the install plan as JSON without a terminal", async () => {
    const { rec, deps } = harness();
    expect(
      await run({ action: "install", dryRun: true, ci: true, json: true }, { ...deps, interactive: () => false })
    ).toBe(0);
    expect(JSON.parse(rec.written[0])).toMatchObject({ command: "fluent install", dryRun: true, method: "install" });
  });

  it("installs under --ci without a terminal, and --json prints only the result", async () => {
    const { rec, deps } = harness();
    expect(await run({ action: "install", ci: true, json: true }, { ...deps, interactive: () => false })).toBe(0);
    expect(rec.prompts).toEqual([]);
    expect(rec.written).toHaveLength(1);
    expect(JSON.parse(rec.written[0])).toMatchObject({ command: "fluent install", exitCode: 0, trackerId: "trk" });
  });

  it("loads the adapter and the SDK before asking", async () => {
    const { FluentNotInstalledError } = await import("../fluentCommand.js");
    const missingAdapter = harness();
    const loadFluent = async () => Promise.reject(new FluentNotInstalledError());
    expect(await run({ action: "install" }, { ...missingAdapter.deps, loadFluent })).toBe(1);
    expect(missingAdapter.rec.prompts).toEqual([]);
    expect(errors).toEqual([FLUENT_INSTALL_HINT]);

    const missingSdk = harness({
      engine: {
        sdkVersion: async () => {
          throw Object.assign(new Error("no sdk"), { code: "FLUENT_SDK_MISSING" });
        },
      },
    });
    expect(await run({ action: "install" }, missingSdk.deps)).toBe(1);
    expect(missingSdk.rec.prompts).toEqual([]);
    expect(missingSdk.rec.calls).toEqual([]);
  });
});

describe("fluentCommand: status", () => {
  it("prints the SDK version and exits 2 while an install is still running", async () => {
    const { deps } = harness({
      engine: { installStatus: async () => ({ finished: false }), sdkVersion: async () => undefined },
    });
    expect(await run({ action: "status" }, deps)).toBe(2);
    expect(infos).toContain("@servicenow/sdk (unknown version)");
    expect(infos).toContain("Install still running.");
  });

  it("reports a finished install with and without an id", async () => {
    const { deps } = harness();
    expect(await run({ action: "status" }, deps)).toBe(0);
    expect(infos).toContain("@servicenow/sdk 4.13.3");
    expect(infos).toContain("Last install finished (inst-1).");
    const noId = harness({ engine: { installStatus: async () => ({ finished: true }) } });
    expect(await run({ action: "status" }, noId.deps)).toBe(0);
    expect(infos).toContain("Last install finished.");
    const runningWithId = harness({ engine: { installStatus: async () => ({ finished: false, id: "x" }) } });
    expect(await run({ action: "status", json: true }, runningWithId.deps)).toBe(2);
    expect(JSON.parse(runningWithId.rec.written[0])).toMatchObject({ exitCode: 2, sdkVersion: "4.13.3" });
  });
});

describe("fluentCommand: failures", () => {
  it("prints the single install hint when the adapter is missing", async () => {
    const { FluentNotInstalledError } = await import("../fluentCommand.js");
    const { deps } = harness();
    expect(
      await run({ action: "build" }, { ...deps, loadFluent: async () => Promise.reject(new FluentNotInstalledError()) })
    ).toBe(1);
    expect(errors).toEqual([FLUENT_INSTALL_HINT]);
  });

  it("prints the same hint when the adapter reports the SDK missing", async () => {
    const { deps } = harness({
      engine: {
        build: async () => {
          throw Object.assign(new Error("sdk missing"), { code: "FLUENT_SDK_MISSING" });
        },
      },
    });
    expect(await run({ action: "build" }, deps)).toBe(1);
    expect(errors).toEqual([FLUENT_INSTALL_HINT]);
  });

  it("turns any other throw into exit 1 with its message", async () => {
    const { deps } = harness({
      engine: {
        pack: async () => {
          throw new Error("zip failed");
        },
        run: async () => {
          throw "";
        },
      },
    });
    expect(await run({ action: "pack" }, deps)).toBe(1);
    expect(errors).toContain("zip failed");
    expect(await run({ action: "run", script: "s" }, deps)).toBe(1);
    expect(errors).toContain("Fluent command failed with an unknown error.");
  });
});

describe("default dependencies", () => {
  async function newRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "syncrona-fluent-"));
    roots.push(root);
    return root;
  }

  it("discovers the project on the real filesystem and reads its scope", async () => {
    const root = await newRoot();
    await writeFile(path.join(root, "now.config.json"), JSON.stringify({ scope: "x_fs_app" }));
    await mkdir(path.join(root, "src"));
    const { rec, deps } = harness();
    const { exists: _e, readFile: _r, ...rest } = deps;
    expect(await run({ action: "install" }, { ...rest, cwd: path.join(root, "src") })).toBe(0);
    expect(rec.prompts[0]).toBe("Install x_fs_app to https://dev1.service-now.com/?");
    expect(rec.engineOptions[0].projectDir).toBe(root);
  });

  it("bridges a Basic profile from the environment", async () => {
    process.env.SN_INSTANCE = "dev1.service-now.com";
    process.env.SN_USER = "admin";
    process.env.SN_PASSWORD = "s3cr3t";
    const { rec, deps } = harness();
    const { resolveCredential: _c, ...rest } = deps;
    expect(await run({ action: "types" }, rest)).toBe(0);
    expect(rec.authInputs).toEqual([
      {
        instanceUrl: "https://dev1.service-now.com/",
        input: { kind: "basic", username: "admin", password: "s3cr3t" },
      },
    ]);
  });

  it("marks API-key and mutual-TLS profiles unsupported", async () => {
    process.env.SN_INSTANCE = "dev1.service-now.com";
    process.env.SN_AUTH_METHOD = "api-key";
    process.env.SN_API_KEY = "key";
    const { deps } = harness();
    const { resolveCredential: _c, ...rest } = deps;
    expect(await run({ action: "types" }, rest)).toBe(1);
    expect(errors[0]).toContain("cannot use a api-key profile");

    delete process.env.SN_AUTH_METHOD;
    delete process.env.SN_API_KEY;
    process.env.SN_USER = "admin";
    process.env.SN_PASSWORD = "pw";
    process.env.SN_CLIENT_CERT = "/certs/client.pem";
    expect(await run({ action: "types" }, rest)).toBe(1);
    expect(errors[1]).toContain("cannot use a mutual-TLS profile");
  });

  it("mints OAuth tokens with core's token manager and hands over a getter", async () => {
    process.env.SN_INSTANCE = "dev1.service-now.com";
    process.env.SN_AUTH_METHOD = "oauth-client-credentials";
    process.env.SN_OAUTH_CLIENT_ID = "client-1";
    process.env.SN_OAUTH_CLIENT_SECRET = "client-secret";
    const posts: string[] = [];
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
      posts.push(String(input));
      return { ok: true, status: 200, json: async () => ({ access_token: "tok", expires_in: 1800 }) } as never;
    });
    const { rec, deps } = harness();
    const { resolveCredential: _c, ...rest } = deps;
    expect(await run({ action: "types" }, rest)).toBe(0);
    const input = rec.authInputs[0].input;
    expect(input.kind).toBe("oauth");
    // No token is minted until the SDK asks for one.
    expect(posts).toEqual([]);
    expect(await (input as { getToken: () => Promise<string> }).getToken()).toBe("tok");
    expect(posts).toEqual(["https://dev1.service-now.com/oauth_token.do"]);
  });

  it("names the HTTP status of a rejected token request", async () => {
    process.env.SN_INSTANCE = "dev1.service-now.com";
    process.env.SN_AUTH_METHOD = "oauth-client-credentials";
    process.env.SN_OAUTH_CLIENT_ID = "client-1";
    process.env.SN_OAUTH_CLIENT_SECRET = "wrong";
    jest.spyOn(globalThis, "fetch").mockImplementation(async () => ({ ok: false, status: 401 }) as never);
    const { rec, deps } = harness();
    const { resolveCredential: _c, ...rest } = deps;
    expect(await run({ action: "types" }, rest)).toBe(0);
    const input = rec.authInputs[0].input as { getToken: () => Promise<string> };
    await expect(input.getToken()).rejects.toThrow("HTTP 401");
  });

  it("refuses when no instance is configured", async () => {
    process.env.SN_USER = "admin";
    process.env.SN_PASSWORD = "pw";
    const { deps } = harness();
    const { resolveCredential: _c, ...rest } = deps;
    expect(await run({ action: "types" }, rest)).toBe(1);
    expect(errors[0]).toContain("No ServiceNow instance is configured");
  });

  it("writes JSON to stdout by default", async () => {
    const stdout: string[] = [];
    jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
    const { deps } = harness();
    const { write: _w, ...rest } = deps;
    expect(await run({ action: "build", dryRun: true }, rest)).toBe(0);
    expect(stdout).toEqual(["[dry-run] fluent build → engine.build({}) (local only)\n"]);
  });

  it("generates native types with the real generator and writes the file to disk", async () => {
    const root = await newRoot();
    await writeFile(path.join(root, "now.config.json"), JSON.stringify({ scope: "x_fs_app" }));
    const { deps } = harness();
    const { exists: _e, readFile: _r, generateTypes: _g, writeFile: _w, ...rest } = deps;
    const client = {
      // Honours the offset like an instance does: the reader stops on an empty page.
      tableAPIGet: async (table: string, _query: string, _fields: string, _limit: number, offset: number) => ({
        data: {
          result:
            offset > 0
              ? []
              : table === "sys_db_object"
              ? [{ name: "x_fs_app_item", label: "Item", "sys_scope.scope": "x_fs_app" }]
              : table === "sys_dictionary"
                ? [{ name: "x_fs_app_item", element: "title", column_label: "Title", internal_type: "string" }]
                : [],
        },
        headers: {},
      }),
    };
    expect(await run({ action: "types", native: true }, { ...rest, cwd: root, getClient: () => client as never })).toBe(0);
    const content = await readFile(path.join(root, "@types", "syncrona", "tables.d.ts"), "utf8");
    expect(content).toContain("export interface x_fs_app_item {");
    expect(content).toContain("  title?: string;");
  });

  it("builds the Table API client from the active profile", async () => {
    process.env.SN_INSTANCE = "dev1.service-now.com";
    process.env.SN_AUTH_METHOD = "api-key";
    process.env.SN_API_KEY = "key";
    const { deps } = harness();
    const { getClient: _c, ...rest } = deps;
    let seen: unknown;
    const generateTypes = async (client: unknown) => {
      seen = client;
      return NATIVE_RESULT;
    };
    expect(await run({ action: "types", native: true }, { ...rest, generateTypes })).toBe(0);
    expect(typeof (seen as { tableAPIGet?: unknown }).tableAPIGet).toBe("function");
  });

  it("loads the real adapter, which reports the SDK missing as the install hint", async () => {
    // @syncrona/fluent is a workspace package, so it resolves from core; the
    // ServiceNow SDK is not installed anywhere in the workspace, so the first
    // engine call fails with FLUENT_SDK_MISSING, and that becomes the hint.
    const root = await newRoot();
    await writeFile(path.join(root, "now.config.json"), "{}");
    const { deps } = harness();
    const { loadFluent: _l, exists: _e, readFile: _r, ...rest } = deps;
    expect(await run({ action: "build" }, { ...rest, cwd: root })).toBe(1);
    expect(errors).toEqual([FLUENT_INSTALL_HINT]);
  });
});

describe("loadFluentModule", () => {
  async function fixture(name: string, body: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "syncrona-fluent-load-"));
    roots.push(root);
    const dir = path.join(root, "node_modules", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, main: "index.cjs" }));
    await writeFile(path.join(dir, "index.cjs"), body);
    return root;
  }

  it("resolves the adapter from the project first", async () => {
    const root = await fixture(
      "fake-fluent-a",
      "exports.createFluentEngine = () => 'engine';\nexports.createFluentAuthResolver = () => 'auth';\n"
    );
    const mod = await loadFluentModule(root, "fake-fluent-a");
    expect(typeof mod.createFluentEngine).toBe("function");
  });

  it("throws FluentNotInstalledError when the package resolves nowhere", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "syncrona-fluent-none-"));
    roots.push(root);
    await expect(loadFluentModule(root, "@syncrona/definitely-not-installed")).rejects.toMatchObject({
      code: "FLUENT_NOT_INSTALLED",
    });
  });

  it("rethrows a missing dependency of the adapter instead of calling the adapter missing", async () => {
    const root = await fixture("fake-fluent-c", "require('@syncrona/definitely-missing-dependency');\n");
    const failure = loadFluentModule(root, "fake-fluent-c");
    await expect(failure).rejects.not.toMatchObject({ code: "FLUENT_NOT_INSTALLED" });
    await expect(failure).rejects.toThrow("@syncrona/definitely-missing-dependency");
  });

  it("rethrows a broken adapter instead of calling it missing", async () => {
    const root = await fixture("fake-fluent-b", "throw new Error('adapter exploded');\n");
    await expect(loadFluentModule(root, "fake-fluent-b")).rejects.toThrow("adapter exploded");
  });
});

describe("fluentCommand: explain", () => {
  it("prints one topic's document to stdout without credentials or a now.config.json", async () => {
    const { rec, deps } = harness({ files: {}, cwd: path.resolve("/elsewhere") });
    const resolveCredential = jest.fn(deps.resolveCredential!);
    expect(await run({ action: "explain", topic: "table" }, { ...deps, resolveCredential })).toBe(0);
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(rec.calls).toEqual([{ method: "explain", options: { topic: "table" } }]);
    expect(rec.engineOptions[0]).toMatchObject({ projectDir: path.resolve("/elsewhere") });
    expect(rec.engineOptions[0].auth).toBeUndefined();
    expect(rec.written).toEqual(["# Table\n\nTables."]);
  });

  it("resolves the SDK from the nearest project, or from --project as given", async () => {
    const { rec, deps } = harness();
    expect(await run({ action: "explain" }, deps)).toBe(0);
    expect(rec.engineOptions[0].projectDir).toBe(PROJECT);
    expect(await run({ action: "explain", project: "/some/dir" }, deps)).toBe(0);
    expect(rec.engineOptions[1].projectDir).toBe(path.resolve("/some/dir"));
  });

  it("lists topics with their tags, related matches and summaries on --peek", async () => {
    const list = { kind: "list", topics: [TABLE_TOPIC, RULE_TOPIC], related: [] } as SN.FluentExplainResult;
    let h = harness({ engine: { explain: async () => list } });
    expect(await run({ action: "explain", list: true }, h.deps)).toBe(0);
    expect(h.rec.written).toEqual(["table [fluent, table]", "business-rule"]);
    expect(infos).toEqual([]);

    const filtered = { kind: "list", filter: "rule", topics: [RULE_TOPIC], related: [TABLE_TOPIC] } as SN.FluentExplainResult;
    h = harness({ engine: { explain: async () => filtered } });
    expect(await run({ action: "explain", list: true, topic: "rule", peek: true }, h.deps)).toBe(0);
    expect(h.rec.written).toEqual(["business-rule\n  Rules.", "table [fluent, table]\n  Tables."]);
    expect(infos).toEqual(['Topics matching "rule":', "Related:"]);

    const empty = { kind: "list", filter: "zzz", topics: [], related: [] } as SN.FluentExplainResult;
    h = harness({ engine: { explain: async () => empty } });
    expect(await run({ action: "explain", list: true, topic: "zzz" }, h.deps)).toBe(0);
    expect(warnings).toEqual(["No matching topics."]);
  });

  it("summarises several matches, or one on --peek, and suggests related topics", async () => {
    const several = { kind: "matches", topics: [TABLE_TOPIC, RULE_TOPIC] } as SN.FluentExplainResult;
    let h = harness({ engine: { explain: async () => several } });
    expect(await run({ action: "explain", topic: "fluent" }, h.deps)).toBe(0);
    expect(h.rec.written).toEqual(["table [fluent, table]\n  Tables.", "business-rule\n  Rules."]);
    expect(infos[0]).toBe('Several topics match "fluent":');
    expect(infos[1]).toContain("syncrona fluent explain <topic>");

    infos.length = 0;
    const one = { kind: "matches", topics: [TABLE_TOPIC] } as SN.FluentExplainResult;
    h = harness({ engine: { explain: async () => one } });
    expect(await run({ action: "explain", topic: "table", peek: true }, h.deps)).toBe(0);
    expect(h.rec.written).toEqual(["table [fluent, table]\n  Tables."]);
    expect(infos).toEqual([]);

    const suggestions = { kind: "suggestions", topics: [RULE_TOPIC] } as SN.FluentExplainResult;
    h = harness({ engine: { explain: async () => suggestions } });
    expect(await run({ action: "explain", topic: "rul" }, h.deps)).toBe(0);
    expect(h.rec.written).toEqual(["business-rule\n  Rules."]);
    expect(infos[0]).toBe('No topic matches "rul" exactly; these may be related:');
  });

  it("exits 1 when nothing matches, as now-sdk explain does", async () => {
    const { rec, deps } = harness({ engine: { explain: async () => ({ kind: "none", topics: [] }) } });
    expect(await run({ action: "explain", topic: "zzz" }, deps)).toBe(1);
    expect(rec.written).toEqual([]);
    expect(errors).toEqual(['No topic matches "zzz".']);
    expect(infos).toContain("Run `syncrona fluent explain --list` to see every topic.");
  });

  it("emits the classified result as JSON", async () => {
    const { rec, deps } = harness();
    expect(await run({ action: "explain", topic: "table", json: true }, deps)).toBe(0);
    expect(JSON.parse(rec.written[0])).toEqual({
      command: "fluent explain",
      exitCode: 0,
      kind: "topic",
      topic: TABLE_TOPIC,
      body: "# Table\n\nTables.",
    });
    const none = harness({ engine: { explain: async () => ({ kind: "none", topics: [] }) } });
    expect(await run({ action: "explain", topic: "zzz", json: true }, none.deps)).toBe(1);
    expect(JSON.parse(none.rec.written[0])).toMatchObject({ command: "fluent explain", exitCode: 1, kind: "none" });
  });

  it("prints the planned call on --dry-run", async () => {
    const { rec, deps } = harness();
    expect(await run({ action: "explain", topic: "flow", dryRun: true }, deps)).toBe(0);
    expect(rec.written).toEqual(['[dry-run] fluent explain → engine.explain({"topic":"flow"}) (local only)']);
    // Only the install probe ran: no explain call reached the engine.
    expect(rec.calls).toEqual([]);
  });

  it("reports an SDK without bundled docs with the adapter's own message", async () => {
    const unavailable = Object.assign(new Error("This @servicenow/sdk does not bundle its documentation"), {
      code: "FLUENT_DOCS_UNAVAILABLE",
    });
    const { deps } = harness({
      engine: {
        explain: async () => {
          throw unavailable;
        },
      },
    });
    expect(await run({ action: "explain", topic: "x" }, deps)).toBe(1);
    expect(errors[0]).toBe("This @servicenow/sdk does not bundle its documentation");
  });

  it("prints the install hint when the SDK is missing", async () => {
    const { deps } = harness({
      engine: {
        explain: async () => {
          throw Object.assign(new Error("missing"), { code: "FLUENT_SDK_MISSING" });
        },
      },
    });
    expect(await run({ action: "explain" }, deps)).toBe(1);
    expect(errors).toEqual([FLUENT_INSTALL_HINT]);
  });
});

describe("fluentCommand: move-to-app", () => {
  it("asks first, naming the records, the instance and both effects, then moves", async () => {
    const { rec, deps } = harness({ files: GLOBAL_CONFIG });
    expect(await run({ action: "move-to-app", ids: `${ID_A},${ID_B}` }, deps)).toBe(0);
    expect(rec.prompts).toHaveLength(1);
    expect(rec.prompts[0]).toContain("Move 2 record(s) into global on https://dev1.service-now.com/?");
    expect(rec.prompts[0]).toContain("sys_claim");
    expect(rec.prompts[0]).toContain("Fluent sources");
    expect(rec.calls).toEqual([{ method: "moveToApp", options: { sysIds: [ID_A, ID_B] } }]);
    expect(rec.authInputs).toHaveLength(1);
    expect(infos).toContain("  src/claimed.now.ts");
    expect(infos).toContain("Moved records into the application; 1 Fluent file(s) changed.");
  });

  it("does nothing when the prompt is declined", async () => {
    const { rec, deps } = harness({ files: GLOBAL_CONFIG, confirm: false });
    expect(await run({ action: "move-to-app", ids: ID_A }, deps)).toBe(0);
    expect(rec.prompts).toHaveLength(1);
    expect(rec.calls).toEqual([]);
    expect(infos).toContain("fluent move-to-app cancelled.");
  });

  it.each([
    ["no terminal", { interactive: () => false }, {}, "this session has no terminal"],
    ["--json", {}, { json: true }, "--json output"],
  ])("refuses with %s instead of prompting, and asks for --ci", async (_label, extraDeps, extraArgs, reason) => {
    const { rec, deps } = harness({ files: GLOBAL_CONFIG });
    expect(await run({ action: "move-to-app", ids: ID_A, ...extraArgs }, { ...deps, ...extraDeps })).toBe(1);
    expect(rec.prompts).toEqual([]);
    expect(rec.calls).toEqual([]);
    expect(rec.written).toEqual([]);
    expect(rec.engineOptions).toEqual([]);
    expect(errors[0]).toContain(reason);
    expect(errors[0]).toContain("Pass --ci to move the records without asking.");
  });

  it("moves under --ci without a terminal", async () => {
    const { rec, deps } = harness({ files: GLOBAL_CONFIG });
    expect(await run({ action: "move-to-app", ids: ID_A, ci: true }, { ...deps, interactive: () => false })).toBe(0);
    expect(rec.prompts).toEqual([]);
    expect(rec.calls.map((c) => c.method)).toEqual(["moveToApp"]);
  });

  it("loads the adapter and the SDK before asking", async () => {
    const { FluentNotInstalledError } = await import("../fluentCommand.js");
    const missingAdapter = harness({ files: GLOBAL_CONFIG });
    const loadFluent = async () => Promise.reject(new FluentNotInstalledError());
    expect(await run({ action: "move-to-app", ids: ID_A }, { ...missingAdapter.deps, loadFluent })).toBe(1);
    expect(missingAdapter.rec.prompts).toEqual([]);
    expect(errors).toEqual([FLUENT_INSTALL_HINT]);

    const missingSdk = harness({
      files: GLOBAL_CONFIG,
      engine: {
        sdkVersion: async () => {
          throw Object.assign(new Error("no sdk"), { code: "FLUENT_SDK_MISSING" });
        },
      },
    });
    expect(await run({ action: "move-to-app", ids: ID_A }, missingSdk.deps)).toBe(1);
    expect(missingSdk.rec.prompts).toEqual([]);
    expect(missingSdk.rec.calls).toEqual([]);
  });

  it("skips the prompt with --ci and emits JSON", async () => {
    const { rec, deps } = harness({ files: GLOBAL_CONFIG });
    expect(await run({ action: "move-to-app", ids: ID_A, ci: true, json: true }, deps)).toBe(0);
    expect(rec.prompts).toEqual([]);
    expect(JSON.parse(rec.written[0])).toEqual({
      command: "fluent move-to-app",
      exitCode: 0,
      requested: 1,
      moved: true,
      changedFiles: ["src/claimed.now.ts"],
      handledPaths: ["claimed.xml"],
    });
  });

  it("exits 2 with a warning when the instance moved none of the records", async () => {
    const { deps } = harness({
      files: GLOBAL_CONFIG,
      engine: { moveToApp: async () => ({ moved: false, changedFiles: [], handledPaths: [] }) },
    });
    expect(await run({ action: "move-to-app", ids: ID_A, ci: true }, deps)).toBe(2);
    expect(warnings[0]).toContain("moved none of the records");
  });

  it("refuses a scoped application before resolving anything on the instance", async () => {
    const { rec, deps } = harness();
    expect(await run({ action: "move-to-app", ids: ID_A, ci: true }, deps)).toBe(1);
    expect(errors[0]).toBe(`fluent move-to-app works on global applications only; ${PROJECT} is scoped to x_acme_app.`);
    expect(rec.prompts).toEqual([]);
    expect(rec.engineOptions).toEqual([]);
  });

  it("names the global application in the prompt", async () => {
    const { rec, deps } = harness({ files: GLOBAL_CONFIG });
    expect(await run({ action: "move-to-app", ids: ID_A }, deps)).toBe(0);
    expect(rec.prompts[0]).toContain("Move 1 record(s) into global on");
  });

  it.each([
    ["is unparseable", "{not json", "is not valid JSON"],
    ["sets no scope", "{}", '"scope"'],
  ])("refuses a now.config.json that %s in the run and the dry run alike", async (_label, content, reason) => {
    for (const dryRun of [false, true]) {
      const { rec, deps } = harness({ files: { [CONFIG_FILE]: content } });
      expect(await run({ action: "move-to-app", ids: ID_A, dryRun }, deps)).toBe(1);
      expect(rec.prompts).toEqual([]);
      expect(rec.calls).toEqual([]);
      expect(rec.written).toEqual([]);
      expect(rec.engineOptions).toEqual([]);
    }
    expect(errors).toHaveLength(2);
    for (const error of errors) {
      expect(error).toContain(CONFIG_FILE);
      expect(error).toContain(reason);
    }
  });

  it("refuses API-key and mutual-TLS profiles", async () => {
    for (const method of ["api-key", "mutual-TLS"] as const) {
      const { rec, deps } = harness({ files: GLOBAL_CONFIG, credential: { kind: "unsupported", method } });
      expect(await run({ action: "move-to-app", ids: ID_A, ci: true }, deps)).toBe(1);
      expect(rec.calls).toEqual([]);
      expect(rec.prompts).toEqual([]);
    }
    expect(errors[0]).toContain("fluent move-to-app cannot use a api-key profile");
    expect(errors[0]).not.toContain("--native");
    expect(errors[1]).toContain("cannot use a mutual-TLS profile");
  });

  it("requires a Fluent project", async () => {
    const { deps } = harness({ files: {} });
    expect(await run({ action: "move-to-app", ids: ID_A, ci: true }, deps)).toBe(1);
    expect(errors[0]).toContain("No now.config.json found");
  });

  it("prints the planned call on --dry-run without credentials or prompts, probing only the adapter", async () => {
    const { rec, deps } = harness({ files: GLOBAL_CONFIG });
    const resolveCredential = jest.fn(deps.resolveCredential!);
    expect(await run({ action: "move-to-app", ids: `${ID_A},${ID_B}`, dryRun: true }, { ...deps, resolveCredential })).toBe(0);
    expect(rec.written).toEqual([
      `[dry-run] fluent move-to-app → engine.moveToApp({"sysIds":["${ID_A}","${ID_B}"]}) against the active instance`,
    ]);
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(rec.prompts).toEqual([]);
    expect(rec.engineOptions).toEqual([{ projectDir: PROJECT, logger: expect.anything() }]);
    expect(rec.calls).toEqual([]);
    expect(rec.authInputs).toEqual([]);
  });

  it("folds repeated ids, case-insensitively, before asking", async () => {
    const { rec, deps } = harness({ files: GLOBAL_CONFIG });
    expect(await run({ action: "move-to-app", ids: `${ID_A},${ID_A.toUpperCase()},${ID_B}` }, deps)).toBe(0);
    expect(rec.prompts[0]).toContain("Move 2 record(s)");
    expect(rec.calls).toEqual([{ method: "moveToApp", options: { sysIds: [ID_A, ID_B] } }]);
  });

  it("refuses an id that is not a sys_id before prompting or claiming anything", async () => {
    const { rec, deps } = harness({ files: GLOBAL_CONFIG });
    expect(await run({ action: "move-to-app", ids: `${ID_A},not-an-id,abc` }, deps)).toBe(1);
    expect(errors[0]).toBe(
      "fluent move-to-app --ids takes 32-character hexadecimal sys_ids; not one: not-an-id, abc."
    );
    expect(rec.prompts).toEqual([]);
    expect(rec.calls).toEqual([]);
  });

  it("--dry-run fails where the real run would: a scoped project", async () => {
    const { rec, deps } = harness();
    expect(await run({ action: "move-to-app", ids: ID_A, dryRun: true }, deps)).toBe(1);
    expect(errors[0]).toContain("works on global applications only");
    expect(rec.written).toEqual([]);
  });

  it("--dry-run --json without --ci is refused, as the real run would be", async () => {
    const { rec, deps } = harness({ files: GLOBAL_CONFIG });
    expect(await run({ action: "move-to-app", ids: ID_A, dryRun: true, json: true }, deps)).toBe(1);
    expect(errors[0]).toContain("--json output");
    expect(errors[0]).toContain("Pass --ci to preview without a prompt; a dry run moves nothing.");
    expect(errors[0]).not.toContain("move the records without asking");
    expect(rec.written).toEqual([]);
  });

  it("--dry-run without a terminal is refused with the dry-run wording", async () => {
    const { rec, deps } = harness({ files: GLOBAL_CONFIG });
    expect(
      await run({ action: "move-to-app", ids: ID_A, dryRun: true }, { ...deps, interactive: () => false })
    ).toBe(1);
    expect(errors[0]).toBe(
      "fluent move-to-app asks for confirmation, and this session has no terminal to answer it. " +
        "Pass --ci to preview without a prompt; a dry run moves nothing."
    );
    expect(rec.written).toEqual([]);
  });

  it("--dry-run validates and folds --ids exactly like the real run", async () => {
    const { rec, deps } = harness({ files: GLOBAL_CONFIG });
    expect(await run({ action: "move-to-app", ids: `${ID_A},bogus`, dryRun: true }, deps)).toBe(1);
    expect(errors[0]).toContain("not one: bogus");
    expect(rec.written).toEqual([]);
    expect(await run({ action: "move-to-app", ids: `${ID_A},${ID_A.toUpperCase()}`, dryRun: true }, deps)).toBe(0);
    expect(rec.written[0]).toContain(`{"sysIds":["${ID_A}"]}`);
  });

  it("--dry-run refuses a stray positional like the real run", async () => {
    const { rec, deps } = harness({ files: GLOBAL_CONFIG });
    expect(await run({ action: "move-to-app", ids: ID_A, topic: "prod", dryRun: true }, deps)).toBe(1);
    expect(errors[0]).toBe('fluent move-to-app takes no positional argument (got "prod"); only `fluent explain <topic>` does.');
    expect(await run({ action: "build", topic: "src", dryRun: true, json: true }, deps)).toBe(1);
    expect(errors[1]).toContain("fluent build takes no positional argument");
    expect(rec.written).toEqual([]);
  });

  it("--dry-run --ci --json prints the plan as JSON", async () => {
    const { rec, deps } = harness({ files: GLOBAL_CONFIG });
    expect(await run({ action: "move-to-app", ids: ID_A, dryRun: true, ci: true, json: true }, deps)).toBe(0);
    expect(JSON.parse(rec.written[0])).toEqual({
      command: "fluent move-to-app",
      exitCode: 0,
      dryRun: true,
      method: "moveToApp",
      options: { sysIds: [ID_A] },
      instance: true,
    });
  });

  it("fails with exit 1 when --ids is missing", async () => {
    const { deps } = harness({ files: GLOBAL_CONFIG });
    expect(await run({ action: "move-to-app" }, deps)).toBe(1);
    expect(errors[0]).toBe("fluent move-to-app needs --ids <sys_id,...>.");
  });
});
