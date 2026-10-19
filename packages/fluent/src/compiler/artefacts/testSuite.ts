// SPDX-License-Identifier: GPL-3.0-or-later
//
// TestSuite() → sys_atf_test_suite and one sys_atf_test_suite_test per test
// (coalesced on suite and test). Order comes from each entry's position unless
// the entry pins it; the hints and errors mirror the SDK's TestSuitePlugin.

import type { FluentValue } from "../evaluate";
import { isGUID } from "../keys";
import type { CompiledRecord, RecordId } from "../record";
import type { ArtefactSpec, BuildContext, Options } from "./shared";

const ENTRY = ["test", "abortOnFailure", "order"];

/** A suite or test given as a sys_id string or a record; an invalid sys_id is reported and skipped. */
function reference(o: Options, ctx: BuildContext, value: FluentValue, table: string, key: string): RecordId | undefined {
  if (value.kind === "string") {
    if (isGUID(value.value)) return ctx.factory.createReference(table, value.value);
    ctx.report("error", `'${value.value}' is not a valid sys_id.`, value.loc);
    return undefined;
  }
  if (value.kind === "call") return ctx.recordOf(value).id;
  return o.error(`TestSuite(): '${key}' must be a sys_id or a record.`, value);
}

function memberships(o: Options, ctx: BuildContext, suite: CompiledRecord): CompiledRecord[] {
  const seenTests = new Set<string>();
  const seenOrders = new Set<number>();
  const rows: CompiledRecord[] = [];
  let previous = 0;
  for (const [index, entry] of (o.array("tests") ?? []).entries()) {
    const form = entry.kind === "object" && entry.props.has("test") ? o.sub(entry, "tests[].", ENTRY) : undefined;
    const pinned = form?.get("order");
    const explicitOrder = form?.number("order");
    const order = explicitOrder ?? previous + 1;
    if (seenOrders.has(order)) {
      ctx.report("hint", `Multiple tests in this suite resolve to order '${order}'. ATF doesn't guarantee run order between ties.`, (pinned ?? entry).loc);
    } else if (explicitOrder !== undefined && explicitOrder <= previous && index > 0) {
      ctx.report(
        "hint",
        `This test's pinned order '${explicitOrder}' is not after the preceding entry's order '${previous}' — its position in 'tests' and its pinned 'order' disagree about run order.`,
        pinned!.loc,
      );
    }
    seenOrders.add(order);
    previous = order;
    const test = reference(o, ctx, form?.get("test") ?? entry, "sys_atf_test", "tests[].test");
    if (test === undefined) continue;
    if (seenTests.has(test.getValue())) {
      ctx.report("error", `Test '${test.getValue()}' is listed more than once in this suite's 'tests' array.`, entry.loc);
      continue;
    }
    seenTests.add(test.getValue());
    rows.push(
      ctx.factory.createRecord({
        table: "sys_atf_test_suite_test",
        source: entry.loc,
        installCategory: o.installCategory,
        fields: {
          test_suite: suite.id,
          test,
          order,
          abort_on_failure: form?.boolean("abortOnFailure") ?? false,
        },
      }),
    );
  }
  return rows;
}

export const testSuite: ArtefactSpec = {
  properties: ["name", "active", "description", "tests", "testFilter", "parent"],
  build(o, ctx) {
    const name = o.string("name") ?? "";
    if (name.trim() === "") ctx.report("error", "'name' must not be empty.", (o.get("name") ?? o.call).loc);
    const parentValue = o.get("parent");
    const parent = parentValue && reference(o, ctx, parentValue, "sys_atf_test_suite", "parent");
    const testFilter = o.string("testFilter") ?? "";
    if (testFilter.trim() !== "" && (o.array("tests")?.length ?? 0) > 0) {
      ctx.report(
        "hint",
        "This suite also lists explicit 'tests'. ATF's filter-driven membership sync is triggered by a business rule on save, not by this install/build — the next time the suite record is saved on the instance, membership rows may be added or removed to match 'testFilter', which may override the explicit list.",
        o.get("testFilter")!.loc,
      );
    }
    const suite = ctx.factory.createRecord({
      table: "sys_atf_test_suite",
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        name,
        active: o.boolean("active") ?? true,
        description: o.string("description") ?? "",
        parent: parent ?? "",
        input_filter: testFilter,
      },
    });
    if (parent !== undefined && parent.getValue() === suite.id.getValue()) {
      ctx.report("error", "A test suite cannot be its own parent.", parentValue!.loc);
    }
    suite.children.push(...memberships(o, ctx, suite));
    return suite;
  },
};
