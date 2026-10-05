// SPDX-License-Identifier: GPL-3.0-or-later
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createFluentEngine,
  defaultSdkLoader,
  findPackageVersion,
  FluentSdkMissingError,
  LoadedSdk,
  splitDiagnostics,
} from "../src/engine";
import type { SN } from "@syncrona/types";

type Call = { method: string; args: unknown[] };

function fakeSdk(overrides: Partial<Record<string, (...args: unknown[]) => unknown>> = {}) {
  const calls: Call[] = [];
  const record =
    (method: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      const override = overrides[method];
      return override ? override(...args) : result;
    };
  class Project {
    constructor(public options: unknown) {
      calls.push({ method: "Project", args: [options] });
    }
  }
  class Orchestrator {
    constructor(...args: unknown[]) {
      calls.push({ method: "Orchestrator", args });
    }
    build = record("build", { success: true, diagnostics: [] });
    pack = record("pack", "/p/target/app.zip");
    transform = record("transform", { changedFiles: ["a.now.ts"], handledPaths: ["a.xml"] });
    install = record("install", { trackerId: "TRK", rollbackId: "RBK" });
    installStatus = record("installStatus", { finished: true, id: "TRK" });
    types = record("types", undefined);
    addDependency = record("addDependency", undefined);
    run = record("run", undefined);
  }
  class ProjectFactory {
    static createNpmPackageName = (name: string) => `pkg-${name.toLowerCase().replace(/\s+/g, "-")}`;
    constructor(public fsArg: unknown) {
      calls.push({ method: "ProjectFactory", args: [fsArg] });
    }
    createProject = record("createProject", {});
    createProjectFromApp = record("createProjectFromApp", {});
  }
  class Connector {
    constructor(public credential: unknown) {
      calls.push({ method: "Connector", args: [credential] });
    }
  }
  class LazyCredential {
    constructor(
      public url: URL,
      public resolver: unknown,
    ) {
      calls.push({ method: "LazyCredential", args: [url.toString()] });
    }
  }
  let loads = 0;
  const sdk = { api: { Project, Orchestrator, ProjectFactory, Connector }, LazyCredential, version: "4.13.3" } as unknown as LoadedSdk;
  const loadSdk = (dir: string) => {
    loads++;
    calls.push({ method: "load", args: [dir] });
    return sdk;
  };
  return { calls, loadSdk, sdk, loads: () => loads };
}

const logger: SN.FluentLogger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn() };
const auth: SN.FluentAuthResolver = async () => ({ type: "oauth", token: "T" });

function engine(sdk: ReturnType<typeof fakeSdk>, withInstance = true) {
  return createFluentEngine(
    withInstance
      ? { projectDir: "/p", instanceUrl: "https://dev.example.invalid/", auth, logger }
      : { projectDir: "/p", logger },
    { loadSdk: sdk.loadSdk, fileSystem: "FS" },
  );
}

const of = (calls: Call[], method: string) => calls.filter((c) => c.method === method);

