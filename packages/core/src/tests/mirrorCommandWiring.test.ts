// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
export {};

// mirrorCommand.test.ts drives the command through an injected `MirrorCommandDeps`,
// which is the right shape for asserting WIRING — which stage ran, what it was
// handed, which of R1's exit codes came back. What that leaves untested is the
// DEFAULT dependency object itself: the real `git` child process, the real
// `mirror.config.js` import, the real credential resolution behind §9's OAuth
// relocation. Those adapters are exactly the layer a fake-deps suite defines
// away, and they are also the layer where a mistake is invisible until an
// operator runs the command for real.
//
// So this file overrides as LITTLE as it can get away with per case, and pins
// the parts of the default object that are cheap to exercise honestly:
//
// - the whole default object at once, through `verify` — the one subcommand that
//   needs no credentials, no git and no network, so it can run against the real
//   `@syncrona/mirror` on a real (empty) tree;
// - `nodeReadConfigModule`, against a real file, in both module shapes a repo
//   root can produce (a default export and a bare namespace);
// - `nodeRunGit`, against the real `git` binary — success, a failure that has
//   stderr to quote, and a failure that has only a spawn error;
// - `nodeResolveAuthorization`, across Basic / API-key / OAuth, including the
//   token POST that INV-2 forbids `@syncrona/mirror` from making itself.
//
// `mirror init` is deliberately NOT used to exercise real git: `git maintenance
// start` registers a launchd/systemd job for the repository, which is a side
// effect outside the temporary directory and has no business in a test run.

const execFileAsync = promisify(execFile);

let mirrorCommand: typeof import("../mirrorCommand.js").mirrorCommand;
let logger: typeof import("../Logger.js").logger;

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
] as const;

const CONFIG = {
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

/**
 * The smallest engine `sync` will accept, plus the recorders each case reads.
 *
 * `runMirrorCommand` CALLS the clock and the sweep-id factory it was handed,
 * because that is the only way the default implementations of either are
 * observable from outside — the command passes them through untouched.
 */
const fakeEngine = () => {
  const seen = {
    rawConfig: undefined as unknown,
    clientOptions: [] as Array<Record<string, unknown>>,
    now: "",
    sweepId: "",
  };
  const engine = {
    loadMirrorConfig: (raw: unknown) => {
      seen.rawConfig = raw;
      return CONFIG;
    },
    nodeWriterFs: () => ({
      makeDir: async () => {},
      writeFile: async () => {},
      rename: async () => {},
      readFile: async () => null,
      readDir: async () => null,
      removeRecursive: async () => {},
    }),
    MirrorHttpClient: class {
      constructor(options: Record<string, unknown>) {
        seen.clientOptions.push(options);
      }
    },
    CatalogService: class {
      async build() {
        return { tables: [], anomalies: [], suppressions: [], scopeSysIdByTable: {} };
      }
    },
    runMirrorCommand: async (options: {
      now: () => string;
      newSweepId: () => string;
    }) => {
      seen.now = options.now();
      seen.sweepId = options.newSweepId();
      return {
        exitCode: 0,
        report: { exitCode: 0, sweepId: seen.sweepId, tables: [] },
        commitMessage: "mirror: sweep",
        fatal: null,
        resumeDecision: null,
        checkpointCleared: true,
      };
    },
    detectDrift: async () => ({ verdicts: [], driftDetected: false, exitCode: 0 }),
    verifyMirror: async () => ({ tables: [], findings: [], exitCode: 0 }),
    renderMirrorReport: () => "# Mirror report\n",
    provisionGitAttributes: async () => ({ path: ".gitattributes" }),
    toNativePath: (root: string, rel: string) => join(root, rel),
    COVERAGE_REL_PATH: "coverage.json",
  };
  return { engine, seen };
};

/** Runs the command with the DEFAULT deps except the ones a case names. */
const run = async (
  action: string,
  overrides: Record<string, unknown>,
  flags: Record<string, unknown> = {}
): Promise<number> => {
  await mirrorCommand(
    { _: ["mirror"], $0: "syncrona", logLevel: "error", action, ...flags } as never,
    overrides as never
  );
  return typeof process.exitCode === "number" ? process.exitCode : 0;
};

const roots: string[] = [];
const newRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "syncrona-mirror-wiring-"));
  roots.push(root);
  return root;
};

