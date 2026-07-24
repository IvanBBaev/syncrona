// SPDX-License-Identifier: GPL-3.0-or-later
//
// REV-107 — the tarball-content gate used to smoke-run ONLY the core CLI, and it
// did so against a symlink of the whole workspace node_modules, so a published
// package that could not resolve its published `@syncrona/*` siblings would slip
// through. These tests pin the hardened contract: the MCP server's bin is smoke-
// tested too (as a require-load, because executing it would hang on its stdio
// transport), and each target's `@syncrona/*` runtime deps are the siblings that
// get supplied from their own packed tarballs.
//
// The end-to-end pack+smoke cannot run here: `npm pack` triggers each package's
// prepack (tsc), a build, so only the declarative targets and pure helpers are
// asserted — exactly the pieces that encode the fix.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const scriptPath = path.resolve(__dirname, '..', '..', '..', 'scripts', 'verify-pack-contents.mjs');

let mod;
before(async () => {
  // The script is ESM; a CommonJS test loads it via dynamic import. Its main
  // guard means importing does NOT trigger `npm pack`.
  mod = await import(scriptPath);
});

test('SMOKE_TARGETS covers both publishable bins, not just the core CLI', () => {
  const names = mod.SMOKE_TARGETS.map((t) => t.name);
  assert.ok(names.includes('syncrona'), 'core CLI must be smoke-tested');
  assert.ok(names.includes('@syncrona/mcp-server'), 'the MCP server bin must be smoke-tested too');
});

test('the core CLI target is executed and asserts its printed version', () => {
  const core = mod.SMOKE_TARGETS.find((t) => t.name === 'syncrona');
  assert.equal(core.mode, 'exec');
  assert.deepEqual(core.args, ['--version']);
  assert.equal(core.expectVersion, true);
});

test('the MCP server target is require-loaded, never executed (its bin would hang)', () => {
  // main() connects a StdioServerTransport that blocks forever; the gate must
  // load the entrypoint, not run it.
  const mcp = mod.SMOKE_TARGETS.find((t) => t.name === '@syncrona/mcp-server');
  assert.equal(mcp.mode, 'require');
  assert.notEqual(mcp.mode, 'exec');
  assert.equal(mcp.expectVersion, false);
});

test('syncronaRuntimeDeps selects only the @syncrona/* siblings supplied from packed tarballs', () => {
  const deps = mod.syncronaRuntimeDeps({
    dependencies: {
      '@syncrona/core': '*',
      '@syncrona/jira': '*',
      'left-pad': '*',
      commander: '*',
    },
  });
  assert.deepEqual(deps, ['@syncrona/core', '@syncrona/jira']);
  // No dependencies at all is safe (a leaf package).
  assert.deepEqual(mod.syncronaRuntimeDeps({}), []);
  assert.deepEqual(mod.syncronaRuntimeDeps({ dependencies: { commander: '*' } }), []);
});

test('forbiddenReason still rejects source, tests, and secrets leaking into a tarball', () => {
  // The content guard is unchanged by REV-107; assert it stays intact.
  assert.ok(mod.forbiddenReason('src/index.ts'), 'src/ must be forbidden');
  assert.ok(mod.forbiddenReason('test/foo.js'), 'test dirs must be forbidden');
  assert.ok(mod.forbiddenReason('dist/index.test.js'), '*.test.* must be forbidden');
  assert.ok(mod.forbiddenReason('.env'), '.env must be forbidden');
  assert.ok(mod.forbiddenReason('.env.production'), '.env.* must be forbidden');
  assert.equal(mod.forbiddenReason('dist/index.js'), null, 'compiled output is allowed');
  assert.equal(mod.forbiddenReason('LICENSE'), null, 'LICENSE is allowed');
});
