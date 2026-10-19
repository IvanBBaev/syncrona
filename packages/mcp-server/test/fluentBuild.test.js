// SPDX-License-Identifier: GPL-3.0-or-later
// SDK-F6: sync_fluent_build — the MCP face of `syncrona fluent build`. The Fluent
// adapter is always injected (or a fixture package); no test needs
// @servicenow/sdk or a ServiceNow instance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  FLUENT_BUILD_OUTCOMES,
  FLUENT_INSTALL_HINT,
  FluentAdapterOutsideWorkspaceError,
  FluentNotInstalledError,
  FluentProjectError,
  MAX_LINE_CHARS,
  MAX_LISTED_DIAGNOSTICS,
  fluentBuildOptions,
  handleFluentBuild,
  handleFluentTool,
  listOutputFiles,
  loadFluentAdapter,
  loadFluentModule,
  resolveFluentProjectDir,
} = require('../dist/handlers/fluentHandlers.js');
const { validateToolArguments } = require('../dist/inputValidation.js');
const { isMutatingTool, toolImplementsDryRun } = require('../dist/safetyPolicy.js');
const { MCP_TOOLS } = require('../dist/toolSchemas.js');

function mkWorkspace() {
  // realpath: on macOS the temp dir sits behind the /var -> /private/var symlink.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-build-')));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function mkProject(workspace, rel = '.') {
  const dir = path.join(workspace, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'now.config.json'), JSON.stringify({ scope: 'x_demo' }));
  return dir;
}

function makeContext(workspaceDir, overrides = {}) {
  const calls = { dryRun: [], audit: [] };
  const context = {
    timeoutMs: 5000,
    dryRun: false,
    startedAt: Date.now(),
    workspaceDir,
    makeDryRunAuditResponse: (toolName, args, details) => {
      calls.dryRun.push({ toolName, args, details });
      return { isError: false, content: [{ type: 'text', text: JSON.stringify({ tool: toolName, planned: details }) }] };
    },
    auditMutatingTool: (...args) => calls.audit.push(args),
    ...overrides,
  };
  return { context, calls };
}

/** A fake adapter: `build` is the engine's build implementation. */
function fakeFluent(build) {
  const seen = { engineOptions: [], buildOptions: [] };
  return {
    seen,
    loader: (projectDir) => ({
      createFluentEngine: (options) => {
        seen.engineOptions.push({ ...options, loaderProjectDir: projectDir });
        return {
          build: async (buildOptions) => {
            seen.buildOptions.push(buildOptions);
            return build(options, buildOptions);
          },
        };
      },
    }),
  };
}

function payloadOf(response) {
  return JSON.parse(response.content[0].text);
}

// --- Contract -------------------------------------------------------------------

test('sync_fluent_build is declared, validated, dryRun-aware and mutating', () => {
  const tool = MCP_TOOLS.find((t) => t.name === 'sync_fluent_build');
  assert.ok(tool, 'tool is declared');
  const props = tool.inputSchema.properties;
  for (const key of ['project', 'frozenKeys', 'errorOnConflict', 'skipClean', 'dryRun', 'timeoutMs']) {
    assert.ok(props[key], `declares ${key}`);
  }
  assert.equal(props.confirmDestructive, undefined, 'a local build needs no confirmation');
  // It writes dist/ and executes project code in-process, so the mutating gates apply.
  assert.equal(isMutatingTool('sync_fluent_build'), true);
  assert.equal(isMutatingTool('sync_fluent_build', { dryRun: true }), true);
  assert.equal(toolImplementsDryRun('sync_fluent_build'), true);
  assert.match(tool.description, /mutating tool/);
  assert.match(tool.description, /inside the server process, with the server's full environment/);
  assert.match(tool.description, /FLUENT_ADAPTER_OUTSIDE_WORKSPACE/);
  assert.match(props.timeoutMs.description, /not a hard limit/);
  assert.match(props.timeoutMs.description, /delays the timeout/);

  assert.equal(validateToolArguments('sync_fluent_build', {}).valid, true);
  assert.equal(
    validateToolArguments('sync_fluent_build', { project: 'app', frozenKeys: true, timeoutMs: 60000 }).valid,
    true
  );
  assert.equal(validateToolArguments('sync_fluent_build', { frozenKeys: 'yes' }).valid, false);
  assert.equal(validateToolArguments('sync_fluent_build', { timeoutMs: 1 }).valid, false);
  assert.equal(validateToolArguments('sync_fluent_build', { project: 7 }).valid, false);
});

test('outcomes carry the CLI exit codes', () => {
  assert.deepEqual(FLUENT_BUILD_OUTCOMES, { succeeded: 0, incomplete: 1, failed: 2 });
});

test('fluentBuildOptions passes only the flags that are set, like the CLI plan', () => {
  assert.deepEqual(fluentBuildOptions({}), {});
  assert.deepEqual(fluentBuildOptions({ frozenKeys: false, skipClean: 'true' }), {});
  assert.deepEqual(fluentBuildOptions({ frozenKeys: true, errorOnConflict: true, skipClean: true }), {
    frozenKeys: true,
    errorOnConflict: true,
    skipClean: true,
  });
});

// --- Project confinement -----------------------------------------------------------

test('resolveFluentProjectDir defaults to the workspace and accepts a nested project', () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const nested = mkProject(ws, 'apps/demo');
  assert.equal(resolveFluentProjectDir(ws, undefined), ws);
  assert.equal(resolveFluentProjectDir(ws, '  '), ws);
  assert.equal(resolveFluentProjectDir(ws, 'apps/demo'), nested);
});

test('resolveFluentProjectDir refuses paths outside the workspace', () => {
  const ws = mkWorkspace();
  mkProject(ws);
  assert.throws(() => resolveFluentProjectDir(ws, '..'), FluentProjectError);
  assert.throws(() => resolveFluentProjectDir(ws, '../elsewhere'), /outside the workspace/);
  assert.throws(() => resolveFluentProjectDir(ws, os.tmpdir()), /outside the workspace/);
  assert.throws(() => resolveFluentProjectDir(ws, 42), /relative to the workspace/);
});

test('resolveFluentProjectDir refuses a symlink that leads out of the workspace', () => {
  const ws = mkWorkspace();
  const outside = mkWorkspace();
  mkProject(outside);
  fs.symlinkSync(outside, path.join(ws, 'link'), 'dir');
  assert.throws(() => resolveFluentProjectDir(ws, 'link'), /symlink/);
});

