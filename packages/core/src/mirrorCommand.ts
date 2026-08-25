// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `syncrona mirror` — the CLI face of the full-instance git mirror (design §5.13).
 *
 * The design gives this module one sentence of scope and it is worth taking
 * literally: "core contributes only argument wiring and credential resolution".
 * `@syncrona/mirror` owns catalog, planning, fetching, serialization, redaction,
 * writing and reporting; nothing here re-decides any of it. What core owns is the
 * three things a library cannot own from inside itself:
 *
 * 1. **The exit code (R1, §10).** 0 = complete, 1 = fatal-incomplete,
 *    2 = completed-with-partials. The engine already derives 0-vs-2 once, in
 *    `buildCoverageReport`, and this module copies that number out rather than
 *    re-deriving it — two places deriving one verdict is how a CI gate comes to
 *    disagree with the report it is gating on. 1 is core's own contribution: it
 *    is what a THROWN failure means, and mapping a throw to an exit code is
 *    precisely the job of the process boundary.
 *
 * 2. **The Authorization header (§9, INV-2).** Acquiring an OAuth token is a
 *    state-changing POST, and `@syncrona/mirror` is a GET-only package — its own
 *    `resolveMirrorAuthorization` deliberately throws `auth` for every `oauth-*`
 *    method rather than quietly minting one. So the token is minted HERE, out of
 *    core's existing credential machinery, and the engine is handed a client
 *    whose `headers` already carry a ready value. The relocation is the reason
 *    `mirror sync` works against an OAuth-only instance where a direct library
 *    call cannot.
 *
 * 3. **Git (D17, analyses §9.4).** A library that writes files has no business
 *    running `git`, but a repo holding a whole instance needs provisioning that a
 *    fresh `git init` does not do: `feature.manyFiles`, `core.fsmonitor`,
 *    `core.precomposeunicode`, and a scheduled `git maintenance`. `mirror init`
 *    does that once; `mirror sync --full` closes a baseline sweep with a plain
 *    `git repack -adf`. `--aggressive` is BANNED and this module never emits it:
 *    it was measured at 6.5x the CPU for about 0.7 MB of gain.
 *
 * Phase 1 never commits. D10's trailers are printed as a suggested commit
 * message and the working tree is left for the operator (or a wrapper) to commit,
 * so a sweep can never rewrite history the user did not ask for.
 *
 * Everything the command touches arrives through {@link MirrorCommandDeps}, and
 * the engine itself arrives through a lazy `import()`. Both are deliberate. The
 * lazy import keeps `syncrona --help` working when the engine tarball is not
 * installed — which is exactly the state the CI pack-install smoke exercises —
 * and the dependency object is what lets this file be tested for wiring without
 * mocking a module graph.
 */
import type { Sync } from "@syncrona/types";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CoverageReport,
  MirrorAuthorization,
  MirrorConfig,
  SyncCadence,
  TableCatalogEntry,
  WriterFs,
} from "@syncrona/mirror";
import { logger } from "./Logger.js";
import { setLogLevel, logErrorHint, resolveInstanceProfile } from "./commandHelpers.js";
import { resolveCredentials, buildClientAuth } from "./snClient.js";
import { createTokenManager, type OAuthTokenResponse, type TokenPoster } from "./oauth.js";

/** The subcommands §13.1 names, in the order the docs list them. */
export const MIRROR_ACTIONS = ["init", "sync", "status", "verify", "report"] as const;
export type MirrorAction = (typeof MIRROR_ACTIONS)[number];

export type MirrorCmdArgs = Sync.SharedCmdArgs & {
  action?: string;
  full?: boolean;
  /**
   * §5.4's escape hatch: plan this sweep as a `reconcile` without waiting for the
   * cadence. Weaker than `full` — it observes every table whole (which is what
   * INV-5 needs before it will delete anything) but does not re-fetch rows the
   * watermark says are unchanged. `full` wins when both are given.
   */
  reconcile?: boolean;
  verifyQuiescent?: boolean;
  deep?: boolean;
  json?: boolean;
};

