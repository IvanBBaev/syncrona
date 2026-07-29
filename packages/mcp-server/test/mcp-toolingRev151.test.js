// SPDX-License-Identifier: GPL-3.0-or-later
// SEC-6 follow-up (REV-151) regression pins for toolService's dry-run consumers.
//
// auditMutatingTool, auditToolCall and shouldInvalidateSemanticIndex all read
// `args.dryRun === true` as proof that nothing happened. But that flag is only a
// REQUEST: a tool whose handler ignores it (as run_workspace_command, run_node_code
// and sync_unified_change_workflow all did before REV-149/REV-150) mutates for real
// while the tamper-evident audit log records `dryRun: true` and the semantic index is
// never invalidated — so a forensic review concludes "no mutation" and later analyses
// answer from a cache that predates the change.
//
// The fix derives the field from isEffectiveDryRun(toolName, args): a dry run counts
// only when the tool actually implements one. A tool that does not is treated as
// having executed for real, which is the safe default.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// AUDIT_DIR is derived from process.cwd() at import time, so move into a scratch
// project root BEFORE loading the dist modules — no audit file of the repo is touched.
const PROJECT_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rev151-')));
process.chdir(PROJECT_ROOT);

const {
  auditMutatingTool,
  auditToolCall,
  shouldInvalidateSemanticIndex,
} = require('../dist/toolService.js');
const { AUDIT_DIR, AUDIT_FILE } = require('../dist/runtimeConfig.js');

function readAuditEntries(auditFile) {
  if (!fs.existsSync(auditFile)) {
    return [];
  }
  return fs
    .readFileSync(auditFile, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function freshAuditFile(name) {
  const dir = path.join(PROJECT_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, file: path.join(dir, 'audit.log') };
}

// --- shouldInvalidateSemanticIndex ---

test('REV-151: a requested dry run on a tool that does not implement one still invalidates the index', () => {
  // run_syncro_command is listed as workspace-changing but no handler branches on
  // dryRun for it, so the workspace really did change: the index must be dropped.
  assert.equal(
    shouldInvalidateSemanticIndex('run_syncro_command', { dryRun: true }),
    true,
    'the old early return trusted the requested flag and left a stale index'
  );
});

test('REV-151: a dry run a tool really implements still suppresses the invalidation', () => {
  assert.equal(shouldInvalidateSemanticIndex('run_workspace_command', { dryRun: true }), false);
  assert.equal(shouldInvalidateSemanticIndex('run_node_code', { dryRun: true }), false);
});

test('REV-151: a real run of a workspace-changing tool still invalidates the index', () => {
  assert.equal(shouldInvalidateSemanticIndex('run_workspace_command', { dryRun: false }), true);
  assert.equal(shouldInvalidateSemanticIndex('sync_create_script_include', {}), true);
  assert.equal(shouldInvalidateSemanticIndex('sn_get_record_history', { dryRun: false }), false);
});

// --- auditToolCall ---

test('REV-151: the audit record does not claim a dry run for a tool that ignores the flag', () => {
  const { dir, file } = freshAuditFile('audit-unaware');
  auditToolCall(
    'sn_get_record_history',
    { dryRun: true, table: 'incident' },
    { isError: false },
    5,
    dir,
    file
  );

  const entries = readAuditEntries(file);
  assert.equal(entries.length, 1);
  assert.equal(
    entries[0].dryRun,
    false,
    'the log recorded dryRun:true for a run that was not a simulation'
  );
});

test('REV-151: the audit record still reports a genuine dry run as such', () => {
  const { dir, file } = freshAuditFile('audit-aware');
  auditToolCall('sync_push', { dryRun: true }, { isError: false }, 5, dir, file);

  const entries = readAuditEntries(file);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].dryRun, true);
  assert.equal(entries[0].mutating, true);
});

// --- auditMutatingTool ---

test('REV-151: auditMutatingTool reports the effective dry run, not the requested one', () => {
  auditMutatingTool('sync_push', { dryRun: true }, { ok: true }, 7);
  auditMutatingTool('sync_push', { dryRun: false }, { ok: true }, 7);
  // Not a mutating tool: nothing may be written at all.
  auditMutatingTool('sn_get_record_history', { dryRun: true }, { ok: true }, 7);

  const entries = readAuditEntries(AUDIT_FILE).filter((entry) => entry.tool === 'sync_push');
  assert.equal(AUDIT_DIR.startsWith(PROJECT_ROOT), true, 'the test must not write into the repo');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].dryRun, true);
  assert.equal(entries[1].dryRun, false);
  assert.equal(
    readAuditEntries(AUDIT_FILE).some((entry) => entry.tool === 'sn_get_record_history'),
    false,
    'a non-mutating tool must not reach the mutation audit'
  );
});
