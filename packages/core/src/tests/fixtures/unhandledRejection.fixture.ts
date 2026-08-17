// SPDX-License-Identifier: GPL-3.0-or-later
// Not part of the suite: the filename deliberately does not match Jest's default
// testMatch, so this runs only when unhandledRejectionConfig.test.ts starts a
// child Jest with an explicit --testMatch for it.
//
// The shape matters. The rejection is created and NOT awaited, so it becomes
// unhandled in the same event-loop turn the test function settles in — the exact
// window `waitForUnhandledRejections` exists to cover. Awaiting anything here
// would move the rejection to a point jest-circus already handles and the
// negative control would stop being one.
it("leaves a rejection unhandled as the test settles", () => {
  Promise.reject(new Error("fixture rejection"));
});
