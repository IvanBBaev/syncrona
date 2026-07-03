// SPDX-License-Identifier: GPL-3.0-or-later
//
// Claims-drift gate. Product claims live in three public artifacts — the root
// README, the marketing comparison page, and the live site (docs/index.html).
// The `syncrona` -> `syncro-now-ai` rename and the license/OAuth stories have
// each drifted between these surfaces before. This asserts a tiny hand-curated
// manifest of stable markers (brand name, current bin name) against each
// artifact, and forbids the old bin invocation from creeping back in. It is a
// grep-gate, not a semantic check: keep the manifest small and stable.
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');

// Each entry: a literal marker that MUST appear in every listed file (paths are
// repo-root-relative).
const REQUIRED_MARKERS = [
  { marker: 'SyncroNow AI', files: ['README.md', 'docs/COMPARISON.md', 'docs/index.html'] },
  { marker: 'syncro-now-ai', files: ['README.md', 'docs/index.html'] },
];

// The old bin name must not return as a command invocation in any public
// artifact. `syncrona` still legitimately appears in paths (`~/.syncrona/`),
// scopes and prose, so only the command forms are forbidden.
const FORBIDDEN_PATTERNS = [
  { pattern: /npx syncrona\b/, label: 'npx syncrona (old bin invocation)' },
  { pattern: /`syncrona /, label: '`syncrona <cmd>` (old bin command form)' },
];
const FORBIDDEN_FILES = ['README.md', 'docs/COMPARISON.md', 'docs/index.html'];

function readFileOrNull(rootDir, relPath) {
  const abs = path.join(rootDir, relPath);
  if (!fs.existsSync(abs)) {
    return null;
  }
  return fs.readFileSync(abs, 'utf-8');
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

  const errors = [];
  const contentCache = new Map();
  const getContent = (relPath) => {
    if (!contentCache.has(relPath)) {
      contentCache.set(relPath, readFileOrNull(rootDir, relPath));
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

  return { ok: errors.length === 0, errors, checked };
}

function runCli(opts = {}) {
  const out = opts.console || console;
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

if (require.main === module) {
  const exitCode = runCli();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

module.exports = {
  validateClaimsDrift,
  runCli,
  REQUIRED_MARKERS,
  FORBIDDEN_PATTERNS,
  FORBIDDEN_FILES,
  ROOT_DIR,
};
