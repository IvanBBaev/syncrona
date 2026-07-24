// SPDX-License-Identifier: GPL-3.0-or-later
//
// Claims-drift gate. Product claims live in three public artifacts — the root
// README, the marketing comparison page, and the live site (docs/index.html).
// The `syncro-now-ai` -> `syncrona` rename and the license/OAuth stories have
// each drifted between these surfaces before. This asserts a tiny hand-curated
// manifest of stable markers (brand name, current bin name) against each
// artifact, and forbids the old bin invocation from creeping back in. It is a
// grep-gate, not a semantic check: keep the manifest small and stable.
//
// It additionally enforces the site's numeric-claims contract: the version
// badge and the "NN CLI commands" / "NN MCP tools" / "NN build plugins" /
// auth-method claims in docs/index.html are checked against the code they
// describe (packages/core and packages/mcp-server), so the hand-maintained
// site can no longer drift from machine-verifiable facts.
const fs = require('node:fs');
const path = require('node:path');
const { extractToolBlocks } = require('./generate-tool-reference.js');

const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');

// --- Site numeric-claims contract (docs/index.html vs code) ---
const INDEX_HTML_PATH = 'docs/index.html';
// The version badge tracks the core CLI package, NOT the root package.json
// (the root version lags behind published releases by design).
const CORE_PACKAGE_JSON = 'packages/core/package.json';
const CLI_COMMANDS_SOURCE = 'packages/core/src/cliCommands.ts';
const TOOL_SCHEMAS_SOURCE = 'packages/mcp-server/src/toolSchemas.ts';
const AUTH_COMMANDS_SOURCE = 'packages/core/src/authCommands.ts';

// The six packages behind the site's "NN build plugins" claim. eslint-plugin
// and prettier-plugin are deliberately excluded: they are lint/format tooling,
// not build-pipeline plugins, so they do not count toward "build plugins".
const BUILD_PLUGIN_PACKAGES = [
  'packages/babel-plugin',
  'packages/babel-plugin-remove-modules',
  'packages/babel-preset-servicenow',
  'packages/sass-plugin',
  'packages/typescript-plugin',
  'packages/webpack-plugin',
];

// Minimum floor of auth-method identifiers the site must document. The first
// five are the `LoginMethod` values accepted by `--auth-method`; `mtls` is not
// a LoginMethod value but the orthogonal mutual-TLS capability (client
// cert/key), which the login flow supports and the site must mention. The
// actual required set is this floor UNIONED with whatever parseAuthMethods()
// finds in authCommands.ts, so a newly added method is required automatically.
const AUTH_METHOD_FLOOR = [
  'basic',
  'oauth-password',
  'oauth-client-credentials',
  'oauth-jwt-bearer',
  'api-key',
  'mtls',
];