describe("createFluentEngine", () => {
  it("does not load the SDK until the first call, then loads it once", async () => {
    const sdk = fakeSdk();
    const e = engine(sdk);
    expect(sdk.loads()).toBe(0);
    await e.build({});
    await e.pack({});
    expect(sdk.loads()).toBe(1);
    expect(of(sdk.calls, "Orchestrator")).toHaveLength(1);
  });

  it("passes the LazyCredential straight to the Orchestrator", async () => {
    const sdk = fakeSdk();
    await engine(sdk).build({ frozenKeys: true });
    expect(of(sdk.calls, "LazyCredential")[0].args).toEqual(["https://dev.example.invalid/"]);
    const orch = of(sdk.calls, "Orchestrator")[0];
    expect(orch.args).toHaveLength(2);
    expect(orch.args[1]).toBeDefined();
    expect(of(sdk.calls, "Project")[0].args[0]).toEqual({ fileSystem: "FS", rootDir: "/p" });
    expect(of(sdk.calls, "build")[0].args[0]).toEqual({ frozenKeys: true });
  });

  it("builds an orchestrator without a credential for local-only use", async () => {
    const sdk = fakeSdk();
    await engine(sdk, false).pack({ packagePath: "/out" });
    expect(of(sdk.calls, "Orchestrator")[0].args).toHaveLength(1);
    expect(of(sdk.calls, "pack")[0].args).toEqual(["/out"]);
  });

  it("maps build diagnostics to errors and warnings", async () => {
    const sdk = fakeSdk({
      build: () => ({
        success: true,
        diagnostics: [
          { level: 1, getFormattedText: () => "E1" },
          { level: 2, message: "W1" },
          { level: 3, message: "I1" },
        ],
      }),
    });
    expect(await engine(sdk).build({})).toEqual({ success: false, errors: ["E1"], warnings: ["W1"] });
    const failed = fakeSdk({ build: () => ({ success: false }) });
    expect(await engine(failed).build({})).toEqual({ success: false, errors: [], warnings: [] });
  });

  it.each([
    [{ mode: "paths", paths: ["a"] }, { paths: ["a"] }],
    [{ mode: "paths", paths: ["a"], tables: [] }, { paths: ["a"] }],
    [{ mode: "paths", paths: ["a"], tables: ["t"] }, { tables: ["t"], paths: ["a"], force: false }],
    [{ mode: "paths", paths: ["a"], tables: ["t"], force: true }, { tables: ["t"], paths: ["a"], force: true }],
    [{ mode: "update-set", updateSetId: "U" }, { method: "update-set", updateSetId: "U" }],
    [{ mode: "incremental" }, { method: "incremental" }],
    [{ mode: "complete" }, { method: "complete" }],
  ])("maps transform %j to the SDK request", async (input, expected) => {
    const sdk = fakeSdk();
    const result = await engine(sdk).transform(input as SN.FluentTransformOptions);
    expect(of(sdk.calls, "transform")[0].args[0]).toEqual(expected);
    expect(result).toEqual({ changedFiles: ["a.now.ts"], handledPaths: ["a.xml"] });
  });

  it("defaults missing transform result arrays", async () => {
    const sdk = fakeSdk({ transform: () => ({}) });
    expect(await engine(sdk).transform({ mode: "complete" })).toEqual({ changedFiles: [], handledPaths: [] });
  });

  it("maps install options, including skipFlowActivation, and tolerates a void result", async () => {
    const sdk = fakeSdk();
    expect(await engine(sdk).install({ clean: true, skipFlowActivation: true, demoData: false })).toEqual({
      trackerId: "TRK",
      rollbackId: "RBK",
    });
    expect(of(sdk.calls, "install")[0].args[0]).toEqual({ clean: true, demoData: false, skipFlags: { skipFlowActivation: true } });
    const voided = fakeSdk({ install: () => undefined });
    expect(await engine(voided).install({})).toEqual({});
    expect(of(voided.calls, "install")[0].args[0]).toEqual({});
  });

  it("forwards installStatus, types, addDependency and run", async () => {
    const sdk = fakeSdk();
    const e = engine(sdk);
    expect(await e.installStatus()).toEqual({ finished: true, id: "TRK" });
    await e.types({ downloadScripts: true });
    await e.addDependency({ table: "t", ids: ["1"], scope: "global" });
    await e.run({ script: "s", args: { a: 1 } });
    expect(of(sdk.calls, "types")[0].args[0]).toEqual({ downloadScripts: true });
    expect(of(sdk.calls, "addDependency")[0].args[0]).toEqual({ table: "t", ids: ["1"], scope: "global" });
    expect(of(sdk.calls, "run")[0].args[0]).toEqual({ script: "s", args: { a: 1 } });
  });

  it.each([
    ["install", (e: SN.FluentEngine) => e.install({})],
    ["status", (e: SN.FluentEngine) => e.installStatus()],
    ["types", (e: SN.FluentEngine) => e.types({})],
    ["dependencies", (e: SN.FluentEngine) => e.addDependency({ table: "t", ids: [], scope: "s" })],
    ["init --from", (e: SN.FluentEngine) => e.createProjectFromApp({ scopeId: "S" })],
  ])("refuses %s without an instance credential", async (action, call) => {
    await expect(call(engine(fakeSdk(), false))).rejects.toThrow(`fluent ${action} needs an instance and credentials.`);
  });

  it("creates a project with a derived or explicit package name", async () => {
    const sdk = fakeSdk();
    const e = engine(sdk, false);
    await e.createProject({ name: "My App", scope: "x_my_app", templateId: "typescript.basic" });
    expect(of(sdk.calls, "ProjectFactory")[0].args[0]).toBe("FS");
    expect(of(sdk.calls, "createProject")[0].args).toEqual([
      "/p",
      {
        name: "My App",
        scope: "x_my_app",
        scopeId: undefined,
        packageName: "pkg-my-app",
        description: "",
        templateId: "typescript.basic",
        projectVersion: undefined,
      },
    ]);
    await e.createProject({ name: "N", scope: "x_n", packageName: "explicit", description: "d" });
    expect((of(sdk.calls, "createProject")[1].args[1] as { packageName: string }).packageName).toBe("explicit");
  });

  it("falls back to the scope when the SDK cannot derive a package name", async () => {
    const sdk = fakeSdk();
    (sdk.sdk.api.ProjectFactory as unknown as { createNpmPackageName?: unknown }).createNpmPackageName = undefined;
    await engine(sdk, false).createProject({ name: "N", scope: "X_Scope" });
    expect((of(sdk.calls, "createProject")[0].args[1] as { packageName: string }).packageName).toBe("x_scope");
  });

  it("creates a project from an instance app through a Connector", async () => {
    const sdk = fakeSdk();
    const e = engine(sdk);
    await e.createProjectFromApp({ scopeId: "S1" });
    await e.createProjectFromApp({ scopeId: "S2", packageName: "pk" });
    expect(of(sdk.calls, "Connector")).toHaveLength(2);
    const [first, second] = of(sdk.calls, "createProjectFromApp");
    expect(first.args[0]).toBe("/p");
    expect(first.args[1]).toBe("S1");
    expect(first.args[3]).toEqual({});
    expect(second.args[3]).toEqual({ packageName: "pk" });
  });

  it("reports the SDK version and logs unknown versions", async () => {
    const sdk = fakeSdk();
    expect(await engine(sdk).sdkVersion()).toBe("4.13.3");
    (sdk.sdk as { version?: string }).version = undefined;
    expect(await engine(sdk).sdkVersion()).toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith("fluent: loaded @servicenow/sdk (unknown version)");
  });
});

