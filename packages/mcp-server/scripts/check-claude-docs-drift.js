const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_CLAUDE_SOURCE = path.join(ROOT_DIR, 'CLAUDE.md');
const DEFAULT_README_SOURCE = path.join(ROOT_DIR, 'README.md');
const DEFAULT_REQUIRED_SECTIONS = [
  '## Purpose',
  '## Workspace Layout',
  '## Quality Gates',
  '## Command Reference',
  '## Documentation Drift Policy',
];

const README_COMMAND_REGEX = /^\|\s*`([^`]+)`\s*\|/gm;
const CLAUDE_COMMAND_REGEX = /`npx\s+syncrona\s+([a-z][a-z0-9-]*)\b/g;

function normalizeCommandName(raw) {
  const normalized = String(raw || '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }
  return normalized.split(/\s+/)[0];
}

function parseCommandNamesFromReadme(raw) {
  return [
    ...new Set(
      [...raw.matchAll(README_COMMAND_REGEX)]
        .map((match) => normalizeCommandName(match[1]))
        .filter((name) => name.length > 0)
    ),
  ].sort();
}

function parseCommandNamesFromClaude(raw) {
  return [
    ...new Set(
      [...raw.matchAll(CLAUDE_COMMAND_REGEX)]
        .map((match) => normalizeCommandName(match[1]))
        .filter((name) => name.length > 0)
    ),
  ].sort();
}

function validateClaudeDocsDrift(opts = {}) {
  const claudeSource = opts.claudeSource || DEFAULT_CLAUDE_SOURCE;
  const readmeSource = opts.readmeSource || DEFAULT_README_SOURCE;
  const requiredSections = Array.isArray(opts.requiredSections)
    ? opts.requiredSections
    : DEFAULT_REQUIRED_SECTIONS;

  const missingFiles = [claudeSource, readmeSource].filter((filePath) => !fs.existsSync(filePath));
  const errors = [];
  if (missingFiles.length > 0) {
    for (const filePath of missingFiles) {
      errors.push(`Missing required docs file: ${filePath}`);
    }
    return {
      ok: false,
      missingFiles,
      missingSections: [],
      missingCommandDocs: [],
      readmeCommands: [],
      claudeCommands: [],
      errors,
    };
  }

  const claudeRaw = fs.readFileSync(claudeSource, 'utf-8');
  const readmeRaw = fs.readFileSync(readmeSource, 'utf-8');

  const missingSections = requiredSections.filter((section) => !claudeRaw.includes(section));
  for (const section of missingSections) {
    errors.push(`Missing required CLAUDE.md section: ${section}`);
  }

  const readmeCommands = parseCommandNamesFromReadme(readmeRaw);
  const claudeCommands = parseCommandNamesFromClaude(claudeRaw);
  const claudeSet = new Set(claudeCommands);
  const missingCommandDocs = readmeCommands.filter((command) => !claudeSet.has(command));
  for (const command of missingCommandDocs) {
    errors.push(`Missing command in CLAUDE.md: ${command}`);
  }

  return {
    ok: errors.length === 0,
    missingFiles: [],
    missingSections,
    missingCommandDocs,
    readmeCommands,
    claudeCommands,
    errors,
  };
}

function runCli(opts = {}) {
  const out = opts.console || console;
  const result = validateClaudeDocsDrift(opts);
  if (!result.ok) {
    out.error('CLAUDE docs drift check failed.');
    for (const error of result.errors) {
      out.error(`- ${error}`);
    }
    return 1;
  }

  out.log(
    `CLAUDE docs drift check passed (${result.readmeCommands.length} commands aligned).`
  );
  return 0;
}

function parseRuntimeOverrides(env = process.env) {
  const claudeSource = typeof env.SYNC_CLAUDE_DOC_SOURCE === 'string'
    ? env.SYNC_CLAUDE_DOC_SOURCE.trim()
    : '';
  const readmeSource = typeof env.SYNC_CLAUDE_README_SOURCE === 'string'
    ? env.SYNC_CLAUDE_README_SOURCE.trim()
    : '';
  const requiredSectionsRaw = typeof env.SYNC_CLAUDE_REQUIRED_SECTIONS === 'string'
    ? env.SYNC_CLAUDE_REQUIRED_SECTIONS
    : '';
  const requiredSections = requiredSectionsRaw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return {
    claudeSource: claudeSource || undefined,
    readmeSource: readmeSource || undefined,
    requiredSections: requiredSections.length > 0 ? requiredSections : undefined,
  };
}

if (require.main === module) {
  const opts = parseRuntimeOverrides();
  const exitCode = runCli(opts);
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

module.exports = {
  validateClaudeDocsDrift,
  parseCommandNamesFromReadme,
  parseCommandNamesFromClaude,
  runCli,
  parseRuntimeOverrides,
  DEFAULT_CLAUDE_SOURCE,
  DEFAULT_README_SOURCE,
  DEFAULT_REQUIRED_SECTIONS,
};
