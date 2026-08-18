// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import type {
  MirrorConfig,
  MirrorStatusResult,
  MirrorVerifyResult,
  RunMirrorResult,
  TableCatalogEntry,
  WriterFs,
} from "@syncrona/mirror";
export {};

// WP-M9 covers the ONE seam design §5.13 gives core: "core contributes only
// argument wiring and credential resolution". Everything this suite asserts is
// therefore about the wiring, not about mirroring — which stage ran, what it was
// handed, and which of R1's three exit codes came back out. The engine itself is
// a fake, because a real sweep is `@syncrona/mirror`'s own test surface and
// duplicating it here would make this file fail for reasons M9 does not own.
//
// Four properties are worth the fake:
//
// - R1 (§10): 0 complete / 1 fatal-incomplete / 2 completed-with-partials. The
//   engine already derives 0-vs-2 in the coverage report; core's job is to not
//   lose it, and to turn a THROW into 1 rather than into an unhandled rejection
//   that exits 0.
// - R3: no silent skips. A stage core cannot run (a missing engine export, an
//   unreadable config) must be an error with an exit code, never a shrug.
// - §9 OAuth relocation: INV-2 forbids `@syncrona/mirror` from minting a token,
//   so the ready `Authorization` header must arrive from core. The proof is that
//   the client is built with the header core resolved.
// - §5.10: `verify` "reports, never mutates". The fake fs records every call, so
//   a write on the verify path fails the suite.

let mirrorCommand: typeof import("../mirrorCommand.js").mirrorCommand;
let logger: typeof import("../Logger.js").logger;

type Deps = Parameters<typeof mirrorCommand>[1];
type Engine = NonNullable<Deps>["loadEngine"] extends () => Promise<infer E>
  ? E
  : never;

const CONFIG: MirrorConfig = {
  formatVersion: 1,
  scopes: "all",
  tiers: { referenceData: true },
  tables: { include: [], exclude: [], perTable: {} },
  attachments: { enabled: false, lfsThresholdBytes: 262_144 },
  redaction: { propertyAllowlist: [] },
  derived: { forms: false, workflows: false, refs: false, aclMatrix: false },
  sync: { reconcileEveryNSyncs: 10, requestsPerSecond: 4, pageSize: 1000 },
  diffIgnore: [],
};

const tableEntry = (name: string, status: TableCatalogEntry["status"]): TableCatalogEntry => ({
  name,
  sysId: `sysid-${name}`,
  superClass: null,
  isMetadata: true,
  tier: 1,
  rowCount: 1,
  maxUpdatedOn: "2026-01-01 00:00:00",
  fields: [],
  status,
});

const coverageReport = (exitCode: 0 | 1 | 2): RunMirrorResult["report"] =>
  ({ exitCode, sweepId: "sweep-1", tables: [] }) as unknown as RunMirrorResult["report"];

const runResult = (exitCode: 0 | 1 | 2): RunMirrorResult => ({
  exitCode,
  report: coverageReport(exitCode),
  commitMessage: "mirror: sweep",
  fatal: null,
  resumeDecision: null,
  checkpointCleared: true,
});

const statusResult = (exitCode: 0 | 2): MirrorStatusResult => ({
  verdicts: [],
  driftDetected: exitCode === 2,
  exitCode,
});

const verifyResult = (exitCode: 0 | 2): MirrorVerifyResult => ({
  tables: [],
  findings: [],
  exitCode,
});

/** A WriterFs that records every call; `files` seeds `readFile`. */
const recordingFs = (files: Record<string, string> = {}) => {
  const calls: string[] = [];
  const fs: WriterFs = {
    makeDir: async (dir) => {
      calls.push(`makeDir:${dir}`);
    },
    writeFile: async (filePath) => {
      calls.push(`writeFile:${filePath}`);
    },
    rename: async (from, to) => {
      calls.push(`rename:${from}->${to}`);
    },
    readFile: async (filePath) => {
      calls.push(`readFile:${filePath}`);
      const hit = Object.entries(files).find(([name]) => filePath.endsWith(name));
      return hit === undefined ? null : new TextEncoder().encode(hit[1]);
    },
    readDir: async (dir) => {
      calls.push(`readDir:${dir}`);
      return null;
    },
    removeRecursive: async (target) => {
      calls.push(`removeRecursive:${target}`);
    },
  };
  return { fs, calls };
};

