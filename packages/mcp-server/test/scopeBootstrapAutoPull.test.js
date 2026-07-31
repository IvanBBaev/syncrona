// SPDX-License-Identifier: GPL-3.0-or-later
//
// REV-96 (GATE-2): `scopeBootstrap.js` measured 24.32% line / 62.50% branch —
// the worst file in the package by a wide margin, and it passed the coverage gate
// only because the aggregate averaged it away. The existing
// `scopeBootstrap.cov.test.js` covers `isValidScopeCode` plus the
// "auto-pull disabled" short-circuit and deliberately stops there, so the entire
// BODY of `autoPullAllScopesAndData` was unexercised — including the
// path-traversal defence that decides whether an instance-supplied string is
// allowed to become a filesystem path and a child-process cwd.
//
// That defence is the reason this file exists, so it is tested here for real.
// The module's collaborators are reached through the CommonJS namespace objects
// (`sessionContext_1.listScopes(...)`, `processRunner_1.runSyncroCliCommand(...)`,
// `servicenowCore_1.getServiceNowConfig(...)`), i.e. the property is looked up at
// CALL time. Overwriting the export on the already-loaded module therefore swaps
// the collaborator without any loader tricks, and `node --test` runs each test
// file in its own child process so the patches cannot leak into another suite.
// Every patch is still restored in a `finally` for the sake of the suites below it.
//
// `PROJECT_DIR` is redirected at a fresh temp directory so the filesystem writes
// are REAL (that is the behaviour under test: what the scaffolding actually puts
// on disk) while staying entirely inside the sandbox. No network is touched: the
// scope listing, the credential resolution and the child `download` are all
// stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runtimeConfig = require('../dist/runtimeConfig.js');
const sessionContext = require('../dist/sessionContext.js');
const processRunner = require('../dist/processRunner.js');
const servicenowCore = require('../dist/servicenowCore.js');
const { autoPullAllScopesAndData } = require('../dist/scopeBootstrap.js');

const AUTO_PULL_ENV = 'SYNCRONA_MCP_AUTO_PULL_ALL_SCOPES';

function okResult(overrides = {}) {
  return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...overrides };
}

/**
 * Drive autoPullAllScopesAndData with every boundary stubbed.
 *
 * @param {object} opts
 * @param {Array<Record<string, unknown>>|Error} opts.scopes rows listScopes resolves
 *   with, or an Error it should reject with.
 * @param {(sub: string, args: string[], timeoutMs: number, cwd: string, env: object) => object} [opts.download]
 * @param {object|Error} [opts.credentials] what getServiceNowConfig returns/throws.
 * @returns {Promise<{ logs: string[], projectDir: string, downloads: object[] }>}
 */
async function runAutoPull(opts) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-autopull-'));
  const downloads = [];
  const logs = [];

  const prevEnv = Object.prototype.hasOwnProperty.call(process.env, AUTO_PULL_ENV)
    ? process.env[AUTO_PULL_ENV]
    : undefined;
  const prevProjectDir = runtimeConfig.PROJECT_DIR;
  const prevListScopes = sessionContext.listScopes;
  const prevRun = processRunner.runSyncroCliCommand;
  const prevConfig = servicenowCore.getServiceNowConfig;
  const prevConsoleError = console.error;

  try {
    delete process.env[AUTO_PULL_ENV];
    runtimeConfig.PROJECT_DIR = projectDir;
    console.error = (msg) => logs.push(String(msg));

    sessionContext.listScopes = async () => {
      if (opts.scopes instanceof Error) {
        throw opts.scopes;
      }
      return opts.scopes;
    };

    processRunner.runSyncroCliCommand = async (sub, args, timeoutMs, cwd, env) => {
      downloads.push({ sub, args, timeoutMs, cwd, env });
      return opts.download ? opts.download(sub, args, timeoutMs, cwd, env) : okResult();
    };

    servicenowCore.getServiceNowConfig = () => {
      if (opts.credentials instanceof Error) {
        throw opts.credentials;
      }
      return (
        opts.credentials || { instance: 'https://dev.example.com', user: 'u', password: 'p' }
      );
    };

    await autoPullAllScopesAndData(1234);
  } finally {
    console.error = prevConsoleError;
    runtimeConfig.PROJECT_DIR = prevProjectDir;
    sessionContext.listScopes = prevListScopes;
    processRunner.runSyncroCliCommand = prevRun;
    servicenowCore.getServiceNowConfig = prevConfig;
    if (prevEnv === undefined) {
      delete process.env[AUTO_PULL_ENV];
    } else {
      process.env[AUTO_PULL_ENV] = prevEnv;
    }
  }

  return { logs, projectDir, downloads };
}