/**
 * How often a spot-check samples, when the caller did not say.
 *
 * §5.10 defines both deep checks as "every Kth sys_id" without fixing K, because
 * K is a cost dial rather than a correctness one: the check is deterministic at
 * any K, and a bigger K only means a longer time-to-first-detection for a defect
 * that affects few records. 50 keeps a `--deep` status inside the "cheap enough
 * for a CI cron" budget §5.10 asks for on a tree with millions of records, and
 * `--deep` on `verify` drops it to 1 for the exhaustive pass.
 */
const SAMPLE_EVERY_DEFAULT = 50;

/** The mirror config module, by convention at the repo root (§3). */
const MIRROR_CONFIG_FILE = "mirror.config.js";

/**
 * The slice of `@syncrona/mirror` the CLI drives.
 *
 * `Pick` over the module's own type rather than a hand-written interface: the
 * signatures then cannot drift from the engine's, and a renamed or removed
 * export is a compile error here instead of a runtime `undefined is not a
 * function` at the far end of a sweep.
 *
 * `provisionGitAttributes` is the one member declared by hand and marked
 * optional. It belongs to WP-M12's attachment/LFS work and lands with it; typing
 * it here lets M9 compile against the agreed contract ahead of the export, and
 * the optionality is honest rather than convenient — `mirror init` refuses to
 * report success when the function is absent (R3: a skipped step is reported,
 * never swallowed).
 */
type MirrorModule = typeof import("@syncrona/mirror");
export type MirrorEngine = Pick<
  MirrorModule,
  | "loadMirrorConfig"
  | "nodeWriterFs"
  | "MirrorHttpClient"
  | "CatalogService"
  | "runMirrorCommand"
  | "detectDrift"
  | "verifyMirror"
  | "renderMirrorReport"
  | "toNativePath"
  | "COVERAGE_REL_PATH"
> & {
  /** WP-M12 (§5.13): `* text=auto eol=lf`, `_derived/** linguist-generated`, LFS patterns. */
  provisionGitAttributes?: (
    fs: WriterFs,
    root: string,
    config: MirrorConfig
  ) => Promise<unknown>;
};

/** Every effect the command has on the world, in one injectable object. */
export interface MirrorCommandDeps {
  /** Lazily resolves the engine, so `--help` survives a missing tarball. */
  loadEngine: () => Promise<MirrorEngine>;
  /** The mirror checkout to operate on. */
  root: string;
  /** ISO-8601 clock, injected so a run is reproducible under test. */
  now: () => string;
  /** Sweep identity, injected for the same reason. */
  newSweepId: () => string;
  /** Reads `<root>/mirror.config.js` and returns its default export. */
  readConfigModule: (root: string) => Promise<unknown>;
  /** Runs one git subcommand in the mirror repo; rejects on a non-zero exit. */
  runGit: (args: readonly string[], cwd: string) => Promise<void>;
  /** §9: mints the ready Authorization header outside `@syncrona/mirror`. */
  resolveAuthorization: (profile?: string) => Promise<MirrorAuthorization>;
  /** Where command output goes — stdout in production, a buffer under test. */
  write: (line: string) => void;
}

/**
 * A stage this command could not run, with the wording the operator needs.
 *
 * Distinguished from an engine failure only so the catch can tell "core could
 * not get far enough to ask" from "the engine answered with a fatal". Both are
 * exit 1 under R1; the message differs.
 */
class MirrorCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MirrorCliError";
  }
}

/** `git` without a shell, so a repo path can never be re-parsed as an argument. */
const nodeRunGit = (args: readonly string[], cwd: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd }, (error, _stdout, stderr) => {
      if (error) {
        const detail = String(stderr || "").trim();
        reject(
          new MirrorCliError(
            `git ${args.join(" ")} failed${detail ? `: ${detail}` : ` (${error.message})`}`
          )
        );
        return;
      }
      resolve();
    });
  });

/**
 * Turns core's resolved credentials into a ready Authorization header (§9).
 *
 * Basic and API-key need no round trip. The three OAuth grants do, and that
 * round trip is the whole reason this lives in core: it is a POST, and
 * `@syncrona/mirror` performs GETs only (INV-2). The token is acquired once,
 * before the sweep starts, because `MirrorHttpClient` snapshots its headers at
 * construction — a mid-sweep re-acquisition would need a new client, which is a
 * Phase-2 concern; until then an expiring token surfaces as an `auth` fatal and
 * exit 1 rather than as a silently truncated tree.
 */
