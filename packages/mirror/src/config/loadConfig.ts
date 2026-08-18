// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `mirror.config.js` validation and defaulting (architecture §4.1, WP-M3).
 *
 * This module is the ONLY place in the mirror that is allowed to apply a config
 * default. Every stage downstream reads `config.sync.pageSize` and
 * `config.attachments.lfsThresholdBytes` directly, with no `??` of its own,
 * because a default applied in two places is a default that disagrees the first
 * time one of them is edited. {@link MirrorConfig} — where nothing but
 * `instance` is optional — is the type-level proof that this function ran.
 *
 * Three decisions here are worth defending, because each of them makes the
 * loader stricter than it strictly has to be:
 *
 *  1. **Every issue is collected, not just the first.** A config with four typos
 *     should be fixable in one pass. Failing on the first one turns that into
 *     four edit-run cycles, and a full-instance sweep is not a cheap thing to
 *     re-run.
 *  2. **Unknown keys are rejected.** A misspelled `syncs: { pageSize: 200 }` that
 *     is silently ignored is the worst possible outcome: the operator believes
 *     the setting is in force, the mirror runs with something else, and nothing
 *     in the output says so. R3's "no silent skips" applies to configuration
 *     just as much as to records.
 *  3. **Out-of-range values are refused rather than clamped.** A config that asks
 *     for 50 requests per second was written by someone who believed the
 *     instance would take 50; quietly running at 20 hides the misunderstanding.
 *     (The client clamps anyway — see `client.ts` — because it must also survive
 *     a config object that was assembled in code and never passed through here.
 *     Belt and braces, with the loader as the one that can still explain itself.)
 *
 * Errors name the field, say what was wrong, and say what is accepted. That
 * third part is what makes the difference between a message an operator can act
 * on and one they have to read the source to interpret.
 */
import {
  FORMAT_VERSION,
  LFS_THRESHOLD_BYTES,
  PAGE_SIZE_DEFAULT,
  RPS_DEFAULT,
  RPS_MAX,
  SYS_ID_RE,
} from "../constants";
import type { MirrorConfig, PerTableConfig } from "../contracts";

/**
 * Table and field name shapes.
 *
 * `@syncrona/sn-transport` keeps its own copies of these (private to
 * `mirrorPolicy.ts`) and `buildKeysetQuery` re-validates against them before any
 * request leaves the process — that is the AUTHORITATIVE gate, and it is the one
 * that stops a `/` or a `,` from redirecting a request or widening a projection.
 * The copies here exist for a different job: to fail at config-load time, naming
 * the offending config line, instead of two minutes into a sweep with a stack
 * trace from the pager. Because the transport still validates independently, a
 * divergence between the two makes the loader more or less chatty — it cannot
 * open a hole.
 */
const TABLE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_.]*$/;
/** Application scope identifiers: `global`, `sn_customerservice`, `x_nuvo_sinc`. */
const SCOPE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
/** `sys_properties` names are dotted and may contain hyphens (`glide.ui.x-y`). */
const PROPERTY_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/**
 * Upper bound on `sync.pageSize`.
 *
 * Not a §11 policy constant — §11 fixes the DEFAULT (`PAGE_SIZE_DEFAULT`), and
 * this is only the edge of the range the loader will accept, which belongs with
 * the validation rather than with the tuning surface. Ten thousand is where a
 * page stops being a sensible unit of retry: the whole page is re-fetched when
 * one request fails, and it is held in memory while it is serialized.
 */
const PAGE_SIZE_MAX = 10_000;

/**
 * Upper bound on `sync.reconcileEveryNSyncs`. A year of hourly syncs is already
 * far past the point where the reconcile is doing its job; a larger number is
 * almost certainly a typo (a missing decimal point, a pasted timestamp).
 */
const RECONCILE_EVERY_MAX = 10_000;

/**
 * A `mirror.config.js` that could not be used, with every reason it could not.
 *
 * The issue list is exposed as data rather than only as prose so a caller — the
 * CLI's `mirror` command, an editor integration — can render the issues its own
 * way, or count them, without parsing the message back apart.
 */
