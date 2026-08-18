// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A minimal HTTP client for talking to {@link FakeInstanceServer} from a test.
 *
 * Built on `node:http` rather than on global `fetch` for two reasons, both of
 * which cost a debugging session before they were written down:
 *
 *   - `agent: false` disables connection pooling. undici's global dispatcher
 *     keeps sockets alive for seconds after the last response, and a keep-alive
 *     socket to a server the test has already closed is exactly the open handle
 *     that makes Jest print "did not exit one second after the test run" and
 *     blames the whole package.
 *   - It hands back the raw status line, the raw header bag and a `Buffer`. The
 *     attachment test needs the bytes unmangled, and the 429 tests need to prove
 *     `retry-after` is ABSENT — a fetch `Headers` object answers `null` for both
 *     "absent" and "present but empty", which is the distinction D6 turns on.
 */
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";

export interface FakeResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** The body decoded as UTF-8. */
  text: string;
}

export interface FakeRequestOptions {
  method?: string;
  /** Basic-auth pair. Omitted → no `Authorization` header at all. */
  auth?: { username: string; password: string };
  bearer?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Issue one request and read the whole response into memory. */
export function fetchRaw(url: string, options: FakeRequestOptions = {}): Promise<FakeResponse> {
  const target = new URL(url);
  const headers: Record<string, string> = { ...options.headers };
  if (options.auth) {
    const encoded = Buffer.from(`${options.auth.username}:${options.auth.password}`, "utf8").toString("base64");
    headers.Authorization = `Basic ${encoded}`;
  }
  if (options.bearer !== undefined) headers.Authorization = `Bearer ${options.bearer}`;

  return new Promise<FakeResponse>((resolve, reject) => {
    const call = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method ?? "GET",
        headers,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body,
            text: body.toString("utf8"),
          });
        });
        response.on("error", reject);
      }
    );
    call.on("error", reject);
    if (options.body !== undefined) call.write(options.body);
    call.end();
  });
}

/** Issue a request and parse the body as JSON. Throws if it is not JSON. */
export async function fetchJson<T = unknown>(
  url: string,
  options: FakeRequestOptions = {}
): Promise<{ status: number; headers: IncomingHttpHeaders; json: T }> {
  const response = await fetchRaw(url, options);
  let json: T;
  try {
    json = JSON.parse(response.text) as T;
  } catch {
    throw new Error(`expected JSON from ${url}, got ${response.status}: ${response.text.slice(0, 200)}`);
  }
  return { status: response.status, headers: response.headers, json };
}

/** The `{ result: … }` envelope every successful Table API response carries. */
export interface TableApiResult<T> {
  result: T;
}

/** Build a Table API URL with the parameters the mirror actually sends (§5.5). */
export function tableUrl(
  baseUrl: string,
  table: string,
  parameters: Record<string, string | number | undefined>
): string {
  const url = new URL(`/api/now/table/${table}`, baseUrl);
  for (const [key, value] of Object.entries(parameters)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}