test('resolveFluentProjectDir needs an existing directory with now.config.json', () => {
  const ws = mkWorkspace();
  fs.mkdirSync(path.join(ws, 'plain'));
  fs.writeFileSync(path.join(ws, 'file.txt'), 'x');
  assert.throws(() => resolveFluentProjectDir(ws, 'missing'), /not found/);
  assert.throws(() => resolveFluentProjectDir(ws, 'file.txt'), /not found/);
  assert.throws(() => resolveFluentProjectDir(ws, 'plain'), /now\.config\.json/);
});

// --- Handler ---------------------------------------------------------------------

test('a refused project is an error result and loads nothing', async () => {
  const ws = mkWorkspace();
  let loaded = false;
  const { context } = makeContext(ws, {
    loadFluent: () => {
      loaded = true;
      throw new Error('unreachable');
    },
  });
  const response = await handleFluentBuild({ project: '../x' }, context);
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /outside the workspace/);
  assert.equal(loaded, false);
});

test('dryRun plans the build and records it without loading the adapter', async () => {
  const ws = mkWorkspace();
  mkProject(ws, 'app');
  let loaded = false;
  const { context, calls } = makeContext(ws, {
    dryRun: true,
    loadFluent: () => {
      loaded = true;
      throw new Error('unreachable');
    },
  });
  const args = { project: 'app', frozenKeys: true, dryRun: true };
  const response = await handleFluentBuild(args, context);
  assert.equal(response.isError, false);
  assert.equal(loaded, false);
  assert.equal(calls.dryRun.length, 1);
  assert.deepEqual(calls.dryRun[0], {
    toolName: 'sync_fluent_build',
    args,
    details: { project: 'app', method: 'build', options: { frozenKeys: true }, outputDir: 'app/dist' },
  });
});

test('a successful build returns exit code 0, diagnostics, output paths and the SDK log', async () => {
  const ws = mkWorkspace();
  const projectDir = mkProject(ws, 'app');
  const fluent = fakeFluent(({ projectDir: dir, logger }) => {
    logger.info('building');
    logger.warn('deprecated API');
    logger.debug('details');
    fs.mkdirSync(path.join(dir, 'dist', 'app', 'update'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'app', 'update', 'b.xml'), '<b/>');
    fs.writeFileSync(path.join(dir, 'dist', 'app', 'a.xml'), '<a/>');
    return { success: true, errors: [], warnings: ['unused import'] };
  });
  const { context, calls } = makeContext(ws, { loadFluent: fluent.loader });

  const response = await handleFluentBuild({ project: 'app', skipClean: true }, context);
  const payload = payloadOf(response);

  assert.equal(response.isError, false);
  assert.deepEqual(response.structuredContent, payload);
  assert.equal(payload.outcome, 'succeeded');
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.project, 'app');
  assert.deepEqual(payload.options, { skipClean: true });
  assert.deepEqual(payload.errors, []);
  assert.deepEqual(payload.warnings, ['unused import']);
  assert.equal(payload.outputDir, 'app/dist');
  assert.deepEqual(payload.outputs, ['app/a.xml', 'app/update/b.xml']);
  assert.deepEqual(payload.log, ['[info] building', '[warn] deprecated API', '[debug] details']);
  assert.equal(typeof payload.durationMs, 'number');

  assert.equal(fluent.seen.engineOptions[0].projectDir, projectDir);
  assert.equal(fluent.seen.engineOptions[0].loaderProjectDir, projectDir);
  assert.deepEqual(fluent.seen.buildOptions, [{ skipClean: true }]);
  // A mutating tool: every real run leaves a mutating audit entry.
  assert.equal(calls.audit.length, 1);
  const [toolName, auditedArgs, outcome, durationMs] = calls.audit[0];
  assert.equal(toolName, 'sync_fluent_build');
  assert.deepEqual(auditedArgs, { project: 'app', skipClean: true });
  assert.deepEqual(outcome, {
    outcome: 'succeeded',
    exitCode: 0,
    project: 'app',
    options: { skipClean: true },
    errorCount: 0,
    warningCount: 1,
  });
  assert.equal(typeof durationMs, 'number');
});

test('a run that could not finish is audited too, with its code', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const { context, calls } = makeContext(ws, {
    loadFluent: () => {
      throw new FluentNotInstalledError();
    },
  });
  const response = await handleFluentBuild({}, context);
  assert.equal(response.isError, true);
  assert.equal(calls.audit.length, 1);
  assert.deepEqual(calls.audit[0][2], {
    outcome: 'incomplete',
    exitCode: 1,
    project: '.',
    options: {},
    errorCount: 0,
    warningCount: 0,
    code: 'FLUENT_NOT_INSTALLED',
  });
});

test('a dry run writes no mutating audit entry of its own and loads nothing', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const { context, calls } = makeContext(ws, {
    dryRun: true,
    loadFluent: () => assert.fail('a dry run must not load the adapter'),
  });
  await handleFluentBuild({ dryRun: true }, context);
  // makeDryRunAuditResponse records the plan; the handler adds nothing else.
  assert.equal(calls.dryRun.length, 1);
  assert.equal(calls.audit.length, 0);
});

test('a build that reports errors returns exit code 2 as an error result', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const fluent = fakeFluent(() => ({ success: false, errors: ['src/a.now.ts: bad key'], warnings: [] }));
  const { context } = makeContext(ws, { loadFluent: fluent.loader });

  const response = await handleFluentBuild({}, context);
  const payload = payloadOf(response);
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent, undefined);
  assert.equal(payload.outcome, 'failed');
  assert.equal(payload.exitCode, 2);
  assert.equal(payload.project, '.');
  assert.deepEqual(payload.errors, ['src/a.now.ts: bad key']);
  assert.equal(payload.outputDir, 'dist');
  assert.deepEqual(payload.outputs, []);
});

test('a malformed engine result is normalized instead of trusted', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const fluent = fakeFluent(() => ({ success: 'yes', errors: 'boom', warnings: [1] }));
  const { context } = makeContext(ws, { loadFluent: fluent.loader });
  const payload = payloadOf(await handleFluentBuild({}, context));
  assert.equal(payload.outcome, 'failed');
  assert.deepEqual(payload.errors, []);
  assert.deepEqual(payload.warnings, ['1']);
});

/** Node's own module-not-found error for `specifier`, required from `from`. */
function moduleNotFound(specifier, from = '/app/node_modules/@syncrona/fluent/dist/index.js', code = 'MODULE_NOT_FOUND') {
  return Object.assign(new Error(`Cannot find module '${specifier}'\nRequire stack:\n- ${from}`), { code });
}

