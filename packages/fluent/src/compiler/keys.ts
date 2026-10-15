// SPDX-License-Identifier: GPL-3.0-or-later
//
// The keys registry behind `src/fluent/generated/keys.ts`: it maps `$id`
// values (explicit keys) and coalesce keys (composite keys) to stable sys_ids
// across builds. It reproduces the ServiceNow SDK's registry semantics so a
// project can move between the SDK build and the native compiler without any
// sys_id changing:
//
// - an explicit key is looked up by its `$id` and table; a new one takes the
//   GUID override, the key itself when it is a GUID, or a fresh GUID;
// - a composite key matches an existing entry by id or by equal coalesce
//   values (nested references compare by id or, recursively, by their keys);
// - a reference with coalesce keys that no top-level entry holds is searched
//   inside other entries' nested keys (e.g. an external role an ACL role names);
// - entries the build did not use are written back marked `deleted: true`.
//
// One deliberate difference: entries for tables the native compiler does not
// produce (the SDK's own `sys_module` records for package.json, bom.json and
// included files) are kept as they are instead of being marked deleted, so a
// later SDK build still finds them.

import { randomUUID } from "node:crypto";

export type GuidGenerator = () => string;

export const defaultGuid: GuidGenerator = () => randomUUID().replaceAll("-", "");

export function isGUID(value: string): boolean {
  return /^[a-f0-9]{32}$/i.test(value);
}

export interface NestedKey {
  id: string;
  key: SerializedKeys;
}
export type SerializedKeys = Record<string, string | NestedKey>;

export interface ExplicitKey {
  table: string;
  id: string;
  deleted?: boolean;
}

export interface CompositeKey {
  table: string;
  id: string;
  deleted?: boolean;
  key: SerializedKeys;
}

export interface KeysData {
  explicit: Record<string, ExplicitKey>;
  composite: CompositeKey[];
  deleted: Record<string, string[]>;
}

/** What a coalesce key value can be before serialization: a plain value or a record reference. */
export interface KeyReference {
  getValue(): string;
  getKeys(): CoalesceKeys | undefined;
}
export type CoalesceKeys = Record<string, string | KeyReference>;

const LEGACY_KEYS: Record<string, string> = {
  list: "sys_ui_list",
  list_id: "sys_ui_list",
  route: "sys_ws_operation",
  web_service_operation: "sys_ws_operation",
  web_service_header: "sys_ws_header",
  web_service_query_parameter: "sys_ws_query_parameter",
};

export class KeysRegistry {
  private readonly usedIds = new Set<string>();

  constructor(
    private readonly data: KeysData = { explicit: {}, composite: [], deleted: {} },
    private readonly guid: GuidGenerator = defaultGuid,
  ) {}

  private use<K extends ExplicitKey | CompositeKey>(key: K): K {
    if (key.deleted) key.deleted = false; // a key registered as deleted earlier is revived
    this.usedIds.add(key.id);
    return key;
  }

  private queryExplicitKey(table: string, key: string | number): ExplicitKey | undefined {
    const existing = this.data.explicit[key];
    return existing?.table === table ? existing : undefined;
  }

  queryExplicitId(table: string, key: string | number): string | undefined {
    return this.queryExplicitKey(table, key)?.id;
  }

  registerExplicitId(table: string, key: string | number, guidOverride?: string): string {
    const existing = this.queryExplicitKey(table, key);
    if (existing) return this.use(existing).id;
    const id = guidOverride ?? (typeof key === "string" && isGUID(key) ? key : this.guid());
    const entry = { table, id };
    this.data.explicit[key] = entry;
    return this.use(entry).id;
  }

  private queryCompositeKey(table: string, query: CoalesceKeys, guid?: string): CompositeKey | undefined {
    const serialized = this.serializeCoalesceKeys(query);
    return this.data.composite.find(
      (existing) =>
        existing.table === table && (existing.id === guid || this.coalesceKeysAreEqual(existing.key, serialized, table)),
    );
  }

  queryCompositeId(table: string, query: CoalesceKeys): string | undefined {
    return this.queryCompositeKey(table, query)?.id ?? this.queryNestedReference(table, query);
  }

  private queryNestedReference(table: string, query: CoalesceKeys): string | undefined {
    const serialized = this.serializeCoalesceKeys(query);
    for (const composite of this.data.composite) {
      const match = this.findNestedReference(composite.key, table, serialized);
      if (match) return match;
    }
    return undefined;
  }

