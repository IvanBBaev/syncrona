const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const DEFAULT_README = path.join(root, 'README.md');
const DEFAULT_GOVERNANCE = path.join(root, 'docs', 'release-governance.md');
const DEFAULT_CHANGELOG = path.join(root, '..', '..', 'CHANGELOG.md');
const DEFAULT_REQUIRED_SECTIONS = [
  '## Versioning',
  '## Changelog policy',
  '## Backward compatibility notes',
  '## Audit retention guidance',
  '## Incident response guidance',
];

function validateReleaseChecklist(opts = {}) {
  const readmePath = opts.readmePath || DEFAULT_README;
  const governancePath = opts.governancePath || DEFAULT_GOVERNANCE;
  const changelogPath = opts.changelogPath || DEFAULT_CHANGELOG;
  const requiredSections = Array.isArray(opts.requiredSections)
    ? opts.requiredSections
    : DEFAULT_REQUIRED_SECTIONS;

  const requiredFiles = [readmePath, governancePath, changelogPath];
  const missingFiles = requiredFiles.filter((p) => !fs.existsSync(p));

  const errors = [];
  if (missingFiles.length > 0) {
    for (const file of missingFiles) {
      errors.push(`Missing required artifact: ${file}`);
    }
    return {
      ok: false,
      missingFiles,
      missingSections: [],
      changelogHasReleaseEntries: false,
      errors,
    };
  }

  const governanceText = fs.readFileSync(governancePath, 'utf-8');
  const changelogText = fs.readFileSync(changelogPath, 'utf-8');

  const missingSections = requiredSections.filter((section) => !governanceText.includes(section));
  for (const section of missingSections) {
    errors.push(`Missing governance section: ${section}`);
  }

  const changelogHasReleaseEntries = /^##\s*\[[^\]]+\]/m.test(changelogText);
  if (!changelogHasReleaseEntries) {
    errors.push('CHANGELOG.md must include at least one release heading like "## [x.y.z]".');
  }

  return {
    ok: errors.length === 0,
    missingFiles,
    missingSections,
    changelogHasReleaseEntries,
    errors,
  };
}

function runCli(opts = {}) {
  const out = opts.console || console;
  const result = validateReleaseChecklist(opts);
  if (!result.ok) {
    out.error('Release checklist failed.');
    for (const err of result.errors) {
      out.error(`- ${err}`);
    }
    return 1;
  }
  out.log('Release checklist passed. Required artifacts and governance policy sections are valid.');
  return 0;
}

function parseRuntimeOverrides(env = process.env) {
  const readmePath = typeof env.SYNC_RELEASE_README === 'string' ? env.SYNC_RELEASE_README.trim() : '';
  const governancePath = typeof env.SYNC_RELEASE_GOVERNANCE === 'string' ? env.SYNC_RELEASE_GOVERNANCE.trim() : '';
  const changelogPath = typeof env.SYNC_RELEASE_CHANGELOG === 'string' ? env.SYNC_RELEASE_CHANGELOG.trim() : '';
  const requiredSectionsRaw = typeof env.SYNC_RELEASE_REQUIRED_SECTIONS === 'string'
    ? env.SYNC_RELEASE_REQUIRED_SECTIONS
    : '';
  const requiredSections = requiredSectionsRaw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return {
    readmePath: readmePath || undefined,
    governancePath: governancePath || undefined,
    changelogPath: changelogPath || undefined,
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
  validateReleaseChecklist,
  runCli,
  parseRuntimeOverrides,
  DEFAULT_README,
  DEFAULT_GOVERNANCE,
  DEFAULT_CHANGELOG,
  DEFAULT_REQUIRED_SECTIONS,
};