test('a missing @syncrona/fluent returns the install hint with exit code 1', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  for (const failure of [
    new FluentNotInstalledError(),
    moduleNotFound('@syncrona/fluent', '/app/index.js'),
    moduleNotFound('@syncrona/fluent', '/app/index.js', 'ERR_MODULE_NOT_FOUND'),
  ]) {
    const { context } = makeContext(ws, {
      loadFluent: () => {
        throw failure;
      },
    });
    const response = await handleFluentBuild({}, context);
    const payload = payloadOf(response);
    assert.equal(response.isError, true);
    assert.equal(payload.outcome, 'incomplete');
    assert.equal(payload.exitCode, 1);
    assert.equal(payload.code, 'FLUENT_NOT_INSTALLED');
    assert.equal(payload.installHint, FLUENT_INSTALL_HINT);
    assert.equal(payload.message, undefined);
    assert.equal(payload.outputs, undefined);
  }
});

test('a missing dependency of an installed adapter keeps its own message, not the install hint', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  // Named in the require stack only, as Node reports a dependency the adapter cannot find.
  const failure = moduleNotFound('left-pad');
  const { context } = makeContext(ws, {
    loadFluent: () => {
      throw failure;
    },
  });
  const response = await handleFluentBuild({}, context);
  const payload = payloadOf(response);
  assert.equal(response.isError, true);
  assert.equal(payload.outcome, 'incomplete');
  assert.equal(payload.exitCode, 1);
  assert.equal(payload.code, undefined);
  assert.equal(payload.installHint, undefined);
  assert.equal(payload.message, failure.message);
});

test('a project source importing a missing file keeps its own message, not the install hint', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const failure = moduleNotFound('./missing-table.now', path.join(ws, 'src', 'index.now.ts'), 'ERR_MODULE_NOT_FOUND');
  const fluent = fakeFluent(() => {
    throw failure;
  });
  const { context } = makeContext(ws, { loadFluent: fluent.loader });
  const payload = payloadOf(await handleFluentBuild({}, context));
  assert.equal(payload.exitCode, 1);
  assert.equal(payload.code, undefined);
  assert.equal(payload.installHint, undefined);
  assert.equal(payload.message, failure.message);
});

test('a missing @servicenow/sdk returns the install hint with exit code 1', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const fluent = fakeFluent(() => {
    throw Object.assign(new Error('@servicenow/sdk is not installed'), { code: 'FLUENT_SDK_MISSING' });
  });
  const { context } = makeContext(ws, { loadFluent: fluent.loader });
  const payload = payloadOf(await handleFluentBuild({}, context));
  assert.equal(payload.exitCode, 1);
  assert.equal(payload.code, 'FLUENT_SDK_MISSING');
  assert.match(payload.installHint, /npm install --save-dev @syncrona\/fluent @servicenow\/sdk/);
});

test('a thrown build failure returns exit code 1 with its message', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const fluent = fakeFluent(() => {
    throw new Error('orchestrator crashed');
  });
  const { context } = makeContext(ws, { loadFluent: fluent.loader });
  const response = await handleFluentBuild({}, context);
  const payload = payloadOf(response);
  assert.equal(response.isError, true);
  assert.equal(payload.outcome, 'incomplete');
  assert.equal(payload.exitCode, 1);
  assert.equal(payload.message, 'orchestrator crashed');
  assert.equal(payload.code, undefined);
});

test('an adapter without createFluentEngine is reported, not called', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  for (const mod of [{}, null]) {
    const { context } = makeContext(ws, { loadFluent: () => mod });
    const payload = payloadOf(await handleFluentBuild({}, context));
    assert.equal(payload.exitCode, 1);
    assert.match(payload.message, /does not export createFluentEngine/);
  }
});

test('a synchronous throw from engine.build is reported with exit code 1', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const { context } = makeContext(ws, {
    loadFluent: () => ({
      createFluentEngine: () => ({
        build: () => {
          throw new Error('sync failure');
        },
      }),
    }),
  });
  const payload = payloadOf(await handleFluentBuild({}, context));
  assert.equal(payload.exitCode, 1);
  assert.equal(payload.message, 'sync failure');
  assert.equal(console.log.name === 'toStderr', false, 'console is restored');
});

test('a build that outlives timeoutMs is incomplete, and stdout stays guarded until it settles', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const realLog = console.log;
  let finish;
  let logDuringBuild;
  const fluent = fakeFluent(
    () =>
      new Promise((resolve) => {
        logDuringBuild = console.log;
        finish = () => resolve({ success: true, errors: [], warnings: [] });
      })
  );
  const { context } = makeContext(ws, { loadFluent: fluent.loader, timeoutMs: 20 });

  const payload = payloadOf(await handleFluentBuild({}, context));
  assert.equal(payload.outcome, 'incomplete');
  assert.equal(payload.exitCode, 1);
  assert.equal(payload.code, 'FLUENT_BUILD_TIMEOUT');
  assert.match(payload.message, /did not finish within 20 ms/);

  // The SDK's console output is routed to stderr while the build runs — even
  // after the call has given up on it — and restored once it settles.
  assert.notEqual(logDuringBuild, realLog);
  assert.notEqual(console.log, realLog);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(console.log, realLog);
});

test('a build that blocks the event loop past timeoutMs returns its real result, flagged budgetExceeded', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  // Synchronous work: the timeout timer cannot fire until the build returns.
  const fluent = fakeFluent(() => {
    const until = Date.now() + 80;
    while (Date.now() < until) {
      // busy-wait
    }
    return { success: true, errors: [], warnings: [] };
  });
  const { context } = makeContext(ws, { loadFluent: fluent.loader, timeoutMs: 20 });
  const response = await handleFluentBuild({}, context);
  const payload = payloadOf(response);
  assert.equal(response.isError, false);
  assert.equal(payload.outcome, 'succeeded');
  assert.equal(payload.code, undefined);
  assert.equal(payload.budgetExceeded, true);
});

test('a build within timeoutMs does not report budgetExceeded', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const fluent = fakeFluent(() => ({ success: true, errors: [], warnings: [] }));
  const { context } = makeContext(ws, { loadFluent: fluent.loader });
  assert.equal(payloadOf(await handleFluentBuild({}, context)).budgetExceeded, undefined);
});

test('the console guard writes to stderr while a build runs', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const realError = console.error;
  const seen = [];
  console.error = (...parts) => seen.push(parts.join(' '));
  try {
    const fluent = fakeFluent(() => {
      console.log('from the sdk');
      console.info('info line');
      console.debug('debug line');
      return { success: true, errors: [], warnings: [] };
    });
    const { context } = makeContext(ws, { loadFluent: fluent.loader });
    await handleFluentBuild({}, context);
  } finally {
    console.error = realError;
  }
  assert.deepEqual(seen, ['from the sdk', 'info line', 'debug line']);
});

