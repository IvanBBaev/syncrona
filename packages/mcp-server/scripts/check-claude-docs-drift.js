// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('node:fs');
const path = require('node:path');
const { parseCliCommandNames, CLI_COMMANDS_SOURCE } = require('./check-claims-drift.js');

const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_CLAUDE_SOURCE = path.join(ROOT_DIR, 'CLAUDE.md');
const DEFAULT_README_SOURCE = path.join(ROOT_DIR, 'README.md');
const DEFAULT_CLI_COMMANDS_SOURCE = CLI_COMMANDS_SOURCE;
const DEFAULT_REQUIRED_SECTIONS = [
  '## Purpose',
  '## Workspace Layout',
  '## Quality Gates',
  '## Command Reference',
  '## Documentation Drift Policy',
];

// The README command table lives under this heading. Parsing is scoped to that
// section (and each row must document an `npx syncrona ...` invocation) so that
// an unrelated table elsewhere in the README whose first cell happens to be a
// lowercase backticked token cannot register as a phantom command.
const README_COMMAND_TABLE_HEADING = '### Commands';
// Ends the section at the next heading of the same or higher level; deeper
// `####` subsections stay inside it.
const NEXT_SECTION_REGEX = /^#{1,3} /m;
// The first backticked cell must START with a command-shaped token (lowercase
// kebab, optionally followed by an arg like `download <scope>`). Symmetric with
// CLAUDE_COMMAND_REGEX below.
const README_COMMAND_REGEX = /^\|\s*`([a-z][a-z0-9-]*)[^`]*`\s*\|.*$/gm;
const README_USAGE_MARKER = 'npx syncrona';
const CLAUDE_COMMAND_REGEX = /`npx\s+syncrona\s+([a-z][a-z0-9-]*)\b/g;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A required section counts only as a genuine line-start heading of the exact
// level, not as a floating substring. Without the anchor a required `## Section`
// is satisfied by a demoted `### Section` (which contains it) or by the text
// embedded in prose or a code fence, so a top-level section could disappear
// while the drift gate stays green.
function hasHeadingLine(text, heading) {
  return new RegExp(`^${escapeRegExp(heading)}(?:\\s|$)`, 'm').test(text);
}

function normalizeCommandName(raw) {
  const normalized = String(raw || '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }
  return normalized.split(/\s+/)[0];
}

// Slice of the README holding the command table. Returns '' when the heading is
// missing, which makes the command comparison fail loudly rather than silently
// finding zero commands.
function sliceCommandTableSection(raw) {
  const start = raw.indexOf(README_COMMAND_TABLE_HEADING);
  if (start === -1) {
    return '';
  }
  const rest = raw.slice(start + README_COMMAND_TABLE_HEADING.length);
  const end = rest.search(NEXT_SECTION_REGEX);
  return end === -1 ? rest : rest.slice(0, end);
}

function parseCommandNamesFromReadme(raw) {
  const section = sliceCommandTableSection(raw);
  return [
    ...new Set(
      [...section.matchAll(README_COMMAND_REGEX)]
        .filter((match) => match[0].includes(README_USAGE_MARKER))
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
  const cliCommandsSource = opts.cliCommandsSource || DEFAULT_CLI_COMMANDS_SOURCE;
  const requiredSections = Array.isArray(opts.requiredSections)
    ? opts.requiredSections
    : DEFAULT_REQUIRED_SECTIONS;

  const missingFiles = [claudeSource, readmeSource, cliCommandsSource].filter(
    (filePath) => !fs.existsSync(filePath)
  );
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
      missingReadmeDocs: [],
      undocumentedInReadme: [],
      unknownCommandDocs: [],
      readmeCommands: [],
      claudeCommands: [],
      codeCommands: [],
      errors,
    };
  }

  const claudeRaw = fs.readFileSync(claudeSource, 'utf-8');
  const readmeRaw = fs.readFileSync(readmeSource, 'utf-8');
  const cliCommandsRaw = fs.readFileSync(cliCommandsSource, 'utf-8');

  const missingSections = requiredSections.filter((section) => !hasHeadingLine(claudeRaw, section));
  for (const section of missingSections) {
    errors.push(`Missing required CLAUDE.md section: ${section}`);
  }

  const readmeCommands = parseCommandNamesFromReadme(readmeRaw);
  const claudeCommands = parseCommandNamesFromClaude(claudeRaw);
  const codeCommands = parseCliCommandNames(cliCommandsRaw);
  const claudeSet = new Set(claudeCommands);
  const readmeSet = new Set(readmeCommands);
  const codeSet = new Set(codeCommands);

  // README -> CLAUDE.md: a documented command must also appear in CLAUDE.md.
  const missingCommandDocs = readmeCommands.filter((command) => !claudeSet.has(command));
  for (const command of missingCommandDocs) {
    errors.push(`Missing command in CLAUDE.md: ${command}`);
  }

  // CLAUDE.md -> README: the reverse direction, so a row cannot silently vanish
  // from the README while CLAUDE.md still lists it.
  const missingReadmeDocs = claudeCommands.filter((command) => !readmeSet.has(command));
  for (const command of missingReadmeDocs) {
    errors.push(`Missing command in README command table: ${command}`);
  }

  // code -> docs: a registered command that neither doc mentions.
  const undocumentedInReadme = codeCommands.filter(
    (command) => !readmeSet.has(command) || !claudeSet.has(command)
  );
  for (const command of undocumentedInReadme) {
    errors.push(`Command registered in cliCommands.ts but not fully documented: ${command}`);
  }

  // docs -> code: a documented command that no longer exists in the registry.
  const unknownCommandDocs = [...new Set([...readmeCommands, ...claudeCommands])]
    .filter((command) => !codeSet.has(command))
    .sort();
  for (const command of unknownCommandDocs) {
    errors.push(`Documented command not registered in cliCommands.ts: ${command}`);
  }

  return {
    ok: errors.length === 0,
    missingFiles: [],
    missingSections,
    missingCommandDocs,
    missingReadmeDocs,
    undocumentedInReadme,
    unknownCommandDocs,
    readmeCommands,
    claudeCommands,
    codeCommands,
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
    `CLAUDE docs drift check passed (${result.readmeCommands.length} commands aligned with cliCommands.ts).`
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
  const cliCommandsSource = typeof env.SYNC_CLAUDE_CLI_COMMANDS_SOURCE === 'string'
    ? env.SYNC_CLAUDE_CLI_COMMANDS_SOURCE.trim()
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
    cliCommandsSource: cliCommandsSource || undefined,
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
  sliceCommandTableSection,
  runCli,
  parseRuntimeOverrides,
  DEFAULT_CLAUDE_SOURCE,
  DEFAULT_README_SOURCE,
  DEFAULT_CLI_COMMANDS_SOURCE,
  DEFAULT_REQUIRED_SECTIONS,
};
