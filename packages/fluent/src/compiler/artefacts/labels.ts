// SPDX-License-Identifier: GPL-3.0-or-later
//
// The labels and plurals the SDK derives from table and column names when a
// definition does not give them: `x_acme_app_cost_center` → "Cost Center",
// plural "Cost Centers". `startCase` is a port of lodash's, ASCII only, which
// is what the SDK's names can hold.

const ACRONYMS = new Set([
  "css",
  "id",
  "pid",
  "url",
  "uri",
  "xml",
  "html",
  "ip",
  "ci",
  "hr",
  "cmdb",
  "cpu",
  "ecc",
  "ldap",
  "ola",
  "olap",
  "rfc",
  "sla",
  "sql",
  "ui",
  "uid",
  "unix",
  "ups",
  "vpn",
]);

const BREAK = "[\\x00-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7f]";
const WORD = new RegExp(
  [
    `[A-Z]?[a-z]+(?=${BREAK}|[A-Z]|$)`,
    `[A-Z]+(?=${BREAK}|[A-Z][a-z]|$)`,
    "[A-Z]?[a-z]+",
    "[A-Z]+",
    "\\d*(?:1ST|2ND|3RD|(?![123])\\dTH)(?=\\b|[a-z_])",
    "\\d*(?:1st|2nd|3rd|(?![123])\\dth)(?=\\b|[A-Z_])",
    "\\d+",
  ].join("|"),
  "g",
);

/** lodash `startCase`: the words of `text`, each with its first letter upper-cased, joined by spaces. */
export function startCase(text: string): string {
  const words = text.replace(/['’]/g, "").match(WORD) ?? [];
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** The name without its scope prefix: `u_`, `sn_`, or `x_<vendor>_`. */
export function stripPrefix(name: string): string {
  if (name.startsWith("u_")) return name.slice(2);
  if (name.startsWith("sn_")) return name.slice(3);
  if (name.startsWith("x_")) {
    const rest = name.slice(2);
    const underscore = rest.indexOf("_");
    return underscore > 0 ? rest.slice(underscore + 1) : rest;
  }
  return name;
}

function applyAcronyms(label: string): string {
  return label
    .split(" ")
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w))
    .join(" ");
}

/** The label the SDK gives a table or column that declares none. */
export function generateLabel(name: string): string {
  return applyAcronyms(startCase(stripPrefix(name)));
}

const PLURAL_AS_IS = ["s", "ed", "by", "Active", ")", " to", " with", " for", " in", " out", " use", "Data", " data"];
const Y_TO_IES = ["ry", "ty", "dy", "cy", "fy", "ly", "ny"];
const PLUS_ES = ["x", "ch", "sh", "z"];

/** The plural the SDK gives a label that declares none. */
export function generatePlural(label: string): string {
  if (PLURAL_AS_IS.some((end) => label.endsWith(end))) return label;
  if (Y_TO_IES.some((end) => label.endsWith(end))) return `${label.slice(0, label.lastIndexOf("y"))}ies`;
  if (PLUS_ES.some((end) => label.endsWith(end))) return `${label}es`;
  return `${label}s`;
}
