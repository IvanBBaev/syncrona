#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Source files must be plain, reviewable text.
//
// WHY THIS EXISTS: `packages/mirror/src/catalog/catalogService.ts` was written
// with two literal NUL bytes in it -- a deliberate, and correct, choice of
// separator for a composite sort key (`${table}\u0000${kind}\u0000${detail}`),
// but written as raw bytes rather than as escapes. That file passed `tsc`,
// passed `eslint`, and passed the full test suite. Nothing in the repository
// noticed. What it did NOT pass was `grep`: GNU/BSD grep classifies a file
// containing a NUL as binary and reports ZERO matches in it, silently and with
// exit status 1. Every search of that file -- including a reviewer grepping for
// a security pattern -- came back clean because the file was unsearchable, not
// because it was clean.
//
// The same audit found a raw U+200B (zero-width space) in
// `packages/mcp-server/src/runtimeUtils.ts`, on the line whose entire security
// value IS that character: it splices a zero-width space into any copy of the
// untrusted-data fence a hostile value carries, so the token stops matching.
// Written literally, that line reads to a reviewer as a join with no effect.
// The defence was invisible in the editor, invisible in the diff, and findable
// only by someone who already suspected it was there.
//
// So: the rule is not "no unusual characters". It is that a character a reader
// cannot SEE must be written as an escape a reader CAN see. `"\u0000"` and a raw
// NUL are the same string at runtime; only one of them survives review.
//
// WHAT IS REJECTED
//   * bytes that are not valid UTF-8
//   * C0 control characters other than tab, LF and CR, and DEL (U+007F)
//   * the BOM (U+FEFF) anywhere, including position 0
//   * zero-width characters: U+200B, U+200C, U+200D, U+2060
//   * bidirectional overrides -- the "Trojan Source" class (CVE-2021-42574):
//     U+061C, U+200E, U+200F, U+202A..U+202E, U+2066..U+2069
//
// PROSE EXCEPTION: in Markdown and plain text, U+200C and U+200D are allowed.
// ZWJ is load-bearing inside emoji sequences and there is no escape form that
// renders, so rejecting it would make the gate wrong rather than strict. Every
// other rule applies to prose too -- a bidi override hidden in a documentation
// code sample is precisely the attack the Trojan Source paper describes, and a
// zero-width SPACE has no legitimate use in prose at all.
//
// SELF-PROVING: the detector is run against synthetic inputs on EVERY
// invocation, before the real scan, not in a separate self-test someone can
// forget to wire up. A gate whose firing was never demonstrated is a gate that
// might be reporting "clean" because it is broken. The synthetic inputs are
// built in memory from character codes; nothing is ever planted in the real
// tree. If any probe fails to trip, or the clean control trips, the gate exits
// non-zero and refuses to report on the repository at all -- a broken detector
// must never be able to say "no findings".
//
// FILE SELECTION: `git ls-files` plus untracked-but-not-ignored files. That is
// deliberately the set of files that can reach a commit -- it picks up a brand
// new package before its first `git add` (which is exactly when this defect was
// introduced), and it inherits every ignore rule for free, so `node_modules`,
// `coverage`, `dist` and `.stryker-tmp` never enter the walk.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

/** Extensions worth checking: the ones whose content is read by humans. */
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".md",
  ".yml",
  ".yaml",
  ".sh",
  ".bash",
  ".zsh",
  ".txt",
  ".toml",
  ".cfg",
  ".ini",
]);

/** Extensions treated as prose, where ZWJ/ZWNJ are allowed (see PROSE EXCEPTION). */
const PROSE_EXTENSIONS = new Set([".md", ".txt"]);

/**
 * The rejected code points, each with the reason a reader needs and the escape
 * that replaces it. Keyed by code point so a finding can name itself precisely
 * rather than saying "an invisible character somewhere on this line".
 */