export class MirrorConfigError extends Error {
  /** One human-readable sentence per problem, in config-file order. */
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    const heading =
      issues.length === 1
        ? "mirror.config.js is invalid (1 problem):"
        : `mirror.config.js is invalid (${issues.length} problems):`;
    super([heading, ...issues.map((issue) => `  - ${issue}`)].join("\n"));
    this.name = "MirrorConfigError";
    this.issues = issues;
  }
}

/**
 * Render a rejected value for an error message.
 *
 * Strings are quoted so a stray space is visible; objects and arrays go through
 * JSON so the reader sees the shape they wrote. Everything else is stringified
 * directly, which is what makes `NaN`, `Infinity`, `null` and `undefined` show
 * up as themselves rather than as JSON's uniform `null`.
 */
const render = (value: unknown): string => {
  if (typeof value === "function") {
    return "a function";
  }
  if (typeof value === "string" || (typeof value === "object" && value !== null)) {
    try {
      return String(JSON.stringify(value));
    } catch {
      // A circular structure, or a `toJSON` that throws. The shape is unprintable
      // but the type still tells the operator which line to look at.
      return `an unserializable ${Array.isArray(value) ? "array" : "object"}`;
    }
  }
  return String(value);
};

/** True for a `{}`-like value: not null, not an array, not a class instance we care about. */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Quote and join accepted names for the "accepted" half of a message. */
const list = (values: readonly string[]): string =>
  values.map((value) => `\`${value}\``).join(", ");

/**
 * Reject keys the schema does not define.
 *
 * The message names the accepted keys because the overwhelmingly common cause is
 * a near-miss (`table` for `tables`, `redactions` for `redaction`), and seeing
 * the real key next to the typo is the whole fix.
 */
const rejectUnknownKeys = (
  object: Record<string, unknown>,
  path: string,
  known: readonly string[],
  issues: string[]
): void => {
  for (const key of Object.keys(object)) {
    if (!known.includes(key)) {
      issues.push(
        `${path}${key}: unknown option. Accepted options here are ${list(known)}.`
      );
    }
  }
};

/** Read a nested object, defaulting to `{}` and recording a typed complaint otherwise. */
const readObject = (
  value: unknown,
  path: string,
  issues: string[]
): Record<string, unknown> => {
  if (value === undefined) {
    return {};
  }
  if (isPlainObject(value)) {
    return value;
  }
  issues.push(`${path}: expected an object, received ${render(value)}.`);
  return {};
};

const readBoolean = (
  value: unknown,
  path: string,
  fallback: boolean,
  issues: string[]
): boolean => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  issues.push(
    `${path}: expected a boolean (true or false), received ${render(value)}.`
  );
  return fallback;
};

const readInteger = (
  value: unknown,
  path: string,
  fallback: number,
  min: number,
  max: number,
  issues: string[]
): number => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) {
    return value;
  }
  issues.push(
    `${path}: expected an integer between ${min} and ${max}, received ${render(value)}.`
  );
  return fallback;
};

/** What a string-array entry has to look like, and what to call it in a message. */
interface NameRule {
  pattern: RegExp;
  /** Noun phrase completing "expected …", e.g. "a table name". */
  expected: string;
  /** A real-world example, so the message shows the shape rather than the regex. */
  example: string;
}

/**
 * Read an array of names: every entry validated, duplicates dropped, order kept.
 *
 * Order is preserved rather than sorted because these lists are the operator's
 * text and reordering them makes the next diff of the config harder to read.
 * Duplicates are dropped silently — a repeated table name has no second meaning,
 * so refusing the config over it would be pedantry, not safety.
 */
const readNameArray = (
  value: unknown,
  path: string,
  rule: NameRule,
  issues: string[]
): string[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push(
      `${path}: expected an array of ${rule.expected}s (e.g. ["${rule.example}"]), received ${render(value)}.`
    );
    return [];
  }
  const accepted: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !rule.pattern.test(entry)) {
      issues.push(
        `${path}[${index}]: expected ${rule.expected} (e.g. "${rule.example}"), received ${render(entry)}.`
      );
      return;
    }
    if (!accepted.includes(entry)) {
      accepted.push(entry);
    }
  });
  return accepted;
};

const PER_TABLE_KEYS = ["ignoreFields", "redact"] as const;
const REDACT_MODES: readonly PerTableConfig["redact"][] = ["sensitive-keys", "all", "none"];

