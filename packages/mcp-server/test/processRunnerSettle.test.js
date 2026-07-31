// SPDX-License-Identifier: GPL-3.0-or-later
// REV-210 — runCommand's promise settles only from the child's `error` or `close`
// event. Node emits `close` after the process has exited AND its stdio streams have
// been closed, so a child that leaves a grandchild holding the inherited pipes never
// produces `close` — not even after SIGTERM and the follow-up SIGKILL, which reach
// the direct child only. The timeout branch therefore kills the child and then waits
// forever: every caller (`syncrona_push`, `syncrona_build`, `syncrona_status`, the
// git tools in workspaceHandlers) plainly awaits runCommand with no outer deadline,
// so an MCP tool call hangs indefinitely and the request slot is never released.
//
// A timeout must be a guarantee about when we answer, not a request the child can
// decline. Each case races the call against an explicit deadline so a regression
// fails as an assertion rather than by stalling the suite.
const test = require('node:test');
const assert = require('node:assert/strict');

const { runCommand } = require('../dist/processRunner.js');

// Ignores SIGTERM and hands its inherited stdio to a grandchild, so the pipes stay
// open after the child itself is killed. The grandchild self-exits so the suite
// leaves nothing behind.
const STUBBORN_CHILD =
  "process.on('SIGTERM',()=>{});" +
  "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},6000)'],{stdio:'inherit'});" +
  'setInterval(()=>{},1000);';

function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

test('REV-210: a timeout settles even when the child leaves the pipes open', async () => {
  const started = Date.now();
  const result = await withDeadline(
    runCommand(process.execPath, ['-e', STUBBORN_CHILD], 600),
    5000,
    'runCommand'
  );
  assert.equal(result.timedOut, true, 'the result must report the timeout');
  assert.equal(typeof result.exitCode, 'number');
  // The kill escalation is allowed to take its time, but it must be bounded.
  assert.ok(Date.now() - started < 5000, 'settles within the escalation window');
});

test('REV-210: a well-behaved command is unaffected', async () => {
  const result = await withDeadline(
    runCommand(process.execPath, ['-e', 'process.stdout.write("hi"); process.exit(3)'], 5000),
    5000,
    'runCommand'
  );
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, 'hi');
});

test('REV-210: a child that exits on SIGTERM still reports the real close code', async () => {
  const result = await withDeadline(
    runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 400),
    5000,
    'runCommand'
  );
  assert.equal(result.timedOut, true);
  // SIGTERM-terminated: node reports a null exit code on the close event, which the
  // runner maps to 1. The point is that this path still resolves from `close`, not
  // from the give-up timer, so the observed code is the child's own outcome.
  assert.equal(result.exitCode, 1);
});

test('REV-210: the promise resolves exactly once', async () => {
  let settlements = 0;
  const promise = runCommand(process.execPath, ['-e', STUBBORN_CHILD], 400).then((r) => {
    settlements += 1;
    return r;
  });
  await withDeadline(promise, 5000, 'runCommand');
  // Give every remaining timer in the escalation chain a chance to fire late.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(settlements, 1);
});
