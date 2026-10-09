// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `sync_fluent_build` — the MCP face of `syncrona fluent build` (SDK-F6): build
 * a ServiceNow Fluent project through the optional `@syncrona/fluent` tier,
 * which drives the ServiceNow SDK (`@servicenow/sdk`) build orchestrator.
 *
 * The mcp-server may not import core (depcruise `consumers-are-siblings`), so
 * this mirrors the build path of `packages/core/src/fluentCommand.ts` rather than
 * calling it. The two must agree on:
 *
 * - how the adapter is found — resolved lazily at call time, from the project
 *   first and then from the server's own install, never as a static import or a
 *   package.json dependency (the CLI declares none either). Without the adapter
 *   or the SDK the call returns the CLI's install hint, not a crash;
 * - what a project is — a directory holding `now.config.json`;
 * - the build options — `frozenKeys`, `errorOnConflict` and `skipClean`, passed
 *   to `engine.build()` only when set;
 * - the outcome — the CLI's exit codes, surfaced as `exitCode` next to a named
 *   `outcome`: 0 `succeeded`, 2 `failed` (the build ran and reported errors),
 *   1 `incomplete` (it could not be run to completion: adapter or SDK missing, a
 *   thrown failure, or the timeout). Anything but `succeeded` is an MCP error
 *   result.
 *
 * Unlike the CLI, the project path is confined to the server's workspace (no
 * walk up past it, no symlink out of it), and the call is bounded by the tool's
 * `timeoutMs`. The build runs in-process and cannot be cancelled, so a build
 * that outlives the budget is reported `incomplete` and may still finish
 * writing its output afterwards.
 *
 * The budget is a timer on the server's event loop, so it only fires while the
 * build yields to it. Stretches of synchronous work inside the build (the SDK
 * compiles the project's TypeScript on the calling thread) block the loop: the
 * timeout cannot fire during them, and the whole server stalls with it. When
 * such a build finishes past the budget, its real result is returned — it is
 * not relabelled a timeout — and `budgetExceeded: true` says the budget did not
 * hold.
 *
 * The result is bounded too: errors, warnings, SDK log lines and output paths
 * are each capped (with the full counts and a `…Truncated` flag), and every
 * line is clipped. Listing the output is best-effort: an unreadable directory or
 * a symlink under `dist/` is reported in `outputWarnings` instead of failing a
 * build that already finished, and no symlink is followed, so the listing never
 * leaves the project's output directory.
 *
 * A build never reaches the instance, but it is still a mutating tool: it
 * overwrites the project's output directory, and it executes code from the
 * workspace — the project's installed adapter and SDK, and any build-time code
 * the project's source pulls in — inside the server process, with the server's
 * full environment (including any instance credentials it holds). So it goes
 * through the same policy and mutating-audit gates as any other write, and it
 * honours `dryRun`: a dry run returns the plan without loading the adapter. As a
 * local write it is exempt from the blanket instance preflight
 * (`enforcePreflightForMutations`; see `isLocalMutatingTool`), which reads the
 * instance session and says nothing about a local build.
 *
 * Trust boundary: an adapter resolved from the project must really live inside
 * the workspace — its real path, after following symlinks, must not leave it —
 * or it is not loaded from there: the server's own install is used when it has
 * the adapter (a monorepo hoists it above a package directory), and otherwise
 * the call is refused. The server's own install is its `node_modules` ancestry
 * only: an adapter Node finds through `NODE_PATH` or a global folder is refused
 * as well. That keeps a symlinked `node_modules` from pulling in
 * code from elsewhere on disk; it does not sandbox the code that is inside the
 * workspace. There is no process isolation: building a project means trusting it
 * as much as running `npm run build` in it with the server's environment.
 */
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "fs";
import { createRequire } from "module";
import path from "path";

import type { ToolResponse } from "../toolResponse";
import type { InsightToolContext } from "./insightShared";
import { errorResponse, textResponse } from "./insightShared";

const TOOL_NAME = "sync_fluent_build";

/** The package the tool loads, and the SDK it drives; both named in the install hint. */
export const FLUENT_PACKAGE = "@syncrona/fluent";
export const FLUENT_SDK_PACKAGE = "@servicenow/sdk";
export const FLUENT_INSTALL_HINT = `Install ${FLUENT_PACKAGE} and ${FLUENT_SDK_PACKAGE} in the project to use sync_fluent_build (npm install --save-dev ${FLUENT_PACKAGE} ${FLUENT_SDK_PACKAGE}).`;

export const NOW_CONFIG = "now.config.json";
/** Where the ServiceNow SDK writes a project's build output, relative to the project. */
export const FLUENT_OUTPUT_DIR = "dist";
/** Cap on the output paths listed in a result, so a large build cannot flood the client. */
export const MAX_LISTED_OUTPUTS = 200;
/** Cap on the SDK log lines kept for the result. */
const MAX_LOG_LINES = 200;
/** Cap on the build errors, and separately the warnings, returned in a result. */
export const MAX_LISTED_DIAGNOSTICS = 200;
/** Cap on the characters kept from any one diagnostic or log line. */
export const MAX_LINE_CHARS = 2000;
/** Cap on the notes about skipped output entries. */
const MAX_OUTPUT_WARNINGS = 20;

/** Outcome names and the CLI exit code each one stands for. */
export const FLUENT_BUILD_OUTCOMES = {
  succeeded: 0,
  incomplete: 1,
  failed: 2,
} as const;
export type FluentBuildOutcome = keyof typeof FLUENT_BUILD_OUTCOMES;

// Local structural view of the `SN.FluentModule` port in @syncrona/types: the
// server does not depend on that package, and needs only the build slice of it.
export type FluentBuildOptions = {
  frozenKeys?: boolean;
  errorOnConflict?: boolean;
  skipClean?: boolean;
};
export type FluentBuildResult = { success: boolean; errors: string[]; warnings: string[] };
export type FluentLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  debug: (message: string) => void;
};
export type FluentBuildModule = {
  createFluentEngine: (options: { projectDir: string; logger: FluentLogger }) => {
    build: (options: FluentBuildOptions) => Promise<FluentBuildResult>;
  };
};
/** Resolves `@syncrona/fluent` for a project; throws {@link FluentNotInstalledError} when absent. */
export type FluentModuleLoader = (projectDir: string) => FluentBuildModule | Promise<FluentBuildModule>;

