// SPDX-License-Identifier: GPL-3.0-or-later
// Pins `waitForUnhandledRejections` in jest.config.cjs.
//
// This is harness plumbing: nothing else in the suite goes red when it stops
// working, and what happens instead is worse than a red test. Node 22 defaults
// to `--unhandled-rejections=throw`, so a rejection nobody listens for is fatal.
// jest-circus does install a listener on the real process for the duration of a
// run, but without this flag it never yields to the event loop before
// `teardown` removes it again — a rejection that becomes unhandled in the same
// turn the test settles lands in that gap, the worker dies mid-file with exit
// code 1, and every test it had not reached yet silently never runs. A suite
// that stops running half its files still exits "green" from the outside.
//
// That is not hypothetical here: it is how two `src/genericUtils.ts` mutants
// escaped the mutation run as un-gradable RuntimeError rather than being killed.
// The first fix attempt — `process.on('unhandledRejection', ...)` from a
// setupFilesAfterEnv file — was a no-op and was removed. That file runs inside
// the test VM, whose `process` is a deep copy made by jest-util's
// `createProcessObject()` with its own EventEmitter, so nothing is ever emitted
// on it; see the comment at jest-circus/build/jestAdapterInit.js `case 'setup'`.
//
// The behavioural halves run a child Jest on purpose. The guarantee under test
// is "the process survives an unhandled rejection", and a process that fails
// that assertion cannot report it — it is gone. So the assertion has to be made
// from outside, and the child's own output is the verdict. Both directions are
// exercised: with the flag off the child must die Node's way, with the shipped
// config it must report an ordinary failing test. Asserting only the second
// would pass just as happily if the fixture never reproduced the bug at all.
import { spawnSync } from "child_process";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "../..");
const FIXTURE_MATCH = "**/unhandledRejection.fixture.ts";

const runFixture = (waitForUnhandledRejections: boolean) =>
  spawnSync(
    process.execPath,
    [
      require.resolve("jest-cli/bin/jest"),
      "--config",
      "jest.config.cjs",
      "--runInBand",
      `--waitForUnhandledRejections=${waitForUnhandledRejections}`,
      "--testMatch",
      FIXTURE_MATCH,
    ],
    {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      // The suite itself already runs under --experimental-vm-modules; the child
      // needs it too or it cannot load the ESM fixture at all, which would make
      // both cases "fail" for the wrong reason.
      env: { ...process.env, NODE_OPTIONS: "--experimental-vm-modules" },
    }
  );

describe("unhandled rejection handling", () => {
  it("is enabled in the shipped jest config", () => {
    const config = require(path.join(PACKAGE_ROOT, "jest.config.cjs")) as {
      waitForUnhandledRejections?: boolean;
    };
    expect(config.waitForUnhandledRejections).toBe(true);
  });

  it("turns an unhandled rejection into a failing test", () => {
    const { stdout, stderr } = runFixture(true);
    const out = `${stdout}${stderr}`;
    // The rejection is attributed to the test that caused it, and the reporter
    // runs at all — which is the part the crash destroys. Matched loosely on the
    // whitespace, which is reporter alignment and would otherwise make a Jest
    // bump fail this test for a reason that has nothing to do with the guarantee.
    expect(out).toMatch(/Tests:\s+1 failed, 1 total/);
    expect(out).toContain("fixture rejection");
  });

  it("negative control: with the flag off the same fixture kills the runner", () => {
    const { stdout, stderr } = runFixture(false);
    const out = `${stdout}${stderr}`;
    // Node's fatal banner, and no reporter summary at all — the run does not
    // end, it stops.
    expect(out).toContain("[Error: fixture rejection]");
    expect(out).not.toContain("Tests:");
  });
});
