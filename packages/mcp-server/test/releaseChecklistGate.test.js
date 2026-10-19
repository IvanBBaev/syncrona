// SPDX-License-Identifier: GPL-3.0-or-later
//
// REV-104 — the release checklist used to pass on a STALE changelog: it only
// required *some* "## [x.y.z]" heading to exist, never that the newest DATED
// release heading matched the shipped version, and it accepted a required
// governance section reduced to a bare heading. These tests pin the hardened
// contract: newest dated heading == shipped version (a leading "## [Unreleased]"
// is allowed), and every required governance section must have a body.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  validateReleaseChecklist,
  findNewestDatedRelease,
  sectionHasBody,
  DEFAULT_REQUIRED_SECTIONS,
} = require('../scripts/validate-release-checklist.js');

// A governance doc with every required section AND a non-empty body, so only the
// dimension under test can fail a given case.
function bodiedGovernance() {
  return DEFAULT_REQUIRED_SECTIONS.map((section) => `${section}\n\n- documented content.`).join('\n\n') + '\n';
}

function makeFixtures({ governance, changelog }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-'));
  const readmePath = path.join(dir, 'README.md');
  const governancePath = path.join(dir, 'release-governance.md');
  const changelogPath = path.join(dir, 'CHANGELOG.md');
  fs.writeFileSync(readmePath, '# README\n');
  fs.writeFileSync(governancePath, governance);
  fs.writeFileSync(changelogPath, changelog);
  return { readmePath, governancePath, changelogPath };
}

test('a stale changelog (newest dated heading behind the shipped version) fails', () => {
  // Version bumped to 1.2.0, but the newest dated release entry is still 1.1.0 —
  // the exact "release checklist passes on a stale changelog" bug.
  const paths = makeFixtures({
    governance: bodiedGovernance(),
    changelog: '# Changelog\n\n## [Unreleased]\n\n- pending\n\n## [1.1.0] - 2026-06-01\n\n- old.\n',
  });
  const result = validateReleaseChecklist({ ...paths, expectedVersion: '1.2.0' });
  assert.equal(result.ok, false);
  assert.equal(result.newestReleaseVersion, '1.1.0');
  assert.equal(result.expectedVersion, '1.2.0');
  assert.equal(result.errors.some((line) => line.includes('stale')), true);
});

test('a changelog whose newest dated heading matches the shipped version passes (with [Unreleased] on top)', () => {
  const paths = makeFixtures({
    governance: bodiedGovernance(),
    changelog: '# Changelog\n\n## [Unreleased]\n\n- pending\n\n## [1.2.0] - 2026-06-01\n\n- shipped.\n',
  });
  const result = validateReleaseChecklist({ ...paths, expectedVersion: '1.2.0' });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.newestReleaseVersion, '1.2.0');
});

test('a changelog holding only [Unreleased] has no dated heading to match', () => {
  const paths = makeFixtures({
    governance: bodiedGovernance(),
    changelog: '# Changelog\n\n## [Unreleased]\n\n- pending\n',
  });
  const result = validateReleaseChecklist({ ...paths, expectedVersion: '1.2.0' });
  assert.equal(result.ok, false);
  assert.equal(result.newestReleaseVersion, null);
  assert.equal(result.errors.some((line) => line.includes('no dated release heading')), true);
});

test('a required governance section reduced to a bare heading is rejected', () => {
  // Every required section is present (passes the presence check) but carries no
  // body — the checklist must not pass on an empty governance doc.
  const paths = makeFixtures({
    governance: DEFAULT_REQUIRED_SECTIONS.join('\n') + '\n',
    changelog: '# Changelog\n\n## [1.2.0] - 2026-06-01\n\n- shipped.\n',
  });
  const result = validateReleaseChecklist({ ...paths, expectedVersion: '1.2.0', requireSectionBodies: true });
  assert.equal(result.ok, false);
  assert.deepEqual(result.emptySections, DEFAULT_REQUIRED_SECTIONS);
  assert.equal(result.errors.some((line) => line.includes('has no content')), true);
});

test('strict checks stay off for a custom-path caller that does not opt in (backward compatible)', () => {
  // Bare-heading governance + a dated heading that does not match the real
  // package version: with no expectedVersion/requireSectionBodies, neither the
  // version-match nor the body check runs, so the legacy contract is preserved.
  const paths = makeFixtures({
    governance: DEFAULT_REQUIRED_SECTIONS.join('\n') + '\n',
    changelog: '# Changelog\n\n## [1.0.0] - 2026-05-29\n',
  });
  const result = validateReleaseChecklist(paths);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.deepEqual(result.emptySections, []);
});

test('findNewestDatedRelease skips [Unreleased] and reads the first dated heading', () => {
  assert.equal(
    findNewestDatedRelease('## [Unreleased]\n\n- x\n\n## [0.9.1] - 2026-07-04\n## [0.9.0] - 2026-07-03\n'),
    '0.9.1',
  );
  assert.equal(findNewestDatedRelease('## [Unreleased]\n\n- pending\n'), null);
  // Strips a leading "v".
  assert.equal(findNewestDatedRelease('## [v2.0.0] - 2026-01-01\n'), '2.0.0');
});

test('sectionHasBody distinguishes a bodied section from a bare heading', () => {
  assert.equal(sectionHasBody('## A\n\n- content\n\n## B\n', '## A'), true);
  assert.equal(sectionHasBody('## A\n## B\n\n- content\n', '## A'), false);
  // A deeper subheading is structure; the content beneath it still counts.
  assert.equal(sectionHasBody('## A\n\n### sub\n\n- content\n\n## B\n', '## A'), true);
});