export type FluentBuildContext = InsightToolContext & {
  /** The directory the project path is confined to (the server's PROJECT_DIR). */
  workspaceDir: string;
  /** Injected in tests; defaults to {@link loadFluentModule}. */
  loadFluent?: FluentModuleLoader;
};

/** Raised when the adapter is absent; mapped to the install hint. */
export class FluentNotInstalledError extends Error {
  readonly code = "FLUENT_NOT_INSTALLED";
  constructor() {
    super(FLUENT_INSTALL_HINT);
    this.name = "FluentNotInstalledError";
  }
}

/** Raised for a project path the tool refuses; reported as an argument error. */
export class FluentProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FluentProjectError";
  }
}

/** Raised when the adapter resolved from the project lives outside the workspace. */
export class FluentAdapterOutsideWorkspaceError extends Error {
  readonly code = "FLUENT_ADAPTER_OUTSIDE_WORKSPACE";
  constructor(message: string) {
    super(message);
    this.name = "FluentAdapterOutsideWorkspaceError";
  }
}

class FluentBuildTimeout extends Error {
  constructor(timeoutMs: number) {
    super(
      `Fluent build did not finish within ${timeoutMs} ms. The build cannot be cancelled and may still write its output; re-run with a larger timeoutMs.`
    );
    this.name = "FluentBuildTimeout";
  }
}

/**
 * Whether `e` says `specifier` itself cannot be found — core's check. A
 * module-not-found error for one of the adapter's own dependencies, or for a
 * file the project's source imports, names that module instead (the adapter
 * appears only in the unquoted require stack), and must surface as itself
 * rather than as "not installed".
 */
function isModuleNotFound(e: unknown, specifier: string): boolean {
  const err = e as { code?: unknown; message?: unknown } | null;
  const code = err?.code;
  if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") return false;
  return typeof err?.message === "string" && err.message.includes(`'${specifier}'`);
}

/** The adapter's own error for a missing SDK (`FluentSdkMissingError`), thrown on first engine use. */
function isSdkMissing(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === "FLUENT_SDK_MISSING";
}