type Harness = ReturnType<typeof harness>;

const harness = (overrides: Partial<Record<string, unknown>> = {}) => {
  const gitCalls: string[][] = [];
  const written: string[] = [];
  const clientOptions: Array<Record<string, unknown>> = [];
  const { fs, calls: fsCalls } = recordingFs(
    (overrides.files as Record<string, string>) ?? {}
  );

  const engine = {
    loadMirrorConfig: jest.fn((_raw: unknown) => CONFIG),
    nodeWriterFs: jest.fn(() => fs),
    // The constructor, not `createMirrorHttpClient`: core arrives holding both
    // halves the factory exists to find, and the factory's instance fallback
    // could name a different one from the credential's. See buildClient's WHY.
    MirrorHttpClient: class {
      constructor(readonly options: Record<string, unknown>) {
        clientOptions.push(options);
      }
    },
    CatalogService: class {
      constructor(readonly options: unknown) {}
      async build() {
        return {
          tables: [tableEntry("incident", "included"), tableEntry("sys_audit", "excluded-tier")],
          anomalies: [],
          suppressions: [],
          scopeSysIdByTable: {},
        };
      }
    },
    runMirrorCommand: jest.fn(async (_options: unknown) => runResult(0)),
    detectDrift: jest.fn(async (_options: unknown) => statusResult(0)),
    verifyMirror: jest.fn(async (_options: unknown) => verifyResult(0)),
    renderMirrorReport: jest.fn((_report: unknown) => "# Mirror report\n"),
    provisionGitAttributes: jest.fn(async (_fs: unknown, _root: string, _config: unknown) => ({
      path: ".gitattributes",
    })),
    toNativePath: (root: string, rel: string) => `${root}/${rel}`,
    COVERAGE_REL_PATH: "coverage.json",
    ...((overrides.engine as Record<string, unknown>) ?? {}),
  };

  const deps = {
    loadEngine: async () => engine as unknown as Engine,
    root: "/repo",
    now: () => "2026-01-01T00:00:00.000Z",
    newSweepId: () => "sweep-1",
    readConfigModule: jest.fn(async (_root: string) => ({ formatVersion: 1 })),
    runGit: jest.fn(async (args: readonly string[]) => {
      gitCalls.push([...args]);
    }),
    resolveAuthorization: jest.fn(async (_profile?: string) => ({
      instance: "dev1.service-now.com",
      headers: { Authorization: "Bearer minted-by-core" },
    })),
    write: (line: string) => {
      written.push(line);
    },
    ...((overrides.deps as Record<string, unknown>) ?? {}),
  };

  return { engine, deps, gitCalls, written, fsCalls, fs, clientOptions };
};

const run = async (
  h: Harness,
  action: string,
  flags: Record<string, unknown> = {}
): Promise<number> => {
  await mirrorCommand(
    { _: ["mirror"], $0: "syncrona", logLevel: "error", action, ...flags } as never,
    h.deps as never
  );
  return typeof process.exitCode === "number" ? process.exitCode : 0;
};

beforeAll(async () => {
  ({ mirrorCommand } = await import("../mirrorCommand.js"));
  ({ logger } = await import("../Logger.js"));
});

/** What the human-readable (non-`--json`) output actually said, per level. */
let warnings: string[];
let errors: string[];