let savedEnv: Record<string, string | undefined>;
let errors: string[];

beforeAll(async () => {
  ({ mirrorCommand } = await import("../mirrorCommand.js"));
  ({ logger } = await import("../Logger.js"));
});

beforeEach(() => {
  savedEnv = Object.fromEntries(AUTH_ENV_VARS.map((name) => [name, process.env[name]]));
  for (const name of AUTH_ENV_VARS) {
    delete process.env[name];
  }
  errors = [];
  jest.spyOn(logger, "info").mockImplementation(() => {});
  jest.spyOn(logger, "success").mockImplementation(() => {});
  jest.spyOn(logger, "warn").mockImplementation(() => {});
  jest.spyOn(logger, "error").mockImplementation((message: unknown) => {
    errors.push(String(message));
  });
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  jest.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("the default dependency object", () => {
  it("runs verify against the real engine and the real stdout writer", async () => {
    // Only the root is injected. Everything else is production: the lazy
    // `import("@syncrona/mirror")`, the engine's own `nodeWriterFs`, and
    // `process.stdout.write` as the output sink. `verify` is the subcommand that
    // makes this possible — §5.10 gives it no instance and no credentials, so a
    // bare checkout is a complete input, and an empty tree claims no records and
    // therefore has nothing to be wrong about.
    const root = await newRoot();
    const stdout: string[] = [];
    jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });

    const code = await run("verify", { root }, { json: true });

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.join("")) as {
      command: string;
      exitCode: number;
      tables: unknown[];
      findings: unknown[];
    };
    expect(parsed.command).toBe("verify");
    expect(parsed.exitCode).toBe(0);
    expect(parsed.tables).toEqual([]);
    expect(parsed.findings).toEqual([]);
    // The trailing newline is the writer's, not the payload's: a JSON line piped
    // into `jq` has to end somewhere.
    expect(stdout.join("").endsWith("\n")).toBe(true);
  });

  it("hands the engine a real ISO-8601 clock and a real sweep id", async () => {
    // Both are injected into the command so a test can freeze them (§ the sibling
    // suite does exactly that), which means the DEFAULTS are only ever observed
    // by the engine. Here the fake engine reports what it was given.
    const root = await newRoot();
    await writeFile(join(root, "mirror.config.js"), "module.exports = { formatVersion: 1 };\n");
    const { engine, seen } = fakeEngine();

    const code = await run("sync", {
      root,
      loadEngine: async () => engine,
      resolveAuthorization: async () => ({ instance: "dev1.service-now.com", headers: {} }),
      write: () => {},
    });

    expect(code).toBe(0);
    expect(seen.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(seen.now).toISOString()).toBe(seen.now);
    expect(seen.sweepId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("reading mirror.config.js off disk", () => {
  it("unwraps the default export of a CommonJS config", async () => {
    const root = await newRoot();
    await writeFile(
      join(root, "mirror.config.js"),
      "module.exports = { marker: 'commonjs-default' };\n"
    );
    const { engine, seen } = fakeEngine();

    const code = await run("sync", {
      root,
      loadEngine: async () => engine,
      resolveAuthorization: async () => ({ instance: "dev1.service-now.com", headers: {} }),
      write: () => {},
    });

    expect(code).toBe(0);
    expect(seen.rawConfig).toEqual({ marker: "commonjs-default" });
  });

  it("falls back to the namespace when an ESM config exports no default", async () => {
    // `mirror.config.js` is read as whatever the surrounding package.json says it
    // is, so a mirror repository that declares `"type": "module"` and writes its
    // config with named exports is a legitimate input — and it has no `default`
    // to unwrap.
    const root = await newRoot();
    await writeFile(join(root, "package.json"), '{ "type": "module" }\n');
    await writeFile(join(root, "mirror.config.js"), "export const marker = 'esm-named';\n");
    const { engine, seen } = fakeEngine();

    const code = await run("sync", {
      root,
      loadEngine: async () => engine,
      resolveAuthorization: async () => ({ instance: "dev1.service-now.com", headers: {} }),
      write: () => {},
    });

    expect(code).toBe(0);
    expect((seen.rawConfig as { marker: string }).marker).toBe("esm-named");
  });

  it("exits 1 naming the file and the root when there is no config to read", async () => {
    const root = await newRoot();
    const { engine } = fakeEngine();

    const code = await run("sync", { root, loadEngine: async () => engine, write: () => {} });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("mirror.config.js");
    expect(errors.join("\n")).toContain(root);
  });
});

describe("shelling out to git", () => {
  it("folds a baseline sweep's loose objects into a pack with the real binary", async () => {
    // §5.13's `git repack -adf` is asserted here by its EFFECT rather than by an
    // argv recording: the sibling suite already pins the argv, and what that
    // cannot show is that the argv is one the installed git actually accepts.
    const root = await newRoot();
    await execFileAsync("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, "record.json"), "{}\n");
    await execFileAsync("git", ["add", "record.json"], { cwd: root });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.email=wiring@example.invalid",
        "-c",
        "user.name=Wiring Test",
        "commit",
        "--quiet",
        "-m",
        "seed",
      ],
      { cwd: root }
    );
    const packDir = join(root, ".git", "objects", "pack");
    const packs = async (): Promise<string[]> =>
      (await readdir(packDir)).filter((name) => name.endsWith(".pack"));
    expect(await packs()).toEqual([]);

    await writeFile(join(root, "mirror.config.js"), "module.exports = { formatVersion: 1 };\n");
    const { engine } = fakeEngine();
    const code = await run(
      "sync",
      {
        root,
        loadEngine: async () => engine,
        resolveAuthorization: async () => ({ instance: "dev1.service-now.com", headers: {} }),
        write: () => {},
      },
      { full: true }
    );

    expect(code).toBe(0);
    expect(await packs()).not.toEqual([]);
  }, 20000);

  it("quotes what git wrote to stderr when git itself refuses", async () => {
    // A directory that is not a repository: git exits non-zero WITH a diagnosis,
    // and R3 says the operator gets to read it rather than a generic failure.
    const root = await newRoot();
    await writeFile(join(root, "mirror.config.js"), "module.exports = { formatVersion: 1 };\n");
    const { engine } = fakeEngine();

    const code = await run(
      "sync",
      {
        root,
        loadEngine: async () => engine,
        resolveAuthorization: async () => ({ instance: "dev1.service-now.com", headers: {} }),
        write: () => {},
      },
      { full: true }
    );

    expect(code).toBe(1);
    const text = errors.join("\n");
    expect(text).toContain("git repack -adf failed:");
    expect(text.toLowerCase()).toContain("not a git repository");
  }, 20000);

  it("falls back to the spawn error when git never ran and so wrote nothing", async () => {
    // The working directory does not exist, so the failure happens before git has
    // a stderr to write to. Without the fallback the operator would be told
    // `git repack -adf failed` and nothing else at all.
    const root = join(await newRoot(), "does", "not", "exist");
    const { engine } = fakeEngine();

    const code = await run(
      "sync",
      {
        root,
        loadEngine: async () => engine,
        readConfigModule: async () => ({ formatVersion: 1 }),
        resolveAuthorization: async () => ({ instance: "dev1.service-now.com", headers: {} }),
        write: () => {},
      },
      { full: true }
    );

    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/git repack -adf failed \(.+\)/);
  });
});

describe("minting the Authorization header in core (§9, INV-2)", () => {
  const syncWith = async (root: string, engine: unknown): Promise<number> =>
    run("sync", {
      root,
      loadEngine: async () => engine,
      readConfigModule: async () => ({ formatVersion: 1 }),
      write: () => {},
    });

  it("encodes Basic credentials without any round trip", async () => {
    process.env.SN_INSTANCE = "dev1.service-now.com";
    process.env.SN_USER = "admin";
    process.env.SN_PASSWORD = "s3cr3t";
    const { engine, seen } = fakeEngine();

    expect(await syncWith(await newRoot(), engine)).toBe(0);
    expect(seen.clientOptions[0].instance).toBe("dev1.service-now.com");
    expect(seen.clientOptions[0].headers).toEqual({
      Authorization: `Basic ${Buffer.from("admin:s3cr3t", "utf8").toString("base64")}`,
    });
    // The rate limits still come from the config, not from the credential.
    expect(seen.clientOptions[0].requestsPerSecond).toBe(CONFIG.sync.requestsPerSecond);
    expect(seen.clientOptions[0].pageSize).toBe(CONFIG.sync.pageSize);
  });

  it("passes an inbound API key through under its own header name", async () => {
    process.env.SN_INSTANCE = "dev1.service-now.com";
    process.env.SN_AUTH_METHOD = "api-key";
    process.env.SN_API_KEY = "key-abc";
    process.env.SN_API_KEY_HEADER = "x-sn-apikey";
    const { engine, seen } = fakeEngine();

    expect(await syncWith(await newRoot(), engine)).toBe(0);
    expect(seen.clientOptions[0].headers).toEqual({ "x-sn-apikey": "key-abc" });
  });

  it("mints an OAuth bearer token with a POST core makes on the engine's behalf", async () => {
    // This is the whole of §9 in one assertion. `@syncrona/mirror` is GET-only
    // (INV-2) and its own `resolveMirrorAuthorization` throws `auth` for every
    // `oauth-*` method rather than quietly posting; the token therefore has to be
    // acquired here, before the sweep starts, and handed over already formatted.
    process.env.SN_INSTANCE = "dev1.service-now.com";
    process.env.SN_AUTH_METHOD = "oauth-client-credentials";
    process.env.SN_OAUTH_CLIENT_ID = "client-1";
    process.env.SN_OAUTH_CLIENT_SECRET = "client-secret";
    const posts: Array<{ url: string; method: string; body: string }> = [];
    jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: unknown, init: unknown) => {
        const request = init as { method: string; body: string };
        posts.push({
          url: String(input),
          method: request.method,
          body: String(request.body),
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "tok-from-instance", expires_in: 1800 }),
        } as never;
      });
    const { engine, seen } = fakeEngine();

    expect(await syncWith(await newRoot(), engine)).toBe(0);
    expect(seen.clientOptions[0].headers).toEqual({
      Authorization: "Bearer tok-from-instance",
    });
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("https://dev1.service-now.com/oauth_token.do");
    expect(posts[0].method).toBe("POST");
    expect(posts[0].body).toContain("grant_type=client_credentials");
  });

  it("turns a rejected token request into exit 1 that names the status", async () => {
    process.env.SN_INSTANCE = "dev1.service-now.com";
    process.env.SN_AUTH_METHOD = "oauth-client-credentials";
    process.env.SN_OAUTH_CLIENT_ID = "client-1";
    process.env.SN_OAUTH_CLIENT_SECRET = "wrong-secret";
    jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => ({ ok: false, status: 401 }) as never);
    const { engine, seen } = fakeEngine();

    expect(await syncWith(await newRoot(), engine)).toBe(1);
    // No client is built at all: a sweep that cannot authenticate must not start
    // and then fail per table (R1 — this is fatal-incomplete, not partial).
    expect(seen.clientOptions).toEqual([]);
    const text = errors.join("\n");
    expect(text).toContain("HTTP 401");
    expect(text).toContain("dev1.service-now.com");
  });

  it("refuses with exit 1 when no instance is configured anywhere", async () => {
    // SN_USER without SN_INSTANCE: credentials are present, so nothing falls back
    // to the credential store, and the sweep has nowhere to point.
    process.env.SN_USER = "admin";
    process.env.SN_PASSWORD = "s3cr3t";
    const { engine, seen } = fakeEngine();

    expect(await syncWith(await newRoot(), engine)).toBe(1);
    expect(seen.clientOptions).toEqual([]);
    expect(errors.join("\n")).toContain("No ServiceNow instance is configured");
  });
});
