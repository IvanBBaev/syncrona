// SPDX-License-Identifier: GPL-3.0-or-later
//
// WP3: a JSON column stored as a `.json` field file.
//
// The instance keeps most JSON columns minified on one line — a UI Builder
// composition is routinely 70 KB of it — which no reviewer and no model can
// diff. The file is therefore pretty-printed, but only when that is reversible:
//
//  - download pretty-prints a value only when it is exactly the canonical
//    minified form (`JSON.stringify(JSON.parse(raw)) === raw`); anything else —
//    a value someone stored indented, one with escaped unicode, a number past
//    double precision — is written byte for byte;
//  - push minifies a file only when it is exactly the pretty form of what it
//    parses to, and sends every other file as it is.
//
// A value that was minified therefore round-trips with no diff on either side,
// and no value is ever rewritten into something it was not.

/** The bytes a JSON column's value is written to its field file as. */
export const formatJsonFieldForDisk = (raw: string): string => {
  const parsed = tryParse(raw);
  if (parsed === NOT_JSON || JSON.stringify(parsed.value) !== raw) {
    return raw;
  }
  return JSON.stringify(parsed.value, null, 2);
};

/**
 * The value a JSON field file is pushed as. An empty file is an empty column.
 * Throws when the file is not JSON: the instance would store it without
 * complaint, and the page or tool reading it would fail at run time instead.
 */
export const jsonFieldForInstance = (content: string, label: string): string => {
  if (content.trim() === "") {
    return content;
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (e) {
    // Node's message already names the line and column of the offending offset.
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`${label} is not valid JSON: ${message}`);
  }
  // An editor's trailing newline is not part of what download wrote.
  if (content.replace(/\r?\n$/, "") === JSON.stringify(value, null, 2)) {
    return JSON.stringify(value);
  }
  return content;
};

// A key naming a credential, after camelCase is split: `apiKey` → `api_key`.
const SECRET_KEY =
  /(?:^|_)(?:password|passwd|pwd|secret|client_secret|api_?key|access_token|refresh_token|auth_token|bearer_token|id_token|private_key|credentials?)$/;

const normalizeKey = (key: string): string =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s.]+/g, "_")
    .toLowerCase();

/**
 * The JSON paths of keys that name a credential and hold a non-empty string —
 * a tool's `tool_attributes`, an external agent's configuration. Such a value
 * must not reach the working tree, so the field file is withheld. Empty for a
 * value that is not JSON (nothing structured to inspect).
 */
export const findSecretJsonPaths = (raw: string): string[] => {
  const parsed = tryParse(raw);
  if (parsed === NOT_JSON) return [];
  const found: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (typeof value === "string" && value !== "" && SECRET_KEY.test(normalizeKey(key))) {
        found.push(childPath);
        continue;
      }
      walk(value, childPath);
    }
  };
  walk(parsed.value, "");
  return found;
};

const NOT_JSON = Symbol("not-json");

const tryParse = (raw: string): { value: unknown } | typeof NOT_JSON => {
  if (raw.trim() === "") return NOT_JSON;
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return NOT_JSON;
  }
};