/**
 * Resolves the Fluent adapter from the project first, then from the server's own
 * install — core's `loadFluentModule` order. `specifier` is a parameter only so
 * tests can point it at a fixture package.
 *
 * An adapter found from the project is loaded only when its real path is inside
 * `workspaceDir` (default: the project itself), so a symlink cannot make the
 * server execute code from outside the workspace. The server's own install is
 * trusted as it is the server's code — and only that install (see below).
 *
 * A project adapter outside the workspace is not refused on the spot: when the
 * server starts in a monorepo package directory, the adapter is hoisted above it
 * and the server's own requirer finds the same package. So the server requirer
 * is still tried, and only when it finds nothing is the escape refused. The
 * escaping path is never loaded through the project requirer.
 *
 * "The server's own install" means the `node_modules` ancestry of the server's
 * package: what the server requirer resolves is loaded only when its real path
 * is inside a package directory that ancestry holds. Node's requirer also
 * searches `NODE_PATH` and the global folders (`~/.node_modules`,
 * `~/.node_libraries`, `<prefix>/lib/node`); an adapter found only there is not
 * the server's code, and is refused like any other escape.
 */
export function loadFluentModule(
  projectDir: string,
  specifier: string = FLUENT_PACKAGE,
  workspaceDir: string = projectDir
): FluentBuildModule {
  const projectRequire = createRequire(path.join(projectDir, "package.json"));
  const fromProject = tryResolve(projectRequire, specifier);
  let refusal: FluentAdapterOutsideWorkspaceError | undefined;
  if (fromProject !== undefined) {
    refusal = adapterOutsideWorkspace(workspaceDir, specifier, fromProject);
    if (!refusal) return loadResolved(projectRequire, fromProject);
  }
  const serverRequire = createRequire(__filename);
  let fromServer: string | undefined;
  try {
    fromServer = tryResolve(serverRequire, specifier);
  } catch (e) {
    // A pending refusal wins over a resolution error of the fallback.
    throw refusal ?? e;
  }
  if (fromServer !== undefined) {
    if (isServerInstall(specifier, fromServer)) return loadResolved(serverRequire, fromServer);
    throw refusal ?? notServerInstall(specifier, fromServer);
  }
  throw refusal ?? new FluentNotInstalledError();
}

/**
 * The package directories `specifier` can occupy in the server's own install:
 * `<dir>/node_modules/<specifier>` for every ancestor of this file — the lookup
 * Node's requirer makes before it falls back to `NODE_PATH` and the global folders.
 */
function serverInstallCandidates(specifier: string): string[] {
  const candidates: string[] = [];
  let dir = path.dirname(__filename);
  for (;;) {
    if (path.basename(dir) !== "node_modules") {
      candidates.push(path.join(dir, "node_modules", ...specifier.split("/")));
    }
    const parent = path.dirname(dir);
    if (parent === dir) return candidates;
    dir = parent;
  }
}

/**
 * Whether `resolved` (what the server requirer found) is inside a package
 * directory of the server's own `node_modules` ancestry. Compared by real path,
 * so a workspace-linked package (npm workspaces link `node_modules/<name>` to the
 * package's source directory) still counts as installed.
 */
function isServerInstall(specifier: string, resolved: string): boolean {
  // A builtin or other non-path resolution has no file to confine.
  if (!path.isAbsolute(resolved)) return true;
  const real = canonicalRealpath(resolved);
  return serverInstallCandidates(specifier).some(
    (candidate) => existsSync(candidate) && isWithin(canonicalRealpath(candidate), real)
  );
}

function notServerInstall(specifier: string, resolved: string): FluentAdapterOutsideWorkspaceError {
  return new FluentAdapterOutsideWorkspaceError(
    `Refusing to load ${specifier} from ${JSON.stringify(canonicalRealpath(resolved))}: it is neither in the workspace nor in the server's own install (Node found it through NODE_PATH or a global folder). Install it in the project.`
  );
}

/** `requireFrom.resolve(specifier)`, or undefined when the package itself is absent. */
function tryResolve(requireFrom: NodeJS.Require, specifier: string): string | undefined {
  try {
    return requireFrom.resolve(specifier);
  } catch (e) {
    if (isModuleNotFound(e, specifier)) return undefined;
    throw e;
  }
}

function loadResolved(requireFrom: NodeJS.Require, resolved: string): FluentBuildModule {
  const mod = requireFrom(resolved) as Partial<FluentBuildModule> & { default?: FluentBuildModule };
  return typeof mod.createFluentEngine === "function" ? (mod as FluentBuildModule) : (mod.default as FluentBuildModule);
}

