// SPDX-License-Identifier: GPL-3.0-or-later
//
// Key-conflict detection, as the SDK build does it after building every
// record:
//
// - two definitions that come out as the same record (same table and sys_id,
//   e.g. two `Role({ name: 'x' })` calls or one `$id` used twice in a table)
//   are an error, since one would silently replace the other on install;
// - one `$id` declared for records of different tables is an error too: the
//   keys registry holds one entry per `$id`, so the second table would take
//   over the first one's key and the first record's sys_id would change on
//   the next build.
//
// The messages follow the SDK's wording, each definition listed with its
// project-relative path and line.

import path from "node:path";
import type { SourceLocation } from "./diagnostics";
import type { CompiledRecord } from "./record";

export type ConflictReporter = (
  message: string,
  location: SourceLocation,
) => void;

function bySource(a: CompiledRecord, b: CompiledRecord): number {
  return (
    a.source.file.localeCompare(b.source.file) ||
    a.source.line - b.source.line ||
    a.source.column - b.source.column
  );
}

function sameSource(a: SourceLocation, b: SourceLocation): boolean {
  return a.file === b.file && a.line === b.line && a.column === b.column;
}

function groupBy(
  records: readonly CompiledRecord[],
  keyOf: (r: CompiledRecord) => string | undefined,
): CompiledRecord[][] {
  const groups = new Map<string, CompiledRecord[]>();
  for (const record of records) {
    const key = keyOf(record);
    if (key !== undefined)
      groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.values()].map((group) => group.sort(bySource));
}

/** Reports every key conflict among `records` (all records of the build, children included) and returns how many. */
export function reportKeyConflicts(
  records: readonly CompiledRecord[],
  projectDir: string,
  report: ConflictReporter,
): number {
  let conflicts = 0;
  const where = (r: CompiledRecord) =>
    `${path.relative(projectDir, r.source.file).split(path.sep).join("/")}:${r.source.line}`;
  const list = (
    group: CompiledRecord[],
    label: (r: CompiledRecord) => string,
  ) => group.map((r, i) => `${i + 1}. ${label(r)}${where(r)}`).join("\n    ");

  const distinct: CompiledRecord[] = [];
  for (const group of groupBy(
    records,
    (r) => `${r.table}.${r.id.getValue()}`,
  )) {
    // One definition can yield the same record twice (a role listed twice on an ACL); that is not a conflict.
    const definitions = group.filter(
      (r, i) =>
        !group
          .slice(0, i)
          .some((earlier) => sameSource(earlier.source, r.source)),
    );
    distinct.push(definitions[0]);
    if (definitions.length < 2) continue;
    const [first] = definitions;
    conflicts++;
    report(
      `Record "${first.table}.${first.id.getValue()}" is defined ${definitions.length} times in the project:\n    ${list(definitions, () => "")}`,
      definitions[1].source,
    );
  }

  for (const group of groupBy(distinct, (r) => r.explicitKey)) {
    if (group.length < 2) continue;
    conflicts++;
    report(
      `Explicit key "${group[0].explicitKey}" is defined multiple times in the project:\n    ${list(group, (r) => `[${r.table}] `)}`,
      group[1].source,
    );
  }

  return conflicts;
}