describe("splitDiagnostics", () => {
  it("defaults to empty and stringifies message-less diagnostics", () => {
    expect(splitDiagnostics()).toEqual({ errors: [], warnings: [] });
    expect(splitDiagnostics([{ level: 1 }]).errors).toEqual(["[object Object]"]);
  });
});

describe("defaultSdkLoader", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-fluent-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function write(rel: string, contents: string) {
    const file = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }

  it("is the engine's default loader", async () => {
    const e = createFluentEngine({ projectDir: tmp, logger });
    await expect(e.sdkVersion()).rejects.toBeInstanceOf(FluentSdkMissingError);
  });

  it("throws FluentSdkMissingError when no SDK resolves", () => {
    expect(() => defaultSdkLoader(tmp)).toThrow(FluentSdkMissingError);
    try {
      defaultSdkLoader(tmp);
    } catch (e) {
      expect((e as FluentSdkMissingError).code).toBe("FLUENT_SDK_MISSING");
    }
  });

  it("resolves the SDK from the project, turns telemetry off and reads its version", () => {
    write("package.json", JSON.stringify({ name: "proj" }));
    write(
      "node_modules/@servicenow/sdk/package.json",
      JSON.stringify({ name: "@servicenow/sdk", version: "4.13.3", exports: { "./api": { default: "./dist/api/index.js" } } }),
    );
    write("node_modules/@servicenow/sdk/dist/api/index.js", "exports.Project = function Project() {};\n");
    write(
      "node_modules/@servicenow/sdk-api/package.json",
      JSON.stringify({ name: "@servicenow/sdk-api", exports: { "./credentials": "./credentials.js" } }),
    );
    write("node_modules/@servicenow/sdk-api/credentials.js", "exports.LazyCredential = function LazyCredential() {};\n");
    delete process.env.NO_TELEMETRY;
    const loaded = defaultSdkLoader(tmp);
    expect(typeof loaded.api.Project).toBe("function");
    expect(typeof loaded.LazyCredential).toBe("function");
    expect(loaded.version).toBe("4.13.3");
    expect(process.env.NO_TELEMETRY).toBe("1");
  });

  it("findPackageVersion skips unreadable manifests and returns undefined when no ancestor matches", () => {
    write("a/b/c.js", "");
    write("a/b/package.json", "{not json");
    write("a/package.json", JSON.stringify({ name: "other", version: "9" }));
    expect(findPackageVersion(path.join(tmp, "a/b/c.js"), "@servicenow/definitely-not-here")).toBeUndefined();
  });
});
