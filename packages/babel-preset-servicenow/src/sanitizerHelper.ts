// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Words ServiceNow's Rhino engine refuses as a bare property name (`a.class`)
 * or object-literal key (`{ class: 1 }`): the ES3 keywords, the words ES3
 * reserved for future use, and the literal names.
 */
const ES3_KEYWORDS =
  "break case catch continue default delete do else finally for function if " +
  "in instanceof new return switch this throw try typeof var void while with";

const ES3_FUTURE_RESERVED =
  "abstract boolean byte char class const debugger double enum export extends " +
  "final float goto implements import int interface long native package " +
  "private protected public short static super synchronized throws transient volatile";

const LITERAL_NAMES = "null true false";

const RESERVED = new Set(
  [ES3_KEYWORDS, ES3_FUTURE_RESERVED, LITERAL_NAMES].join(" ").split(" ")
);

/** True when `word` cannot appear as a dot-accessed property name under ES3. */
export function isReservedWord(word: string): boolean {
  return RESERVED.has(word);
}