const REJECTED = new Map([
  [0x200b, "zero-width space"],
  [0x200c, "zero-width non-joiner"],
  [0x200d, "zero-width joiner"],
  [0x2060, "word joiner"],
  [0xfeff, "byte-order mark / zero-width no-break space"],
  [0x061c, "arabic letter mark (bidi)"],
  [0x200e, "left-to-right mark (bidi)"],
  [0x200f, "right-to-left mark (bidi)"],
  [0x202a, "left-to-right embedding (bidi)"],
  [0x202b, "right-to-left embedding (bidi)"],
  [0x202c, "pop directional formatting (bidi)"],
  [0x202d, "left-to-right override (bidi)"],
  [0x202e, "right-to-left override (bidi)"],
  [0x2066, "left-to-right isolate (bidi)"],
  [0x2067, "right-to-left isolate (bidi)"],
  [0x2068, "first strong isolate (bidi)"],
  [0x2069, "pop directional isolate (bidi)"],
]);

/** Allowed in prose only. */
const PROSE_ALLOWED = new Set([0x200c, 0x200d]);

const C0_ALLOWED = new Set([0x09, 0x0a, 0x0d]);

const describeControl = (code) => {
  if (code === 0x7f) return "DEL";
  const names = {
    0x00: "NUL",
    0x07: "BEL",
    0x08: "backspace",
    0x0b: "vertical tab",
    0x0c: "form feed",
    0x1a: "SUB",
    0x1b: "ESC",
  };
  return names[code] ?? "C0 control";
};

const escapeFor = (code) => `\\u${code.toString(16).padStart(4, "0")}`;

/**
 * Scan one file's text. Returns a list of findings; an empty list means clean.
 *
 * Takes text and a flag rather than a path so the self-test can drive it with
 * synthetic input without touching the filesystem.
 */
