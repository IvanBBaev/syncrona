// SPDX-License-Identifier: GPL-3.0-or-later
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createFluentEngine,
  defaultSdkDocsLoader,
  defaultSdkLoader,
  explainDocs,
  findPackageVersion,
  FluentDocsUnavailableError,
  FluentSdkMissingError,
  isSupportedSdkVersion,
  LoadedSdk,
  LoadedSdkDocs,
  SdkDocFile,
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
    moveToApp = record("moveToApp", { changedFiles: [{ getPath: () => "/p/src/claimed.now.ts" }], handledPaths: ["claimed.xml"] });
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

  it("reports ProjectFile results by path", async () => {
    const sdk = fakeSdk({ transform: () => ({ changedFiles: [{ getPath: () => "/p/src/x.now.ts" }, "y.now.ts"] }) });
    expect(await engine(sdk).transform({ mode: "complete" })).toEqual({ changedFiles: ["/p/src/x.now.ts", "y.now.ts"], handledPaths: [] });
  });

  it("moves records into the app and reports the transformed files", async () => {
    const sdk = fakeSdk();
    const ids = ["a1", "b2"];
    expect(await engine(sdk).moveToApp({ sysIds: ids })).toEqual({
      moved: true,
      changedFiles: ["/p/src/claimed.now.ts"],
      handledPaths: ["claimed.xml"],
    });
    const call = of(sdk.calls, "moveToApp")[0];
    expect(call.args[0]).toEqual({ sysIds: ["a1", "b2"] });
    expect((call.args[0] as { sysIds: string[] }).sysIds).not.toBe(ids);
    expect(of(sdk.calls, "Orchestrator")[0].args).toHaveLength(2);
  });

  it("reports nothing moved when the instance claims no records, and defaults missing arrays", async () => {
    expect(await engine(fakeSdk({ moveToApp: () => undefined })).moveToApp({ sysIds: ["a"] })).toEqual({
      moved: false,
      changedFiles: [],
      handledPaths: [],
    });
    expect(await engine(fakeSdk({ moveToApp: () => ({}) })).moveToApp({ sysIds: ["a"] })).toEqual({
      moved: true,
      changedFiles: [],
      handledPaths: [],
    });
  });

  it("explains through the docs loader without loading the SDK API", async () => {
    const sdk = fakeSdk();
    const loadDocs = jest.fn(() => fakeDocs());
    const e = createFluentEngine({ projectDir: "/p", logger }, { loadSdk: sdk.loadSdk, loadDocs });
    const result = await e.explain({ topic: "table" });
    expect(result).toEqual({ kind: "topic", topic: { name: "table", tags: ["fluent", "table"], summary: "Tables." }, body: "# Table\n\nTables.\n" });
    expect(loadDocs).toHaveBeenCalledWith("/p");
    expect(sdk.loads()).toBe(0);
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
    ["move-to-app", (e: SN.FluentEngine) => e.moveToApp({ sysIds: ["a"] })],
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
        projectVersion: "0.0.1",
        sdkVersion: "4.13.3",
      },
    ]);
    await e.createProject({ name: "N", scope: "x_n", packageName: "explicit", description: "d" });
    expect((of(sdk.calls, "createProject")[1].args[1] as { packageName: string }).packageName).toBe("explicit");
  });

  it("gives a new project a version and pins the loaded SDK, falling back to the supported range", async () => {
    const sdk = fakeSdk();
    await engine(sdk, false).createProject({ name: "N", scope: "x_n", projectVersion: "2.1.0" });
    expect(of(sdk.calls, "createProject")[0].args[1]).toMatchObject({ projectVersion: "2.1.0", sdkVersion: "4.13.3" });
    (sdk.sdk as { version?: string }).version = undefined;
    await engine(sdk, false).createProject({ name: "N", scope: "x_n" });
    expect(of(sdk.calls, "createProject")[1].args[1]).toMatchObject({ projectVersion: "0.0.1", sdkVersion: "~4.13" });
  });

  it("warns once when the loaded SDK is outside ~4.13", async () => {
    const warn = jest.fn();
    const sdk = fakeSdk();
    (sdk.sdk as { version?: string }).version = "4.14.0";
    const e = createFluentEngine({ projectDir: "/p", logger: { ...logger, warn } }, { loadSdk: sdk.loadSdk });
    await e.build({});
    await e.pack({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("@servicenow/sdk 4.14.0 is outside the supported range ~4.13");
    const quiet = jest.fn();
    await createFluentEngine({ projectDir: "/p", logger: { ...logger, warn: quiet } }, { loadSdk: fakeSdk().loadSdk }).build({});
    expect(quiet).not.toHaveBeenCalled();
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
    // Pinned to the loaded SDK; the SDK itself would write "latest".
    expect(first.args[3]).toEqual({ sdkVersion: "4.13.3" });
    expect(second.args[3]).toEqual({ sdkVersion: "4.13.3", packageName: "pk" });
    (sdk.sdk as { version?: string }).version = undefined;
    await engine(sdk).createProjectFromApp({ scopeId: "S3" });
    expect(of(sdk.calls, "createProjectFromApp")[2].args[3]).toEqual({ sdkVersion: "~4.13" });
  });

  it("reports the SDK version and logs unknown versions", async () => {
    const sdk = fakeSdk();
    expect(await engine(sdk).sdkVersion()).toBe("4.13.3");
    (sdk.sdk as { version?: string }).version = undefined;
    expect(await engine(sdk).sdkVersion()).toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith("fluent: loaded @servicenow/sdk (unknown version)");
  });
});