async function nodeResolveAuthorization(profile?: string): Promise<MirrorAuthorization> {
  const credentials = resolveCredentials(profile);
  if (!credentials.instance) {
    throw new MirrorCliError(
      "No ServiceNow instance is configured. Run `syncrona login`, or set SN_INSTANCE in the environment."
    );
  }
  const { oauth, apiKey } = buildClientAuth(credentials);

  if (apiKey) {
    return { instance: credentials.instance, headers: { [apiKey.header]: apiKey.value } };
  }
  if (!oauth) {
    const encoded = Buffer.from(`${credentials.user}:${credentials.password}`, "utf8").toString(
      "base64"
    );
    return { instance: credentials.instance, headers: { Authorization: `Basic ${encoded}` } };
  }

  const baseUrl = `https://${credentials.instance}/`;
  const post: TokenPoster = async (tokenPath, body) => {
    const response = await fetch(new URL(tokenPath, baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      throw new MirrorCliError(
        `OAuth token request to ${credentials.instance} failed with HTTP ${response.status}. ` +
          `Check the client id/secret and the grant configured for this instance.`
      );
    }
    return (await response.json()) as OAuthTokenResponse;
  };
  const tokens = createTokenManager(
    { username: credentials.user, password: credentials.password },
    oauth,
    post
  );
  return {
    instance: credentials.instance,
    headers: { Authorization: `Bearer ${await tokens.getToken()}` },
  };
}

/** Loads `<root>/mirror.config.js` as an ES module and unwraps its default. */
async function nodeReadConfigModule(root: string): Promise<unknown> {
  const configPath = path.join(root, MIRROR_CONFIG_FILE);
  const loaded = (await import(pathToFileURL(configPath).href)) as { default?: unknown };
  return loaded.default ?? loaded;
}

const defaultDeps = (): MirrorCommandDeps => ({
  loadEngine: () => import("@syncrona/mirror"),
  root: process.cwd(),
  now: () => new Date().toISOString(),
  newSweepId: () => randomUUID(),
  readConfigModule: nodeReadConfigModule,
  runGit: nodeRunGit,
  resolveAuthorization: nodeResolveAuthorization,
  write: (line: string) => process.stdout.write(`${line}\n`),
});

/** The failure class an engine error carries, when it carries one (F1–F9). */
function failureClassOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("failureClass" in error)) {
    return null;
  }
  const value = (error as { failureClass: unknown }).failureClass;
  return typeof value === "string" ? value : null;
}

