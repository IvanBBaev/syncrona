// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `loadMirrorConfig` — validation and defaulting of `mirror.config.js` (§4.1).
 *
 * Table-driven on both sides, because the two halves of the acceptance criterion
 * are different claims and neither implies the other:
 *
 *  - The VALID table asserts that every field is defaulted. A loader that
 *    defaults eleven of twelve fields type-checks, passes a happy-path test with
 *    a fully-specified config, and then hands a stage `undefined` at 3 a.m.
 *    So the first case here is the empty object, and it asserts the ENTIRE
 *    resolved config by deep equality rather than field by field: a new field
 *    added to `MirrorConfig` without a default fails this test on the day it is
 *    added, which is the only day it is cheap to fix.
 *  - The INVALID table asserts that errors are ACTIONABLE. "Invalid config" is
 *    not actionable; "sync.pageSize: expected an integer between 1 and 10000,
 *    received 0" is. Each case therefore pins three things — that the field path
 *    appears, that the message says what was received, and that it says what is
 *    accepted — instead of only pinning that something threw.
 */
import { MirrorConfigError, loadMirrorConfig } from "../src/config/loadConfig";
import {
  LFS_THRESHOLD_BYTES,
  PAGE_SIZE_DEFAULT,
  RPS_DEFAULT,
  RPS_MAX,
} from "../src/constants";
import type { MirrorConfig } from "../src/contracts";

/** The config that results from `{}` — every default, in one place. */
const FULLY_DEFAULTED: MirrorConfig = {
  formatVersion: 1,
  scopes: "all",
  tiers: { referenceData: false },
  tables: { include: [], exclude: [], perTable: {} },
  attachments: { enabled: false, lfsThresholdBytes: LFS_THRESHOLD_BYTES },
  redaction: { propertyAllowlist: [] },
  derived: { forms: true, workflows: true, refs: true, aclMatrix: true },
  sync: {
    reconcileEveryNSyncs: 10,
    requestsPerSecond: RPS_DEFAULT,
    pageSize: PAGE_SIZE_DEFAULT,
  },
  diffIgnore: [],
};

/** A value that cannot be rendered through JSON, for the error-formatting path. */
const circularObject = (): Record<string, unknown> => {
  const value: Record<string, unknown> = {};
  value.self = value;
  return value;
};

const circularArray = (): unknown[] => {
  const value: unknown[] = [];
  value.push(value);
  return value;
};

interface ValidCase {
  name: string;
  input: unknown;
  expected: MirrorConfig;
}

const VALID_CASES: ValidCase[] = [
  {
    name: "an empty object defaults every single field",
    input: {},
    expected: FULLY_DEFAULTED,
  },
  {
    name: "an explicit formatVersion of 1 is accepted",
    input: { formatVersion: 1 },
    expected: FULLY_DEFAULTED,
  },
  {
    name: "an instance is trimmed and carried through",
    input: { instance: "  dev12345.service-now.com  " },
    expected: { ...FULLY_DEFAULTED, instance: "dev12345.service-now.com" },
  },
  {
    name: '"all" is accepted verbatim for scopes',
    input: { scopes: "all" },
    expected: FULLY_DEFAULTED,
  },
  {
    name: "a scope list keeps operator order and drops duplicates",
    input: { scopes: ["x_nuvo_sinc", "global", "x_nuvo_sinc"] },
    expected: { ...FULLY_DEFAULTED, scopes: ["x_nuvo_sinc", "global"] },
  },
  {
    name: "every boolean switch can be flipped away from its default",
    input: {
      tiers: { referenceData: true },
      attachments: { enabled: true },
      derived: { forms: false, workflows: false, refs: false, aclMatrix: false },
    },
    expected: {
      ...FULLY_DEFAULTED,
      tiers: { referenceData: true },
      attachments: { enabled: true, lfsThresholdBytes: LFS_THRESHOLD_BYTES },
      derived: { forms: false, workflows: false, refs: false, aclMatrix: false },
    },
  },
  {
    name: "sync numbers are accepted at both ends of their ranges",
    input: {
      sync: { reconcileEveryNSyncs: 1, requestsPerSecond: RPS_MAX, pageSize: 10_000 },
      attachments: { lfsThresholdBytes: 1 },
    },
    expected: {
      ...FULLY_DEFAULTED,
      attachments: { enabled: false, lfsThresholdBytes: 1 },
      sync: { reconcileEveryNSyncs: 1, requestsPerSecond: RPS_MAX, pageSize: 10_000 },
    },
  },
  {
    name: "per-table overrides are read, and absent members stay absent (D7)",
    input: {
      tables: {
        include: ["sys_script", "sys_script"],
        exclude: ["sys_email"],
        perTable: {
          sys_script: { ignoreFields: ["sys_mod_count", "sys_mod_count"] },
          sys_user: { redact: "all" },
          incident: {},
        },
      },
    },
    expected: {
      ...FULLY_DEFAULTED,
      tables: {
        include: ["sys_script"],
        exclude: ["sys_email"],
        perTable: {
          sys_script: { ignoreFields: ["sys_mod_count"] },
          sys_user: { redact: "all" },
          incident: {},
        },
      },
    },
  },
  {
    name: "every redaction mode, including the per-table opt-out, is spellable",
    input: {
      redaction: { propertyAllowlist: ["glide.ui.list.recent_items", "glide.x-y"] },
      tables: {
        perTable: {
          a_table: { redact: "sensitive-keys" },
          b_table: { redact: "none" },
        },
      },
    },
    expected: {
      ...FULLY_DEFAULTED,
      tables: {
        include: [],
        exclude: [],
        perTable: {
          a_table: { redact: "sensitive-keys" },
          b_table: { redact: "none" },
        },
      },
      redaction: { propertyAllowlist: ["glide.ui.list.recent_items", "glide.x-y"] },
    },
  },
  {
    name: "diffIgnore rules are read at all three levels of specificity (D13)",
    input: {
      diffIgnore: [
        { table: "sys_properties" },
        { table: "sys_properties", field: "value" },
        {
          table: "sys_user",
          field: "sys_updated_on",
          sysId: "0123456789abcdef0123456789abcdef",
        },
      ],
    },
    expected: {
      ...FULLY_DEFAULTED,
      diffIgnore: [
        { table: "sys_properties" },
        { table: "sys_properties", field: "value" },
        {
          table: "sys_user",
          field: "sys_updated_on",
          sysId: "0123456789abcdef0123456789abcdef",
        },
      ],
    },
  },
];

