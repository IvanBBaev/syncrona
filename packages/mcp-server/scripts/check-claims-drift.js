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
// Mirrors the tool-name parsing used by check-docs-drift.js.
const TOOL_NAME_REGEX = /name:\s*"([^"]+)"/g;
const AUTH_METHOD_VALUE_REGEX = /value:\s*"([a-z0-9-]+)"/g;
// First quoted token of a `    command: ` registry line, whether the value is a
// bare string or an array literal whose head is the primary name.
const CLI_COMMAND_NAME_REGEX = /^ {4}command:\s*(?:\[\s*)?"([^"]+)"/gm;

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

// CLI command count = registry entries in cliCommands.ts. Each registered
// command is declared exactly one per line as `    command: ...` (4-space
// indent), so a plain line count is the command count.
function countCliCommands(raw) {
  return raw.split(/\r?\n/).filter((line) => line.startsWith('    command: ')).length;
}

// Primary command NAMES from the same registry lines countCliCommands counts.
// A `command` value is either a bare string ("download <scope>") or an array
// whose first element is the primary name and the rest are aliases
// (["dev", "d"]); either way the first quoted token holds the name, and any
// positional-argument suffix (`<scope>`, `[target]`) is stripped.
// Exported so the CLAUDE/README drift gate can check the docs against code
// rather than only against each other.
function parseCliCommandNames(raw) {
  const names = [...raw.matchAll(CLI_COMMAND_NAME_REGEX)]
    .map((match) => match[1].trim().split(/\s+/)[0])
    .filter((name) => name.length > 0);
  return [...new Set(names)].sort();
}

// Unique declared MCP tool names (same parsing approach as check-docs-drift.js).
function parseToolNamesFromSchemas(raw) {
  return [...new Set([...raw.matchAll(TOOL_NAME_REGEX)].map((m) => m[1]))];
}

// Auth-method identifiers the CLI accepts, parsed from the
// LOGIN_METHOD_CHOICES array in authCommands.ts (the set `--auth-method`
// validates against), unioned with the hardcoded floor so a refactor of the
// choices array cannot silently shrink the documented surface.
function parseAuthMethods(raw) {
  const start = raw.indexOf('LOGIN_METHOD_CHOICES');
  const end = start === -1 ? -1 : raw.indexOf('];', start);
  const block = start === -1 || end === -1 ? '' : raw.slice(start, end);
  const parsed = [...block.matchAll(AUTH_METHOD_VALUE_REGEX)].map((m) => m[1]);
  return [...new Set([...parsed, ...AUTH_METHOD_FLOOR])].sort();
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
      const lowerHtml = html.toLowerCase();
      for (const method of parseAuthMethods(authRaw)) {
        checked += 1;
        if (!lowerHtml.includes(method.toLowerCase())) {
          errors.push(
            `Missing auth method "${method}" in ${INDEX_HTML_PATH} ` +
              `(accepted by ${AUTH_COMMANDS_SOURCE})`
          );
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
  parseCliCommandNames,
  parseToolNamesFromSchemas,
  parseAuthMethods,
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
