// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `sysparm_query` parsing and evaluation for the fake instance.
 *
 * The only query the mirror is supposed to emit is the keyset form
 * `buildKeysetQuery` produces (`[extra]^sys_id><cursor>^ORDERBYsys_id`), plus
 * the watermark filters the planner adds. This module supports that surface and
 * refuses the rest LOUDLY, because a fake that quietly ignores a condition it
 * does not understand turns "the mirror sent a malformed query" into "the
 * mirror returned too many rows", and the second symptom is discovered three
 * work packages later.
 *
 * Two measured behaviours are reproduced rather than corrected:
 *
 *   - M12: a condition naming a column the table does not have is SILENTLY
 *     dropped by the platform, which then returns every row. That is a
 *     data-loss trap dressed as a successful response (a typo'd scope filter
 *     mirrors the whole instance), so the fake drops it the same way and
 *     reports the dropped names through the request log — visible to a test,
 *     invisible to the client, exactly like production.
 *   - No `ORDERBY` means no guaranteed order. The fake answers such a query in
 *     a deterministically SHUFFLED order rather than in sys_id order: a client
 *     that forgot `ORDERBYsys_id` would page correctly against a fake that
 *     helpfully sorted anyway, and would then skip and duplicate rows against a
 *     real instance. Shuffled-but-deterministic keeps the test suite
 *     reproducible while making the omission fail here instead of in
 *     production.
 *
 * All comparisons are string comparisons. That is not a shortcut: every field
 * on the wire is a string (M8), and the `YYYY-MM-DD HH:MM:SS` date-time format
 * (M9) is lexicographically ordered, so `sys_updated_on>2026-03-01 00:00:00`
 * means what it looks like it means without any date parsing.
 */
import { SeededRandom, seedFromString } from "./prng";
import type { FixtureRow } from "./corpus";

export type QueryOperator =
  | "="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "IN"
  | "LIKE"
  | "STARTSWITH"
  | "ENDSWITH"
  | "ISEMPTY"
  | "ISNOTEMPTY";

export interface QueryCondition {
  field: string;
  operator: QueryOperator;
  value: string;
}

export interface OrderByClause {
  field: string;
  descending: boolean;
}

export interface ParsedQuery {
  conditions: QueryCondition[];
  orderBy: OrderByClause[];
}

/** Thrown for query syntax the fake refuses to guess at. Surfaces as HTTP 400. */
export class UnsupportedQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedQueryError";
  }
}

/**
 * Symbolic operators, longest first.
 *
 * `>=` must be tested before `>` or `sys_updated_on>=X` parses as
 * `sys_updated_on > "=X"` — a condition that matches nothing and would make a
 * watermark sweep look like an empty instance.
 */
const SYMBOLIC_OPERATORS: readonly QueryOperator[] = [">=", "<=", "!=", "=", ">", "<"];

/**
 * Word operators, longest first (`ISNOTEMPTY` before `ISEMPTY`).
 *
 * These are matched case-sensitively as uppercase tokens. Dictionary elements
 * on a ServiceNow instance are lowercase, so an uppercase run inside a
 * condition is unambiguously an operator and never part of a field name.
 */
const WORD_OPERATORS: readonly QueryOperator[] = [
  "ISNOTEMPTY",
  "ISEMPTY",
  "STARTSWITH",
  "ENDSWITH",
  "LIKE",
  "IN",
];

const VALUELESS_OPERATORS: ReadonlySet<QueryOperator> = new Set(["ISEMPTY", "ISNOTEMPTY"]);

/** Segments the fake refuses rather than approximates. */
const REFUSED_PREFIXES: ReadonlyArray<[string, string]> = [
  ["OR", "disjunctions (^OR) are not supported by the fake instance"],
  ["NQ", "new-query segments (^NQ) are not supported by the fake instance"],
];

function parseCondition(segment: string): QueryCondition {
  for (let index = 1; index < segment.length; index += 1) {
    for (const operator of SYMBOLIC_OPERATORS) {
      if (segment.startsWith(operator, index)) {
        return {
          field: segment.slice(0, index),
          operator,
          value: segment.slice(index + operator.length),
        };
      }
    }
    for (const operator of WORD_OPERATORS) {
      if (segment.startsWith(operator, index)) {
        const value = segment.slice(index + operator.length);
        if (VALUELESS_OPERATORS.has(operator) && value !== "") {
          throw new UnsupportedQueryError(`operator ${operator} takes no value, got ${JSON.stringify(value)}`);
        }
        return { field: segment.slice(0, index), operator, value };
      }
    }
  }
  throw new UnsupportedQueryError(`unparseable query segment ${JSON.stringify(segment)}`);
}