test('the console guard also covers the adapter load and engine creation', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  // The real loadFluentModule path: an installed @syncrona/fluent whose module
  // top-level and engine constructor both print to stdout.
  writeFixturePackage(
    ws,
    '@syncrona/fluent',
    [
      "console.log('module top-level');",
      'exports.createFluentEngine = () => {',
      "  console.info('engine created');",
      '  return { build: async () => ({ success: true, errors: [], warnings: [] }) };',
      '};',
    ].join('\n')
  );
  const realLog = console.log;
  const realError = console.error;
  const seen = [];
  console.error = (...parts) => seen.push(parts.join(' '));
  let response;
  try {
    const { context } = makeContext(ws);
    response = await handleFluentBuild({}, context);
  } finally {
    console.error = realError;
  }
  assert.equal(payloadOf(response).outcome, 'succeeded');
  assert.deepEqual(seen, ['module top-level', 'engine created']);
  assert.equal(console.log, realLog, 'console is restored after the build');
});

test('a load failure that logs first is guarded, and the guard is released', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const realLog = console.log;
  const realError = console.error;
  const seen = [];
  console.error = (...parts) => seen.push(parts.join(' '));
  let response;
  try {
    const { context } = makeContext(ws, {
      loadFluent: async () => {
        console.log('loading the adapter');
        throw new Error('adapter exploded');
      },
    });
    response = await handleFluentBuild({}, context);
  } finally {
    console.error = realError;
  }
  assert.equal(payloadOf(response).outcome, 'incomplete');
  assert.deepEqual(seen, ['loading the adapter']);
  assert.equal(console.log, realLog, 'console is restored after a failed load');
});

test('handleFluentTool owns only sync_fluent_build', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const { context } = makeContext(ws, { dryRun: true });
  assert.equal(await handleFluentTool('sync_build', {}, context), null);
  const response = await handleFluentTool('sync_fluent_build', { dryRun: true }, context);
  assert.equal(response.isError, false);
});

// --- Adapter resolution --------------------------------------------------------------

function writeFixturePackage(projectDir, name, source) {
  const dir = path.join(projectDir, 'node_modules', ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), source);
}

test('loadFluentModule resolves the adapter from the project first', () => {
  const ws = mkWorkspace();
  writeFixturePackage(ws, '@fixture/fluent-a', 'exports.createFluentEngine = () => "project";');
  const mod = loadFluentModule(ws, '@fixture/fluent-a');
  assert.equal(mod.createFluentEngine(), 'project');
});

test('loadFluentModule accepts a default-export module', () => {
  const ws = mkWorkspace();
  writeFixturePackage(ws, '@fixture/fluent-b', 'exports.default = { createFluentEngine: () => "default" };');
  assert.equal(loadFluentModule(ws, '@fixture/fluent-b').createFluentEngine(), 'default');
});

test('loadFluentModule throws FluentNotInstalledError when neither location has it', () => {
  const ws = mkWorkspace();
  assert.throws(
    () => loadFluentModule(ws, '@fixture/not-installed-anywhere'),
    (e) => e instanceof FluentNotInstalledError && e.code === 'FLUENT_NOT_INSTALLED' && e.message === FLUENT_INSTALL_HINT
  );
});

test('loadFluentModule rethrows a missing dependency of an installed adapter as itself', () => {
  const ws = mkWorkspace();
  writeFixturePackage(ws, '@fixture/fluent-d', "require('@fixture/absent-dependency'); exports.createFluentEngine = () => 'x';");
  assert.throws(
    () => loadFluentModule(ws, '@fixture/fluent-d'),
    (e) =>
      !(e instanceof FluentNotInstalledError) &&
      e.code === 'MODULE_NOT_FOUND' &&
      e.message.includes("'@fixture/absent-dependency'")
  );
});

test('loadFluentModule refuses a project adapter that is a symlink out of the workspace', () => {
  const ws = mkWorkspace();
  const outside = mkWorkspace();
  writeFixturePackage(outside, '@fixture/fluent-link', 'globalThis.__fluentLinkLoaded = true; exports.createFluentEngine = () => "outside";');
  fs.mkdirSync(path.join(ws, 'node_modules', '@fixture'), { recursive: true });
  fs.symlinkSync(
    path.join(outside, 'node_modules', '@fixture', 'fluent-link'),
    path.join(ws, 'node_modules', '@fixture', 'fluent-link'),
    'dir'
  );
  assert.throws(
    () => loadFluentModule(ws, '@fixture/fluent-link'),
    (e) =>
      e instanceof FluentAdapterOutsideWorkspaceError &&
      e.code === 'FLUENT_ADAPTER_OUTSIDE_WORKSPACE' &&
      e.message.includes('outside the workspace')
  );
  assert.equal(globalThis.__fluentLinkLoaded, undefined, 'the linked code never ran');
});

test('loadFluentModule refuses a node_modules that is itself a symlink out of the workspace', () => {
  const ws = mkWorkspace();
  const outside = mkWorkspace();
  writeFixturePackage(outside, '@fixture/fluent-nm', 'exports.createFluentEngine = () => "outside";');
  fs.symlinkSync(path.join(outside, 'node_modules'), path.join(ws, 'node_modules'), 'dir');
  assert.throws(() => loadFluentModule(ws, '@fixture/fluent-nm'), FluentAdapterOutsideWorkspaceError);
});

test('loadFluentModule confines to the workspace, not just the project', () => {
  const ws = mkWorkspace();
  const projectDir = mkProject(ws, 'apps/one');
  // Hoisted to the workspace root: outside the project, still inside the workspace.
  writeFixturePackage(ws, '@fixture/fluent-hoisted', 'exports.createFluentEngine = () => "hoisted";');
  assert.equal(loadFluentModule(projectDir, '@fixture/fluent-hoisted', ws).createFluentEngine(), 'hoisted');
  // The same package seen from a project whose workspace is the project alone is refused.
  assert.throws(() => loadFluentModule(projectDir, '@fixture/fluent-hoisted'), FluentAdapterOutsideWorkspaceError);
});