interface InvalidCase {
  name: string;
  input: unknown;
  /** Fragments every one of which must appear somewhere in the issue list. */
  says: string[];
  /** Exact number of issues, where the count is itself the point of the case. */
  issueCount?: number;
}

const INVALID_CASES: InvalidCase[] = [
  {
    name: "a non-object export is rejected before anything else is attempted",
    input: null,
    says: ["mirror config", "expected an object", "mirror.config.js", "null"],
    issueCount: 1,
  },
  {
    name: "an array export is not an object either",
    input: [],
    says: ["expected an object", "[]"],
    issueCount: 1,
  },
  {
    name: "a misspelled top-level key is named, with the real keys beside it",
    input: { syncs: { pageSize: 200 } },
    says: ["syncs", "unknown option", "`sync`", "`tables`"],
    issueCount: 1,
  },
  {
    name: "a misspelled nested key is named with its full path",
    input: { sync: { pagesize: 200 } },
    says: ["sync.pagesize", "unknown option", "`pageSize`"],
    issueCount: 1,
  },
  {
    name: "a future formatVersion is refused rather than best-effort read",
    input: { formatVersion: 2 },
    says: ["formatVersion", "expected 1", "received 2"],
    issueCount: 1,
  },
  {
    name: "an instance with a slash is refused (it is an alias, not a URL)",
    input: { instance: "https://dev12345.service-now.com/" },
    says: ["instance", "no spaces or slashes", "dev12345.service-now.com"],
    issueCount: 1,
  },
  {
    name: "a blank instance is refused",
    input: { instance: "   " },
    says: ["instance", "expected a credential-store instance alias"],
    issueCount: 1,
  },
  {
    name: "a non-string instance is refused",
    input: { instance: 12345 },
    says: ["instance", "received 12345"],
    issueCount: 1,
  },
  {
    name: "an empty scope array is refused (it would mirror nothing, silently)",
    input: { scopes: [] },
    says: ["scopes", 'expected "all" or a non-empty array', "[]"],
    issueCount: 1,
  },
  {
    name: "a scopes value of the wrong type names both accepted shapes",
    input: { scopes: "global" },
    says: ["scopes", 'expected "all"', '"global"'],
    issueCount: 1,
  },
  {
    name: "a function is described as a function rather than as undefined",
    input: { scopes: () => "all" },
    says: ["scopes", "a function"],
    issueCount: 1,
  },
  {
    name: "a scope entry that is not a scope name is reported by index",
    input: { scopes: ["global", "not a scope", 7] },
    says: ["scopes[1]", "scopes[2]", "a scope name", "x_nuvo_sinc", "received 7"],
    issueCount: 2,
  },
  {
    name: "a non-object section is refused with the shape it should have had",
    input: { tiers: "yes" },
    says: ["tiers", "expected an object", '"yes"'],
    issueCount: 1,
  },
  {
    name: "an unserializable section value is still described by its type",
    input: { attachments: circularArray() },
    says: ["attachments", "an unserializable array"],
    issueCount: 1,
  },
  {
    name: "a non-boolean switch says which two values are accepted",
    input: { tiers: { referenceData: "true" } },
    says: ["tiers.referenceData", "expected a boolean (true or false)", '"true"'],
    issueCount: 1,
  },
  {
    name: "an unserializable boolean value is described by its type",
    input: { derived: { forms: circularObject() } },
    says: ["derived.forms", "an unserializable object"],
    issueCount: 1,
  },
  {
    name: "a table name that is not one is refused with an example",
    input: { tables: { include: ["sys script"], exclude: [{}] } },
    says: ["tables.include[0]", "tables.exclude[0]", "a table name", "sys_script", "{}"],
    issueCount: 2,
  },
  {
    name: "a table list of the wrong type says an array was expected",
    input: { tables: { include: "sys_script" } },
    says: ["tables.include", "expected an array of a table names", '"sys_script"'],
    issueCount: 1,
  },
  {
    name: "a table in both include and exclude is a contradiction, not a precedence puzzle",
    input: { tables: { include: ["sys_script"], exclude: ["sys_script"] } },
    says: ["tables", "sys_script", "both", "include", "exclude", "will not guess"],
    issueCount: 1,
  },
  {
    name: "a perTable key that is not a table name is refused",
    input: { tables: { perTable: { "sys script": {} } } },
    says: ["tables.perTable.sys script", "a table name key"],
    issueCount: 1,
  },
  {
    name: "a perTable entry that is not an object is refused",
    input: { tables: { perTable: { sys_script: true } } },
    says: ["tables.perTable.sys_script", "expected an object", "true"],
    issueCount: 1,
  },
  {
    name: "an unknown perTable option is named with the accepted ones",
    input: { tables: { perTable: { sys_script: { ignoreField: ["x"] } } } },
    says: [
      "tables.perTable.sys_script.ignoreField",
      "unknown option",
      "`ignoreFields`",
      "`redact`",
    ],
    issueCount: 1,
  },
  {
    name: "an unknown redaction mode lists the three that exist",
    input: { tables: { perTable: { sys_script: { redact: "maybe" } } } },
    says: [
      "tables.perTable.sys_script.redact",
      "`sensitive-keys`",
      "`all`",
      "`none`",
      '"maybe"',
    ],
    issueCount: 1,
  },
  {
    name: "a bad ignoreFields entry is reported by index",
    input: { tables: { perTable: { sys_script: { ignoreFields: ["ok", "not ok"] } } } },
    says: ["tables.perTable.sys_script.ignoreFields[1]", "a field name", "sys_mod_count"],
    issueCount: 1,
  },
  {
    name: "a property allowlist entry that is not a property key is refused",
    input: { redaction: { propertyAllowlist: ["glide.ui.ok", "1.bad"] } },
    says: ["redaction.propertyAllowlist[1]", "a sys_properties key"],
    issueCount: 1,
  },
  {
    name: "an lfs threshold below the range is refused rather than clamped",
    input: { attachments: { lfsThresholdBytes: 0 } },
    says: ["attachments.lfsThresholdBytes", "expected an integer between 1 and 104857600"],
    issueCount: 1,
  },
  {
    name: "an lfs threshold above GitHub's hard blob limit is refused",
    input: { attachments: { lfsThresholdBytes: 104_857_601 } },
    says: ["attachments.lfsThresholdBytes", "104857600", "104857601"],
    issueCount: 1,
  },
  {
    name: "a fractional page size is refused (it is not a row count)",
    input: { sync: { pageSize: 100.5 } },
    says: ["sync.pageSize", "expected an integer between 1 and 10000", "100.5"],
    issueCount: 1,
  },
  {
    name: "a page size of zero is refused",
    input: { sync: { pageSize: 0 } },
    says: ["sync.pageSize", "received 0"],
    issueCount: 1,
  },
  {
    name: "a request rate above the platform ceiling is refused, not clamped to it",
    input: { sync: { requestsPerSecond: 50 } },
    says: ["sync.requestsPerSecond", `between 1 and ${RPS_MAX}`, "received 50"],
    issueCount: 1,
  },
  {
    name: "reconcileEveryNSyncs of 0 is refused — 'never reconcile' is not offered",
    input: { sync: { reconcileEveryNSyncs: 0 } },
    says: ["sync.reconcileEveryNSyncs", "between 1 and 10000", "received 0"],
    issueCount: 1,
  },
  {
    name: "a non-numeric sync value is refused with the same message shape",
    input: { sync: { requestsPerSecond: "4" } },
    says: ["sync.requestsPerSecond", "expected an integer", '"4"'],
    issueCount: 1,
  },
  {
    name: "diffIgnore of the wrong type says what a rule looks like",
    input: { diffIgnore: { table: "sys_properties" } },
    says: ["diffIgnore", "expected an array of rules", "sys_properties"],
    issueCount: 1,
  },
  {
    name: "a diffIgnore entry that is not an object is reported by index",
    input: { diffIgnore: ["sys_properties"] },
    says: ["diffIgnore[0]", "expected a rule object", '"sys_properties"'],
    issueCount: 1,
  },
  {
    name: "an unknown diffIgnore key is named",
    input: { diffIgnore: [{ table: "sys_properties", column: "value" }] },
    says: ["diffIgnore[0].column", "unknown option", "`field`", "`sysId`"],
    issueCount: 1,
  },
  {
    name: "a diffIgnore rule without a usable table is refused",
    input: { diffIgnore: [{ field: "value" }] },
    says: ["diffIgnore[0].table", "a table name", "undefined"],
    issueCount: 1,
  },
  {
    name: "a diffIgnore field that is not a field name is refused",
    input: { diffIgnore: [{ table: "sys_properties", field: "va lue" }] },
    says: ["diffIgnore[0].field", "a field name", "value"],
    issueCount: 1,
  },
  {
    name: "a diffIgnore sysId that is not a sys_id is refused (INV-6)",
    input: { diffIgnore: [{ table: "sys_user", sysId: "ABC" }] },
    says: ["diffIgnore[0].sysId", "32-character lowercase hex sys_id", '"ABC"'],
    issueCount: 1,
  },
  {
    name: "an uppercase-hex sysId is refused too — the canonical form is lowercase",
    input: {
      diffIgnore: [{ table: "sys_user", sysId: "0123456789ABCDEF0123456789ABCDEF" }],
    },
    says: ["diffIgnore[0].sysId", "lowercase"],
    issueCount: 1,
  },
  {
    name: "every problem in a thoroughly broken config is reported in one pass",
    input: {
      formatVersion: 99,
      scopes: 3,
      tiers: { referenceData: "yes" },
      sync: { pageSize: -1, requestsPerSecond: 999 },
      typo: true,
    },
    says: [
      "typo",
      "formatVersion",
      "scopes",
      "tiers.referenceData",
      "sync.pageSize",
      "sync.requestsPerSecond",
    ],
    issueCount: 6,
  },
];

