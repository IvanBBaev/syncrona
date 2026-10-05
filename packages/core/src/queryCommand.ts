// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncrona/types";
import { logger } from "./Logger.js";
import { setLogLevel } from "./commandHelpers.js";
import { defaultClient, NonApiResponseError, type SNClient } from "./snClient.js";

/**
 * `syncrona query <table>` — a read-only Table API query with the flag set and
 * the `-o json` envelope of `now-sdk query`, so scripts written against the SDK
 * keep working when they switch binaries.
 */

export const QUERY_DEFAULT_LIMIT = 100;
export const QUERY_DEFAULT_TIMEOUT_MS = 30000;
export const QUERY_OUTPUT_FORMATS = ["json", "raw"] as const;
export const QUERY_DISPLAY_VALUES = ["true", "false", "all"] as const;

export type QueryCmdArgs = Sync.SharedCmdArgs & {
  table: string;
  query: string;
  limit?: number;
  offset?: number;
  fields?: string;
  displayValue?: string;
  excludeReferenceLink?: boolean;
  /** yargs maps `--no-count` to `count: false`; `noCount` is accepted as well. */
  count?: boolean;
  noCount?: boolean;
  timeout?: number;
  view?: string;
  queryCategory?: string;
  queryNoDomain?: boolean;
  output?: string;
};

export type QueryRecord = Record<string, unknown>;

/** The `now-sdk query -o json` success envelope. */
export type QuerySuccessEnvelope = {
  ok: true;
  hasMore: boolean;
  nextOffset: number | null;
  records: QueryRecord[];
};

/** The `now-sdk query -o json` failure envelope. */
export type QueryFailureEnvelope = {
  ok: false;
  error: { message: string; status?: number; table: string };
};

export type QueryDeps = {
  getClient: (profile?: string) => Pick<SNClient, "tableAPIGet">;
  /** Where the result goes — stdout in production, a buffer under test. */
  write: (line: string) => void;
};

const defaultDeps: QueryDeps = {
  getClient: (profile) => defaultClient(profile),
  write: (line) => process.stdout.write(`${line}\n`),
};

function requireInteger(name: string, value: number, min: number): number {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`--${name} must be an integer >= ${min} (got ${String(value)}).`);
  }
  return value;
}

/** Translates the parsed flags into the extra sysparm_* params, mirroring now-sdk. */
export function buildQueryParams(args: QueryCmdArgs): Record<string, string> {
  const params: Record<string, string> = {
    sysparm_display_value: args.displayValue ?? "false",
    sysparm_exclude_reference_link: String(args.excludeReferenceLink ?? true),
  };
  if (args.count === false || args.noCount === true) {
    params.sysparm_no_count = "true";
  }
  if (args.view) {
    params.sysparm_view = args.view;
  }
  if (args.queryCategory) {
    params.sysparm_query_category = args.queryCategory;
  }
  if (args.queryNoDomain === true) {
    params.sysparm_query_no_domain = "true";
  }
  return params;
}

/**
 * Fetches one page. `hasMore` comes from asking for `limit + 1` rows rather than
 * from the Link header or X-Total-Count: both depend on the count query that
 * `--no-count` switches off, while the extra row is exact either way.
 */
export async function runQuery(
  client: Pick<SNClient, "tableAPIGet">,
  args: QueryCmdArgs
): Promise<QuerySuccessEnvelope> {
  const table = String(args.table ?? "").trim();
  if (!table) {
    throw new Error("A table name is required, e.g. `syncrona query incident -q active=true`.");
  }
  if (typeof args.query !== "string") {
    throw new Error("--query (-q) is required; pass an encoded query such as `active=true`.");
  }
  const limit = requireInteger("limit", args.limit ?? QUERY_DEFAULT_LIMIT, 1);
  const offset = requireInteger("offset", args.offset ?? 0, 0);
  const timeout = requireInteger("timeout", args.timeout ?? QUERY_DEFAULT_TIMEOUT_MS, 0);

  const resp = await client.tableAPIGet(table, args.query, args.fields ?? "", limit + 1, offset, {
    params: buildQueryParams(args),
    timeout,
  });
  const data: unknown = resp.data;
  if (!data || typeof data !== "object" || !Array.isArray((data as { result?: unknown }).result)) {
    const contentType = resp.headers?.["content-type"];
    const snippet = typeof data === "string" ? data.slice(0, 120).replace(/\s+/g, " ").trim() : "";
    throw new NonApiResponseError(typeof contentType === "string" ? contentType : undefined, snippet);
  }
  const rows = (data as { result: QueryRecord[] }).result;
  const hasMore = rows.length > limit;
  return {
    ok: true,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
    records: hasMore ? rows.slice(0, limit) : rows,
  };
}

function statusOf(e: unknown): number | undefined {
  const status = (e as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === "number" ? status : undefined;
}

// The Table API puts the useful reason ("Invalid table x") in the body, not in
// axios' generic "Request failed with status code 400".
function messageOf(e: unknown): string {
  const base = e instanceof Error ? e.message : String(e);
  const detail = (e as { response?: { data?: { error?: { message?: unknown } } } } | null)?.response
    ?.data?.error?.message;
  return typeof detail === "string" && detail && !base.includes(detail) ? `${base}: ${detail}` : base;
}

export async function queryCommand(
  args: QueryCmdArgs,
  deps: QueryDeps = defaultDeps
): Promise<QuerySuccessEnvelope | QueryFailureEnvelope> {
  setLogLevel(args);
  const machineMode = args.output !== undefined;
  if (machineMode) {
    // stdout carries exactly one JSON document in machine mode; any log line
    // goes to stderr so `syncrona query ... -o json | jq` never sees it.
    logger.routeAllToStderr();
  }

  try {
    const envelope = await runQuery(deps.getClient(args.instanceProfile), args);
    if (machineMode) {
      // `raw` only changes how now-sdk prints a `--select`ed value; without a
      // selection it prints the same compact envelope, and so does this.
      deps.write(JSON.stringify(envelope));
    } else {
      logger.info(`Retrieved ${envelope.records.length} record(s) from table '${args.table}'`);
      if (envelope.hasMore) {
        logger.info(`More records available. Use --offset ${envelope.nextOffset} to fetch the next page`);
      }
      deps.write(JSON.stringify(envelope.records, null, 2));
    }
    return envelope;
  } catch (e) {
    if (!machineMode) {
      throw e;
    }
    const status = statusOf(e);
    const failure: QueryFailureEnvelope = {
      ok: false,
      error: {
        message: messageOf(e),
        ...(status !== undefined ? { status } : {}),
        table: args.table,
      },
    };
    deps.write(JSON.stringify(failure));
    process.exitCode = 1;
    return failure;
  }
}
