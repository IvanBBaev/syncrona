// SPDX-License-Identifier: GPL-3.0-or-later
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * Decoder for the payload columns of Flow Designer step rows.
 *
 * A trigger, action, logic or subflow instance keeps its configured inputs in a
 * payload column (`values`, `trigger_inputs`, `subflow_inputs`, ...). Depending
 * on the release that column holds plain JSON or base64-encoded gzip of JSON.
 * Detection runs in that order:
 *
 *   1. empty            → `null`
 *   2. plain JSON       → the parsed value
 *   3. base64 + gzip    → gunzip (bounded), then JSON
 *   4. anything else    → `decoded: false` with a reason and the byte count
 *
 * Nothing here throws: an unknown or corrupt payload comes back as
 * `decoded: false`, so one bad step never fails reading a whole flow.
 */

/** Largest inflated payload read (bytes); a bigger one is reported as `unknown`. */
export const FLOW_VALUES_MAX_INFLATED = 4 * 1024 * 1024;

/** How a payload column was stored. */
export type FlowValuesFormat = "empty" | "json" | "base64-gzip-json" | "unknown";

export type FlowValuesDetection =
  | { format: Exclude<FlowValuesFormat, "unknown">; decoded: true; value: unknown; bytes: number }
  | { format: "unknown"; decoded: false; reason: string; bytes: number };

/** Strict base64 (standard alphabet, padded), whitespace already removed. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Base64 of any gzip stream starts with these four characters (magic 1f 8b 08). */
export const GZIP_BASE64_PREFIX = "H4sI";

type JsonParse = { ok: true; value: unknown } | { ok: false };

function parseJson(text: string): JsonParse {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Detect the storage format of a payload column and decode it. */
export function detectFlowValues(raw: unknown): FlowValuesDetection {
  const text = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
  const bytes = Buffer.byteLength(text, "utf8");
  const trimmed = text.replace(/^\ufeff/, "").trim();
  if (!trimmed) return { format: "empty", decoded: true, value: null, bytes };

  // Base64 of gzip always starts "H4sI", which is never valid JSON, so trying
  // JSON first cannot misread a compressed value.
  const json = parseJson(trimmed);
  if (json.ok) return { format: "json", decoded: true, value: json.value, bytes };

  const compact = trimmed.replace(/\s+/g, "");
  if (BASE64.test(compact)) {
    const buf = Buffer.from(compact, "base64");
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      let inflated: string;
      try {
        inflated = gunzipSync(buf, { maxOutputLength: FLOW_VALUES_MAX_INFLATED }).toString("utf8");
      } catch (error) {
        return {
          format: "unknown",
          decoded: false,
          reason: `base64 + gzip payload did not inflate: ${(error as Error).message}`,
          bytes,
        };
      }
      const inner = parseJson(inflated);
      if (inner.ok) return { format: "base64-gzip-json", decoded: true, value: inner.value, bytes };
      return { format: "unknown", decoded: false, reason: "base64 + gzip payload is not JSON", bytes };
    }
  }

  return {
    format: "unknown",
    decoded: false,
    reason: "not JSON and not base64 + gzip JSON",
    bytes,
  };
}

/**
 * Encode a decoded payload back into the given storage format. The gzip bytes
 * need not match what the instance wrote (header fields and compression level
 * differ), but decoding the result yields the same value.
 */
export function encodeFlowValues(value: unknown, format: Exclude<FlowValuesFormat, "unknown">): string {
  if (format === "empty") return "";
  const json = JSON.stringify(value);
  if (format === "json") return json;
  return gzipSync(Buffer.from(json, "utf8")).toString("base64");
}