describe("loadMirrorConfig — valid configs", () => {
  it.each(VALID_CASES)("$name", ({ input, expected }) => {
    expect(loadMirrorConfig(input)).toEqual(expected);
  });

  it("returns a config the caller cannot mutate the input through", () => {
    // The resolved config is handed to every stage. If it shared array identity
    // with the operator's module export, a stage that sorted `tables.include` in
    // place would mutate the config module's own object — and a second
    // `loadMirrorConfig` call in the same process would then see different input.
    const input = { tables: { include: ["sys_script"] }, diffIgnore: [{ table: "a_b" }] };
    const config = loadMirrorConfig(input);

    expect(config.tables.include).not.toBe(input.tables.include);
    expect(config.diffIgnore).not.toBe(input.diffIgnore);
    expect(config.diffIgnore[0]).not.toBe(input.diffIgnore[0]);
  });

  it("omits `instance` entirely rather than setting it to undefined", () => {
    // `"instance" in config` is how a caller asks "did the operator pin an
    // instance, or should the active one be used?". An own property holding
    // undefined answers that question wrongly.
    expect(Object.prototype.hasOwnProperty.call(loadMirrorConfig({}), "instance")).toBe(
      false
    );
  });
});

describe("loadMirrorConfig — invalid configs produce actionable errors", () => {
  it.each(INVALID_CASES)("$name", ({ input, says, issueCount }) => {
    let error: MirrorConfigError | undefined;
    try {
      loadMirrorConfig(input);
    } catch (thrown) {
      error = thrown as MirrorConfigError;
    }

    expect(error).toBeInstanceOf(MirrorConfigError);
    const message = (error as MirrorConfigError).message;
    for (const fragment of says) {
      expect(message).toContain(fragment);
    }
    if (issueCount !== undefined) {
      expect((error as MirrorConfigError).issues).toHaveLength(issueCount);
    }
  });

  it("exposes the issues as data, and heads the message with a count", () => {
    const one = (): unknown => loadMirrorConfig({ formatVersion: 2 });
    const many = (): unknown => loadMirrorConfig({ formatVersion: 2, scopes: 3 });

    expect(one).toThrow(/^mirror\.config\.js is invalid \(1 problem\):/);
    expect(many).toThrow(/^mirror\.config\.js is invalid \(2 problems\):/);

    try {
      many();
      throw new Error("expected loadMirrorConfig to reject this config");
    } catch (thrown) {
      const error = thrown as MirrorConfigError;
      expect(error.name).toBe("MirrorConfigError");
      expect(error.issues).toHaveLength(2);
      // Rendered one per line so a terminal shows a checklist, not a paragraph.
      expect(error.message.split("\n")).toHaveLength(3);
    }
  });
});