// ---------------------------------------------------------------------------
// Path-traversal defence: the one behaviour this module exists for.
//
// `scope.scope` arrives from the instance and is fed to path.join + mkdirSync
// and used as a child process cwd. A value carrying `../`, a separator or an
// absolute path must be refused, and refusing it must not stop the remaining
// scopes from syncing.
// ---------------------------------------------------------------------------

test('autoPullAllScopesAndData: refuses a traversing scope code — no directory is created and no child runs for it', async () => {
  const { logs, projectDir, downloads } = await runAutoPull({
    scopes: [{ scope: '../../etc', name: 'evil' }],
  });

  // Nothing was scaffolded for the rejected value...
  assert.equal(
    fs.existsSync(path.join(projectDir, 'packages', '../../etc')),
    false,
    'a traversing scope code must not produce a workspace directory'
  );
  // ...and, critically, nothing escaped the project dir either.
  assert.deepEqual(
    fs.readdirSync(path.join(projectDir, 'packages')),
    [],
    'packages/ must stay empty when the only scope was rejected'
  );
  // No child process was ever given the untrusted value as its cwd.
  assert.deepEqual(downloads, [], 'no download may run for a rejected scope code');
  assert.ok(
    logs.some((l) => l.includes('skipping invalid scope code') && l.includes('../../etc')),
    `expected a skip log naming the offending value, got ${JSON.stringify(logs)}`
  );
});

test('autoPullAllScopesAndData: one invalid scope does not abort the valid ones (skip-and-continue, not fail-fast)', async () => {
  const { logs, downloads, projectDir } = await runAutoPull({
    scopes: [
      { scope: 'x_acme_good', name: 'Good' },
      { scope: 'x_evil/../..', name: 'Bad' },
      { scope: 'x_acme_also_good', name: 'Also good' },
    ],
  });

  assert.deepEqual(
    downloads.map((d) => d.args[0]),
    // Sorted by localeCompare, so "also_good" precedes "good".
    ['x_acme_also_good', 'x_acme_good'],
    'the two valid scopes must still be downloaded'
  );
  assert.deepEqual(
    fs.readdirSync(path.join(projectDir, 'packages')).sort(),
    ['x_acme_also_good', 'x_acme_good'],
    'only the valid scopes get a workspace'
  );
  // The summary line is the operator-visible record that something was refused.
  assert.ok(
    logs.some((l) => l.includes('2 succeeded, 0 failed, 1 skipped (invalid scope code), total 3')),
    `expected an accurate summary, got ${JSON.stringify(logs)}`
  );
});

test('autoPullAllScopesAndData: rejects an absolute-path scope code', async () => {
  const { logs, downloads } = await runAutoPull({
    scopes: [{ scope: '/etc/passwd', name: 'abs' }],
  });
  assert.deepEqual(downloads, []);
  assert.ok(logs.some((l) => l.includes('skipping invalid scope code')));
  assert.ok(logs.some((l) => l.includes('0 succeeded, 0 failed, 1 skipped')));
});

// ---------------------------------------------------------------------------
// Workspace scaffolding: what actually lands on disk for a valid scope.
// ---------------------------------------------------------------------------

test('autoPullAllScopesAndData: scaffolds packages/<scope>/src with a sync.config.js and package.json', async () => {
  const { projectDir } = await runAutoPull({
    scopes: [{ scope: 'x_acme_app', name: 'Acme App' }],
  });

  const scopeDir = path.join(projectDir, 'packages', 'x_acme_app');
  assert.ok(fs.existsSync(path.join(scopeDir, 'src')), 'src/ must be created');

  // sync.config.js is CJS the core CLI later requires; it must parse and expose
  // the source/build directories the downloader relies on.
  const cfg = require(path.join(scopeDir, 'sync.config.js'));
  assert.equal(cfg.sourceDirectory, 'src');
  assert.equal(cfg.buildDirectory, 'build');
  assert.deepEqual(cfg.rules, []);
  assert.equal(cfg.refreshInterval, 30);

  // package.json must be private — a scaffolded scope workspace is never publishable.
  const pkg = JSON.parse(fs.readFileSync(path.join(scopeDir, 'package.json'), 'utf-8'));
  assert.equal(pkg.name, 'x_acme_app');
  assert.equal(pkg.private, true);
  assert.equal(pkg.version, '1.0.0');
});