/** Read `tables.perTable` — a map keyed by table name, each value a small override. */
const readPerTable = (
  value: unknown,
  path: string,
  issues: string[]
): Record<string, PerTableConfig> => {
  const source = readObject(value, path, issues);
  const result: Record<string, PerTableConfig> = {};

  for (const [table, rawEntry] of Object.entries(source)) {
    if (!TABLE_NAME_RE.test(table)) {
      issues.push(
        `${path}.${table}: expected a table name key (e.g. "sys_script"), received ${render(table)}.`
      );
      continue;
    }
    const entryPath = `${path}.${table}`;
    const entry = readObject(rawEntry, entryPath, issues);
    rejectUnknownKeys(entry, `${entryPath}.`, PER_TABLE_KEYS, issues);

    const resolved: PerTableConfig = {};
    if (entry.ignoreFields !== undefined) {
      resolved.ignoreFields = readNameArray(
        entry.ignoreFields,
        `${entryPath}.ignoreFields`,
        { pattern: FIELD_NAME_RE, expected: "a field name", example: "sys_mod_count" },
        issues
      );
    }
    if (entry.redact !== undefined) {
      if (REDACT_MODES.includes(entry.redact as PerTableConfig["redact"])) {
        resolved.redact = entry.redact as PerTableConfig["redact"];
      } else {
        issues.push(
          `${entryPath}.redact: expected one of ${list(["sensitive-keys", "all", "none"])}, received ${render(entry.redact)}.`
        );
      }
    }
    result[table] = resolved;
  }

  return result;
};

const DIFF_IGNORE_KEYS = ["table", "field", "sysId"] as const;

/** Read `diffIgnore` — expected-drift rules for the cross-instance report (D13). */
const readDiffIgnore = (
  value: unknown,
  path: string,
  issues: string[]
): MirrorConfig["diffIgnore"] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push(
      `${path}: expected an array of rules (e.g. [{ table: "sys_properties" }]), received ${render(value)}.`
    );
    return [];
  }

  const rules: MirrorConfig["diffIgnore"] = [];
  value.forEach((rawRule, index) => {
    const rulePath = `${path}[${index}]`;
    if (!isPlainObject(rawRule)) {
      issues.push(
        `${rulePath}: expected a rule object with a \`table\` (e.g. { table: "sys_properties", field: "value" }), received ${render(rawRule)}.`
      );
      return;
    }
    rejectUnknownKeys(rawRule, `${rulePath}.`, DIFF_IGNORE_KEYS, issues);

    if (typeof rawRule.table !== "string" || !TABLE_NAME_RE.test(rawRule.table)) {
      issues.push(
        `${rulePath}.table: expected a table name (e.g. "sys_properties"), received ${render(rawRule.table)}.`
      );
      return;
    }
    const rule: MirrorConfig["diffIgnore"][number] = { table: rawRule.table };

    if (rawRule.field !== undefined) {
      if (typeof rawRule.field !== "string" || !FIELD_NAME_RE.test(rawRule.field)) {
        issues.push(
          `${rulePath}.field: expected a field name (e.g. "value"), received ${render(rawRule.field)}.`
        );
        return;
      }
      rule.field = rawRule.field;
    }

    if (rawRule.sysId !== undefined) {
      // INV-6, via the regex `@syncrona/sn-transport` owns. A "sys_id" that is
      // not one would silently match nothing, so the rule would look active in
      // the config and be inert in the report.
      if (typeof rawRule.sysId !== "string" || !SYS_ID_RE.test(rawRule.sysId)) {
        issues.push(
          `${rulePath}.sysId: expected a 32-character lowercase hex sys_id, received ${render(rawRule.sysId)}.`
        );
        return;
      }
      rule.sysId = rawRule.sysId;
    }

    rules.push(rule);
  });

  return rules;
};

const ROOT_KEYS = [
  "formatVersion",
  "instance",
  "scopes",
  "tiers",
  "tables",
  "attachments",
  "redaction",
  "derived",
  "sync",
  "diffIgnore",
] as const;
const TIERS_KEYS = ["referenceData"] as const;
const TABLES_KEYS = ["include", "exclude", "perTable"] as const;
const ATTACHMENTS_KEYS = ["enabled", "lfsThresholdBytes"] as const;
const REDACTION_KEYS = ["propertyAllowlist"] as const;
const DERIVED_KEYS = ["forms", "workflows", "refs", "aclMatrix"] as const;
const SYNC_KEYS = ["reconcileEveryNSyncs", "requestsPerSecond", "pageSize"] as const;