test('a refused adapter surfaces as an incomplete run with its code', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const { context, calls } = makeContext(ws, {
    loadFluent: () => {
      throw new FluentAdapterOutsideWorkspaceError('Refusing to load @syncrona/fluent from outside the workspace.');
    },
  });
  const payload = payloadOf(await handleFluentBuild({}, context));
  assert.equal(payload.outcome, 'incomplete');
  assert.equal(payload.code, 'FLUENT_ADAPTER_OUTSIDE_WORKSPACE');
  assert.match(payload.message, /outside the workspace/);
  assert.equal(calls.audit[0][2].code, 'FLUENT_ADAPTER_OUTSIDE_WORKSPACE');
});

test('the default loader loads a hoisted adapter in the workspace and never runs a linked one', async () => {
  const ws = mkWorkspace();
  mkProject(ws, 'apps/one');
  writeFixturePackage(
    ws,
    '@syncrona/fluent',
    'exports.createFluentEngine = () => ({ build: async () => { globalThis.__fluentFixtureBuilds = (globalThis.__fluentFixtureBuilds || 0) + 1; return { success: true, errors: [], warnings: [] }; } });'
  );
  const hoisted = makeContext(ws);
  const ok = payloadOf(await handleFluentBuild({ project: 'apps/one' }, hoisted.context));
  assert.equal(ok.outcome, 'succeeded');
  assert.equal(globalThis.__fluentFixtureBuilds, 1);

  const linkedWs = mkWorkspace();
  mkProject(linkedWs);
  fs.symlinkSync(path.join(ws, 'node_modules'), path.join(linkedWs, 'node_modules'), 'dir');
  const linked = makeContext(linkedWs);
  const result = payloadOf(await handleFluentBuild({}, linked.context));
  assert.equal(globalThis.__fluentFixtureBuilds, 1, 'the linked adapter never ran');
  assert.equal(result.outcome, 'incomplete');
  // The escape falls through to the server's own install. In this monorepo that
  // is the workspace's @syncrona/fluent (without @servicenow/sdk); a server
  // installed without the adapter refuses the escape instead.
  let serverHasAdapter = true;
  try {
    require.resolve('@syncrona/fluent', { paths: [path.resolve(__dirname, '../dist/handlers')] });
  } catch {
    serverHasAdapter = false;
  }
  if (serverHasAdapter) assert.notEqual(result.code, 'FLUENT_ADAPTER_OUTSIDE_WORKSPACE');
  else assert.equal(result.code, 'FLUENT_ADAPTER_OUTSIDE_WORKSPACE');
});

test('loadFluentAdapter reports a project adapter with its real package directory and version', () => {
  const ws = mkWorkspace();
  writeFixturePackage(ws, '@fixture/fluent-info', 'exports.createFluentEngine = () => "info";');
  const pkgDir = path.join(ws, 'node_modules', '@fixture', 'fluent-info');
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ ...manifest, version: '9.8.7' }));
  const loaded = loadFluentAdapter(ws, '@fixture/fluent-info');
  assert.equal(loaded.module.createFluentEngine(), 'info');
  assert.deepEqual(loaded.adapter, { source: 'project', path: fs.realpathSync.native(pkgDir), version: '9.8.7' });
});

test('loadFluentAdapter reports a package without a version, and a nested entry, by its package directory', () => {
  const ws = mkWorkspace();
  const pkgDir = path.join(ws, 'node_modules', '@fixture', 'fluent-nover');
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@fixture/fluent-nover', main: 'lib/index.js' }));
  // A nested manifest that names another package is skipped on the way up.
  fs.writeFileSync(path.join(pkgDir, 'lib', 'package.json'), JSON.stringify({ type: 'commonjs' }));
  fs.writeFileSync(path.join(pkgDir, 'lib', 'index.js'), 'exports.createFluentEngine = () => "nover";');
  const { adapter } = loadFluentAdapter(ws, '@fixture/fluent-nover');
  assert.deepEqual(adapter, { source: 'project', path: fs.realpathSync.native(pkgDir) });
});

test('loadFluentAdapter reports the server install as the source of a fallback', () => {
  const ws = mkWorkspace();
  const { adapter } = loadFluentAdapter(ws, 'zod');
  const serverZod = path.dirname(require.resolve('zod/package.json', { paths: [path.resolve(__dirname, '..')] }));
  assert.equal(adapter.source, 'server');
  assert.equal(adapter.path, fs.realpathSync.native(serverZod));
  assert.equal(adapter.version, JSON.parse(fs.readFileSync(path.join(serverZod, 'package.json'), 'utf8')).version);
});

test('the build response and audit name the adapter the default loader loaded', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  writeFixturePackage(
    ws,
    '@syncrona/fluent',
    'exports.createFluentEngine = () => ({ build: async () => ({ success: true, errors: [], warnings: [] }) });'
  );
  const pkgDir = path.join(ws, 'node_modules', '@syncrona', 'fluent');
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@syncrona/fluent', version: '1.2.3', main: 'index.js' })
  );
  const { context, calls } = makeContext(ws);
  const payload = payloadOf(await handleFluentBuild({}, context));
  const expected = { source: 'project', path: fs.realpathSync.native(pkgDir), version: '1.2.3' };
  assert.equal(payload.outcome, 'succeeded');
  assert.deepEqual(payload.adapter, expected);
  assert.deepEqual(calls.audit[0][2].adapter, expected);
});

test('an injected loader, a refused or a missing adapter reports no adapter', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const injected = makeContext(ws, { loadFluent: fakeFluent(async () => ({ success: true, errors: [], warnings: [] })).loader });
  const payload = payloadOf(await handleFluentBuild({}, injected.context));
  assert.equal('adapter' in payload, false);
  assert.equal('adapter' in injected.calls.audit[0][2], false);
  const refused = makeContext(ws, {
    loadFluent: () => {
      throw new FluentAdapterOutsideWorkspaceError('Refusing to load @syncrona/fluent from outside the workspace.');
    },
  });
  assert.equal('adapter' in payloadOf(await handleFluentBuild({}, refused.context)), false);
});

test('loadFluentModule falls back to the server install and rethrows other resolution errors', () => {
  const ws = mkWorkspace();
  // `zod` is not in the temporary project, but the server's own install resolves it.
  assert.doesNotThrow(() => loadFluentModule(ws, 'zod'));
  // A package whose `exports` hides the entry is a real resolution error, not "missing".
  const dir = path.join(ws, 'node_modules', '@fixture', 'fluent-c');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@fixture/fluent-c', exports: {} }));
  assert.throws(() => loadFluentModule(ws, '@fixture/fluent-c'), (e) => !(e instanceof FluentNotInstalledError));
});

