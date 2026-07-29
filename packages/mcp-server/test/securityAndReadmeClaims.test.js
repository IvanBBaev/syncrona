// SPDX-License-Identifier: GPL-3.0-or-later
//
// REV-135 / REV-136 / REV-137 — three security- and behaviour-relevant docs
// claims were false, and nothing checked them against the code:
//
//   * SECURITY.md promised that "Mutating tools require confirmDestructive=true".
//     `sync_set_scope`, `sync_set_update_set` and `sync_prepare_session` are in
//     MUTATING_TOOLS and change the integration user's session on the instance
//     with no confirmation flag at all, so a reader hardening an MCP deployment
//     was told a control existed that does not.
//   * SECURITY.md promised the diagnostic log gets "best-effort redaction of
//     known credential fields". The file transport applies uncolorize +
//     timestamp + printf and nothing else — there is no redactor.
//   * README documented a `pull` command that does not exist and claimed that
//     switching `flat` on re-lays an existing workspace on the next `refresh`;
//     nothing converts an existing tree.
//
// These tests re-derive each claim from the code so the docs cannot drift again.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const security = fs.readFileSync(path.join(repoRoot, 'SECURITY.md'), 'utf8');
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

const { MCP_TOOLS } = require('../dist/toolSchemas.js');
const { isMutatingTool } = require('../dist/publicApi.js');

test('SECURITY.md names every mutating tool that does NOT require confirmDestructive', () => {
  const unconfirmed = MCP_TOOLS.filter(
    (tool) =>
      isMutatingTool(tool.name) &&
      !((tool.inputSchema && tool.inputSchema.required) || []).includes('confirmDestructive'),
  ).map((tool) => tool.name);

  assert.ok(
    unconfirmed.length > 0,
    'this gate assumes at least one mutating tool is unconfirmed; if that changed, update SECURITY.md and this test together',
  );
  const undocumented = unconfirmed.filter((name) => !security.includes(name));
  assert.deepEqual(
    undocumented,
    [],
    `SECURITY.md must name the mutating tools that take effect without confirmDestructive: ${undocumented.join(', ')}`,
  );
});

test('SECURITY.md does not claim a blanket confirmDestructive gate', () => {
  assert.equal(
    /Mutating tools require `confirmDestructive=true`/.test(security),
    false,
    'the blanket claim is false — session-context tools mutate without any confirmation flag',
  );
});

test('SECURITY.md does not claim the diagnostic log is redacted', () => {
  const logger = fs.readFileSync(
    path.join(repoRoot, 'packages', 'core', 'src', 'Logger.ts'),
    'utf8',
  );
  const transport = logger.slice(logger.indexOf('diagnosticFileTransport'), logger.indexOf('class SyncLogger'));
  assert.ok(transport.includes('transports.File'), 'expected the diagnostic file transport');
  assert.equal(
    /redact/i.test(transport),
    false,
    'if a redacting format is ever added to the file transport, update SECURITY.md and this test together',
  );
  assert.equal(
    /logger applies\s+best-effort redaction|redaction of known credential fields/.test(security),
    false,
    'SECURITY.md must not promise redaction the transport does not perform',
  );
});

test('README does not document a `pull` command — no such CLI command exists', () => {
  const commands = fs.readFileSync(
    path.join(repoRoot, 'packages', 'core', 'src', 'commander.ts'),
    'utf8',
  );
  assert.equal(/command\(\s*["']pull["']/.test(commands), false, 'no `pull` command is registered');
  assert.equal(
    /`pull`/.test(readme),
    false,
    'README must not reference a `pull` command that the CLI does not register',
  );
});

test('README states that switching `flat` does not convert an existing workspace', () => {
  const flatSection = readme.slice(
    readme.indexOf('#### Flat layout (experimental)'),
    readme.indexOf('### There are WAY too many files in here!'),
  );
  assert.ok(flatSection.length > 0, 'expected the flat-layout section in README');
  assert.equal(
    /re-lays files\s+on the next `refresh`/.test(flatSection),
    false,
    'nothing re-lays an existing tree; refresh only fetches files the manifest lacks',
  );
  assert.ok(
    /does not convert what is already on disk/.test(flatSection),
    'README must warn that an existing workspace keeps its old layout',
  );
});
