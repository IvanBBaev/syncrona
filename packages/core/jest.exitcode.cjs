// SPDX-License-Identifier: GPL-3.0-or-later
// `process.exitCode` is the one piece of state the CLI shares with every test
// that touches it, and it is not reset by Jest between tests or between test
// files: a worker runs many suites in one process, so a value one test leaves
// behind is still there for the next suite in that worker.
//
// That matters here because the source does not only WRITE it. `downloadCommand`
// READS it (src/commands.ts: `if (process.exitCode)`) to decide whether to
// announce a clean completion or warn about a partial pull, so a stray 1 from an
// unrelated suite silently flips which branch a later test exercises — the
// per-run coverage flapper on ./src/commands.ts that jest.config.cjs records.
// It also leaks into Jest's own exit status when the run is in-band, which turns
// a fully green suite into a red process.
//
// Suites used to guard this individually, and most still do (the local hooks
// document the intent and are harmless). But the two patterns in use were not
// equivalent:
//   - save in `beforeEach` / restore in `afterEach` is exception-safe, because
//     Jest runs afterEach whatever the test did;
//   - save at the top of a test BODY and restore at the bottom is not. The
//     restore is skipped the moment an assertion between them throws — so the
//     first real failure poisons every test after it, in that file and in every
//     later file the worker picks up, and the cascade of unrelated failures (or
//     unrelated passes) buries the one result that was true.
//
// This hook, registered via setupFilesAfterEnv, makes the guarantee global and
// exception-safe by construction, so no suite has to remember. It resets to
// `undefined` — Node's pristine value, and a value the setter accepts — rather
// than to a snapshot taken at setup time. A snapshot is NOT pristine: workers
// are reused across test files, and jest-circus runs same-block afterEach hooks
// in REGISTRATION order, so a suite-local afterEach (two suites park the code
// at 0 in one) runs after this file's afterEach and its leftovers are what the
// next file's setup would snapshot. That baseline poisoned every later file in
// the worker — a scheduling-dependent failure that only surfaced on the
// two-worker macOS CI runner, where exitCodeIsolation.test.ts caught it.
//
// It cannot mask a real defect: it only touches the boundary BETWEEN tests.
// Inside a test the code under test still sets whatever it sets, and every
// assertion still observes exactly that.
beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
});