test('autoPullAllScopesAndData: does not overwrite an existing sync.config.js or package.json', async () => {
  // First pass scaffolds; then hand-edit both files and re-run. Auto-pull runs
  // unattended at every server start, so clobbering a developer's config would
  // silently destroy local settings.
  const first = await runAutoPull({ scopes: [{ scope: 'x_acme_app', name: 'Acme' }] });
  const scopeDir = path.join(first.projectDir, 'packages', 'x_acme_app');
  const configPath = path.join(scopeDir, 'sync.config.js');
  const packagePath = path.join(scopeDir, 'package.json');

  fs.writeFileSync(configPath, 'module.exports = { sourceDirectory: "custom" };\n', 'utf-8');
  fs.writeFileSync(packagePath, '{"name":"x_acme_app","hand":"edited"}\n', 'utf-8');

  // Re-run against the SAME project dir.
  const prevProjectDir = runtimeConfig.PROJECT_DIR;
  const prevListScopes = sessionContext.listScopes;
  const prevRun = processRunner.runSyncroCliCommand;
  const prevConsoleError = console.error;
  try {
    runtimeConfig.PROJECT_DIR = first.projectDir;
    console.error = () => {};
    sessionContext.listScopes = async () => [{ scope: 'x_acme_app', name: 'Acme' }];
    processRunner.runSyncroCliCommand = async () => okResult();
    await autoPullAllScopesAndData(1234);
  } finally {
    console.error = prevConsoleError;
    runtimeConfig.PROJECT_DIR = prevProjectDir;
    sessionContext.listScopes = prevListScopes;
    processRunner.runSyncroCliCommand = prevRun;
  }

  assert.match(fs.readFileSync(configPath, 'utf-8'), /sourceDirectory: "custom"/);
  assert.equal(JSON.parse(fs.readFileSync(packagePath, 'utf-8')).hand, 'edited');
});

// ---------------------------------------------------------------------------
// The child download: cwd, args and forwarded credentials.
// ---------------------------------------------------------------------------

test('autoPullAllScopesAndData: runs `download <scope> --logLevel warn --ci` in the scope directory', async () => {
  const { downloads, projectDir } = await runAutoPull({
    scopes: [{ scope: 'x_acme_app', name: 'Acme' }],
  });

  assert.equal(downloads.length, 1);
  const [call] = downloads;
  assert.equal(call.sub, 'download');
  assert.deepEqual(call.args, ['x_acme_app', '--logLevel', 'warn', '--ci']);
  // --ci matters: auto-pull is unattended, so a prompting child would hang the
  // server start until the timeout.
  assert.ok(call.args.includes('--ci'));
  assert.equal(call.timeoutMs, 1234, 'the caller-supplied timeout must reach the child');
  assert.equal(call.cwd, path.join(projectDir, 'packages', 'x_acme_app'));
});

test('autoPullAllScopesAndData: forwards resolved SN_* credentials to the child download', async () => {
  const { downloads } = await runAutoPull({
    scopes: [{ scope: 'x_acme_app', name: 'Acme' }],
    credentials: { instance: 'https://i.example.com', user: 'alice', password: 's3cret' },
  });

  assert.deepEqual(downloads[0].env, {
    SN_INSTANCE: 'https://i.example.com',
    SN_USER: 'alice',
    SN_PASSWORD: 's3cret',
  });
});

test('autoPullAllScopesAndData: still attempts the download with no forwarded env when credentials cannot be resolved', async () => {
  const { downloads, logs } = await runAutoPull({
    scopes: [{ scope: 'x_acme_app', name: 'Acme' }],
    credentials: new Error('no .env and no credential store entry'),
  });

  // Credential resolution failing must not abort the pull: the child may still
  // find credentials of its own (own .env, keychain), so it is attempted with
  // `undefined` extraEnv rather than skipped.
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].env, undefined);
  assert.ok(
    logs.some((l) => l.includes('could not resolve credentials') && l.includes('no .env')),
    `expected the resolution failure to be logged, got ${JSON.stringify(logs)}`
  );
});

// ---------------------------------------------------------------------------
// Failure accounting: a non-zero child exit is a FAILURE, not a success.
// ---------------------------------------------------------------------------