/** Reads and validates the mirror config, or explains why it could not. */
async function loadConfig(deps: MirrorCommandDeps, engine: MirrorEngine): Promise<MirrorConfig> {
  let raw: unknown;
  try {
    raw = await deps.readConfigModule(deps.root);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Deliberately NOT "run `mirror init` first": init needs the config too (it
    // is what tells `provisionGitAttributes` which paths go to LFS), so pointing
    // there would send the operator in a circle.
    throw new MirrorCliError(
      `Could not read ${MIRROR_CONFIG_FILE} in ${deps.root}: ${message}. ` +
        `Every mirror command except \`verify\` reads it, so write one at the root of the mirror repository first.`
    );
  }
  return engine.loadMirrorConfig(raw);
}

/**
 * Builds the GET-only client the engine sweeps with, header already minted (§9).
 *
 * Constructed directly rather than through the engine's own
 * `createMirrorHttpClient`. That factory exists to FIND the two things core
 * already holds by the time it gets here — which instance, and what header —
 * and its instance fallback (the config's value, then the stored active marker)
 * can name a different instance from the one the resolved credential belongs
 * to. `MirrorHttpClientOptions.headers` is the seam §9 names for the relocation,
 * and the constructor is where that seam lives with nothing in front of it.
 */
async function buildClient(
  deps: MirrorCommandDeps,
  engine: MirrorEngine,
  config: MirrorConfig,
  profile?: string
): Promise<InstanceType<MirrorEngine["MirrorHttpClient"]>> {
  const auth = await deps.resolveAuthorization(profile);
  return new engine.MirrorHttpClient({
    instance: auth.instance,
    headers: auth.headers,
    requestsPerSecond: config.sync.requestsPerSecond,
    pageSize: config.sync.pageSize,
  });
}

/** D17 provisioning: the settings a million-file checkout needs from day one. */
async function runInit(
  deps: MirrorCommandDeps,
  engine: MirrorEngine,
  json: boolean
): Promise<number> {
  const config = await loadConfig(deps, engine);
  const settings: Array<[string, string]> = [
    ["feature.manyFiles", "true"],
    ["core.fsmonitor", "true"],
    ["core.precomposeunicode", "true"],
  ];
  for (const [key, value] of settings) {
    await deps.runGit(["config", key, value], deps.root);
  }
  // Scheduled incremental maintenance instead of a periodic `gc --aggressive`:
  // the aggressive repack was measured at 6.5x CPU for ~0.7 MB, so it is banned
  // outright and never appears in any argv this module builds.
  await deps.runGit(["maintenance", "start"], deps.root);

  const provision = engine.provisionGitAttributes;
  if (typeof provision !== "function") {
    throw new MirrorCliError(
      "The installed @syncrona/mirror does not export provisionGitAttributes, so .gitattributes " +
        "was not written and the repository is only partly provisioned. Upgrade @syncrona/mirror " +
        "and re-run `syncrona mirror init`."
    );
  }
  await provision(engine.nodeWriterFs(), deps.root, config);

  if (json) {
    deps.write(
      JSON.stringify(
        {
          command: "init",
          exitCode: 0,
          root: deps.root,
          gitConfig: Object.fromEntries(settings),
          maintenance: "started",
          gitAttributes: "written",
        },
        null,
        2
      )
    );
  } else {
    logger.info(
      `Provisioned ${deps.root} for scale: ${settings
        .map(([key]) => key)
        .join(", ")}, git maintenance, .gitattributes.`
    );
    logger.success("Mirror repository initialized. ✅");
  }
  return 0;
}

/**
 * Where this sweep sat in the §5.4 reconcile cycle, in one sentence.
 *
 * Worth a line of output because the cycle is otherwise invisible and its
 * consequence is not: between reconciles the mirror grows monotonically —
 * a record deleted on the instance keeps its directory, because INV-5 will not
 * remove anything without a completed full sweep to point at. An operator who can
 * see "4 syncs until the next reconcile" can answer "why is this record still
 * here" without reading the design document.
 */
function describeCadence(cadence: SyncCadence): string {
  const { ordinal, everyN, syncsUntilReconcile, forced } = cadence;
  if (syncsUntilReconcile === null) {
    // `reconcileEveryNSyncs` is 0, negative or fractional, so the planner refused
    // to promote anything. Silence here would look identical to a healthy cycle.
    return `Sync ${ordinal}: the reconcile cadence is disabled (reconcileEveryNSyncs = ${everyN}), so deletions reach the mirror only with --reconcile or --full.`;
  }
  const position = `Sync ${ordinal} of the ${everyN}-sync reconcile cycle`;
  if (forced) {
    // The count still governs the automatic one, so it is reported alongside
    // rather than replaced — a forced reconcile does not reset the cycle.
    return `${position} — reconciling because it was asked for; the scheduled one is ${syncsUntilReconcile} sync(s) away.`;
  }
  if (syncsUntilReconcile === 0) {
    return `${position} — this is the scheduled reconcile, so deletions on the instance are propagated.`;
  }
  return `${position}; ${syncsUntilReconcile} more before deletions are reconciled (--reconcile forces one now).`;
}

/** One sweep, then the D10 commit message the operator (not this CLI) applies. */
async function runSync(
  deps: MirrorCommandDeps,
  engine: MirrorEngine,
  args: MirrorCmdArgs,
  profile: string | undefined
): Promise<number> {
  const config = await loadConfig(deps, engine);
  const client = await buildClient(deps, engine, config, profile);
  const result = await engine.runMirrorCommand({
    config,
    root: deps.root,
    fs: engine.nodeWriterFs(),
    now: deps.now,
    newSweepId: deps.newSweepId,
    client,
    ...(args.full === undefined ? {} : { full: args.full }),
    ...(args.reconcile === undefined ? {} : { reconcile: args.reconcile }),
    ...(args.verifyQuiescent === undefined ? {} : { verifyQuiescent: args.verifyQuiescent }),
  });
  // The ordinal is deliberately NOT passed: the engine owns the count, persists it
  // under `.mirror/state/` and advances it only on a run that finished. A CLI that
  // supplied one would be a CLI that could postpone a reconcile indefinitely.

  // A baseline sweep writes the whole instance in one pass, which leaves a repo
  // full of loose objects; a plain full repack is the measured-cheap way to fold
  // them into one pack. Incremental syncs are left to `git maintenance`.
  if (args.full === true) {
    await deps.runGit(["repack", "-adf"], deps.root);
  }

  if (args.json === true) {
    deps.write(
      JSON.stringify(
        {
          command: "sync",
          exitCode: result.exitCode,
          commitMessage: result.commitMessage,
          report: result.report,
          fatal: result.fatal,
          resumeDecision: result.resumeDecision,
          checkpointCleared: result.checkpointCleared,
          syncCadence: result.syncCadence,
          syncCounterWarning: result.syncCounterWarning,
        },
        null,
        2
      )
    );
  } else {
    // Phase 1 never runs `git commit`: the sweep's evidence is printed and the
    // decision to record it stays with whoever owns the repo's history.
    deps.write(result.commitMessage);
    logger.info(describeCadence(result.syncCadence));
    if (result.syncCounterWarning !== null) {
      logger.warn(result.syncCounterWarning);
    }
    if (result.fatal) {
      logger.error(`Sweep ended incomplete: ${result.fatal.failureClass}.`);
    } else if (result.exitCode === 2) {
      logger.warn("Sweep completed with partials — see MIRROR-REPORT.md for every reason.");
    } else {
      logger.success("Mirror sweep complete. ✅");
    }
  }
  return result.exitCode;
}

/**
 * §5.10 status: aggregate-only comparison, exit 0 in sync / 2 on drift.
 *
 * The catalog is rebuilt rather than read off disk because the question status
 * asks is "does the tree still match the INSTANCE", and only the instance knows
 * which tables exist today — a table that vanished, or one that appeared since
 * the last sweep, is drift the mirrored tree cannot report on itself.
 */
async function runStatus(
  deps: MirrorCommandDeps,
  engine: MirrorEngine,
  args: MirrorCmdArgs,
  profile: string | undefined
): Promise<0 | 2> {
  const config = await loadConfig(deps, engine);
  const client = await buildClient(deps, engine, config, profile);
  const catalog = await new engine.CatalogService({ source: client, config }).build();
  const included = catalog.tables.filter((entry) => entry.status === "included");
  const byName = new Map<string, TableCatalogEntry>(
    catalog.tables.map((entry) => [entry.name, entry])
  );

  const result = await engine.detectDrift({
    fs: engine.nodeWriterFs(),
    root: deps.root,
    client,
    tables: included.map((entry) => entry.name),
    ...(args.deep === true
      ? {
          deep: {
            client,
            catalog: byName,
            redaction: config.redaction,
            sampleEvery: SAMPLE_EVERY_DEFAULT,
          },
        }
      : {}),
  });

  if (args.json === true) {
    deps.write(
      JSON.stringify(
        {
          command: "status",
          exitCode: result.exitCode,
          driftDetected: result.driftDetected,
          verdicts: result.verdicts,
        },
        null,
        2
      )
    );
  } else {
    for (const verdict of result.verdicts) {
      if (verdict.kind !== "in-sync") {
        logger.warn(`${verdict.table}: ${verdict.kind}`);
      }
    }
    if (result.driftDetected) {
      logger.error(`Drift detected across ${result.verdicts.length} checked table(s).`);
    } else {
      logger.success(`In sync across ${result.verdicts.length} table(s). ✅`);
    }
  }
  return result.exitCode;
}

/**
 * §5.10 verify: reports, never mutates, and never opens a socket.
 *
 * The verifier answers entirely from the tree — shards against record
 * directories, `contentHash` against the bytes on disk — so no credential is
 * resolved and no client is built. That absence is the feature: `mirror verify`
 * is runnable on a clone with no access to the instance at all.
 */
async function runVerify(
  deps: MirrorCommandDeps,
  engine: MirrorEngine,
  args: MirrorCmdArgs
): Promise<0 | 2> {
  const result = await engine.verifyMirror({
    fs: engine.nodeWriterFs(),
    root: deps.root,
    sampleEvery: args.deep === true ? 1 : SAMPLE_EVERY_DEFAULT,
  });

  if (args.json === true) {
    deps.write(
      JSON.stringify(
        {
          command: "verify",
          exitCode: result.exitCode,
          tables: result.tables,
          findings: result.findings,
        },
        null,
        2
      )
    );
  } else {
    for (const finding of result.findings) {
      logger.warn(`${finding.table} ${finding.kind}: ${finding.detail}`);
    }
    if (result.exitCode === 2) {
      logger.error(
        `Verify found ${result.findings.length} finding(s) across ${result.tables.length} table(s).`
      );
    } else {
      logger.success(`Verified ${result.tables.length} table(s) with no findings. ✅`);
    }
  }
  return result.exitCode;
}

/**
 * Re-reads the committed machine report and re-surfaces its verdict.
 *
 * `coverage.json` is the source and `MIRROR-REPORT.md` is a rendering of it, so
 * this reads the former and re-renders through the engine's own renderer rather
 * than printing the committed Markdown. That way `mirror report` also proves the
 * two are still one artifact, and its exit code is the LAST SWEEP's R1 verdict —
 * which is what makes it usable as a CI gate long after the sweep job ended.
 */
async function runReport(
  deps: MirrorCommandDeps,
  engine: MirrorEngine,
  args: MirrorCmdArgs
): Promise<number> {
  const fs = engine.nodeWriterFs();
  const target = engine.toNativePath(deps.root, engine.COVERAGE_REL_PATH);
  const bytes = await fs.readFile(target);
  if (bytes === null) {
    throw new MirrorCliError(
      `No ${engine.COVERAGE_REL_PATH} in ${deps.root}: no sweep has written a coverage report yet. ` +
        `Run \`syncrona mirror sync --full\` first.`
    );
  }
  const text = new TextDecoder().decode(bytes);
  let report: CoverageReport;
  try {
    report = JSON.parse(text) as CoverageReport;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new MirrorCliError(
      `${engine.COVERAGE_REL_PATH} in ${deps.root} is not valid JSON (${message}); ` +
        `it is committed output, so this means the file was edited or truncated.`
    );
  }

  deps.write(args.json === true ? text : engine.renderMirrorReport(report));
  return typeof report.exitCode === "number" ? report.exitCode : 0;
}

/**
 * `syncrona mirror <action>` — see the module docblock for the division of
 * labour. Sets `process.exitCode` rather than calling `process.exit()`, so
 * buffered stdout is flushed before the process ends.
 */
export async function mirrorCommand(
  args: MirrorCmdArgs,
  overrides: Partial<MirrorCommandDeps> = {}
): Promise<void> {
  setLogLevel(args);
  const deps: MirrorCommandDeps = { ...defaultDeps(), ...overrides };
  const profile = resolveInstanceProfile(args);
  const action = String(args.action ?? "").trim() as MirrorAction;

  if (!(MIRROR_ACTIONS as readonly string[]).includes(action)) {
    logger.error(
      `Unknown mirror subcommand "${args.action ?? ""}". Expected one of: ${MIRROR_ACTIONS.join(
        " | "
      )}.`
    );
    process.exitCode = 1;
    return;
  }

  try {
    const engine = await deps.loadEngine();
    switch (action) {
      case "init":
        process.exitCode = await runInit(deps, engine, args.json === true);
        return;
      case "sync":
        process.exitCode = await runSync(deps, engine, args, profile);
        return;
      case "status":
        process.exitCode = await runStatus(deps, engine, args, profile);
        return;
      case "verify":
        process.exitCode = await runVerify(deps, engine, args);
        return;
      case "report":
        process.exitCode = await runReport(deps, engine, args);
        return;
    }
  } catch (e) {
    // R1: everything that reaches here is fatal-incomplete. The failure class is
    // surfaced when the engine attached one (F1–F9), because "auth" and
    // "unreachable" call for very different next steps and R3 forbids losing
    // that distinction on the way out.
    const failureClass = failureClassOf(e);
    const message = e instanceof Error ? e.message : String(e);
    logger.error(
      failureClass === null
        ? message || "Mirror command failed with an unknown error."
        : `[${failureClass}] ${message}`
    );
    logErrorHint(e);
    process.exitCode = 1;
  }
}