beforeEach(() => {
  warnings = [];
  errors = [];
  jest.spyOn(logger, "info").mockImplementation(() => {});
  jest.spyOn(logger, "success").mockImplementation(() => {});
  jest.spyOn(logger, "warn").mockImplementation((message: unknown) => {
    warnings.push(String(message));
  });
  jest.spyOn(logger, "error").mockImplementation((message: unknown) => {
    errors.push(String(message));
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("mirror init (D17 repo provisioning)", () => {
  it("sets the three scale settings, starts maintenance, and writes .gitattributes", async () => {
    const h = harness();
    const code = await run(h, "init");

    expect(code).toBe(0);
    expect(h.gitCalls).toEqual([
      ["config", "feature.manyFiles", "true"],
      ["config", "core.fsmonitor", "true"],
      ["config", "core.precomposeunicode", "true"],
      ["maintenance", "start"],
    ]);
    expect(h.engine.provisionGitAttributes).toHaveBeenCalledTimes(1);
    const [fsArg, rootArg, configArg] = h.engine.provisionGitAttributes.mock.calls[0] as [
      unknown,
      string,
      unknown,
    ];
    expect(fsArg).toBe(h.fs);
    expect(rootArg).toBe("/repo");
    expect(configArg).toBe(CONFIG);
  });

  it("never runs gc --aggressive (banned by §5.13: 6.5x CPU for ~0.7 MB)", async () => {
    const h = harness();
    await run(h, "init");
    expect(h.gitCalls.flat()).not.toContain("--aggressive");
  });

  it("fails loudly with exit 1 when the engine cannot provision .gitattributes (R3)", async () => {
    // A missing engine export is a degradation, and R3 forbids degrading in
    // silence: init must not report success over a repo it did not finish
    // preparing.
    const h = harness({ engine: { provisionGitAttributes: undefined } });
    const code = await run(h, "init");
    expect(code).toBe(1);
  });
});

describe("mirror sync (§5.13, R1)", () => {
  it("forwards --full and --verify-quiescent into runMirrorCommand and exits 0", async () => {
    const h = harness();
    const code = await run(h, "sync", { full: true, verifyQuiescent: true });

    expect(code).toBe(0);
    expect(h.engine.runMirrorCommand).toHaveBeenCalledTimes(1);
    const options = h.engine.runMirrorCommand.mock.calls[0][0] as Record<string, unknown>;
    expect(options.full).toBe(true);
    expect(options.verifyQuiescent).toBe(true);
    expect(options.root).toBe("/repo");
    expect(options.config).toBe(CONFIG);
    expect(options.fs).toBe(h.fs);
  });

  it("propagates the engine's exit code 2 verbatim rather than re-deriving it", async () => {
    const h = harness({
      engine: { runMirrorCommand: jest.fn(async () => runResult(2)) },
    });
    expect(await run(h, "sync")).toBe(2);
  });

  it("maps a thrown transport failure to exit 1 (fatal-incomplete)", async () => {
    const failure = Object.assign(new Error("instance unreachable"), {
      failureClass: "unreachable",
    });
    const h = harness({
      engine: {
        runMirrorCommand: jest.fn(async () => {
          throw failure;
        }),
      },
    });
    expect(await run(h, "sync")).toBe(1);
  });

  it("ends a --full baseline sweep with a plain repack, never --aggressive", async () => {
    const h = harness();
    await run(h, "sync", { full: true });
    expect(h.gitCalls).toContainEqual(["repack", "-adf"]);
    expect(h.gitCalls.flat()).not.toContain("--aggressive");
  });

  it("does not repack an incremental sync", async () => {
    const h = harness();
    await run(h, "sync");
    expect(h.gitCalls).toEqual([]);
  });

  it("hands the engine a client built from the Authorization header core minted (§9)", async () => {
    // INV-2: acquiring an OAuth token is a state-changing POST, which
    // @syncrona/mirror may not perform. Core resolves the header and the engine
    // only ever sees a ready one — proven here by the client factory's options.
    const h = harness();
    await run(h, "sync", { instanceProfile: "prod" });

    expect(h.deps.resolveAuthorization).toHaveBeenCalledWith("prod");
    expect(h.clientOptions).toHaveLength(1);
    expect(h.clientOptions[0].headers).toEqual({ Authorization: "Bearer minted-by-core" });
    expect(h.clientOptions[0].instance).toBe("dev1.service-now.com");
    // The rate limits still come from the config the factory would have applied.
    expect(h.clientOptions[0].requestsPerSecond).toBe(CONFIG.sync.requestsPerSecond);
    expect(h.clientOptions[0].pageSize).toBe(CONFIG.sync.pageSize);

    const options = h.engine.runMirrorCommand.mock.calls[0][0] as Record<string, unknown>;
    expect(options.client).toBeInstanceOf(h.engine.MirrorHttpClient);
    // The engine is never handed raw credential material to build a transport of
    // its own — that is the whole point of the relocation.
    expect(options.transport).toBeUndefined();
  });

  it("names the failure class when the engine ends a sweep incomplete (R3)", async () => {
    // A fatal is not a partial: the engine stopped, so the tree is unfinished and
    // saying which class stopped it is the difference between "retry" and
    // "reconfigure". R3 forbids reducing that to a bare non-zero exit.
    const h = harness({
      engine: {
        runMirrorCommand: jest.fn(async () => ({
          ...runResult(1),
          fatal: { failureClass: "unreachable", message: "connect ETIMEDOUT" },
        })),
      },
    });

    expect(await run(h, "sync")).toBe(1);
    expect(errors.join("\n")).toContain("unreachable");
  });

  it("emits the suggested commit message so Phase 1 never commits for the user (D10)", async () => {
    const h = harness();
    await run(h, "sync");
    expect(h.gitCalls.flat()).not.toContain("commit");
    expect(h.written.join("\n") + JSON.stringify(h.written)).toContain("mirror: sweep");
  });
});

describe("mirror status (§5.10)", () => {
  it("passes only the catalog's included tables to the detector and exits 0 in sync", async () => {
    const h = harness();
    const code = await run(h, "status");

    expect(code).toBe(0);
    expect(h.engine.detectDrift).toHaveBeenCalledTimes(1);
    const options = h.engine.detectDrift.mock.calls[0][0] as Record<string, unknown>;
    expect(options.tables).toEqual(["incident"]);
    expect(options.root).toBe("/repo");
    expect(options.deep).toBeUndefined();
  });

  it("exits 2 when drift is detected", async () => {
    const h = harness({ engine: { detectDrift: jest.fn(async () => statusResult(2)) } });
    expect(await run(h, "status")).toBe(2);
  });

  it("reports the drifting tables by name and stays quiet about the in-sync ones", async () => {
    // A status run over a whole instance is mostly good news, so printing every
    // verdict would bury the few that matter. Only the non-`in-sync` ones are
    // named; the count in the summary line is what accounts for the rest.
    const h = harness({
      engine: {
        detectDrift: jest.fn(async () => ({
          verdicts: [
            { kind: "in-sync", table: "sys_script", liveCount: 2, mirroredCount: 2 },
            { kind: "count-drift", table: "incident", liveCount: 9, mirroredCount: 7 },
          ],
          driftDetected: true,
          exitCode: 2,
        })),
      },
    });

    expect(await run(h, "status")).toBe(2);
    expect(warnings).toEqual(["incident: count-drift"]);
    expect(errors.join("\n")).toContain("2 checked table(s)");
  });

  it("--deep supplies the keyset sampler with the live catalog", async () => {
    const h = harness();
    await run(h, "status", { deep: true });

    const options = h.engine.detectDrift.mock.calls[0][0] as Record<string, unknown>;
    const deep = options.deep as { catalog: Map<string, TableCatalogEntry>; sampleEvery: number };
    expect(deep).toBeDefined();
    expect(deep.sampleEvery).toBeGreaterThanOrEqual(1);
    expect(deep.catalog.get("incident")?.name).toBe("incident");
  });
});

describe("mirror verify (§5.10 — reports, never mutates)", () => {
  it("exits 0 with no findings and touches nothing on disk", async () => {
    const h = harness();
    const code = await run(h, "verify");

    expect(code).toBe(0);
    expect(h.engine.verifyMirror).toHaveBeenCalledTimes(1);
    const mutations = h.fsCalls.filter((call) =>
      /^(makeDir|writeFile|rename|removeRecursive):/.test(call)
    );
    expect(mutations).toEqual([]);
  });

  it("exits 2 when the verifier reports findings", async () => {
    const h = harness({ engine: { verifyMirror: jest.fn(async () => verifyResult(2)) } });
    expect(await run(h, "verify")).toBe(2);
  });

  it("prints every finding with the detail the verifier attached to it", async () => {
    // The finding kinds are terse by design (`content-hash-mismatch`), so the
    // detail is what tells the operator which record and what went wrong with it.
    // Dropping it would leave a report that says damage exists and not where.
    const h = harness({
      engine: {
        verifyMirror: jest.fn(async () => ({
          tables: [],
          findings: [
            {
              kind: "content-hash-mismatch",
              scope: "global",
              table: "sys_script",
              sysId: "a".repeat(32),
              path: "instance/global/sys_script/aa/aaaa/record.json",
              detail: "expected deadbeef, read cafebabe",
            },
          ],
          exitCode: 2,
        })),
      },
    });

    expect(await run(h, "verify")).toBe(2);
    expect(warnings).toEqual([
      "sys_script content-hash-mismatch: expected deadbeef, read cafebabe",
    ]);
  });

  it("never opens a network connection — verify answers from the tree alone", async () => {
    const h = harness();
    await run(h, "verify");
    expect(h.deps.resolveAuthorization).not.toHaveBeenCalled();
    expect(h.clientOptions).toEqual([]);
  });
});

describe("mirror report", () => {
  it("re-renders the committed coverage.json and re-surfaces its exit code", async () => {
    const h = harness({
      files: { "coverage.json": JSON.stringify({ exitCode: 2, sweepId: "s1", tables: [] }) },
    });
    const code = await run(h, "report");

    expect(code).toBe(2);
    expect(h.engine.renderMirrorReport).toHaveBeenCalledTimes(1);
    expect(h.written.join("\n")).toContain("# Mirror report");
  });

  it("--json prints the machine report instead of the Markdown one", async () => {
    const h = harness({
      files: { "coverage.json": JSON.stringify({ exitCode: 0, sweepId: "s1", tables: [] }) },
    });
    const code = await run(h, "report", { json: true });

    expect(code).toBe(0);
    expect(h.engine.renderMirrorReport).not.toHaveBeenCalled();
    expect(JSON.parse(h.written.join("\n")).sweepId).toBe("s1");
  });

  it("exits 1 when no sweep has ever written a coverage report (R3)", async () => {
    const h = harness();
    expect(await run(h, "report")).toBe(1);
  });

  it("says the committed report was edited when it no longer parses", async () => {
    // `coverage.json` is generated and committed, so invalid JSON in it is never
    // a mirror bug — it is a hand-edit or a truncated checkout, and the message
    // has to say so or the operator goes looking in the wrong place.
    const h = harness({ files: { "coverage.json": '{"exitCode": 0, "tables": [' } });

    expect(await run(h, "report")).toBe(1);
    const text = errors.join("\n");
    expect(text).toContain("is not valid JSON");
    expect(text).toContain("edited or truncated");
  });
});

describe("argument surface", () => {
  it("rejects an unknown subcommand with exit 1 instead of doing nothing", async () => {
    const h = harness();
    expect(await run(h, "nuke")).toBe(1);
    expect(h.engine.runMirrorCommand).not.toHaveBeenCalled();
  });

  it("exits 1 when mirror.config.js cannot be read", async () => {
    const h = harness({
      deps: {
        readConfigModule: jest.fn(async () => {
          throw new Error("ENOENT: mirror.config.js");
        }),
      },
    });
    expect(await run(h, "sync")).toBe(1);
  });

  it("--json emits one machine object per subcommand", async () => {
    for (const action of ["init", "sync", "status", "verify"]) {
      const h = harness();
      await run(h, action, { json: true });
      const parsed = JSON.parse(h.written.join("\n")) as { command: string; exitCode: number };
      expect(parsed.command).toBe(action);
      expect(parsed.exitCode).toBe(0);
    }
  });
});