test('autoPullAllScopesAndData: a non-zero child exit counts as failed and surfaces exit code, stderr and stdout', async () => {
  const { logs } = await runAutoPull({
    scopes: [{ scope: 'x_acme_app', name: 'Acme' }],
    download: () =>
      okResult({ exitCode: 7, stderr: '  boom-on-stderr  ', stdout: ' boom-on-stdout ' }),
  });

  const failure = logs.find((l) => l.includes('x_acme_app failed'));
  assert.ok(failure, `expected a failure log, got ${JSON.stringify(logs)}`);
  assert.match(failure, /exit=7/);
  assert.match(failure, /stderr=boom-on-stderr/);
  assert.match(failure, /stdout=boom-on-stdout/);
  assert.ok(
    logs.some((l) => l.includes('0 succeeded, 1 failed, 0 skipped')),
    'the summary must report the failure'
  );
  assert.ok(
    !logs.some((l) => l.includes('x_acme_app synced')),
    'a failed scope must never be reported as synced'
  );
});

test('autoPullAllScopesAndData: a timed-out child is reported as timedOut=true', async () => {
  const { logs } = await runAutoPull({
    scopes: [{ scope: 'x_acme_app', name: 'Acme' }],
    download: () => okResult({ exitCode: 1, timedOut: true }),
  });
  const failure = logs.find((l) => l.includes('x_acme_app failed'));
  assert.match(failure, /timedOut=true/);
});

test('autoPullAllScopesAndData: truncates a huge child stderr to 500 characters', async () => {
  // The failure message goes into the server's stderr log; an unbounded child
  // dump would flood it.
  const { logs } = await runAutoPull({
    scopes: [{ scope: 'x_acme_app', name: 'Acme' }],
    download: () => okResult({ exitCode: 1, stderr: 'e'.repeat(2000) }),
  });
  const failure = logs.find((l) => l.includes('x_acme_app failed'));
  const captured = /stderr=(e+)/.exec(failure);
  assert.ok(captured, 'expected a stderr= fragment');
  assert.equal(captured[1].length, 500);
});

test('autoPullAllScopesAndData: a thrown child error is caught per-scope and the next scope still runs', async () => {
  const { logs, downloads } = await runAutoPull({
    scopes: [
      { scope: 'x_first', name: 'First' },
      { scope: 'x_second', name: 'Second' },
    ],
    download: (_sub, args) => {
      if (args[0] === 'x_first') {
        throw new Error('spawn ENOENT');
      }
      return okResult();
    },
  });

  assert.equal(downloads.length, 2, 'the second scope must still be attempted');
  assert.ok(logs.some((l) => l.includes('x_first failed: spawn ENOENT')));
  assert.ok(logs.some((l) => l.includes('x_second synced')));
  assert.ok(
    logs.some((l) =>
      l.includes('1 succeeded, 1 failed, 0 skipped (invalid scope code), total 2')
    )
  );
});

test('autoPullAllScopesAndData: a non-Error throw is stringified rather than crashing the loop', async () => {
  const { logs } = await runAutoPull({
    scopes: [{ scope: 'x_acme_app', name: 'Acme' }],
    download: () => {
      throw 'plain string rejection';
    },
  });
  assert.ok(logs.some((l) => l.includes('x_acme_app failed: plain string rejection')));
});

// ---------------------------------------------------------------------------
// Scope listing: empty and failing.
// ---------------------------------------------------------------------------

test('autoPullAllScopesAndData: returns early and logs when the instance reports no x_* scopes', async () => {
  const { logs, downloads } = await runAutoPull({ scopes: [] });
  assert.deepEqual(downloads, []);
  assert.ok(logs.some((l) => l.includes('no x_* scopes found')));
  // The completion summary is NOT printed on this path — the run never started.
  assert.ok(!logs.some((l) => l.includes('Auto scope pull complete')));
});

test('autoPullAllScopesAndData: a listing failure aborts without writing anything and is logged', async () => {
  const { logs, downloads, projectDir } = await runAutoPull({
    scopes: new Error('HTTP 401 Unauthorized'),
  });
  assert.deepEqual(downloads, []);
  assert.ok(
    logs.some((l) => l.includes('failed while listing scopes') && l.includes('HTTP 401')),
    `expected the listing error to be logged, got ${JSON.stringify(logs)}`
  );
  // packages/ is created before the listing, but nothing inside it.
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'packages')), []);
});

test('autoPullAllScopesAndData: a non-Error listing rejection is stringified', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-autopull-'));
  const logs = [];
  const prevProjectDir = runtimeConfig.PROJECT_DIR;
  const prevListScopes = sessionContext.listScopes;
  const prevConsoleError = console.error;
  try {
    runtimeConfig.PROJECT_DIR = projectDir;
    console.error = (msg) => logs.push(String(msg));
    sessionContext.listScopes = async () => {
      throw { code: 'ECONNREFUSED' };
    };
    await autoPullAllScopesAndData(1234);
  } finally {
    console.error = prevConsoleError;
    runtimeConfig.PROJECT_DIR = prevProjectDir;
    sessionContext.listScopes = prevListScopes;
  }
  assert.ok(logs.some((l) => l.includes('failed while listing scopes')));
});