test('loadFluentModule falls through to the server install when the project resolves above the workspace', () => {
  // The monorepo case: the server starts in a package directory, and the adapter
  // is hoisted to the repository root. `zod` stands in for it: the project
  // requirer finds <repo>/node_modules/zod, outside this package, and the
  // server's own requirer resolves the identical real path, which is trusted.
  const serverPackageDir = path.resolve(__dirname, '..');
  const hoisted = require.resolve('zod', { paths: [serverPackageDir] });
  assert.ok(
    !fs.realpathSync(hoisted).startsWith(fs.realpathSync(serverPackageDir) + path.sep),
    'zod is hoisted above the package'
  );
  assert.doesNotThrow(() => loadFluentModule(serverPackageDir, 'zod', serverPackageDir));
});

test('a project adapter hoisted above the workspace stays refused when the server install lacks it', () => {
  const repo = mkWorkspace();
  const appDir = mkProject(repo, 'packages/app');
  writeFixturePackage(
    repo,
    '@fixture/fluent-above',
    'globalThis.__fluentAboveLoaded = true; exports.createFluentEngine = () => "above";'
  );
  assert.throws(
    () => loadFluentModule(appDir, '@fixture/fluent-above', appDir),
    (e) =>
      e instanceof FluentAdapterOutsideWorkspaceError &&
      e.code === 'FLUENT_ADAPTER_OUTSIDE_WORKSPACE' &&
      /start the server from the workspace root or pass project:/.test(e.message)
  );
  assert.equal(globalThis.__fluentAboveLoaded, undefined, 'the hoisted code never ran');
});

/**
 * Runs loadFluentModule in a child process with `env` (NODE_PATH and HOME are
 * read once, at startup, into Module.globalPaths) and reports what happened.
 */