export function parseEncodedQuery(raw: string): ParsedQuery {
  const conditions: QueryCondition[] = [];
  const orderBy: OrderByClause[] = [];
  if (raw === "") return { conditions, orderBy };

  for (const segment of raw.split("^")) {
    // `^EQ` terminates an encoded query and an empty segment comes from a
    // trailing or doubled `^`; both are no-ops on a real instance.
    if (segment === "" || segment === "EQ") continue;
    if (segment.startsWith("ORDERBYDESC")) {
      orderBy.push({ field: segment.slice("ORDERBYDESC".length), descending: true });
      continue;
    }
    if (segment.startsWith("ORDERBY")) {
      orderBy.push({ field: segment.slice("ORDERBY".length), descending: false });
      continue;
    }
    const refused = REFUSED_PREFIXES.find(([prefix]) => segment.startsWith(prefix));
    if (refused) throw new UnsupportedQueryError(refused[1]);
    conditions.push(parseCondition(segment));
  }
  return { conditions, orderBy };
}

export function rowMatchesCondition(row: FixtureRow, condition: QueryCondition): boolean {
  const actual = row[condition.field] ?? "";
  const expected = condition.value;
  switch (condition.operator) {
    case "=":
      return actual === expected;
    case "!=":
      return actual !== expected;
    case ">":
      return actual > expected;
    case ">=":
      return actual >= expected;
    case "<":
      return actual < expected;
    case "<=":
      return actual <= expected;
    case "IN":
      return expected.split(",").includes(actual);
    case "LIKE":
      return actual.toLowerCase().includes(expected.toLowerCase());
    case "STARTSWITH":
      return actual.toLowerCase().startsWith(expected.toLowerCase());
    case "ENDSWITH":
      return actual.toLowerCase().endsWith(expected.toLowerCase());
    case "ISEMPTY":
      return actual === "";
    case "ISNOTEMPTY":
      return actual !== "";
    /* c8 ignore next 2 -- exhaustive switch; unreachable while QueryOperator is closed */
    default:
      return false;
  }
}

export interface QueryEvaluation {
  rows: FixtureRow[];
  /** Fields named in conditions that the table does not declare (M12). */
  droppedFields: string[];
}

/**
 * Deterministic Fisher-Yates, seeded from the table name.
 *
 * Used only when the caller supplied no `ORDERBY`. Seeding from the table name
 * (not from a counter) keeps repeated requests for the same unordered query
 * consistent within a run and across runs, so a failure is reproducible.
 */
function deterministicShuffle(rows: FixtureRow[], seedKey: string): FixtureRow[] {
  const out = [...rows];
  const random = new SeededRandom(seedFromString(seedKey));
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = random.nextInt(i + 1);
    const swap = out[i] as FixtureRow;
    out[i] = out[j] as FixtureRow;
    out[j] = swap;
  }
  return out;
}

function compareByOrder(a: FixtureRow, b: FixtureRow, orderBy: readonly OrderByClause[]): number {
  for (const clause of orderBy) {
    const left = a[clause.field] ?? "";
    const right = b[clause.field] ?? "";
    if (left !== right) {
      const sign = left < right ? -1 : 1;
      return clause.descending ? -sign : sign;
    }
  }
  // sys_id as the final tiebreak: without it, two rows equal on the ordered
  // field would come back in insertion order, which changes after a mid-sweep
  // insert and would make a paging test flaky for reasons unrelated to paging.
  const left = a.sys_id ?? "";
  const right = b.sys_id ?? "";
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface ConditionSplit {
  /** Conditions the table can actually evaluate. */
  effective: QueryCondition[];
  /** Fields named in conditions that the table does not declare (M12). */
  droppedFields: string[];
}

/**
 * Split conditions into the ones the table can evaluate and the ones it must
 * silently ignore (M12).
 *
 * `sys_id` is always treated as known: every table has it, and the keyset
 * cursor depends on it, so dropping it would turn a paging bug into an infinite
 * loop over page one.
 */
export function splitConditions(
  conditions: readonly QueryCondition[],
  knownFields: ReadonlySet<string>
): ConditionSplit {
  const effective: QueryCondition[] = [];
  const droppedFields: string[] = [];
  for (const condition of conditions) {
    if (condition.field === "sys_id" || knownFields.has(condition.field)) effective.push(condition);
    else droppedFields.push(condition.field);
  }
  return { effective, droppedFields };
}

export const rowMatchesAll = (row: FixtureRow, conditions: readonly QueryCondition[]): boolean =>
  conditions.every((condition) => rowMatchesCondition(row, condition));

/**
 * Filter and order `rows`.
 *
 * `knownFields` is the table's wire column set; see {@link splitConditions}.
 */
export function evaluateQuery(
  rows: readonly FixtureRow[],
  parsed: ParsedQuery,
  knownFields: ReadonlySet<string>,
  tableName: string
): QueryEvaluation {
  const { effective, droppedFields } = splitConditions(parsed.conditions, knownFields);
  const filtered = rows.filter((row) => rowMatchesAll(row, effective));
  const ordered =
    parsed.orderBy.length === 0
      ? deterministicShuffle(filtered, tableName)
      : [...filtered].sort((a, b) => compareByOrder(a, b, parsed.orderBy));

  return { rows: ordered, droppedFields };
}
