// SPDX-License-Identifier: GPL-3.0-or-later
//
// The record model the compiler builds and the factory that gives each record
// its sys_id through the keys registry, the way the SDK's factory does:
//
// - a table with a coalesce strategy registers its coalesce values as a
//   composite key (an explicit `$id` already in the registry keeps its sys_id);
// - otherwise an explicit `$id` registers an explicit key;
// - a reference resolves lazily, on its first read, so records declared later
//   have registered by then.

import { FluentCompileError, type SourceLocation } from "./diagnostics";
import { isGUID, type CoalesceKeys, type GuidGenerator, type KeyReference, type KeysRegistry } from "./keys";

export type InstallCategory = "update" | "unload" | "unload.demo" | "apply_once";

/** Tables whose records are identified by these field values instead of an `$id`. */
export const COALESCE_STRATEGIES: Record<string, readonly string[]> = {
  sys_user_role: ["name"],
  sys_user_role_contains: ["role", "contains"],
  sys_security_acl_role: ["sys_security_acl", "sys_user_role"],
  sys_ui_action_role: ["sys_ui_action", "sys_user_role"],
  sys_ui_action_view: ["sys_ui_action", "sys_ui_view"],
};

export class RecordId implements KeyReference {
  private resolved?: string;
  /** XML attributes rendered before the coalesce key attributes. */
  readonly attributes: Record<string, string> = {};

  constructor(
    readonly table: string,
    private readonly guid: string | (() => string),
    readonly keys?: CoalesceKeys,
  ) {}

  getValue(): string {
    this.resolved ??= typeof this.guid === "string" ? this.guid : this.guid();
    return this.resolved;
  }

  getKeys(): CoalesceKeys | undefined {
    return this.keys;
  }

  withAttribute(name: string, value: string): this {
    this.attributes[name] = value;
    return this;
  }
}

/** A field rendered as a CDATA section. */
export class CData {
  constructor(readonly text: string) {}
}

export type FieldValue = string | number | boolean | undefined | RecordId | CData;

export interface CompiledRecord {
  table: string;
  id: RecordId;
  installCategory: InstallCategory;
  fields: Map<string, FieldValue>;
  /** Records the same API call produced along with this one (m2m rows and the like). */
  children: CompiledRecord[];
  source: SourceLocation;
  /** The `$id` the record was declared with, if any. */
  explicitKey?: string;
}

export interface CreateRecordOptions {
  table: string;
  source: SourceLocation;
  installCategory: InstallCategory;
  explicitId?: string | number;
  fields: Record<string, FieldValue | CompiledRecord>;
}

function isCompiledRecord(v: unknown): v is CompiledRecord {
  return typeof v === "object" && v !== null && "fields" in v;
}

export class RecordFactory {
  constructor(
    private readonly registry: KeysRegistry,
    private readonly scope: string,
    private readonly scopeId: string,
    private readonly guid: GuidGenerator,
  ) {}

  createRecord(options: CreateRecordOptions): CompiledRecord {
    const { table, explicitId } = options;
    const fields = new Map<string, FieldValue>(
      Object.entries(options.fields).map(([k, v]) => [k, isCompiledRecord(v) ? v.id : v]),
    );
    // An explicit id that is a GUID is the sys_id.
    const guidOverride = typeof explicitId === "string" && isGUID(explicitId) ? explicitId : undefined;
    const strategy = COALESCE_STRATEGIES[table];
    let id: RecordId;
    if (strategy) {
      const keys: CoalesceKeys = Object.fromEntries(
        strategy.map((k) => {
          const v = fields.get(k);
          return [k, v instanceof RecordId ? v : (v === undefined ? "" : String(v)) || "NULL"];
        }),
      );
      const override = explicitId ? (this.registry.queryExplicitId(table, explicitId) ?? guidOverride) : guidOverride;
      id = new RecordId(table, this.registry.registerCompositeId(table, keys, override), keys);
    } else if (explicitId) {
      id = new RecordId(table, this.registry.registerExplicitId(table, explicitId, guidOverride));
    } else {
      throw new FluentCompileError(`Cannot determine the sys_id of this ${table} record: give it a $id.`, options.source);
    }
    fields.set("sys_scope", new RecordId("sys_scope", this.scopeId).withAttribute("display_value", this.scope));
    fields.set("sys_update_name", `${table}_${id.getValue()}`);
    const explicitKey = explicitId === undefined || explicitId === "" ? {} : { explicitKey: String(explicitId) };
    return { table, id, installCategory: options.installCategory, fields, children: [], source: options.source, ...explicitKey };
  }

  /** A reference to a record by GUID, `$id` key or coalesce keys, resolved on first read. */
  createReference(table: string, guid?: string, keys?: Record<string, string | RecordId | CompiledRecord>): RecordId {
    const coalesce: CoalesceKeys | undefined = keys
      ? Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, typeof v === "string" ? v : isCompiledRecord(v) ? v.id : v]))
      : undefined;
    return new RecordId(
      table,
      () => {
        const fallback = guid ? (isGUID(guid) ? guid : (this.registry.queryExplicitId(table, guid) ?? guid)) : this.guid();
        return coalesce ? (this.registry.queryCompositeId(table, coalesce) ?? fallback) : fallback;
      },
      coalesce,
    );
  }
}

// --- Output model ---------------------------------------------------------------

export interface RecordUpdateField {
  name: string;
  /** Absent or empty renders as an empty element. */
  value?: string;
  cdata?: boolean;
  attributes?: Record<string, string>;
}

/** One `<record_update>` file: `<installCategory>/<table>_<sysId>.xml` under the app's dist directory. */
export interface RecordUpdateModel {
  table: string;
  sysId: string;
  installCategory: InstallCategory;
  action: "INSERT_OR_UPDATE";
  path: string;
  /** In output order: sys_id, sys_scope, sys_update_name, then the rest by name. */
  fields: RecordUpdateField[];
}

const LEADING_FIELDS = ["sys_scope", "sys_update_name"];

function toField(name: string, value: FieldValue): RecordUpdateField {
  if (value instanceof CData) return { name, value: value.text, cdata: true };
  if (value instanceof RecordId) {
    const attributes: Record<string, string> = { ...value.attributes };
    for (const [k, v] of Object.entries(value.keys ?? {})) attributes[k] = typeof v === "string" ? v : v.getValue();
    return { name, value: value.getValue(), ...(Object.keys(attributes).length > 0 ? { attributes } : {}) };
  }
  return value === undefined ? { name } : { name, value: String(value) };
}

export function toRecordUpdate(record: CompiledRecord): RecordUpdateModel {
  const sysId = record.id.getValue();
  const rest = [...record.fields.keys()].filter((k) => !LEADING_FIELDS.includes(k)).sort((a, b) => a.localeCompare(b));
  return {
    table: record.table,
    sysId,
    installCategory: record.installCategory,
    action: "INSERT_OR_UPDATE",
    path: `${record.installCategory}/${record.table}_${sysId}.xml`,
    fields: [
      { name: "sys_id", value: sysId },
      ...[...LEADING_FIELDS, ...rest].map((k) => toField(k, record.fields.get(k))),
    ],
  };
}