function isWithin(base: string, target: string): boolean {
  return target === base || target.startsWith(base + path.sep);
}

/**
 * The canonical real path of `p`. The native realpath also canonicalizes letter
 * case on a case-insensitive filesystem (the macOS and Windows defaults), where
 * the JavaScript one keeps the case it was given, so two spellings of one
 * directory compare equal in {@link isWithin}.
 */
export function canonicalRealpath(p: string): string {
  return realpathSync.native(path.resolve(p));
}

/**
 * The refusal for an adapter resolved from the project whose real path leaves
 * the workspace — a symlinked package, a `node_modules` that is itself a link,
 * or a package hoisted above the workspace — or undefined when it stays inside.
 * Node resolves symlinks by default, so `resolved` is normally real already; the
 * check re-reads it so the refusal does not depend on `--preserve-symlinks`.
 */
function adapterOutsideWorkspace(
  workspaceDir: string,
  specifier: string,
  resolved: string
): FluentAdapterOutsideWorkspaceError | undefined {
  // A builtin or other non-path resolution has no file to confine.
  if (!path.isAbsolute(resolved)) return undefined;
  const real = canonicalRealpath(resolved);
  if (isWithin(canonicalRealpath(workspaceDir), real)) return undefined;
  return new FluentAdapterOutsideWorkspaceError(
    `Refusing to load ${specifier} from outside the workspace: it resolves to ${JSON.stringify(real)}. Install it in the project rather than linking it in; if it is hoisted above the workspace, start the server from the workspace root or pass project: relative to that root.`
  );
}

/**
 * Resolves `project` (relative to the workspace; default the workspace itself)
 * to a Fluent project directory inside the workspace. Both the lexical path and
 * its real path must stay inside, so a symlink cannot lead the build out.
 */
export function resolveFluentProjectDir(workspaceDir: string, project: unknown): string {
  if (project !== undefined && typeof project !== "string") {
    throw new FluentProjectError("project must be a path relative to the workspace.");
  }
  const raw = typeof project === "string" ? project.trim() : "";
  const base = path.resolve(workspaceDir);
  const target = path.resolve(base, raw || ".");
  if (!isWithin(base, target)) {
    throw new FluentProjectError(`Refusing to build outside the workspace: ${JSON.stringify(raw)}.`);
  }
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new FluentProjectError(`Project directory not found: ${JSON.stringify(raw || ".")}.`);
  }
  if (!isWithin(canonicalRealpath(base), canonicalRealpath(target))) {
    throw new FluentProjectError(
      `Refusing to build outside the workspace: ${JSON.stringify(raw)} resolves through a symlink.`
    );
  }
  if (!existsSync(path.join(target, NOW_CONFIG))) {
    throw new FluentProjectError(
      `No ${NOW_CONFIG} in ${JSON.stringify(raw || ".")}; it is not a Fluent project.`
    );
  }
  return target;
}

/** Maps tool arguments to `engine.build()` options, set flags only — the CLI's plan. */
export function fluentBuildOptions(args: Record<string, unknown>): FluentBuildOptions {
  return {
    ...(args.frozenKeys === true ? { frozenKeys: true } : {}),
    ...(args.errorOnConflict === true ? { errorOnConflict: true } : {}),
    ...(args.skipClean === true ? { skipClean: true } : {}),
  };
}

export type OutputListing = {
  files: string[];
  truncated: boolean;
  /** Entries left out (symlinks, unreadable directories), at most {@link MAX_OUTPUT_WARNINGS}. */
  warnings: string[];
};

/**
 * Lists files under `dir`, relative to it and sorted, up to `limit` entries.
 *
 * Best-effort and confined: no symlink is followed or listed (each is noted in
 * `warnings`), `dir` itself must not be a symlink, and a directory that cannot
 * be read is noted and skipped rather than thrown — the listing runs after a
 * build has finished, and must not turn its result into an internal error.
 */