/**
 * Validate and default a raw `mirror.config.js` export (§4.1).
 *
 * @param input Whatever the config module exported — this function assumes nothing.
 * @returns A fully-populated {@link MirrorConfig}; every array and object in it is
 *          freshly built, so the caller can neither mutate the input through the
 *          result nor be surprised by a later mutation of the input.
 * @throws {MirrorConfigError} listing every problem found, not only the first.
 */
export function loadMirrorConfig(input: unknown): MirrorConfig {
  const issues: string[] = [];

  if (!isPlainObject(input)) {
    // A bare `throw` here rather than a collected issue: with no object there is
    // nothing further to validate, and a list of twelve "missing" fields would
    // bury the one thing that is actually wrong.
    throw new MirrorConfigError([
      `mirror config: expected an object (the default export of mirror.config.js), received ${render(input)}.`,
    ]);
  }

  rejectUnknownKeys(input, "", ROOT_KEYS, issues);

  // --- formatVersion --------------------------------------------------------
  // INV-8: the tree's byte format is versioned, and a config written against a
  // future version may name options this build would silently ignore.
  if (input.formatVersion !== undefined && input.formatVersion !== FORMAT_VERSION) {
    issues.push(
      `formatVersion: expected ${FORMAT_VERSION} (the only format this build writes), received ${render(input.formatVersion)}.`
    );
  }

  // --- instance -------------------------------------------------------------
  let instance: string | undefined;
  if (input.instance !== undefined) {
    const raw = typeof input.instance === "string" ? input.instance.trim() : "";
    if (raw === "" || /[\s/\\]/.test(raw)) {
      issues.push(
        `instance: expected a credential-store instance alias or host with no spaces or slashes (e.g. "dev12345.service-now.com"), received ${render(input.instance)}.`
      );
    } else {
      instance = raw;
    }
  }

  // --- scopes ---------------------------------------------------------------
  let scopes: MirrorConfig["scopes"] = "all";
  if (input.scopes !== undefined) {
    if (input.scopes === "all") {
      scopes = "all";
    } else if (Array.isArray(input.scopes) && input.scopes.length > 0) {
      scopes = readNameArray(
        input.scopes,
        "scopes",
        { pattern: SCOPE_NAME_RE, expected: "a scope name", example: "x_nuvo_sinc" },
        issues
      );
    } else {
      issues.push(
        `scopes: expected "all" or a non-empty array of scope names (e.g. ["global", "x_nuvo_sinc"]), received ${render(input.scopes)}.`
      );
    }
  }

  // --- tiers ----------------------------------------------------------------
  const tiers = readObject(input.tiers, "tiers", issues);
  rejectUnknownKeys(tiers, "tiers.", TIERS_KEYS, issues);
  // T3 (reference data) defaults OFF: it is operational data rather than
  // application metadata, it is the largest tier by row count, and mirroring it
  // is a deliberate choice rather than the obvious one.
  const referenceData = readBoolean(
    tiers.referenceData,
    "tiers.referenceData",
    false,
    issues
  );

  // --- tables ---------------------------------------------------------------
  const tables = readObject(input.tables, "tables", issues);
  rejectUnknownKeys(tables, "tables.", TABLES_KEYS, issues);
  const include = readNameArray(
    tables.include,
    "tables.include",
    { pattern: TABLE_NAME_RE, expected: "a table name", example: "sys_script" },
    issues
  );
  const exclude = readNameArray(
    tables.exclude,
    "tables.exclude",
    { pattern: TABLE_NAME_RE, expected: "a table name", example: "sys_email" },
    issues
  );
  // Resolving the contradiction silently (either way) means the mirror does
  // something the config does not say. Both orderings have been argued for in
  // other tools, which is itself the reason not to pick one.
  for (const table of include) {
    if (exclude.includes(table)) {
      issues.push(
        `tables: "${table}" is listed in both \`include\` and \`exclude\`. Remove it from one of them — the mirror will not guess which wins.`
      );
    }
  }
  const perTable = readPerTable(tables.perTable, "tables.perTable", issues);

  // --- attachments ----------------------------------------------------------
  const attachments = readObject(input.attachments, "attachments", issues);
  rejectUnknownKeys(attachments, "attachments.", ATTACHMENTS_KEYS, issues);
  // Attachments default OFF. M16 measured 5 755 attachments on one live
  // instance, 452 of them above the LFS threshold and the largest 76.8 MB;
  // turning them on also requires git-lfs to be installed and configured. That
  // is a decision an operator should make, not one a first run should make for
  // them — and R3 keeps it honest, because the coverage report names the tier
  // that was not fetched.
  const attachmentsEnabled = readBoolean(
    attachments.enabled,
    "attachments.enabled",
    false,
    issues
  );
  const lfsThresholdBytes = readInteger(
    attachments.lfsThresholdBytes,
    "attachments.lfsThresholdBytes",
    LFS_THRESHOLD_BYTES,
    1,
    // 100 MB is GitHub's hard blob limit; a threshold at or above it would mean
    // "never use LFS", which is spelled by disabling attachments, not by a number
    // that makes every large file unpushable.
    100 * 1024 * 1024,
    issues
  );

  // --- redaction ------------------------------------------------------------
  const redaction = readObject(input.redaction, "redaction", issues);
  rejectUnknownKeys(redaction, "redaction.", REDACTION_KEYS, issues);
  const propertyAllowlist = readNameArray(
    redaction.propertyAllowlist,
    "redaction.propertyAllowlist",
    {
      pattern: PROPERTY_NAME_RE,
      expected: "a sys_properties key",
      example: "glide.ui.list.recent_items",
    },
    issues
  );

  // --- derived --------------------------------------------------------------
  const derived = readObject(input.derived, "derived", issues);
  rejectUnknownKeys(derived, "derived.", DERIVED_KEYS, issues);
  // All four default ON: the derived layer is regenerated from the canonical
  // layer on every sync, so it costs no extra API calls, and it is the half of
  // the tree a human actually reads.
  const derivedForms = readBoolean(derived.forms, "derived.forms", true, issues);
  const derivedWorkflows = readBoolean(derived.workflows, "derived.workflows", true, issues);
  const derivedRefs = readBoolean(derived.refs, "derived.refs", true, issues);
  const derivedAclMatrix = readBoolean(derived.aclMatrix, "derived.aclMatrix", true, issues);

  // --- sync -----------------------------------------------------------------
  const sync = readObject(input.sync, "sync", issues);
  rejectUnknownKeys(sync, "sync.", SYNC_KEYS, issues);
  // 1 = reconcile every sync. Zero is NOT accepted: a mirror that never
  // reconciles can never notice a deletion the audit trail missed, so "off" is
  // not a state this engine offers.
  const reconcileEveryNSyncs = readInteger(
    sync.reconcileEveryNSyncs,
    "sync.reconcileEveryNSyncs",
    10,
    1,
    RECONCILE_EVERY_MAX,
    issues
  );
  const requestsPerSecond = readInteger(
    sync.requestsPerSecond,
    "sync.requestsPerSecond",
    RPS_DEFAULT,
    1,
    RPS_MAX,
    issues
  );
  const pageSize = readInteger(
    sync.pageSize,
    "sync.pageSize",
    PAGE_SIZE_DEFAULT,
    1,
    PAGE_SIZE_MAX,
    issues
  );

  // --- diffIgnore -----------------------------------------------------------
  const diffIgnore = readDiffIgnore(input.diffIgnore, "diffIgnore", issues);

  if (issues.length > 0) {
    throw new MirrorConfigError(issues);
  }

  return {
    formatVersion: FORMAT_VERSION,
    ...(instance === undefined ? {} : { instance }),
    scopes,
    tiers: { referenceData },
    tables: { include, exclude, perTable },
    attachments: { enabled: attachmentsEnabled, lfsThresholdBytes },
    redaction: { propertyAllowlist },
    derived: {
      forms: derivedForms,
      workflows: derivedWorkflows,
      refs: derivedRefs,
      aclMatrix: derivedAclMatrix,
    },
    sync: { reconcileEveryNSyncs, requestsPerSecond, pageSize },
    diffIgnore,
  };
}
