// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
export {};

// Edge branches of `syncrona mirror` that the main suites leave open: the
// process-boundary fallbacks (a missing action, a non-Error throw, an empty
// message, a non-string failure class), `verify --deep` sampling every record,
// and `mirror report` over a coverage file that carries no valid exit code.
// Each test asserts the outcome a user sees — the exit code and the printed
// line — not merely that the line executed.

let mirrorCommand: typeof import("../mirrorCommand.js").mirrorCommand;
let logger: typeof import("../Logger.js").logger;

type Deps = NonNullable<Parameters<typeof mirrorCommand>[1]>;

beforeAll(async () => {
  ({ mirrorCommand } = await import("../mirrorCommand.js"));
  ({ logger } = await import("../Logger.js"));
});

let errors: string[];
let successes: string[];
let written: string[];

beforeEach(() => {
  errors = [];
  successes = [];
  written = [];
  process.exitCode = undefined;
  jest.spyOn(logger, "info").mockImplementation(() => {});
  jest.spyOn(logger, "warn").mockImplementation(() => {});
  jest.spyOn(logger, "success").mockImplementation((message: unknown) => {
    successes.push(String(message));
  });
  jest.spyOn(logger, "error").mockImplementation((message: unknown) => {
    errors.push(String(message));
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  process.exitCode = undefined;
});

const baseArgs = (flags: Record<string, unknown>) =>
  ({ _: ["mirror"], $0: "syncrona", logLevel: "error", ...flags }) as never;

/** Deps whose engine loader yields `engine`; nothing touches the network or git. */
const depsWith = (engine: Record<string, unknown>): Partial<Deps> => ({
  loadEngine: async () => engine as never,
  root: "/repo",
  write: (line: string) => {
    written.push(line);
  },
  runGit: jest.fn(async () => {}),
  resolveAuthorization: jest.fn(async () => {
    throw new Error("must not resolve a credential");
  }),
});

const exitCode = (): number => (typeof process.exitCode === "number" ? process.exitCode : 0);

describe("mirror action validation", () => {
  it("rejects a missing action with exit 1 and names the empty subcommand", async () => {
    const loadEngine = jest.fn(async () => ({}) as never);
    await mirrorCommand(baseArgs({}), { loadEngine });

    expect(exitCode()).toBe(1);
    expect(loadEngine).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Unknown mirror subcommand "".');
    expect(errors[0]).toContain("init | sync | status | verify | report");
  });

  it("validates the action before using any dependency when called without overrides", async () => {
    // The default `overrides = {}` path builds the real node deps; an unknown
    // action must still stop before any of them runs.
    await mirrorCommand(baseArgs({ action: "explode" }));

    expect(exitCode()).toBe(1);
    expect(errors).toEqual([
      expect.stringContaining('Unknown mirror subcommand "explode".'),
    ]);
  });
});

describe("mirror fatal-error boundary (R1: a throw is exit 1)", () => {
  const failWith = async (thrown: unknown) => {
    await mirrorCommand(baseArgs({ action: "verify" }), {
      loadEngine: async () => {
        throw thrown;
      },
    });
  };

  it("stringifies a non-Error throw instead of losing it", async () => {
    await failWith("engine tarball missing");
    expect(exitCode()).toBe(1);
    expect(errors[0]).toBe("engine tarball missing");
  });

  it("falls back to a generic message when the error message is empty", async () => {
    await failWith(new Error(""));
    expect(exitCode()).toBe(1);
    expect(errors[0]).toBe("Mirror command failed with an unknown error.");
  });

  it("omits the failure-class prefix when failureClass is not a string", async () => {
    await failWith(Object.assign(new Error("socket hang up"), { failureClass: 7 }));
    expect(exitCode()).toBe(1);
    expect(errors[0]).toBe("socket hang up");
  });

  it("prefixes a string failure class", async () => {
    await failWith(Object.assign(new Error("401"), { failureClass: "auth" }));
    expect(exitCode()).toBe(1);
    expect(errors[0]).toBe("[auth] 401");
  });
});

describe("mirror verify --deep", () => {
  it("samples every record and never resolves a credential", async () => {
    const verifyMirror = jest.fn(async (_options: Record<string, unknown>) => ({
      tables: [{ table: "incident" }],
      findings: [],
      exitCode: 0 as const,
    }));
    const fs = { readFile: async () => null };
    const deps = depsWith({ verifyMirror, nodeWriterFs: () => fs });

    await mirrorCommand(baseArgs({ action: "verify", deep: true }), deps);

    expect(exitCode()).toBe(0);
    expect(verifyMirror).toHaveBeenCalledTimes(1);
    const options = verifyMirror.mock.calls[0][0];
    expect(options.sampleEvery).toBe(1);
    expect(options.root).toBe("/repo");
    expect(options.fs).toBe(fs);
    expect(deps.resolveAuthorization).not.toHaveBeenCalled();
    expect(successes).toEqual([expect.stringContaining("Verified 1 table(s) with no findings")]);
  });

  it("uses the sparse default sample without --deep", async () => {
    const verifyMirror = jest.fn(async (_options: Record<string, unknown>) => ({
      tables: [],
      findings: [],
      exitCode: 0 as const,
    }));
    await mirrorCommand(
      baseArgs({ action: "verify" }),
      depsWith({ verifyMirror, nodeWriterFs: () => ({}) })
    );
    expect(verifyMirror.mock.calls[0][0].sampleEvery).toBe(50);
  });
});

describe("mirror report over a coverage file without a valid exitCode", () => {
  const reportEngine = (json: string) => {
    const renderMirrorReport = jest.fn((_report: unknown) => "# Mirror report\n");
    return {
      renderMirrorReport,
      engine: {
        nodeWriterFs: () => ({
          readFile: async (target: string) =>
            target === "/repo/coverage.json" ? new TextEncoder().encode(json) : null,
        }),
        toNativePath: (root: string, rel: string) => `${root}/${rel}`,
        COVERAGE_REL_PATH: "coverage.json",
        renderMirrorReport,
      },
    };
  };

  it.each([
    ["absent", '{"sweepId":"s-1","tables":[]}'],
    ["a string", '{"exitCode":"2","tables":[]}'],
    ["out of range", '{"exitCode":3,"tables":[]}'],
    ["not an object", "null"],
  ])("exits 1 and prints nothing when the exit code is %s", async (_label, raw) => {
    const { engine, renderMirrorReport } = reportEngine(raw);
    await mirrorCommand(baseArgs({ action: "report", json: true }), depsWith(engine));

    expect(exitCode()).toBe(1);
    expect(renderMirrorReport).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    expect(errors[0]).toContain("carries no exit code of 0, 1 or 2");
  });

  it("re-surfaces a valid exit code of 1", async () => {
    const { engine } = reportEngine('{"exitCode":1,"tables":[]}');
    await mirrorCommand(baseArgs({ action: "report" }), depsWith(engine));
    expect(exitCode()).toBe(1);
    expect(written).toEqual(["# Mirror report\n"]);
  });
});
