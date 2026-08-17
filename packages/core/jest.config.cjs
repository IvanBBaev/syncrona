// SPDX-License-Identifier: GPL-3.0-or-later
// This config is CommonJS (.cjs) on purpose: the package is now "type": "module"
// (ESM), so a plain jest.config.js would be parsed as ESM and break module.exports.
//
// The source tree is native ESM under TypeScript NodeNext, so tests run as real
// ESM via ts-jest (useESM) + Node's --experimental-vm-modules (set in the "test"
// script). Consequences that shape this config:
//   - extensionsToTreatAsEsm marks .ts files as ESM for the jest runtime.
//   - moduleNameMapper strips the mandatory ".js" suffix off relative specifiers
//     so jest resolves "./foo.js" back to the "./foo.ts" source.
//   - jest.mock() is NOT hoisted/applied under ESM; suites use
//     jest.unstable_mockModule() + a deferred await import() of the subject.
module.exports = {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: true }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // Force the OS keychain off by default so no test touches the real keychain
  // (hermetic + deterministic); keychain behaviour is tested via mocks.
  setupFiles: ['<rootDir>/jest.setup.cjs'],
  // Runs after the test framework is installed, which is what lets it register
  // global hooks (setupFiles above runs too early for that). It resets
  // `process.exitCode` around every test so no suite can inherit — or leak — a
  // value another one left behind; see the file for why the per-suite guards
  // were not enough on their own.
  setupFilesAfterEnv: ['<rootDir>/jest.exitcode.cjs'],
  // Whole-source coverage: the gate previously measured only src/commands.ts,
  // which made the "core >= 80%" CI claim meaningless. Thresholds below are a
  // ratchet floor set just under the measured baseline (2026-07-03: statements
  // 95.5%, branches 83.2%, functions 91.8%, lines 95.5% — up from the earlier
  // 85.7/71.9/80.7/85.6 baseline after per-file coverage suites landed for
  // diagnosticsCommands, downloadPipeline, config, FileUtils, manifestBuilder,
  // updateNotifier, pushCommand and Logger). Raise these as coverage grows;
  // never lower them. The lines/statements floors sit ~3pts under the measured
  // numbers so a real regression fails CI while cross-OS noise does not; the
  // branch floor keeps extra headroom because OS-specific branches
  // (keychain/homedir/platform) still make Linux CI measure a touch below macOS.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/tests/**',
  ],
  testPathIgnorePatterns: [
    ".js",
    // Stryker copies the whole package (tests included) into its sandbox and
    // does not clean it up when a run is interrupted, so without this a
    // leftover .stryker-tmp makes Jest run every suite twice — and the sandbox
    // copies resolve REPO_ROOT relative to themselves, which fails the
    // license-consistency suite from inside an otherwise green tree.
    "/\\.stryker-tmp/",
  ],
  coverageThreshold: {
    global: {
      statements: 92,
      branches: 79,
      functions: 89,
      lines: 92,
    },
    // REV-95 (GATE-1): the global-only thresholds above are diluted by the
    // whole tree — a brand-new source file at 0% coverage barely moves the
    // aggregate and ships green. These PER-FILE floors catch that: every file
    // that mismatches the floor fails CI on its own.
    //
    // Both globs together still preserve the global ratchet. Jest computes the
    // "global" bucket from files that match NO other threshold group; because
    // './src/**/*.ts' matches every collected source file, that bucket is empty
    // and Jest falls back to measuring `global` across ALL covered files (see
    // @jest/reporters coverage_reporter). So global and per-file gates both
    // stay live.
    //
    // REV-141: the globs MUST stay recursive to keep that invariant. They used to be
    // single-level ('./src/*.ts'), while collectCoverageFrom is recursive
    // ('src/**/*.ts'): the first source file added under a subdirectory would
    // therefore match no threshold group, land in the "global" bucket alone,
    // and Jest would then evaluate the global thresholds against THAT ONE FILE
    // instead of the whole tree — silently turning the repo-wide ratchet into a
    // single-file check (and skipping the per-file floor for it as well).
    //
    // src/index.ts is the CLI entry barrel (exercised only via subprocess
    // smoke tests, so it measures 0% lines/functions but 100% branches). It is
    // matched only by the branches glob below (which it passes) and excluded
    // from the lines glob via the '!(index)' extglob, so its legitimate 0%
    // lines does not fail the floor.
    //
    // GATE-2: these two globs used to sit at 20/20, which is a floor only against
    // a file with no test whatsoever — a module could fall from 98% to 21% and
    // still ship green. They are sized a few points under the weakest LEGITIMATE
    // file, so a real regression fails while cross-OS noise does not.
    //
    // Re-measured 2026-08-02 (whole suite, `jest --coverage`). The previous
    // sizing was anchored to src/mcpCommand.ts at 83.33% lines / 68.18% branches,
    // and that anchor was itself the bug: those were MACOS numbers, the file has
    // uncovered `process.platform` branches, and on Linux it measured 77.77 /
    // 52.27 — under this very floor, by one line. It now has a suite that pins the
    // platform instead of reading it (100.00 / 98.11 on every host) and a named
    // floor below, so the anchor moves to the real weak points:
    //   - lines: bootstrap.ts 84.00% (its uncovered code sits behind
    //     `JEST_WORKER_ID` guards, so it is unreachable from this suite by
    //     construction — the number is stable, not neglected);
    //   - branches: commandHelpers.ts and wizard.ts, both 71.79%.
    // Hence 81 / 67 rather than 78 / 62. `process.platform` now appears in exactly
    // two source files here (this one's neighbour diagnosticsCommands.ts is the
    // other) and both have suites that pin it, so the cross-OS branch drift these
    // floors used to absorb is down to the keychain and homedir cases.
    './src/**/*.ts': {
      branches: 67,
    },
    './src/**/!(index).ts': {
      lines: 81,
    },
    // GATE-2, per-module floors. The tree-wide globs above are necessarily sized
    // for the weakest file in the package, so on their own they let the modules
    // that write files, push to the instance, hold credentials or shell out drop
    // 15-20 points and still pass. Each key below pins ONE file a few points under
    // what it measures today (2026-07-30, recorded per entry as `measured L/B`):
    // ~3pts of headroom on lines and ~4-5pts on branches, because branch coverage
    // is the metric that moves between macOS and Linux CI (keychain, homedir and
    // platform branches). A ratchet, not a cliff: raise a floor when coverage
    // rises, never lower one to turn a red build green.
    //
    // Mechanics that make these safe (verified in @jest/reporters, coverage
    // reporter `_checkThreshold`):
    //   - A covered file is pushed into EVERY threshold group it matches, so a
    //     file listed here is still scored by the globs above and still feeds the
    //     `global` ratchet; adding keys cannot disable either.
    //   - A key that resolves to an existing file becomes a PATH group (prefix
    //     match); full filenames are used so one key can only ever score one file.
    //   - A key that matches nothing fails loudly with "Jest: Coverage data for
    //     <key> was not found.", so a floor left behind by a rename or a delete is
    //     reported instead of silently gating nothing.
    //   - Keys are resolved against process.cwd(), NOT rootDir (Jest does not
    //     expand <rootDir> in coverageThreshold keys). The suite runs from this
    //     package via `npm --workspace syncrona test`; running jest from the repo
    //     root with `-c packages/core/jest.config.cjs` makes every key below fail
    //     as "not found" rather than pass vacuously.
    //
    // Only lines and branches are pinned. Statements track lines almost exactly
    // here, and a functions floor on a single file is too coarse to mean anything
    // (one uncovered arrow in a 4-function module is a 25pt drop).
    //
    // The `// measured L / B` annotations are MACHINE-CHECKED, in two halves:
    //   - coverageFloors.test.ts (GATE-3) asserts each floor sits at or below its
    //     annotation and within the allowed headroom of it;
    //   - `npm run test:coverage:annotations` (scripts/check-coverage-annotations.mjs)
    //     asserts each annotation still equals what the file actually measures,
    //     reading Jest's json-summary report. They had drifted apart before that
    //     gate existed, which silently inflated the headroom every raise-the-floor
    //     decision was based on. Re-measure before editing one; never hand-edit an
    //     annotation to match a floor.
    //
    // Exact match is the rule HERE, with no escape hatch. The mcp-server gate
    // accepts a declared second reading (`// measured L / B (also L / B: cause)`)
    // because V8 range coverage reports two values for the same tree; istanbul does
    // not — three full runs of this suite produced a byte-identical
    // coverage-summary.json — so the annotations gate rejects that form on this
    // file. An annotation here that stopped matching is a real change, and the
    // per-run flapper this config has actually seen (`./src/commands.ts`, via
    // `process.exitCode` leaking between Jest suites) was fixed in the suite's
    // hooks, not absorbed by widening the gate.

    // Local filesystem writes and the path-containment guard.
    './src/FileUtils.ts': { lines: 95, branches: 87 }, // measured 98.32 / 92.53
    // Everything that mutates the ServiceNow instance, plus the collaboration
    // lock and the resumable checkpoint that protect a partial push.
    './src/pushCommand.ts': { lines: 97, branches: 89 }, // measured 100.00 / 93.91
    './src/pushPipeline.ts': { lines: 93, branches: 75 }, // measured 96.03 / 79.16
    './src/downloadPipeline.ts': { lines: 94, branches: 81 }, // measured 97.87 / 84.61
    './src/downloadCheckpoint.ts': { lines: 96, branches: 94 }, // measured 100.00 / 100.00
    './src/manifestBuilder.ts': { lines: 91, branches: 77 }, // measured 93.86 / 82.37
    // Deletes local files under `repair --apply --prune`.
    './src/repairCommand.ts': { lines: 93, branches: 88 }, // measured 96.61 / 93.67
    // Transport: auth headers, retries and the request surface every command uses.
    './src/snClient.ts': { lines: 97, branches: 89 }, // measured 100.00 / 93.28
    // Credentials: the keychain/file store and the auth-method picker.
    './src/authCommands.ts': { lines: 88, branches: 70 }, // measured 91.62 / 75.89
    './src/config.ts': { lines: 96, branches: 85 }, // measured 99.46 / 89.92
    './src/envFile.ts': { lines: 96, branches: 80 }, // measured 100.00 / 85.00
    // Scope resolution — a scope code reaches both a URL and a local path.
    './src/scopeManagement.ts': { lines: 94, branches: 82 }, // measured 97.72 / 86.66
    './src/commandHelpers.ts': { lines: 92, branches: 67 }, // measured 95.83 / 71.79
    './src/commands.ts': { lines: 93, branches: 79 }, // measured 96.73 / 83.11
    // Spawns plugin processes / watches the tree / drives the interactive setup.
    './src/PluginManager.ts': { lines: 96, branches: 84 }, // measured 100.00 / 89.65
    './src/Watcher.ts': { lines: 91, branches: 68 }, // measured 94.25 / 73.07
    './src/devCommands.ts': { lines: 96, branches: 90 }, // measured 100.00 / 95.23
    './src/wizard.ts': { lines: 95, branches: 67 }, // measured 98.57 / 71.79
    './src/gitUtils.ts': { lines: 96, branches: 94 }, // measured 100.00 / 100.00
    // Rewrites third-party MCP client config files, writes the secrets file that
    // points the server at an instance, and spawns the server. It had no named
    // floor while it was the weakest file in the tree; that is what let it fail
    // the tree-wide floor on Linux by a single line (77.77 lines / 52.27
    // branches) while macOS measured 83.33 / 68.18 and shipped green.
    './src/mcpCommand.ts': { lines: 97, branches: 93 }, // measured 100.00 / 98.27
    // The CLI registry: 23 one-line delegations, so a floor on LINES is what
    // catches an entry that no longer routes anywhere (it declares no branches,
    // and a branch floor on 0/0 is reported as 100% and would gate nothing).
    './src/cliCommands.ts': { lines: 96 }, // measured 100.00 lines (0 branches)
  },
}