// A docs module of our own with the SDK's shape: precise matches are exact
// names or tags, the broad filter adds substrings of either.
function fakeDocs(): LoadedSdkDocs & { reads: string[] } {
  const docFiles: SdkDocFile[] = [
    { name: "table", tags: ["fluent", "table"], summary: "Tables.", filePath: "/docs/fluent/table.md" },
    { name: "business-rule", tags: ["fluent", "rule"], summary: "Rules.", filePath: "/docs/fluent/business-rule.md" },
    { name: "client-script", tags: ["fluent", "script"], summary: "Client scripts.", filePath: "/docs/fluent/client-script.md" },
    { name: "script-include", tags: ["fluent", "script"], summary: "Script includes.", filePath: "/docs/fluent/script-include.md" },
    { name: "flow", tags: ["guides"], summary: "Flows.", filePath: "/docs/guides/flow.md" },
  ];
  const reads: string[] = [];
  const precise = (d: SdkDocFile, t: string) => d.name === t || d.tags.includes(t);
  const broad = (d: SdkDocFile, t: string) => d.name.includes(t) || d.tags.some((tag) => tag.includes(t));
  return {
    reads,
    docsDir: "/docs",
    fs: {
      readdirSync: () => [],
      statSync: () => ({ isDirectory: () => false }),
      readFileSync: (p) => {
        reads.push(p);
        return "---\ntags: [fluent, table]\n---\n# Table\n\nTables.\n";
      },
    },
    docs: {
      scanDocs: (dir, fsArg) => {
        expect(dir).toBe("/docs");
        expect(typeof fsArg.readFileSync).toBe("function");
        return docFiles;
      },
      parseFrontmatter: (content) => ({ tags: [], body: content.replace(/^---[\s\S]*?---\n/, "") }),
      findDocs: (topics, t) => topics.filter((d) => precise(d, t)),
      filterDocs: (topics, t) => topics.filter((d) => broad(d, t)),
    },
  };
}

