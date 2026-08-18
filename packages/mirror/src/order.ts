// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The one ordering primitive shared by everything that sorts on the way to a file.
 *
 * It lives in a module of its own rather than inside whichever stage happened to
 * need it first. `compareBytewise` began in the catalog service, and by the time the
 * shard parser and the deletion authority each needed to order a list of objects by
 * a string key, two hand-rolled copies of the same ternary existed. A one-line
 * utility is exactly the kind of thing that gets retyped instead of imported, and
 * retyped copies do not stay identical: the first one written with `localeCompare`
 * sorts `sys_ui_action` before `sys_uiaction` on one machine and after it on
 * another, and INV-1 is gone with no test able to see it — because every machine
 * agrees with itself.
 *
 * Importing from here also keeps the dependency edge pointing the right way. The
 * writer needing a comparator is not a reason for `write/` to import `catalog/`.
 *
 * What this module is NOT is a ban on `array.sort()`. Called with no comparator on a
 * `string[]`, `Array.prototype.sort` is specified to compare by UTF-16 code units —
 * the same order this function computes — and rewriting those call sites would be
 * churn with no behavioural difference. `compareBytewise` is for the cases where a
 * comparator is unavoidable: ordering objects by a string field, or breaking a tie
 * after a numeric key. The thing that genuinely must never appear is a
 * locale-sensitive comparison, and `test/order.test.ts` fails if one does.
 */

/**
 * Byte-order string comparison.
 *
 * `String.prototype.localeCompare` and `Intl.Collator` sort by something other than
 * code units — `localeCompare` puts `sys_ui_action` before `sys_uiaction` under some
 * ICU locales and after it under others, and the ICU version is a property of the
 * Node build, not of the repository. INV-1 says a re-run against an unchanged
 * instance produces an identical tree, and the machine that ran the sweep is not an
 * input the mirror is allowed to have.
 */
export const compareBytewise = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
