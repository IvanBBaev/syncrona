// SPDX-License-Identifier: GPL-3.0-or-later
//
// The stdio boundary is the only surface a real MCP client touches, and it is the one
// surface every other test in this package skips: they all call exported functions
// directly, so the transport framing, the SDK's JSON-RPC parser, a `console.log` landing
// on the wrong fd and an unhandled rejection taking the process down are all invisible
// to them. `scripts/stdio-fuzz.js` spawns the compiled server as a real child process,
// feeds it a corpus of hostile frames over a real pipe, and checks five invariants
// (stdout purity, liveness, id fidelity, no leakage, hermeticity) — see the header of
// that file for what each one means and why.
//
// It lives in the default suite rather than behind a flag because it costs ~220 ms: the
// corpus is deliberately non-executing, so no frame reaches the real CLI. That was not
// true of the first draft — two frames named the real `sync_status` tool and each spawned
// a 2-4 s `syncrona status` subprocess, which made the run both slow and flaky — so the
// harness now checks hermeticity from the server's own audit log rather than assuming it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { runStdioFuzz, buildCorpus, SERVER_ENTRY } = require('../scripts/stdio-fuzz.js');

test('the compiled server exists before the boundary is fuzzed', () => {
  // Without this the harness would spawn a node process that dies instantly, every frame
  // would report "wedged-or-died", and the failure would be attributed to the server
  // rather than to a missing build.
  assert.ok(fs.existsSync(SERVER_ENTRY), `expected a compiled server at ${SERVER_ENTRY} (run \`npm run build\`)`);
});

test('the hostile-input corpus stays meaningful', () => {
  // A green run over an empty or truncated corpus is a false green — the same lesson the
  // collaboration-lock race harness learned when a shell quoting bug silently ran zero
  // rounds and reported success. Pin the size and the group coverage so a filter bug or a
  // careless deletion fails here instead of quietly reducing what is verified.
  const corpus = buildCorpus();
  assert.ok(corpus.length >= 40, `corpus shrank to ${corpus.length} frames`);
  assert.equal(new Set(corpus.map((f) => f.name)).size, corpus.length, 'frame names must be unique');

  for (const required of [
    'truncated-json', // byte-level framing
    'batch', // JSON-RPC envelope
    'notification-no-id', // id fidelity
    'proto-in-params', // prototype pollution
    'call-unknown-tool', // tools/call dispatch
    'deep-nesting-1000', // depth
    'large-payload-1mb', // size
  ]) {
    assert.ok(
      corpus.some((f) => f.name === required),
      `corpus lost its "${required}" frame`
    );
  }
});

test('the MCP stdio boundary survives every hostile frame', async () => {
  const report = await runStdioFuzz();

  assert.deepEqual(
    report.violations,
    [],
    `stdio invariants violated:\n${report.violations.map((v) => `  ${v.kind}: ${v.detail}`).join('\n')}`
  );

  // A violation-free run that stopped after three frames would also be a false green:
  // the loop breaks on the first frame that wedges the server, so frame count is the
  // proof that the whole corpus was actually delivered.
  assert.equal(report.frames.length, buildCorpus().length, 'the run stopped before the corpus was exhausted');
  assert.ok(
    report.frames.every((f) => f.alive),
    `server stopped answering after: ${report.frames.filter((f) => !f.alive).map((f) => f.name).join(', ')}`
  );

  // The server answered something — otherwise "no violations" could mean "no output at
  // all", which is a wedge the per-frame ping should have caught but which is cheap to
  // assert directly.
  assert.ok(report.messages > 0, 'the server produced no JSON-RPC messages at all');
}, { timeout: 60000 });