describe("explainDocs", () => {
  const names = (topics: SN.FluentDocTopic[]) => topics.map((t) => t.name);

  it("lists every topic without a topic, or with a blank one", () => {
    for (const opts of [{}, { topic: "  " }, { list: true }]) {
      const result = explainDocs(fakeDocs(), opts);
      expect(result.kind).toBe("list");
      if (result.kind !== "list") throw new Error("unreachable");
      expect(names(result.topics)).toEqual(["table", "business-rule", "client-script", "script-include", "flow"]);
      expect(result.related).toEqual([]);
      expect(result.filter).toBeUndefined();
    }
  });

  it("filters the list into strong and related matches", () => {
    const result = explainDocs(fakeDocs(), { list: true, topic: "script" });
    expect(result).toMatchObject({ kind: "list", filter: "script" });
    if (result.kind !== "list") throw new Error("unreachable");
    expect(names(result.topics)).toEqual(["client-script", "script-include"]);
    const related = explainDocs(fakeDocs(), { list: true, topic: "rule" });
    if (related.kind !== "list") throw new Error("unreachable");
    expect(names(related.topics)).toEqual(["business-rule"]);
    expect(related.related).toEqual([]);
    const weak = explainDocs(fakeDocs(), { list: true, topic: "scr" });
    if (weak.kind !== "list") throw new Error("unreachable");
    expect(weak.topics).toEqual([]);
    expect(names(weak.related)).toEqual(["client-script", "script-include"]);
  });

  it("returns one precise match with its body, read through the docs fs", () => {
    const docs = fakeDocs();
    expect(explainDocs(docs, { topic: " table " })).toEqual({
      kind: "topic",
      topic: { name: "table", tags: ["fluent", "table"], summary: "Tables." },
      body: "# Table\n\nTables.\n",
    });
    expect(docs.reads).toEqual(["/docs/fluent/table.md"]);
  });

  it("returns summaries for several matches, or for one with peek", () => {
    const docs = fakeDocs();
    const several = explainDocs(docs, { topic: "script" });
    expect(several.kind).toBe("matches");
    expect(names((several as { topics: SN.FluentDocTopic[] }).topics)).toEqual(["client-script", "script-include"]);
    expect(explainDocs(docs, { topic: "flow", peek: true })).toEqual({
      kind: "matches",
      topics: [{ name: "flow", tags: ["guides"], summary: "Flows." }],
    });
    expect(docs.reads).toEqual([]);
  });

  it("suggests substring matches, and reports none when nothing matches", () => {
    const suggestions = explainDocs(fakeDocs(), { topic: "inc" });
    expect(suggestions.kind).toBe("suggestions");
    expect(names((suggestions as { topics: SN.FluentDocTopic[] }).topics)).toEqual(["script-include"]);
    expect(explainDocs(fakeDocs(), { topic: "zzz" })).toEqual({ kind: "none", topics: [] });
  });

  it("copies tags so callers cannot mutate the SDK's index", () => {
    const docs = fakeDocs();
    const result = explainDocs(docs, { topic: "flow", peek: true });
    if (result.kind !== "matches") throw new Error("unreachable");
    result.topics[0].tags.push("x");
    expect(docs.docs.scanDocs("/docs", docs.fs)[4].tags).toEqual(["guides"]);
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

  it("reports an SDK without @servicenow/sdk-api/credentials as missing, not as a resolver error", () => {
    write("package.json", JSON.stringify({ name: "proj" }));
    write(
      "node_modules/@servicenow/sdk/package.json",
      JSON.stringify({ name: "@servicenow/sdk", version: "4.13.3", exports: { "./api": { default: "./dist/api/index.js" } } }),
    );
    write("node_modules/@servicenow/sdk/dist/api/index.js", "exports.Project = function Project() {};\n");
    let thrown: unknown;
    try {
      defaultSdkLoader(tmp);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FluentSdkMissingError);
    expect((thrown as Error).message).toContain("@servicenow/sdk-api/credentials cannot be loaded");
  });

  it("rethrows a credentials module that fails for another reason", () => {
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
    write("node_modules/@servicenow/sdk-api/credentials.js", "throw new Error('credentials exploded');\n");
    expect(() => defaultSdkLoader(tmp)).toThrow("credentials exploded");
  });

  it("isSupportedSdkVersion accepts 4.13.x only", () => {
    expect(["4.13.0", "4.13.3", " 4.13.10 ", "4.13.1-beta.2"].every(isSupportedSdkVersion)).toBe(true);
    expect(["4.12.2", "4.14.0", "5.13.0", "4.130.1", "latest"].some(isSupportedSdkVersion)).toBe(false);
  });

  function writeSdk(options: { name?: string; docs?: boolean; docsModule?: boolean } = {}) {
    write("package.json", JSON.stringify({ name: "proj" }));
    write(
      "node_modules/@servicenow/sdk/package.json",
      JSON.stringify({
        name: options.name ?? "@servicenow/sdk",
        version: "4.13.3",
        exports: { "./api": { default: "./dist/api/index.js" } },
      }),
    );
    write("node_modules/@servicenow/sdk/dist/api/index.js", "throw new Error('the full API must not load for explain');\n");
    if (options.docs ?? true) write("node_modules/@servicenow/sdk/docs/guides/flow.md", "---\ntags: [guides]\n---\n# Flow\n");
    const exportsMap: Record<string, string> = { "./credentials": "./credentials.js" };
    if (options.docsModule ?? true) {
      exportsMap["./docs"] = "./docs.js";
      write(
        "node_modules/@servicenow/sdk-api/docs.js",
        "exports.scanDocs = (dir, fs) => fs.readdirSync(dir).map((name) => ({ name, dir: fs.statSync(dir + '/' + name).isDirectory() }));\n" +
          "exports.read = (fs, p) => fs.readFileSync(p, 'utf-8');\n",
      );
    }
    write("node_modules/@servicenow/sdk-api/package.json", JSON.stringify({ name: "@servicenow/sdk-api", exports: exportsMap }));
  }

  it("locates the SDK's bundled docs and lean docs module without loading the API", () => {
    writeSdk();
    const loaded = defaultSdkDocsLoader(tmp);
    const sdkRoot = fs.realpathSync(path.join(tmp, "node_modules/@servicenow/sdk"));
    expect(fs.realpathSync(loaded.docsDir)).toBe(path.join(sdkRoot, "docs"));
    const scanned = loaded.docs.scanDocs(loaded.docsDir, loaded.fs) as unknown as { name: string; dir: boolean }[];
    expect(scanned).toEqual([{ name: "guides", dir: true }]);
    const read = (loaded.docs as unknown as { read(fs: unknown, p: string): string }).read;
    expect(read(loaded.fs, path.join(loaded.docsDir, "guides/flow.md"))).toContain("# Flow");
  });

  it("is the engine's default docs loader", async () => {
    const e = createFluentEngine({ projectDir: tmp, logger });
    await expect(e.explain({})).rejects.toBeInstanceOf(FluentSdkMissingError);
  });

  it.each([
    ["no docs directory", { docs: false }],
    ["no docs module", { docsModule: false }],
    ["no @servicenow/sdk package root", { name: "not-the-sdk" }],
  ])("explains that an SDK with %s cannot serve explain", (_label, options) => {
    writeSdk(options);
    expect(() => defaultSdkDocsLoader(tmp)).toThrow(FluentDocsUnavailableError);
    expect(() => defaultSdkDocsLoader(tmp)).toThrow(/does not bundle its documentation/);
    try {
      defaultSdkDocsLoader(tmp);
    } catch (e) {
      expect((e as FluentDocsUnavailableError).code).toBe("FLUENT_DOCS_UNAVAILABLE");
    }
  });

  it("findPackageVersion skips unreadable manifests and returns undefined when no ancestor matches", () => {
    write("a/b/c.js", "");
    write("a/b/package.json", "{not json");
    write("a/package.json", JSON.stringify({ name: "other", version: "9" }));
    expect(findPackageVersion(path.join(tmp, "a/b/c.js"), "@servicenow/definitely-not-here")).toBeUndefined();
  });
});
