// SPDX-License-Identifier: GPL-3.0-or-later
import { writeAuditEvent } from "./audit";
import { AUDIT_DIR, AUDIT_FILE } from "./runtimeConfig";

export type CloseableResource = {
  close?: () => void | Promise<void>;
};

export type GracefulShutdownOptions = {
  serverResource?: CloseableResource;
  drainTimeoutMs?: number;
  pollIntervalMs?: number;
  auditDir?: string;
  auditFile?: string;
  waitFn?: (ms: number) => Promise<void>;
  exitFn?: (code: number) => void;
  logger?: (message: string) => void;
  exitProcess?: boolean;
};

export type GracefulShutdownController = {
  beginRequest: () => boolean;
  endRequest: () => void;
  isShuttingDown: () => boolean;
  setTransportResource: (resource: CloseableResource | undefined) => void;
  shutdown: (signal: string) => Promise<void>;
};

// CONC-7 (REV-111): a 5s drain was long enough to abandon an in-flight mutating
// tool call (or the scope bootstrap) mid-write on SIGTERM. Raise the default and
// make it operator-configurable via SYNCRONA_SHUTDOWN_DRAIN_MS.
export const DEFAULT_DRAIN_TIMEOUT_MS = 30000;
export const MIN_DRAIN_TIMEOUT_MS = 1000;
export const MAX_DRAIN_TIMEOUT_MS = 600000;
export const DRAIN_TIMEOUT_ENV_VAR = "SYNCRONA_SHUTDOWN_DRAIN_MS";

/**
 * Resolve the effective drain timeout (ms), clamped to [1s, 10min].
 * Precedence: explicit option value > SYNCRONA_SHUTDOWN_DRAIN_MS > default (30s).
 * An explicit programmatic option always wins so callers (and tests) stay
 * deterministic; the env var only governs the omitted-option path (production).
 */
export function resolveDrainTimeoutMs(
  optionValue?: number,
  env: NodeJS.ProcessEnv = process.env
): number {
  let candidate = DEFAULT_DRAIN_TIMEOUT_MS;

  const rawEnv = env[DRAIN_TIMEOUT_ENV_VAR];
  if (typeof rawEnv === "string" && rawEnv.trim().length > 0) {
    const parsed = Number(rawEnv.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      candidate = parsed;
    }
  }

  if (typeof optionValue === "number" && Number.isFinite(optionValue) && optionValue > 0) {
    candidate = optionValue;
  }

  return Math.min(Math.max(candidate, MIN_DRAIN_TIMEOUT_MS), MAX_DRAIN_TIMEOUT_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function closeResource(resource: CloseableResource | undefined): Promise<void> {
  if (!resource || typeof resource.close !== "function") {
    return;
  }

  try {
    await Promise.resolve(resource.close());
  } catch (_) {
    // Best-effort close to avoid masking shutdown path.
  }
}

export function createGracefulShutdownController(
  options: GracefulShutdownOptions = {}
): GracefulShutdownController {
  const drainTimeoutMs = resolveDrainTimeoutMs(options.drainTimeoutMs);
  const pollIntervalMs = Math.max(options.pollIntervalMs ?? 50, 10);
  const waitFn = options.waitFn ?? sleep;
  const exitFn = options.exitFn ?? process.exit;
  const logger = options.logger ?? ((message: string) => console.error(message));
  const exitProcess = options.exitProcess !== false;
  const serverResource = options.serverResource;
  const auditDir = options.auditDir ?? AUDIT_DIR;
  const auditFile = options.auditFile ?? AUDIT_FILE;

  let transportResource: CloseableResource | undefined;
  let activeRequests = 0;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;

  return {
    beginRequest: () => {
      if (shuttingDown) {
        return false;
      }
      activeRequests += 1;
      return true;
    },
    endRequest: () => {
      activeRequests = Math.max(activeRequests - 1, 0);
    },
    isShuttingDown: () => shuttingDown,
    setTransportResource: (resource: CloseableResource | undefined) => {
      transportResource = resource;
    },
    shutdown: async (signal: string) => {
      if (shutdownPromise) {
        return shutdownPromise;
      }

      shuttingDown = true;
      shutdownPromise = (async () => {
        const startedAt = Date.now();
        logger(`SyncroNow AI MCP shutdown requested by ${signal}`);
        writeAuditEvent(auditDir, auditFile, {
          timestamp: new Date().toISOString(),
          event: "shutdown.requested",
          signal,
          pendingRequests: activeRequests,
        });

        while (activeRequests > 0 && Date.now() - startedAt < drainTimeoutMs) {
          await waitFn(pollIntervalMs);
        }

        const waitedMs = Date.now() - startedAt;
        const drained = activeRequests === 0;
        writeAuditEvent(auditDir, auditFile, {
          timestamp: new Date().toISOString(),
          event: "shutdown.drained",
          signal,
          drained,
          pendingRequests: activeRequests,
          waitedMs,
        });

        await closeResource(transportResource);
        await closeResource(serverResource);

        writeAuditEvent(auditDir, auditFile, {
          timestamp: new Date().toISOString(),
          event: "shutdown.completed",
          signal,
          drained,
          waitedMs,
        });

        if (exitProcess) {
          exitFn(0);
        }
      })();

      return shutdownPromise;
    },
  };
}