const VERSION_BADGE_REGEX = /<span class="version">\s*v(\d+\.\d+\.\d+)/g;
// Mirrors the tool-name parsing used by check-docs-drift.js. Every quote style
// the compiler accepts for a string literal must be accepted here too: keying on
// double quotes alone makes a `name: 'x'` declaration invisible to the gate, and
// nothing in this repo enforces a quote style.
const TOOL_NAME_REGEX = /name:\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/g;
const AUTH_METHOD_VALUE_REGEX = /value:\s*(?:"([a-z0-9-]+)"|'([a-z0-9-]+)'|`([a-z0-9-]+)`)/g;
// First quoted token of a `command:` registry property, whether the value is a
// bare string or an array literal whose head is the primary name. Indentation is
// deliberately NOT part of the pattern — a registry entry nested one level deeper
// (or reformatted) is still a command, and anchoring on a fixed column made such
// an entry invisible to both the count and the name set. The leading boundary
// keeps `subcommand:`-style properties out, and requiring a quote right after the
// colon keeps the `command: string | string[]` type declaration out.
const CLI_COMMAND_NAME_REGEX = /(?:^|[\s,{])command:\s*(?:\[\s*)?(?:"([^"]+)"|'([^']+)')/gm;
// Counts `command:` registry PROPERTIES independently of whether the name parser
// can read their value: it matches any command property whose value opens a
// literal — an array (`[`), a string (`"`/`'`), or a template (`` ` ``) — while the
// leading boundary and the required literal opener keep `subcommand:` and the
// `command: string | string[]` type declaration out, exactly like the name regex.
// It deliberately accepts the backtick form the name regex does NOT, so a template
// command value (or a duplicate registration collapsed by the name set's dedup)
// makes this entry count exceed the parsed-name count — the drift the cross-check
// below surfaces instead of silently dropping the entry.
const CLI_COMMAND_ENTRY_REGEX = /(?:^|[\s,{])command:\s*(?:\[|"|'|`)/gm;

function firstCapture(match) {
  return match[1] ?? match[2] ?? match[3];
}

// Each entry: a literal marker that MUST appear in every listed file (paths are
// repo-root-relative).
const REQUIRED_MARKERS = [
  { marker: 'SyncroNow AI', files: ['README.md', 'docs/COMPARISON.md', 'docs/index.html'] },
  { marker: 'syncrona', files: ['README.md', 'docs/index.html'] },
];

// The old bin name must not return as a command invocation in any public
// artifact. `syncro-now-ai` may still be referenced in prose (e.g. a
// "formerly syncro-now-ai" note), so only the command forms are forbidden.
const FORBIDDEN_PATTERNS = [
  { pattern: /npx syncro-now-ai\b/, label: 'npx syncro-now-ai (old bin invocation)' },
  { pattern: /`syncro-now-ai /, label: '`syncro-now-ai <cmd>` (old bin command form)' },
];
const FORBIDDEN_FILES = ['README.md', 'docs/COMPARISON.md', 'docs/index.html'];

function readFileOrNull(rootDir, relPath) {
  const abs = path.join(rootDir, relPath);
  if (!fs.existsSync(abs)) {
    return null;
  }
  return fs.readFileSync(abs, 'utf-8');
}

// Primary command NAMES from the `command:` registry entries of cliCommands.ts.
// A `command` value is either a bare string ("download <scope>") or an array
// whose first element is the primary name and the rest are aliases
// (["dev", "d"]); either way the first quoted token holds the name, and any
// positional-argument suffix (`<scope>`, `[target]`) is stripped.
// Exported so the CLAUDE/README drift gate can check the docs against code
// rather than only against each other.
function parseCliCommandNames(raw) {
  const names = [...raw.matchAll(CLI_COMMAND_NAME_REGEX)]
    .map((match) => firstCapture(match).trim().split(/\s+/)[0])
    .filter((name) => name.length > 0);
  return [...new Set(names)].sort();
}

// CLI command count = distinct registry entries in cliCommands.ts. Derived from
// the same parse as the name set so the two can never disagree: a line count
// keyed on layout counted entries the name parser did not recognise (and vice
// versa), which let a reformatted registry drift past this gate.
function countCliCommands(raw) {
  return parseCliCommandNames(raw).length;
}

// Structural count of `command:` registry properties, read independently of the
// name parser (see CLI_COMMAND_ENTRY_REGEX).
function countCliCommandEntries(raw) {
  return [...raw.matchAll(CLI_COMMAND_ENTRY_REGEX)].length;
}

// Cross-check: the number of structural command entries must equal the number of
// distinct parsed names. They agree for a well-formed registry; they diverge when
// a duplicate command name is registered (the name set's dedup shrinks it) or a
// command's value is a form the name parser cannot read (e.g. a template literal),
// either of which would otherwise let a registry entry vanish from the "NN CLI
// commands" claim unnoticed. Surfacing the divergence turns a silent drop into a
// gate failure.
function crossCheckCliCommands(raw) {
  const entries = countCliCommandEntries(raw);
  const names = parseCliCommandNames(raw).length;
  return { ok: entries === names, entries, names };
}

// Structural read of the schema source: scope to the `BASE_MCP_TOOLS` array and
// take each tool object's own first `name:` literal, so the "NN MCP tools" claim
// can never be inflated by a `name: "..."` in a comment, a description string, or
// an object literal outside the array. Returns null when the array is absent (a
// bare `name:`-only fixture) so the caller falls back to the whole-file scan.
function declaredToolNamesFromBlocks(raw) {
  let blocks;
  try {
    blocks = extractToolBlocks(raw);
  } catch {
    return null;
  }
  const names = [];
  for (const block of blocks) {
    const match = new RegExp(TOOL_NAME_REGEX.source).exec(block);
    if (match) {
      names.push(firstCapture(match));
    }
  }
  return names;
}

// Unique declared MCP tool names (same parsing approach as check-docs-drift.js).
function parseToolNamesFromSchemas(raw) {
  const structural = declaredToolNamesFromBlocks(raw);
  const names =
    structural !== null ? structural : [...raw.matchAll(TOOL_NAME_REGEX)].map(firstCapture);
  return [...new Set(names)];
}

// Auth-method identifiers the CLI accepts, parsed from the
// LOGIN_METHOD_CHOICES array in authCommands.ts (the set `--auth-method`
// validates against), unioned with the hardcoded floor so a refactor of the
// choices array cannot silently shrink the documented surface.
function parseAuthMethods(raw) {
  const start = raw.indexOf('LOGIN_METHOD_CHOICES');
  const end = start === -1 ? -1 : raw.indexOf('];', start);
  const block = start === -1 || end === -1 ? '' : raw.slice(start, end);
  const parsed = [...block.matchAll(AUTH_METHOD_VALUE_REGEX)].map(firstCapture);
  return [...new Set([...parsed, ...AUTH_METHOD_FLOOR])].sort();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Isolate the Security & credentials section (`<section ... id="security">`) so
// the auth-method gate cannot be satisfied by a stray token elsewhere on the
// page. Without this, a page-wide substring match passes on any unrelated word
// that merely contains a method name — e.g. "basically" would satisfy "basic"
// even after every real Basic-auth reference had been deleted. Returns null when
// the section is absent so the caller reports that instead of silently passing.
function extractAuthSection(html) {
  const startIdx = html.indexOf('id="security"');
  if (startIdx === -1) {
    return null;
  }
  const endIdx = html.indexOf('</section>', startIdx);
  return endIdx === -1 ? html.slice(startIdx) : html.slice(startIdx, endIdx);
}

// Occurrences of a numeric claim like "22 CLI commands" in the page. Claims
// appear both in plain text/attribute form (meta descriptions, prose) and as
// adjacent stat markup (<div>22</div><div>CLI commands</div>), so both the raw
// HTML and a tag-stripped rendering are scanned. Every occurrence must carry
// the same number — a page that says 22 in one place and 21 in another drifts.
// Section-number headings are NOT claims: the live page's "§07 Build plugins"
// heading strips to "07 Build plugins", so zero-padded numbers (`[1-9]\d*`
// with a `(?<!\d)` boundary) and `§`-prefixed numbers are excluded.
function extractNumericClaims(html, label) {
  const claimRegex = new RegExp(`(?<!§\\s{0,4})(?<!\\d)([1-9]\\d*)\\s+${label}`, 'gi');
  const stripped = html.replace(/<[^>]*>/g, ' ');
  const values = new Set();
  for (const text of [html, stripped]) {
    for (const match of text.matchAll(claimRegex)) {
      values.add(Number(match[1]));
    }
  }
  return [...values];
}

function validateClaimsDrift(opts = {}) {
  const rootDir = opts.rootDir || ROOT_DIR;
  const requiredMarkers = Array.isArray(opts.requiredMarkers)
    ? opts.requiredMarkers
    : REQUIRED_MARKERS;
  const forbiddenPatterns = Array.isArray(opts.forbiddenPatterns)
    ? opts.forbiddenPatterns
    : FORBIDDEN_PATTERNS;
  const forbiddenFiles = Array.isArray(opts.forbiddenFiles) ? opts.forbiddenFiles : FORBIDDEN_FILES;

  // Optional index.html override (CLI arg / SYNC_CLAIMS_INDEX_HTML env) so the
  // site checks can run against a fixture; every read of docs/index.html —
  // marker, forbidden-pattern and numeric-claims checks alike — honours it.
  const indexHtmlPath =
    typeof opts.indexHtmlPath === 'string' && opts.indexHtmlPath.length > 0
      ? opts.indexHtmlPath
      : null;

  const errors = [];
  const contentCache = new Map();
  const getContent = (relPath) => {
    if (!contentCache.has(relPath)) {
      if (relPath === INDEX_HTML_PATH && indexHtmlPath) {
        contentCache.set(
          relPath,
          fs.existsSync(indexHtmlPath) ? fs.readFileSync(indexHtmlPath, 'utf-8') : null
        );
      } else {
        contentCache.set(relPath, readFileOrNull(rootDir, relPath));
      }
    }
    return contentCache.get(relPath);
  };

  let checked = 0;
  for (const { marker, files } of requiredMarkers) {
    for (const relPath of files) {
      const content = getContent(relPath);
      if (content === null) {
        errors.push(`Missing claims artifact: ${relPath}`);
        continue;
      }
      checked += 1;
      if (!content.includes(marker)) {
        errors.push(`Missing required claim "${marker}" in ${relPath}`);
      }
    }
  }

  for (const relPath of forbiddenFiles) {
    const content = getContent(relPath);
    if (content === null) {
      errors.push(`Missing claims artifact: ${relPath}`);
      continue;
    }
    for (const { pattern, label } of forbiddenPatterns) {
      if (pattern.test(content)) {
        errors.push(`Forbidden claim ${label} found in ${relPath}`);
      }
    }
  }

  // --- Site numeric-claims contract ---
  // Skipped when docs/index.html is absent: the marker loop above already
  // reports the missing artifact, and there is nothing to compare against.
  const html = getContent(INDEX_HTML_PATH);
  if (html !== null) {
    // 1. Version badge must match the core CLI package version.
    const corePkgRaw = getContent(CORE_PACKAGE_JSON);
    if (corePkgRaw === null) {
      errors.push(`Missing claims source: ${CORE_PACKAGE_JSON}`);
    } else {
      let coreVersion = null;
      try {
        coreVersion = JSON.parse(corePkgRaw).version || null;
      } catch {
        coreVersion = null;
      }
      if (!coreVersion) {
        errors.push(`Unreadable "version" in ${CORE_PACKAGE_JSON}`);
      } else {
        checked += 1;
        const badges = [...new Set([...html.matchAll(VERSION_BADGE_REGEX)].map((m) => m[1]))];
        if (badges.length === 0) {
          errors.push(
            `Missing version badge (<span class="version">vX.Y.Z) in ${INDEX_HTML_PATH}: ` +
              `expected v${coreVersion} (${CORE_PACKAGE_JSON})`
          );
        }
        for (const found of badges) {
          if (found !== coreVersion) {
            errors.push(
              `Version badge drift in ${INDEX_HTML_PATH}: ` +
                `expected v${coreVersion} (${CORE_PACKAGE_JSON}), found v${found}`
            );
          }
        }
      }
    }

    // 2–4. Numeric claims: "NN CLI commands", "NN MCP tools", "NN build plugins".
    const numericClaims = [];

    const cliRaw = getContent(CLI_COMMANDS_SOURCE);
    if (cliRaw === null) {
      errors.push(`Missing claims source: ${CLI_COMMANDS_SOURCE}`);
    } else {
      // Internal consistency of the registry BEFORE it backs a public claim: a
      // structural entry count that outruns the distinct-name count means an entry
      // was dropped (unreadable value) or duplicated, so the claimed number would
      // be wrong at the source.
      const crossCheck = crossCheckCliCommands(cliRaw);
      if (!crossCheck.ok) {
        errors.push(
          `CLI command registry drift in ${CLI_COMMANDS_SOURCE}: ` +
            `${crossCheck.entries} command entr${crossCheck.entries === 1 ? 'y' : 'ies'} declared ` +
            `but ${crossCheck.names} distinct name${crossCheck.names === 1 ? '' : 's'} parsed ` +
            `(a duplicate registration or a command value the name parser cannot read).`
        );
      }
      numericClaims.push({
        label: 'CLI commands',
        expected: countCliCommands(cliRaw),
        source: CLI_COMMANDS_SOURCE,
      });
    }

    const toolsRaw = getContent(TOOL_SCHEMAS_SOURCE);
    if (toolsRaw === null) {
      errors.push(`Missing claims source: ${TOOL_SCHEMAS_SOURCE}`);
    } else {
      numericClaims.push({
        label: 'MCP tools',
        expected: parseToolNamesFromSchemas(toolsRaw).length,
        source: TOOL_SCHEMAS_SOURCE,
      });
    }

    const missingPluginDirs = BUILD_PLUGIN_PACKAGES.filter(
      (relPath) => !fs.existsSync(path.join(rootDir, relPath))
    );
    if (missingPluginDirs.length > 0) {
      errors.push(
        `Missing build-plugin package dir(s) backing the "build plugins" claim: ` +
          missingPluginDirs.join(', ')
      );
    } else {
      numericClaims.push({
        label: 'build plugins',
        expected: BUILD_PLUGIN_PACKAGES.length,
        source: 'packages/* build-plugin dirs',
      });
    }

    for (const { label, expected, source } of numericClaims) {
      checked += 1;
      const found = extractNumericClaims(html, label);
      if (found.length === 0) {
        errors.push(
          `Missing claim "<n> ${label}" in ${INDEX_HTML_PATH}: ` +
            `expected "${expected} ${label}" (${source})`
        );
        continue;
      }
      for (const value of found) {
        if (value !== expected) {
          errors.push(
            `Claim drift in ${INDEX_HTML_PATH}: ` +
              `expected "${expected} ${label}" (${source}), found "${value} ${label}"`
          );
        }
      }
    }

    // 5. Every auth-method identifier the CLI accepts must appear on the site.
    const authRaw = getContent(AUTH_COMMANDS_SOURCE);
    if (authRaw === null) {
      errors.push(`Missing claims source: ${AUTH_COMMANDS_SOURCE}`);
    } else {
      const authSection = extractAuthSection(html);
      if (authSection === null) {
        errors.push(
          `Missing auth section (id="security") in ${INDEX_HTML_PATH} ` +
            `(required to document methods accepted by ${AUTH_COMMANDS_SOURCE})`
        );
      } else {
        const lowerAuthSection = authSection.toLowerCase();
        for (const method of parseAuthMethods(authRaw)) {
          checked += 1;
          // Word-boundary match scoped to the auth section: the method name must
          // be a whole token (so "basic" is not matched inside "basically") and
          // must appear within the security markup, not anywhere on the page.
          const token = escapeRegExp(method.toLowerCase());
          const boundary = new RegExp(`(?<![a-z0-9-])${token}(?![a-z0-9-])`);
          if (!boundary.test(lowerAuthSection)) {
            errors.push(
              `Missing auth method "${method}" in ${INDEX_HTML_PATH} ` +
                `(accepted by ${AUTH_COMMANDS_SOURCE})`
            );
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, checked };
}

const INDEX_HTML_FLAG = '--index-html=';
const CLI_USAGE = [
  'Usage: node check-claims-drift.js [--index-html=<path>] [<path-to-index.html>]',
  '',
  'Options:',
  '  --index-html=<path>  Validate this file instead of the repository default.',
  '  -h, --help           Print this message.',
  '',
  'Environment:',
  '  SYNC_CLAIMS_INDEX_HTML  Same as --index-html; an explicit argument wins.',
].join('\n');

function runCli(opts = {}) {
  const out = opts.console || console;

  if (opts.help) {
    out.log(CLI_USAGE);
    return 0;
  }

  const unknownArgs = Array.isArray(opts.unknownArgs) ? opts.unknownArgs : [];
  if (unknownArgs.length > 0) {
    out.error(`Unrecognized argument${unknownArgs.length > 1 ? 's' : ''}: ${unknownArgs.join(', ')}`);
    out.error(CLI_USAGE);
    return 1;
  }

  const result = validateClaimsDrift(opts);
  if (!result.ok) {
    out.error('Claims drift check failed.');
    for (const error of result.errors) {
      out.error(`- ${error}`);
    }
    return 1;
  }
  out.log(`Claims drift check passed (${result.checked} required claims aligned).`);
  return 0;
}

function parseRuntimeOverrides(env = process.env, argv = process.argv) {
  const fromEnv = typeof env.SYNC_CLAIMS_INDEX_HTML === 'string'
    ? env.SYNC_CLAIMS_INDEX_HTML.trim()
    : '';

  let fromArg = '';
  let help = false;
  const unknownArgs = [];

  for (const raw of argv.slice(2)) {
    const arg = typeof raw === 'string' ? raw.trim() : '';
    if (arg.length === 0) {
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg.startsWith(INDEX_HTML_FLAG)) {
      const value = arg.slice(INDEX_HTML_FLAG.length).trim();
      if (value.length === 0) {
        unknownArgs.push(arg);
        continue;
      }
      fromArg = value;
      continue;
    }
    // A flag-looking argument is never a path. `--verbose` used to be accepted as
    // the index.html path and then failed far downstream with a confusing
    // "Missing claims source" error.
    if (arg.startsWith('-')) {
      unknownArgs.push(arg);
      continue;
    }
    if (fromArg.length === 0) {
      fromArg = arg;
      continue;
    }
    unknownArgs.push(arg);
  }

  // An explicit CLI argument beats the ambient env override.
  return { indexHtmlPath: fromArg || fromEnv || undefined, unknownArgs, help };
}

if (require.main === module) {
  const exitCode = runCli(parseRuntimeOverrides());
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

module.exports = {
  validateClaimsDrift,
  runCli,
  parseRuntimeOverrides,
  countCliCommands,
  countCliCommandEntries,
  crossCheckCliCommands,
  parseCliCommandNames,
  parseToolNamesFromSchemas,
  declaredToolNamesFromBlocks,
  parseAuthMethods,
  extractAuthSection,
  extractNumericClaims,
  CLI_USAGE,
  REQUIRED_MARKERS,
  FORBIDDEN_PATTERNS,
  FORBIDDEN_FILES,
  BUILD_PLUGIN_PACKAGES,
  AUTH_METHOD_FLOOR,
  INDEX_HTML_PATH,
  CORE_PACKAGE_JSON,
  CLI_COMMANDS_SOURCE,
  TOOL_SCHEMAS_SOURCE,
  AUTH_COMMANDS_SOURCE,
  ROOT_DIR,
};
