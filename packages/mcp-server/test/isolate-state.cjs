// SPDX-License-Identifier: GPL-3.0-or-later
//
// Preloaded (`--require`) by every `node --test` run of this package. The audit
// trail keeps its high-water markers in ~/.syncrona/audit-integrity by default,
// so each suite run used to leave dozens of marker files in the developer's real
// home directory. Point the state dir at a throwaway temp dir instead. Child test
// processes inherit the variable, and a test that needs a specific value still
// sets and restores it itself.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.env.SYNCRONA_AUDIT_STATE_DIR) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-test-audit-state-'));
  process.env.SYNCRONA_AUDIT_STATE_DIR = stateDir;
  // Only the process that created the dir removes it. That is the test runner,
  // which exits after every child test process it spawned.
  process.on('exit', () => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
}