function findViolations(text, { prose }) {
  const findings = [];
  let line = 1;
  let column = 1;

  for (const ch of text) {
    const code = ch.codePointAt(0);
    let reason = null;

    if (code < 0x20 && !C0_ALLOWED.has(code)) {
      reason = describeControl(code);
    } else if (code === 0x7f) {
      reason = describeControl(code);
    } else if (REJECTED.has(code) && !(prose && PROSE_ALLOWED.has(code))) {
      reason = REJECTED.get(code);
    }

    if (reason !== null) {
      findings.push({ line, column, code, reason });
    }

    if (ch === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return findings;
}

/**
 * Prove the detector fires, before trusting it to say a repository is clean.
 *
 * Each probe is a (description, input, prose flag, expectation) tuple built from
 * `String.fromCodePoint` -- the probe characters are never written literally
 * here either, both because this file is subject to its own rule and because a
 * literal probe would be as invisible in this file as in any other.
 */
function selfTest() {
  const zwsp = String.fromCodePoint(0x200b);
  const rlo = String.fromCodePoint(0x202e);
  const zwj = String.fromCodePoint(0x200d);
  const nul = String.fromCodePoint(0x00);
  const bom = String.fromCodePoint(0xfeff);

  const probes = [
    ["a NUL in a template literal", `const k = \`\${a}${nul}\${b}\`;`, false, 1],
    ["a NUL on the second line reports line 2", `x\nconst k = "${nul}";`, false, 1],
    ["a zero-width space in a string", `join("FENCE${zwsp}")`, false, 1],
    ["a right-to-left override", `const x = "admin${rlo}";`, false, 1],
    ["a BOM at position 0", `${bom}const x = 1;`, false, 1],
    ["an ESC character", `const x = "${String.fromCodePoint(0x1b)}[31m";`, false, 1],
    ["two findings in one file are both reported", `${nul}${zwsp}`, false, 2],
    ["a zero-width joiner in code", `const emoji = "a${zwj}b";`, false, 1],
    ["a zero-width joiner in prose is allowed", `Emoji: a${zwj}b`, true, 0],
    ["a zero-width space in prose is still rejected", `Text${zwsp}here`, true, 1],
    ["a NUL in prose is still rejected", `Text${nul}here`, true, 1],
    ["the escape form is not a finding", 'const k = `${a}\\u0000${b}`;', false, 0],
    ["ordinary source is clean", 'const x = 1;\n\t// tab and newline are fine\r\n', false, 0],
    ["non-ASCII text is not a finding", "const s = \"é你好 АБВ\";", false, 0],
  ];

  const failures = [];
  for (const [description, input, prose, expected] of probes) {
    const actual = findViolations(input, { prose }).length;
    if (actual !== expected) {
      failures.push(`  ${description}: expected ${expected} finding(s), got ${actual}`);
    }
  }

  // The line/column report is part of the contract -- a finding nobody can
  // locate is a finding nobody fixes.
  const located = findViolations(`ok\nconst k = "${nul}";`, { prose: false })[0];
  if (!located || located.line !== 2 || located.column !== 12) {
    failures.push(
      `  position reporting: expected line 2 column 12, got ${
        located ? `line ${located.line} column ${located.column}` : "no finding"
      }`
    );
  }

  if (failures.length > 0) {
    console.error(
      [
        "source-text: SELF-TEST FAILED — the detector is broken.",
        "",
        ...failures,
        "",
        "  Refusing to scan the repository: a detector that cannot demonstrate it",
        "  fires must never be allowed to report 'no findings'.",
      ].join("\n")
    );
    process.exit(2);
  }
}

/** Tracked files plus untracked-not-ignored ones — everything that can reach a commit. */
function listCandidateFiles() {
  const run = (args) => {
    const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      console.error(
        `source-text: \`git ${args.join(" ")}\` failed.\n` +
          "This gate selects files through git so it inherits the ignore rules; it\n" +
          "cannot fall back to a directory walk without also scanning node_modules."
      );
      process.exit(2);
    }
    return result.stdout.split("\0").filter(Boolean);
  };

  const tracked = run(["ls-files", "-z"]);
  const untracked = run(["ls-files", "-z", "--others", "--exclude-standard"]);
  return [...new Set([...tracked, ...untracked])].sort();
}

selfTest();

if (process.argv.includes("--self-test-only")) {
  console.log("source-text: self-test OK — every probe fires and the clean controls pass.");
  process.exit(0);
}

const findings = [];
let scanned = 0;

for (const relative of listCandidateFiles()) {
  if (!TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
    continue;
  }

  const absolute = path.join(repoRoot, relative);
  let bytes;
  try {
    bytes = fs.readFileSync(absolute);
  } catch {
    // A file listed by git but unreadable now (a race with a concurrent edit,
    // a broken symlink) is not this gate's business to adjudicate.
    continue;
  }

  scanned += 1;

  // `TextDecoder` with `fatal` is the only check that distinguishes real UTF-8
  // from bytes that decode to U+FFFD. Silent replacement would let a mojibake
  // file through as "clean text".
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    findings.push({ file: relative, line: 0, column: 0, code: -1, reason: "not valid UTF-8" });
    continue;
  }

  const prose = PROSE_EXTENSIONS.has(path.extname(relative).toLowerCase());
  for (const violation of findViolations(text, { prose })) {
    findings.push({ file: relative, ...violation });
  }
}

if (findings.length === 0) {
  console.log(`source-text: OK — ${scanned} files, no control or invisible characters.`);
  process.exit(0);
}

const lines = [
  `source-text: ${findings.length} finding(s) across ${scanned} scanned files.`,
  "",
];

for (const finding of findings) {
  if (finding.code === -1) {
    lines.push(`  ${finding.file}: ${finding.reason}`);
    continue;
  }
  lines.push(
    `  ${finding.file}:${finding.line}:${finding.column}  U+${finding.code
      .toString(16)
      .toUpperCase()
      .padStart(4, "0")} ${finding.reason} — write it as ${escapeFor(finding.code)}`
  );
}

lines.push(
  "",
  "  These characters are invisible in an editor and in a diff. A file holding a",
  "  NUL is reported as binary by grep, which then finds NOTHING in it and says so",
  "  with a clean exit — so every future search of that file lies to you.",
  "",
  "  The fix is never to remove the character's effect, only its literal form:",
  "  the escape and the raw byte are the same string at runtime. Replace it with",
  "  the escape shown above and leave a comment saying why the character is there.",
  "",
  "  In Markdown and plain text, U+200C and U+200D are allowed (emoji sequences",
  "  need them and no escape form renders). Everything else applies to prose too."
);

console.error(lines.join("\n"));
process.exit(1);
