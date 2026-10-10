// SPDX-License-Identifier: GPL-3.0-or-later
// runCommand stdio contract. Nobody ever writes to the child's stdin, so a child
// that reads it (a confirmation prompt, `npx` asking to install, a tool waiting
// for piped input) must see end-of-input at once rather than wait for the timeout.
const test = require('node:test');
const assert = require('node:assert/strict');

const { runCommand } = require('../dist/processRunner.js');

// Exits 0 as soon as stdin ends; keeps the event loop alive until then.
const READS_STDIN_TO_END =
  "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));setInterval(()=>{},1000);";

test('a child that reads stdin sees end-of-input instead of hanging until the timeout', async () => {
  const started = Date.now();
  const result = await runCommand(process.execPath, ['-e', READS_STDIN_TO_END], 3000);
  assert.equal(result.timedOut, false, 'the child must not wait for input that never comes');
  assert.equal(result.exitCode, 0);
  assert.ok(Date.now() - started < 2500, 'answers before the timeout fires');
});
