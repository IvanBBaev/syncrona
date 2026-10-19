// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('node:fs');
const path = require('node:path');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A required section is present only when it appears as a genuine line-start
// heading of the exact level, not as a floating substring. Without the anchor a
// required `## Versioning` is satisfied by a demoted `### Versioning` (which
// contains it) or by the text buried in prose or a code fence — so a top-level
// governance section could silently vanish while the gate stays green.
function hasHeadingLine(text, heading) {
  return new RegExp(`^${escapeRegExp(heading)}(?:\\s|$)`, 'm').test(text);
}

// REV-104: the newest DATED release heading, e.g. "## [0.9.1] - 2026-07-04" ->
// "0.9.1". Because the changelog is newest-first, the first dated heading is the
// shipped release. A leading "## [Unreleased]" section carries no `- <date>`, so
// it is skipped and an in-progress Unreleased block never counts as the release.
function findNewestDatedRelease(changelogText) {
  const match = /^##\s*\[v?([^\]]+)\]\s*-\s*\d{4}-\d{2}-\d{2}/m.exec(changelogText);
  return match ? match[1].trim() : null;
}

// REV-104: a governance section has a body when at least one non-blank,
// non-heading line sits between its heading and the next heading of the same or
// a higher level. A required section reduced to a bare heading passes the mere
// presence check while documenting nothing, so the checklist "passes" empty.
function sectionHasBody(text, heading) {
  const level = (heading.match(/^#+/) || ['##'])[0].length;
  const headingRe = new RegExp(`^${escapeRegExp(heading)}(?:\\s|$)`);
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => headingRe.test(line));
  if (start < 0) return false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const headingMatch = lines[i].match(/^(#{1,6})\s/);
    if (headingMatch) {
      if (headingMatch[1].length <= level) break; // next same/higher heading ends the section
      continue; // a deeper subheading is structure, not body — keep scanning
    }
    if (lines[i].trim().length > 0) return true;
  }
  return false;
}

const root = path.resolve(__dirname, '..');
const DEFAULT_README = path.join(root, 'README.md');
const DEFAULT_GOVERNANCE = path.join(root, 'docs', 'release-governance.md');
const DEFAULT_CHANGELOG = path.join(root, '..', '..', 'CHANGELOG.md');
// The shipped version the changelog is matched against. `root` is
// `packages/mcp-server`, so this is the mcp-server package (in lockstep with the
// other published `@syncrona/*` packages), NOT the private monorepo root, whose
// version is intentionally held behind.
const DEFAULT_PACKAGE_JSON = path.join(root, 'package.json');
const DEFAULT_REQUIRED_SECTIONS = [
  '## Versioning',
  // Ordering matters at release time: the site badge must be bumped before the test
  // suites run, because one of them executes the live claims gate. Requiring the
  // section keeps that procedure from quietly disappearing from the checklist.
  '## Version bump procedure',
  '## Changelog policy',
  '## Backward compatibility notes',
  '## Audit retention guidance',
  '## Incident response guidance',
];

function validateReleaseChecklist(opts = {}) {
  const readmePath = opts.readmePath || DEFAULT_README;
  const governancePath = opts.governancePath || DEFAULT_GOVERNANCE;
  const changelogPath = opts.changelogPath || DEFAULT_CHANGELOG;
  const packageJsonPath = opts.packageJsonPath || DEFAULT_PACKAGE_JSON;
  const requiredSections = Array.isArray(opts.requiredSections)
    ? opts.requiredSections
    : DEFAULT_REQUIRED_SECTIONS;

  // REV-104: the version-match and non-empty-body checks are the actual release
  // gate, which validates the DEFAULT repo artifacts. When a caller overrides a
  // path it is inspecting a synthetic fixture, so the strict checks stay off
  // unless it opts in explicitly — this keeps the programmatic API backward
  // compatible while the real `validate-release-checklist` CLI runs strict.
  const usingDefaultArtifacts = !opts.readmePath && !opts.governancePath && !opts.changelogPath;
  // A caller that supplies an explicit `expectedVersion` clearly wants the match
  // checked, even against a custom changelog fixture.
  const requireVersionMatch =
    opts.requireVersionMatch ?? (usingDefaultArtifacts || typeof opts.expectedVersion === 'string');
  const requireSectionBodies = opts.requireSectionBodies ?? usingDefaultArtifacts;

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
      emptySections: [],
      changelogHasReleaseEntries: false,
      newestReleaseVersion: null,
      expectedVersion: null,
      errors,
    };
  }

  const governanceText = fs.readFileSync(governancePath, 'utf-8');
  const changelogText = fs.readFileSync(changelogPath, 'utf-8');

  const missingSections = requiredSections.filter((section) => !hasHeadingLine(governanceText, section));
  for (const section of missingSections) {
    errors.push(`Missing governance section: ${section}`);
  }

  // REV-104: a section that is present but reduced to a bare heading documents
  // nothing; only checked for present sections (a missing one is already flagged).
  const emptySections = requireSectionBodies
    ? requiredSections.filter(
        (section) => hasHeadingLine(governanceText, section) && !sectionHasBody(governanceText, section),
      )
    : [];
  for (const section of emptySections) {
    errors.push(`Governance section has no content: ${section}`);
  }

  // Require a real semver heading: "## [Unreleased]" alone must not satisfy this.
  const changelogHasReleaseEntries = /^##\s*\[v?\d+\.\d+\.\d+/m.test(changelogText);
  if (!changelogHasReleaseEntries) {
    errors.push('CHANGELOG.md must include at least one release heading like "## [x.y.z]".');
  }

  // REV-104: the newest DATED release heading must equal the shipped version, so
  // a version bump whose changelog entry was forgotten (a stale changelog) fails
  // the gate instead of passing on an out-of-date top section. A leading
  // "## [Unreleased]" section is allowed and does not count as the release.
  const newestReleaseVersion = findNewestDatedRelease(changelogText);
  let expectedVersion = null;
  if (requireVersionMatch) {
    if (typeof opts.expectedVersion === 'string' && opts.expectedVersion.trim()) {
      expectedVersion = opts.expectedVersion.trim();
    } else {
      try {
        const shipped = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')).version;
        expectedVersion = typeof shipped === 'string' && shipped.trim() ? shipped.trim() : null;
      } catch {
        expectedVersion = null;
      }
    }

    if (!expectedVersion) {
      errors.push(`Could not determine the shipped version from ${packageJsonPath}.`);
    } else if (!newestReleaseVersion) {
      errors.push(
        'CHANGELOG.md has no dated release heading like "## [x.y.z] - YYYY-MM-DD" ' +
          `to match against the shipped version "${expectedVersion}".`,
      );
    } else if (newestReleaseVersion !== expectedVersion) {
      errors.push(
        `CHANGELOG.md is stale: its newest dated release heading is "${newestReleaseVersion}" ` +
          `but the shipped version is "${expectedVersion}". Add a "## [${expectedVersion}] - <date>" entry.`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    missingFiles,
    missingSections,
    emptySections,
    changelogHasReleaseEntries,
    newestReleaseVersion,
    expectedVersion,
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
  findNewestDatedRelease,
  sectionHasBody,
  DEFAULT_README,
  DEFAULT_GOVERNANCE,
  DEFAULT_CHANGELOG,
  DEFAULT_PACKAGE_JSON,
  DEFAULT_REQUIRED_SECTIONS,
};