  private findNestedReference(keys: SerializedKeys, table: string, query: SerializedKeys): string | undefined {
    for (const [fieldName, value] of Object.entries(keys)) {
      if (typeof value === "object") {
        if (fieldName === table && this.coalesceKeysAreEqual(value.key, query, table)) return value.id;
        const nested = this.findNestedReference(value.key, table, query);
        if (nested) return nested;
      }
    }
    return undefined;
  }

  registerCompositeId(table: string, key: CoalesceKeys, guidOverride?: string): string {
    const existing = this.queryCompositeKey(table, key, guidOverride);
    if (existing) return this.use(existing).id;
    const entry = { table, id: guidOverride ?? this.guid(), key: this.serializeCoalesceKeys(key) };
    this.data.composite.push(entry);
    return this.use(entry).id;
  }

  private serializeCoalesceKeys(keys: CoalesceKeys): SerializedKeys {
    const entries = Object.entries(keys);
    if (entries.length === 0) throw new Error("Coalesce keys object is empty.");
    return Object.fromEntries(
      entries.map(([k, v]): [string, string | NestedKey] => {
        // Empty values are "NULL", as the platform's coalesce strategies spell them.
        if (!v) return [k, "NULL"];
        if (typeof v === "string") return [k, v];
        const nested = v.getKeys();
        return nested ? [k, { id: v.getValue(), key: this.serializeCoalesceKeys(nested) }] : [k, v.getValue()];
      }),
    );
  }

  /**
   * Whether every key of `right` matches `left` (extra keys on the left are
   * ignored). A nested key matches a plain id equal to its own id, or another
   * nested key with the same id or, recursively, equal coalesce values.
   */
  private coalesceKeysAreEqual(leftOrig: SerializedKeys, rightOrig: SerializedKeys, table?: string): boolean {
    const left = table ? mapLegacyKeys(leftOrig, table) : leftOrig;
    const right = table ? mapLegacyKeys(rightOrig, table) : rightOrig;
    return Object.entries(right).every(([k, rightValue]) => {
      const leftValue = left[k];
      if (typeof leftValue === "string") {
        // A legacy explicit key in place of a sys_id resolves to its sys_id first.
        const resolved = this.queryExplicitId(k, leftValue) ?? leftValue;
        return typeof rightValue === "string" ? resolved === rightValue : resolved === rightValue.id;
      }
      if (typeof leftValue === "object") {
        return typeof rightValue === "string"
          ? leftValue.id === rightValue
          : leftValue.id === rightValue.id || this.coalesceKeysAreEqual(leftValue.key, rightValue.key);
      }
      return false;
    });
  }

  /**
   * The registry to write back. `keepTable` names the tables whose unused
   * entries stay as they are (the ones this compiler does not produce).
   */
  commit(keepTable: (table: string) => boolean = () => false): Partial<KeysData> {
    const isUsed = (v: { table: string; id: string }) => this.usedIds.has(v.id) || keepTable(v.table);
    // Object.fromEntries puts integer-like keys first, as the SDK's output does.
    const explicit: Record<string, ExplicitKey> = Object.fromEntries(
      Object.entries(this.data.explicit)
        .sort(([a], [b]) => a.localeCompare(b))
        // An explicit key that later became a composite one is dropped.
        .filter(([, v]) => !this.data.composite.some((k) => k.table === v.table && k.id === v.id))
        .map(([k, v]) => [k, isUsed(v) ? v : { ...v, deleted: true }]),
    );
    const composite = this.data.composite
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((v) =>
        isUsed(v)
          ? "deleted" in v
            ? { table: v.table, id: v.id, deleted: v.deleted, key: v.key } // keeps `deleted` before `key`
            : v
          : { table: v.table, id: v.id, deleted: true, key: v.key },
      );
    const deleted = this.data.deleted;
    return {
      ...(Object.keys(explicit).length > 0 ? { explicit } : {}),
      ...(composite.length > 0 ? { composite } : {}),
      ...(Object.keys(deleted).length > 0 ? { deleted } : {}),
    };
  }
}

function mapLegacyKeys(obj: SerializedKeys, table: string): SerializedKeys {
  const mapped = { ...obj };
  for (const [key, value] of Object.entries(mapped)) {
    const target =
      key === "attr" ? (table === "sys_ws_query_parameter_map" ? "sys_ws_query_parameter" : "sys_ws_header") : LEGACY_KEYS[key];
    if (target) {
      mapped[target] = value;
      delete mapped[key];
    }
  }
  delete mapped.rest;
  return mapped;
}
