// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import type { SN } from "@syncrona/types";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
}

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
    sdkVersion: async () => "4.13.3",
    ...overrides,
  } as SN.FluentEngine;
}

function harness(
  options: {
    engine?: Partial<SN.FluentEngine>;
    credential?: SN.FluentCredentialInput;
    confirm?: boolean;
    files?: Record<string, string>;
    cwd?: string;
  } = {}
): { rec: Recorder; deps: Partial<Deps> } {
  const rec: Recorder = { calls: [], engineOptions: [], authInputs: [], written: [], prompts: [] };
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
});

describe("fluentCommand: dispatch and exit codes", () => {
  it("rejects an unknown action with exit 1", async () => {
    const { deps } = harness();
    expect(await run({ action: "deploy" }, deps)).toBe(1);
    expect(errors.join("\n")).toContain('Unknown fluent action "deploy"');
    expect(await run({}, deps)).toBe(1);
  });

  it("prints the planned call on --dry-run without loading the adapter or prompting", async () => {
    const { rec, deps } = harness();
    const loadFluent = jest.fn(deps.loadFluent!);
    expect(await run({ action: "install", dryRun: true, reinstall: true }, { ...deps, loadFluent })).toBe(0);
    expect(loadFluent).not.toHaveBeenCalled();
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

  it("prompts Reinstall and falls back to an unknown scope when now.config.json has none", async () => {
    const { rec, deps } = harness({ files: { [CONFIG_FILE]: "{}" } });
    expect(await run({ action: "install", reinstall: true }, deps)).toBe(0);
    expect(rec.prompts[0]).toBe("Reinstall (unknown scope) to https://dev1.service-now.com/?");
    const broken = harness({ files: { [CONFIG_FILE]: "not json" } });
    expect(await run({ action: "install" }, broken.deps)).toBe(0);
    expect(broken.rec.prompts[0]).toContain("(unknown scope)");
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

  it("rethrows a broken adapter instead of calling it missing", async () => {
    const root = await fixture("fake-fluent-b", "throw new Error('adapter exploded');\n");
    await expect(loadFluentModule(root, "fake-fluent-b")).rejects.toThrow("adapter exploded");
  });
});
