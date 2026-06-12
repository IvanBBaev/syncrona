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
  const drainTimeoutMs = Math.max(options.drainTimeoutMs ?? 5000, 1000);
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
        logger(`Syncrona MCP shutdown requested by ${signal}`);
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