function loadInChild(projectDir, specifier, env) {
  const { spawnSync } = require('node:child_process');
  const script = `
    const { loadFluentModule } = require(${JSON.stringify(path.resolve(__dirname, '../dist/handlers/fluentHandlers.js'))});
    let result;
    try {
      loadFluentModule(${JSON.stringify(projectDir)}, ${JSON.stringify(specifier)});
      result = { loaded: true };
    } catch (e) {
      result = { loaded: false, code: e.code, name: e.name, message: e.message };
    }
    result.ran = globalThis.__fluentOutsideRan === true;
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, NODE_PATH: '', ...env },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('loadFluentModule never loads an adapter that only NODE_PATH resolves', () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const outside = mkWorkspace();
  writeFixturePackage(
    outside,
    '@fixture/fluent-nodepath',
    'globalThis.__fluentOutsideRan = true; exports.createFluentEngine = () => "outside";'
  );
  const result = loadInChild(ws, '@fixture/fluent-nodepath', { NODE_PATH: path.join(outside, 'node_modules') });
  assert.equal(result.ran, false, 'the NODE_PATH adapter never ran');
  assert.equal(result.loaded, false);
  assert.equal(result.code, 'FLUENT_ADAPTER_OUTSIDE_WORKSPACE');
});

test('loadFluentModule never loads an adapter from a global folder (~/.node_modules)', () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const home = mkWorkspace();
  const dir = path.join(home, '.node_modules', '@fixture', 'fluent-global');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@fixture/fluent-global', main: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'globalThis.__fluentOutsideRan = true; exports.createFluentEngine = () => "global";');
  const result = loadInChild(ws, '@fixture/fluent-global', { HOME: home, USERPROFILE: home });
  assert.equal(result.ran, false, 'the global-folder adapter never ran');
  assert.equal(result.loaded, false);
  assert.equal(result.code, 'FLUENT_ADAPTER_OUTSIDE_WORKSPACE');
});

test('a NODE_PATH that points inside the server install still loads the server copy', () => {
  // The server's own install stays trusted however Node reached it: here NODE_PATH
  // names the monorepo's own node_modules, which is also in the server's ancestry.
  const ws = mkWorkspace();
  mkProject(ws);
  const repoNodeModules = path.resolve(__dirname, '../../../node_modules');
  const result = loadInChild(ws, 'zod', { NODE_PATH: repoNodeModules });
  assert.equal(result.loaded, true, result.message);
});

/**
 * Runs `fn` in this process with NODE_PATH set to `nodePath`, so the server
 * requirer's global-folder lookup is measured here rather than in a child.
 * Module.globalPaths is rebuilt from the environment and restored afterwards.
 */
function withNodePath(nodePath, fn) {
  const Module = require('node:module');
  const saved = process.env.NODE_PATH;
  process.env.NODE_PATH = nodePath;
  Module._initPaths();
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = saved;
    Module._initPaths();
  }
}

test('in process: an adapter only NODE_PATH resolves is refused and never runs', () => {
  // The project requirer sees the same global folders as the server's, so it finds
  // the NODE_PATH copy first and its workspace refusal is what surfaces.
  const ws = mkWorkspace();
  const outside = mkWorkspace();
  writeFixturePackage(outside, '@fixture/fluent-np-inproc', 'globalThis.__fluentNpInprocRan = true;');
  withNodePath(path.join(outside, 'node_modules'), () => {
    assert.throws(
      () => loadFluentAdapter(ws, '@fixture/fluent-np-inproc'),
      (e) => e instanceof FluentAdapterOutsideWorkspaceError && e.message.includes('from outside the workspace')
    );
  });
  assert.equal(globalThis.__fluentNpInprocRan, undefined, 'the NODE_PATH adapter never ran');
});

test('in process: a resolution error of the server fallback is rethrown, unless a refusal is pending', () => {
  // A NODE_PATH package whose `exports` hides its entry makes the server requirer
  // throw a real resolution error instead of reporting the package as missing.
  const outside = mkWorkspace();
  const hidden = path.join(outside, 'node_modules', '@fixture', 'fluent-np-hidden');
  fs.mkdirSync(hidden, { recursive: true });
  fs.writeFileSync(path.join(hidden, 'package.json'), JSON.stringify({ name: '@fixture/fluent-np-hidden', exports: {} }));
  const ws = mkWorkspace();
  // The same name hoisted above an app workspace gives a pending refusal.
  const repo = mkWorkspace();
  const appDir = mkProject(repo, 'packages/app');
  writeFixturePackage(repo, '@fixture/fluent-np-hidden', 'globalThis.__fluentNpHiddenRan = true;');
  withNodePath(path.join(outside, 'node_modules'), () => {
    assert.throws(
      () => loadFluentAdapter(ws, '@fixture/fluent-np-hidden'),
      (e) => !(e instanceof FluentNotInstalledError) && !(e instanceof FluentAdapterOutsideWorkspaceError)
    );
    assert.throws(
      () => loadFluentAdapter(appDir, '@fixture/fluent-np-hidden', appDir),
      (e) => e instanceof FluentAdapterOutsideWorkspaceError && /start the server from the workspace root/.test(e.message)
    );
  });
  assert.equal(globalThis.__fluentNpHiddenRan, undefined, 'the hoisted code never ran');
});

test('in process: a server-install package whose main leaves its directory is refused and never runs', () => {
  // The package sits in a node_modules directory of the server's own ancestry
  // (dist/node_modules), but its `main` points outside the package, so what the
  // server requirer resolves is neither in the workspace nor in the server install.
  const name = `zz-fluent-main-escape-${process.pid}`;
  const nodeModules = path.resolve(__dirname, '../dist/node_modules');
  const createdNodeModules = !fs.existsSync(nodeModules);
  const pkgDir = path.join(nodeModules, name);
  const elsewhere = mkWorkspace();
  fs.writeFileSync(path.join(elsewhere, 'index.js'), 'globalThis.__fluentMainEscapeRan = true;');
  try {
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name, main: path.relative(pkgDir, path.join(elsewhere, 'index.js')) })
    );
    const ws = mkWorkspace();
    assert.throws(
      () => loadFluentAdapter(ws, name),
      (e) =>
        e instanceof FluentAdapterOutsideWorkspaceError &&
        e.message.includes("resolves outside both the workspace and the server's own install") &&
        e.message.includes('a package entry that leaves its directory') &&
        !e.message.includes('Node found it through')
    );
  } finally {
    fs.rmSync(createdNodeModules ? nodeModules : pkgDir, { recursive: true, force: true });
  }
  assert.equal(globalThis.__fluentMainEscapeRan, undefined, 'the escaped entry never ran');
  assert.equal(fs.existsSync(pkgDir), false, 'the fixture left nothing in dist');
});

test('loadFluentAdapter reports an adapter outside any package by its real file path', () => {
  // An absolute specifier names a file with no enclosing package of that name, so
  // the manifest walk reaches the filesystem root and reports the file itself.
  const ws = mkWorkspace();
  const file = path.join(ws, 'adapter.js');
  fs.writeFileSync(file, 'exports.createFluentEngine = () => "bare";');
  const loaded = loadFluentAdapter(ws, file);
  assert.equal(loaded.module.createFluentEngine(), 'bare');
  assert.deepEqual(loaded.adapter, { source: 'project', path: fs.realpathSync.native(file) });
});

/** Asserts the project adapter `specifier` is refused and its code never ran (`flag` stays unset). */
function assertRefusedUnrun(projectDir, specifier, workspaceDir, flag) {
  assert.throws(() => loadFluentModule(projectDir, specifier, workspaceDir), FluentAdapterOutsideWorkspaceError);
  assert.equal(globalThis[flag], undefined, `${specifier} never ran`);
}

test('loadFluentModule refuses an adapter in a sibling directory that shares the workspace prefix', () => {
  const root = mkWorkspace();
  const ws = path.join(root, 'app');
  fs.mkdirSync(ws);
  writeFixturePackage(path.join(root, 'app-evil'), '@fixture/fluent-prefix', 'globalThis.__fluentPrefix = 1;');
  fs.mkdirSync(path.join(ws, 'node_modules', '@fixture'), { recursive: true });
  fs.symlinkSync(
    path.join(root, 'app-evil', 'node_modules', '@fixture', 'fluent-prefix'),
    path.join(ws, 'node_modules', '@fixture', 'fluent-prefix'),
    'dir'
  );
  assertRefusedUnrun(ws, '@fixture/fluent-prefix', ws, '__fluentPrefix');
});

test('loadFluentModule refuses a package whose entry file is a symlink out of the workspace', () => {
  const ws = mkWorkspace();
  const outside = mkWorkspace();
  fs.writeFileSync(path.join(outside, 'entry.js'), 'globalThis.__fluentEntryLink = 1;');
  writeFixturePackage(ws, '@fixture/fluent-entry', '');
  const entry = path.join(ws, 'node_modules', '@fixture', 'fluent-entry', 'index.js');
  fs.rmSync(entry);
  fs.symlinkSync(path.join(outside, 'entry.js'), entry, 'file');
  assertRefusedUnrun(ws, '@fixture/fluent-entry', ws, '__fluentEntryLink');
});

test('loadFluentModule refuses a package whose main escapes the workspace', () => {
  const root = mkWorkspace();
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(root, 'escaped.js'), 'globalThis.__fluentMainEscape = 1;');
  const dir = path.join(ws, 'node_modules', '@fixture', 'fluent-main');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: '@fixture/fluent-main', main: '../../../../escaped.js' })
  );
  assertRefusedUnrun(ws, '@fixture/fluent-main', ws, '__fluentMainEscape');
});

// A case-insensitive filesystem (the macOS and Windows defaults) accepts a path
// spelled in another case; the confinement checks must not refuse it for that.
const caseInsensitiveFs = (() => {
  const probe = fs.realpathSync(os.tmpdir());
  const flipped = probe.replace(/[a-z]/, (c) => c.toUpperCase());
  return flipped !== probe && fs.existsSync(flipped);
})();

function otherCase(dir) {
  return path.join(path.dirname(dir), path.basename(dir).toUpperCase());
}

test(
  'loadFluentModule accepts an in-workspace adapter when the workspace path differs only in case',
  { skip: !caseInsensitiveFs },
  () => {
    const ws = mkWorkspace();
    writeFixturePackage(ws, '@fixture/fluent-case', 'exports.createFluentEngine = () => "case";');
    assert.equal(loadFluentModule(ws, '@fixture/fluent-case', otherCase(ws)).createFluentEngine(), 'case');
    assert.equal(loadFluentModule(otherCase(ws), '@fixture/fluent-case', ws).createFluentEngine(), 'case');
  }
);

test('resolveFluentProjectDir accepts a workspace path that differs only in case', { skip: !caseInsensitiveFs }, () => {
  const ws = mkWorkspace();
  mkProject(ws, 'apps/one');
  assert.doesNotThrow(() => resolveFluentProjectDir(otherCase(ws), 'apps/one'));
});

// --- Output listing ------------------------------------------------------------------

test('listOutputFiles lists sorted relative paths and caps the list', () => {
  const ws = mkWorkspace();
  const dist = path.join(ws, 'dist');
  fs.mkdirSync(path.join(dist, 'sub'), { recursive: true });
  for (const name of ['c.xml', 'a.xml', 'sub/b.xml']) fs.writeFileSync(path.join(dist, name), 'x');
  assert.deepEqual(listOutputFiles(dist), { files: ['a.xml', 'c.xml', 'sub/b.xml'], truncated: false, warnings: [] });
  assert.deepEqual(listOutputFiles(dist, 2), { files: ['a.xml', 'c.xml'], truncated: true, warnings: [] });
  assert.deepEqual(listOutputFiles(path.join(ws, 'missing')), { files: [], truncated: false, warnings: [] });
});

test('listOutputFiles neither follows nor lists symlinks', () => {
  const ws = mkWorkspace();
  const outside = mkWorkspace();
  fs.mkdirSync(path.join(outside, 'secrets'));
  fs.writeFileSync(path.join(outside, 'secrets', 'key.pem'), 'x');
  fs.writeFileSync(path.join(outside, 'passwd'), 'x');
  const dist = path.join(ws, 'dist');
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, 'a.xml'), 'x');
  fs.symlinkSync(path.join(outside, 'secrets'), path.join(dist, 'dirlink'), 'dir');
  fs.symlinkSync(path.join(outside, 'passwd'), path.join(dist, 'filelink'));
  const listing = listOutputFiles(dist);
  assert.deepEqual(listing.files, ['a.xml']);
  assert.equal(listing.warnings.length, 2);
  assert.match(listing.warnings[0], /symlink "dirlink"/);
  assert.match(listing.warnings[1], /symlink "filelink"/);
});

test('listOutputFiles refuses an output directory that is itself a symlink', () => {
  const ws = mkWorkspace();
  const outside = mkWorkspace();
  fs.writeFileSync(path.join(outside, 'passwd'), 'x');
  fs.symlinkSync(outside, path.join(ws, 'dist'), 'dir');
  const listing = listOutputFiles(path.join(ws, 'dist'));
  assert.deepEqual(listing.files, []);
  assert.match(listing.warnings[0], /is a symlink/);
});

// Permission bits do not bind root, and Windows has no POSIX modes.
const canDenyRead = process.platform !== 'win32' && process.getuid?.() !== 0;

test('an unreadable output directory leaves a finished build succeeded, with a warning', { skip: !canDenyRead }, async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const locked = path.join(ws, 'dist', 'locked');
  const fluent = fakeFluent(({ projectDir }) => {
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, 'x.xml'), 'x');
    fs.writeFileSync(path.join(projectDir, 'dist', 'a.xml'), 'x');
    fs.chmodSync(locked, 0o000);
    return { success: true, errors: [], warnings: [] };
  });
  const { context } = makeContext(ws, { loadFluent: fluent.loader });
  try {
    const response = await handleFluentBuild({}, context);
    const payload = payloadOf(response);
    assert.equal(response.isError, false);
    assert.equal(payload.outcome, 'succeeded');
    assert.deepEqual(payload.outputs, ['a.xml']);
    assert.equal(payload.outputWarnings.length, 1);
    assert.match(payload.outputWarnings[0], /unreadable directory "locked"/);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

test('a build output symlink out of the workspace is not listed in the result', async () => {
  const ws = mkWorkspace();
  const outside = mkWorkspace();
  fs.writeFileSync(path.join(outside, 'passwd'), 'x');
  mkProject(ws);
  const fluent = fakeFluent(({ projectDir }) => {
    fs.symlinkSync(outside, path.join(projectDir, 'dist'), 'dir');
    return { success: true, errors: [], warnings: [] };
  });
  const { context } = makeContext(ws, { loadFluent: fluent.loader });
  const payload = payloadOf(await handleFluentBuild({}, context));
  assert.equal(payload.outcome, 'succeeded');
  assert.deepEqual(payload.outputs, []);
  assert.match(payload.outputWarnings[0], /is a symlink/);
});

test('errors, warnings, log lines and long lines are capped with full counts', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const errors = Array.from({ length: 20000 }, (_, i) => `src/f${i}.now.ts: bad key`);
  const warnings = ['w'.repeat(MAX_LINE_CHARS + 50), 'short'];
  const fluent = fakeFluent(({ logger }) => {
    for (let i = 0; i < 250; i += 1) logger.info(`line ${i}`);
    return { success: false, errors, warnings };
  });
  const { context } = makeContext(ws, { loadFluent: fluent.loader });
  const payload = payloadOf(await handleFluentBuild({}, context));

  assert.equal(payload.outcome, 'failed');
  assert.equal(payload.errors.length, MAX_LISTED_DIAGNOSTICS);
  assert.deepEqual(payload.errors, errors.slice(0, MAX_LISTED_DIAGNOSTICS));
  assert.equal(payload.errorCount, 20000);
  assert.equal(payload.errorsTruncated, true);

  assert.equal(payload.warnings.length, 2);
  assert.equal(payload.warningCount, 2);
  assert.equal(payload.warningsTruncated, undefined);
  assert.ok(payload.warnings[0].startsWith('w'.repeat(MAX_LINE_CHARS)));
  assert.match(payload.warnings[0], /\[50 more chars\]$/);
  assert.equal(payload.warnings[1], 'short');

  assert.equal(payload.log.length, 200);
  assert.equal(payload.logTruncated, true);
});

test('an uncapped result reports counts without truncation flags', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const fluent = fakeFluent(() => ({ success: true, errors: [], warnings: ['one'] }));
  const { context } = makeContext(ws, { loadFluent: fluent.loader });
  const payload = payloadOf(await handleFluentBuild({}, context));
  assert.equal(payload.errorCount, 0);
  assert.equal(payload.warningCount, 1);
  assert.equal(payload.errorsTruncated, undefined);
  assert.equal(payload.warningsTruncated, undefined);
  assert.equal(payload.logTruncated, undefined);
  assert.equal(payload.outputWarnings, undefined);
});

test('a large build output is truncated in the result', async () => {
  const ws = mkWorkspace();
  mkProject(ws);
  const fluent = fakeFluent(({ projectDir }) => {
    fs.mkdirSync(path.join(projectDir, 'dist'), { recursive: true });
    for (let i = 0; i < 205; i += 1) {
      fs.writeFileSync(path.join(projectDir, 'dist', `f${String(i).padStart(3, '0')}.xml`), 'x');
    }
    return { success: true, errors: [], warnings: [] };
  });
  const { context } = makeContext(ws, { loadFluent: fluent.loader });
  const payload = payloadOf(await handleFluentBuild({}, context));
  assert.equal(payload.outputs.length, 200);
  assert.equal(payload.outputsTruncated, true);
});