// ---------------------------------------------------------------------------
// Row normalisation: rows arrive as untyped records straight off the REST API.
// ---------------------------------------------------------------------------

test('autoPullAllScopesAndData: drops rows with an empty/missing scope field before validation', async () => {
  const { downloads, logs } = await runAutoPull({
    scopes: [
      { scope: '', name: 'Blank' },
      { name: 'Missing scope entirely' },
      { scope: 'x_acme_app', name: 'Real' },
    ],
  });

  // An empty scope is filtered out by listScopedApplications, so it is neither
  // downloaded NOR counted as "skipped (invalid scope code)" — it never reaches
  // the validation step.
  assert.deepEqual(downloads.map((d) => d.args[0]), ['x_acme_app']);
  assert.ok(logs.some((l) => l.includes('1 succeeded, 0 failed, 0 skipped (invalid scope code), total 1')));
});

test('autoPullAllScopesAndData: processes scopes in a deterministic sorted order', async () => {
  const { downloads } = await runAutoPull({
    scopes: [
      { scope: 'x_zulu', name: 'Z' },
      { scope: 'x_alpha', name: 'A' },
      { scope: 'x_mike', name: 'M' },
    ],
  });
  assert.deepEqual(
    downloads.map((d) => d.args[0]),
    ['x_alpha', 'x_mike', 'x_zulu'],
    'sorting keeps the log/summary order stable across runs'
  );
});

test('autoPullAllScopesAndData: a non-string scope value is dropped at normalisation, never reaching path handling', async () => {
  // `toStringField` returns "" for anything that is not a string, so a numeric
  // (or object/array) `scope` off the REST API collapses to an empty string and
  // is removed by the length filter. It therefore never reaches path.join or the
  // scope-code validator, and is NOT counted as "skipped (invalid scope code)" —
  // the skip counter is reserved for values that looked like scopes but failed
  // the shape check. Asserting the count proves which of the two guards caught it.
  const { downloads, logs } = await runAutoPull({
    scopes: [{ scope: 12345, name: 'Numeric' }],
  });
  assert.deepEqual(downloads, []);
  assert.ok(
    !logs.some((l) => l.includes('skipping invalid scope code')),
    'a non-string scope is filtered out before the validator, so no skip is logged'
  );
  assert.ok(
    logs.some((l) => l.includes('no x_* scopes found')),
    `the row list collapses to empty, got ${JSON.stringify(logs)}`
  );
});

// ---------------------------------------------------------------------------
// The enable toggle: unset and explicitly-on both mean "run".
// ---------------------------------------------------------------------------

test('autoPullAllScopesAndData: runs when the toggle is unset (auto-pull defaults ON)', async () => {
  const { downloads } = await runAutoPull({ scopes: [{ scope: 'x_acme_app', name: 'A' }] });
  assert.equal(downloads.length, 1, 'an unset toggle must not disable auto-pull');
});

for (const onValue of ['1', 'true', 'yes', 'on', 'anything-else']) {
  test(`autoPullAllScopesAndData: runs when the toggle is "${onValue}" (only the four off-words disable it)`, async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-autopull-'));
    const prevEnv = Object.prototype.hasOwnProperty.call(process.env, AUTO_PULL_ENV)
      ? process.env[AUTO_PULL_ENV]
      : undefined;
    const prevProjectDir = runtimeConfig.PROJECT_DIR;
    const prevListScopes = sessionContext.listScopes;
    const prevRun = processRunner.runSyncroCliCommand;
    const prevConsoleError = console.error;
    const downloads = [];
    try {
      process.env[AUTO_PULL_ENV] = onValue;
      runtimeConfig.PROJECT_DIR = projectDir;
      console.error = () => {};
      sessionContext.listScopes = async () => [{ scope: 'x_acme_app', name: 'A' }];
      processRunner.runSyncroCliCommand = async (...a) => {
        downloads.push(a);
        return okResult();
      };
      await autoPullAllScopesAndData(1234);
    } finally {
      console.error = prevConsoleError;
      runtimeConfig.PROJECT_DIR = prevProjectDir;
      sessionContext.listScopes = prevListScopes;
      processRunner.runSyncroCliCommand = prevRun;
      if (prevEnv === undefined) {
        delete process.env[AUTO_PULL_ENV];
      } else {
        process.env[AUTO_PULL_ENV] = prevEnv;
      }
    }
    assert.equal(downloads.length, 1);
  });
}
