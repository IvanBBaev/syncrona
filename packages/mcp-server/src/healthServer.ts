import { createServer } from "http";
import type { AddressInfo } from "net";

export type HealthEndpointConfig = {
  enabled: boolean;
  port: number;
  host: string;
  path: string;
};

export type HealthEndpointServer = {
  close: () => Promise<void>;
  url: string;
  host: string;
  port: number;
  path: string;
};

let HEALTH_HTTP_STATUS: Record<string, unknown> = {
  enabled: false,
};

export function parseHealthHttpConfig(env: NodeJS.ProcessEnv = process.env): HealthEndpointConfig {
  const rawPort = typeof env.SYNCRONA_HEALTH_HTTP_PORT === "string"
    ? env.SYNCRONA_HEALTH_HTTP_PORT.trim()
    : "";
  if (!rawPort) {
    return {
      enabled: false,
      port: 0,
      host: "127.0.0.1",
      path: "/healthz",
    };
  }

  const parsedPort = Number.parseInt(rawPort, 10);
  if (!Number.isFinite(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    return {
      enabled: false,
      port: 0,
      host: "127.0.0.1",
      path: "/healthz",
    };
  }

  const rawHost = typeof env.SYNCRONA_HEALTH_HTTP_HOST === "string"
    ? env.SYNCRONA_HEALTH_HTTP_HOST.trim()
    : "";
  const host = rawHost || "127.0.0.1";

  const rawPath = typeof env.SYNCRONA_HEALTH_HTTP_PATH === "string"
    ? env.SYNCRONA_HEALTH_HTTP_PATH.trim()
    : "";
  const normalizedPath = rawPath ? `/${rawPath.replace(/^\/+/, "")}` : "/healthz";

  return {
    enabled: true,
    port: parsedPort,
    host,
    path: normalizedPath,
  };
}

function formatHostForUrl(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]`;
  }
  return host;
}

export function getHealthEndpointStatus(): Record<string, unknown> {
  return { ...HEALTH_HTTP_STATUS };
}

export async function startHealthHttpServer(
  config: HealthEndpointConfig,
  getSnapshot: () => Record<string, unknown>,
  logger: (message: string) => void = (message) => console.error(message)
): Promise<HealthEndpointServer | null> {
  if (!config.enabled) {
    HEALTH_HTTP_STATUS = { enabled: false };
    return null;
  }

  const httpServer = createServer((req, res) => {
    const method = String(req.method || "GET").toUpperCase();
    const requestPath = String(req.url || "").split("?")[0] || "/";
    if (method !== "GET" || requestPath !== config.path) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ status: "not_found", path: requestPath }));
      return;
    }

    const payload = getSnapshot();
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address() as AddressInfo | null;
  const resolvedHost = address?.address || config.host;
  const resolvedPort = typeof address?.port === "number" ? address.port : config.port;
  const url = `http://${formatHostForUrl(resolvedHost)}:${resolvedPort}${config.path}`;
  HEALTH_HTTP_STATUS = {
    enabled: true,
    host: resolvedHost,
    port: resolvedPort,
    path: config.path,
    url,
  };
  logger(`Health HTTP endpoint enabled at ${url}`);

  return {
    host: resolvedHost,
    port: resolvedPort,
    path: config.path,
    url,
    close: async () => {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      HEALTH_HTTP_STATUS = {
        enabled: false,
      };
    },
  };
}