export function listOutputFiles(dir: string, limit: number = MAX_LISTED_OUTPUTS): OutputListing {
  const files: string[] = [];
  const warnings: string[] = [];
  let truncated = false;
  const relative = (full: string): string => path.relative(dir, full).split(path.sep).join("/") || ".";
  const note = (message: string): void => {
    if (warnings.length < MAX_OUTPUT_WARNINGS) warnings.push(message);
  };
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (e) {
      note(`Skipped unreadable directory ${JSON.stringify(relative(current))}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      const full = path.join(current, entry.name);
      // Dirent types come from lstat: a symlink is neither a file nor a directory here.
      if (entry.isSymbolicLink()) {
        note(`Skipped symlink ${JSON.stringify(relative(full))}; output symlinks are not followed.`);
      } else if (entry.isDirectory()) {
        walk(full);
      } else if (files.length >= limit) {
        truncated = true;
      } else {
        files.push(relative(full));
      }
    }
  };
  let top;
  try {
    top = lstatSync(dir);
  } catch {
    return { files, truncated, warnings }; // no output directory yet
  }
  if (top.isSymbolicLink()) {
    note(`Skipped the output directory: ${JSON.stringify(path.basename(dir))} is a symlink, which is not followed.`);
  } else if (top.isDirectory()) {
    walk(dir);
  }
  return { files, truncated, warnings };
}

/** The first `limit` items of `items`, each clipped to {@link MAX_LINE_CHARS}. */
function capList(items: string[], limit: number): { items: string[]; truncated: boolean } {
  return { items: items.slice(0, limit).map(clipLine), truncated: items.length > limit };
}

function clipLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [${line.length - MAX_LINE_CHARS} more chars]` : line;
}

function toPosixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/") || ".";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

/**
 * The stdio transport owns stdout: a stray `console.log` from the SDK during an
 * in-process build would corrupt the MCP stream. While any build is running,
 * the stdout-bound console methods are routed to stderr. Counted, because two
 * builds can overlap and the first to finish must not restore early.
 */
let consoleGuardDepth = 0;
let savedConsole: Pick<Console, "log" | "info" | "debug"> | null = null;

function acquireConsoleGuard(): () => void {
  if (consoleGuardDepth === 0) {
    savedConsole = { log: console.log, info: console.info, debug: console.debug };
    const toStderr = (...parts: unknown[]): void => console.error(...parts);
    console.log = toStderr;
    console.info = toStderr;
    console.debug = toStderr;
  }
  consoleGuardDepth += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    consoleGuardDepth -= 1;
    if (consoleGuardDepth === 0 && savedConsole) {
      console.log = savedConsole.log;
      console.info = savedConsole.info;
      console.debug = savedConsole.debug;
      savedConsole = null;
    }
  };
}

/** Runs `build` under the console guard, rejecting with a timeout after `timeoutMs`. */
async function runBounded(build: () => Promise<FluentBuildResult>, timeoutMs: number): Promise<FluentBuildResult> {
  const release = acquireConsoleGuard();
  let running: Promise<FluentBuildResult>;
  try {
    running = Promise.resolve(build());
  } catch (e) {
    release();
    throw e;
  }
  // The guard is released when the build itself settles, not when the race does:
  // a timed-out build keeps running and may still log.
  running.then(release, release);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FluentBuildTimeout(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([running, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function handleFluentBuild(
  args: Record<string, unknown>,
  context: FluentBuildContext
): Promise<ToolResponse> {
  let projectDir: string;
  try {
    projectDir = resolveFluentProjectDir(context.workspaceDir, args.project);
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : String(e));
  }
  const options = fluentBuildOptions(args);
  const project = toPosixRelative(path.resolve(context.workspaceDir), projectDir);
  const outputDir = path.join(projectDir, FLUENT_OUTPUT_DIR);
  const outputDirRelative = toPosixRelative(path.resolve(context.workspaceDir), outputDir);

  if (context.dryRun) {
    return context.makeDryRunAuditResponse(TOOL_NAME, args, {
      project,
      method: "build",
      options,
      outputDir: outputDirRelative,
    });
  }

  const log: string[] = [];
  let logTruncated = false;
  const record = (level: string) => (message: string) => {
    if (log.length < MAX_LOG_LINES) log.push(clipLine(`[${level}] ${message}`));
    else logTruncated = true;
  };
  const logger: FluentLogger = { info: record("info"), warn: record("warn"), debug: record("debug") };

  let outcome: FluentBuildOutcome = "incomplete";
  let result: FluentBuildResult | undefined;
  let message: string | undefined;
  let code: string | undefined;
  let budgetExceeded = false;

  // Loading the adapter and creating the engine run SDK code as well (module
  // top-level, engine constructor), so the guard covers them too, not only the
  // build. runBounded takes its own counted hold, which outlives this one when a
  // timed-out build keeps running.
  const releaseConsoleGuard = acquireConsoleGuard();
  try {
    const load: FluentModuleLoader =
      context.loadFluent ?? ((dir) => loadFluentModule(dir, FLUENT_PACKAGE, context.workspaceDir));
    const fluent = await load(projectDir);
    if (!fluent || typeof fluent.createFluentEngine !== "function") {
      throw new Error(`${FLUENT_PACKAGE} does not export createFluentEngine; reinstall it.`);
    }
    const engine = fluent.createFluentEngine({ projectDir, logger });
    const buildStartedAt = Date.now();
    const raw = await runBounded(() => engine.build(options), context.timeoutMs);
    // A build that blocked the event loop can finish past a timer that never got to fire.
    budgetExceeded = Date.now() - buildStartedAt > context.timeoutMs;
    result = { success: raw?.success === true, errors: stringList(raw?.errors), warnings: stringList(raw?.warnings) };
    outcome = result.success ? "succeeded" : "failed";
  } catch (e) {
    outcome = "incomplete";
    // Only the adapter itself missing is "not installed"; a missing dependency of
    // an installed adapter, or a missing file the project imports, keeps its message.
    if (e instanceof FluentNotInstalledError || isModuleNotFound(e, FLUENT_PACKAGE)) {
      code = "FLUENT_NOT_INSTALLED";
      message = FLUENT_INSTALL_HINT;
    } else if (isSdkMissing(e)) {
      code = "FLUENT_SDK_MISSING";
      message = FLUENT_INSTALL_HINT;
    } else {
      code =
        e instanceof FluentBuildTimeout
          ? "FLUENT_BUILD_TIMEOUT"
          : e instanceof FluentAdapterOutsideWorkspaceError
            ? e.code
            : undefined;
      message = clipLine(e instanceof Error ? e.message : String(e));
    }
  } finally {
    releaseConsoleGuard();
  }

  const exitCode = FLUENT_BUILD_OUTCOMES[outcome];
  const outputs = result ? listOutputFiles(outputDir) : undefined;
  const errors = capList(result?.errors ?? [], MAX_LISTED_DIAGNOSTICS);
  const warnings = capList(result?.warnings ?? [], MAX_LISTED_DIAGNOSTICS);

  // Every real run is recorded, whatever its outcome: once the adapter has been
  // looked up, project code may have run and the output directory may have changed.
  context.auditMutatingTool(
    TOOL_NAME,
    args,
    {
      outcome,
      exitCode,
      project,
      options,
      errorCount: result?.errors.length ?? 0,
      warningCount: result?.warnings.length ?? 0,
      ...(budgetExceeded ? { budgetExceeded: true } : {}),
      ...(code ? { code } : {}),
    },
    Date.now() - context.startedAt
  );

  return textResponse(
    {
      outcome,
      exitCode,
      project,
      options,
      errors: errors.items,
      warnings: warnings.items,
      errorCount: result?.errors.length ?? 0,
      warningCount: result?.warnings.length ?? 0,
      ...(errors.truncated ? { errorsTruncated: true } : {}),
      ...(warnings.truncated ? { warningsTruncated: true } : {}),
      ...(outputs
        ? {
            outputDir: outputDirRelative,
            outputs: outputs.files,
            ...(outputs.truncated ? { outputsTruncated: true } : {}),
            ...(outputs.warnings.length > 0 ? { outputWarnings: outputs.warnings } : {}),
          }
        : {}),
      ...(budgetExceeded ? { budgetExceeded: true } : {}),
      ...(code ? { code } : {}),
      ...(code === "FLUENT_NOT_INSTALLED" || code === "FLUENT_SDK_MISSING" ? { installHint: FLUENT_INSTALL_HINT } : {}),
      ...(message && !(code === "FLUENT_NOT_INSTALLED" || code === "FLUENT_SDK_MISSING") ? { message } : {}),
      ...(log.length > 0 ? { log } : {}),
      ...(logTruncated ? { logTruncated: true } : {}),
      durationMs: Date.now() - context.startedAt,
    },
    outcome !== "succeeded"
  );
}

/** The `fluent` tool family's entry point in the handler registry. */
export async function handleFluentTool(
  toolName: string,
  args: Record<string, unknown>,
  context: FluentBuildContext
): Promise<ToolResponse | null> {
  switch (toolName) {
    case "sync_fluent_build":
      return handleFluentBuild(args, context);
    default:
      return null;
  }
}
