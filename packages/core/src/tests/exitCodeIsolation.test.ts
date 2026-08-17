// SPDX-License-Identifier: GPL-3.0-or-later
// Pins the global `process.exitCode` reset in jest.exitcode.cjs.
//
// The hook is harness plumbing, so nothing else in the suite fails when it stops
// working — it just quietly reintroduces the cross-test leak it exists to
// prevent: a stray exit code flips the `if (process.exitCode)` branch in
// downloadCommand for whichever suite the worker picks up next, and leaks into
// Jest's own exit status when the run is in-band. Both failures look like
// something else, which is exactly why the guarantee needs a test of its own.
//
// Deliberately written with NO local guard: the assertions below are only true
// because the global hook ran. Adding a beforeEach here would test the guard
// instead of the thing it is meant to pin.
describe("process.exitCode isolation", () => {
  // Order matters. Jest runs the tests in a file in declaration order, so this
  // one is the polluter: it leaves a failing exit code behind on purpose and,
  // like the leaky suites this hook was written for, does not clean up after
  // itself.
  it("a test may set a failing exit code and observe it within its own body", () => {
    expect(process.exitCode).toBeUndefined();
    process.exitCode = 1;
    // The hook only touches the boundary between tests, never the value a test
    // is in the middle of asserting on.
    expect(process.exitCode).toBe(1);
  });

  it("the next test starts clean rather than inheriting the previous one's exit code", () => {
    expect(process.exitCode).toBeUndefined();
  });

  // The failure mode the exception-safe form exists for: a restore written at
  // the bottom of a test body is skipped when an assertion above it throws. This
  // stands in for that by throwing past a would-be cleanup line.
  it("a test that dies before its own cleanup still hands the next one a clean slate", () => {
    expect(() => {
      process.exitCode = 130;
      throw new Error("assertion failed before the inline restore could run");
      // An inline `process.exitCode = undefined` here would never execute.
    }).toThrow("assertion failed");
    expect(process.exitCode).toBe(130);
  });

  it("is clean again after a test that skipped its own cleanup", () => {
    expect(process.exitCode).toBeUndefined();
  });
});
