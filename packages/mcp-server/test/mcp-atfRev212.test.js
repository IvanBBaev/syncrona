// SPDX-License-Identifier: GPL-3.0-or-later
//
// REV-212: `timeoutMs` is the budget for the whole ATF poll, not for each request
// inside it. The old loop spent it per attempt and never read the clock, so 40
// attempts × (request + 1.5 s sleep) blocked a tool call for minutes past a
// deadline the caller had already given up on.
//
// The budget is asserted on a MOCKED clock (`setTimeout` + `Date`), never on wall
// time. A wall-clock bound here measures the machine's scheduler rather than
// pollAtfResults: the first version of this suite asserted "a 2 s budget finishes
// in under 10 s" and failed at 29 953 ms inside a coverage run on a box at load
// average 70 — the code was right, the assertion was not. Faking the clock makes
// every expectation below an equality instead of a bound, and the suite instant.
const test = require('node:test');
const assert = require('node:assert/strict');

const { pollAtfResults } = require('../dist/handlers/insightAtfTests.js');
const {
  clearServiceNowSecretsCache,
  clearScopedApiPrefixCache,
} = require('../dist/servicenowCore.js');

const REAL_GLOBAL_FETCH = global.fetch;

const TABLE = 'sys_atf_test_suite_result';
const QUERY = 'test_suite=suite1';
const FIELDS = 'sys_id,status';

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 40;
// Divides every wait the poll can ask for, so the virtual clock lands exactly on
// each timer rather than overshooting it.
const TICK_MS = 25;

test.afterEach(() => {
  global.fetch = REAL_GLOBAL_FETCH;
});

function withEnv(fn) {
  const old = {
    SN_INSTANCE: process.env.SN_INSTANCE,
    SN_USER: process.env.SN_USER,
    SN_PASSWORD: process.env.SN_PASSWORD,
  };
  process.env.SN_INSTANCE = 'dev123.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  clearServiceNowSecretsCache();
  clearScopedApiPrefixCache();
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.env.SN_INSTANCE = old.SN_INSTANCE;
      process.env.SN_USER = old.SN_USER;
      process.env.SN_PASSWORD = old.SN_PASSWORD;
      clearServiceNowSecretsCache();
      clearScopedApiPrefixCache();
    });
}

// Always "running", so the poll can only ever end on its own budget.
function neverTerminalFetch(counter) {
  return async () => {
    counter.calls += 1;
    return {
      status: 200,
      text: async () =>
        JSON.stringify({ result: [{ sys_id: 'r1', status: 'running', output: '' }] }),
    };
  };
}

// Each drive gets its own virtual epoch. `nextRequestSlotAt` in servicenowCore is
// module-global rate-limiter state expressed in Date.now() terms, so a later test
// restarting its fake clock at zero would be told to wait for a slot an earlier
// test had reserved. Moving the epoch forward keeps every reservation in the past.
let virtualEpoch = 0;

async function drivePoll(t, timeoutMs) {
  virtualEpoch += 1_000_000;
  const startedAt = virtualEpoch;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: startedAt });

  let settled = false;
  const pending = pollAtfResults(TABLE, QUERY, FIELDS, timeoutMs).then((value) => {
    settled = true;
    return value;
  });

  // setImmediate is deliberately NOT faked: awaiting it yields to a real macrotask,
  // which drains every microtask the poll has queued (the fetch, response.text, the
  // JSON parse) before the clock moves again. The iteration cap is a backstop — a
  // poll that never settles must fail the assertion below, not hang the suite.
  for (let i = 0; i < 20_000 && !settled; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!settled) {
      t.mock.timers.tick(TICK_MS);
    }
  }
  assert.ok(settled, 'the poll did not settle within the virtual clock budget');

  const poll = await pending;
  return { poll, elapsedMs: Date.now() - startedAt };
}

test('REV-212 a never-terminal poll spends the budget once, not once per attempt', async (t) => {
  await withEnv(async () => {
    const counter = { calls: 0 };
    global.fetch = neverTerminalFetch(counter);

    const { poll, elapsedMs } = await drivePoll(t, 2000);

    //    +0  attempt 1 -> "running"; 2000 ms left, so the full 1500 interval is waited
    // +1500  attempt 2 -> "running";  500 ms left, so the wait is clamped to 500
    //        (an unclamped interval would land at 3000 — half again past the budget)
    // +2000  the deadline is reached, so no third request is issued
    //
    // The old loop read the clock nowhere: 40 attempts, 58 500 ms of sleeping alone.
    assert.equal(counter.calls, 2);
    assert.equal(elapsedMs, 2000);
    // Giving up on time still reports what the last attempt saw — the caller infers
    // "not finished" from the rows, so they must not be thrown away.
    assert.equal(poll.status, 200);
    assert.equal(poll.rows.length, 1);
    assert.equal(poll.rows[0].status, 'running');
  });
});

test('REV-212 a wider budget waits the full interval and still stops on the deadline', async (t) => {
  await withEnv(async () => {
    const counter = { calls: 0 };
    global.fetch = neverTerminalFetch(counter);

    const { elapsedMs } = await drivePoll(t, 5000);

    // Attempts at +0, +1500, +3000, +4500; the last of them has 500 ms left, so the
    // final wait is clamped and the poll ends exactly on the deadline. This is the
    // other half of the clamp: it must not shorten a wait that fits.
    assert.equal(counter.calls, 4);
    assert.equal(elapsedMs, 5000);
  });
});

test('REV-212 the attempt cap still bounds a budget nothing else would bound', async (t) => {
  await withEnv(async () => {
    const counter = { calls: 0 };
    global.fetch = neverTerminalFetch(counter);

    // Ten hours of budget: only ATF_MAX_POLL_ATTEMPTS can end this poll.
    const { elapsedMs } = await drivePoll(t, 10 * 60 * 60 * 1000);

    assert.equal(counter.calls, MAX_POLL_ATTEMPTS);
    // 39 waits, not 40: no interval is owed after the final attempt, whose result is
    // already in hand.
    assert.equal(elapsedMs, (MAX_POLL_ATTEMPTS - 1) * POLL_INTERVAL_MS);
  });
});

test('REV-212 an already-exhausted budget still issues exactly one request', async (t) => {
  await withEnv(async () => {
    const counter = { calls: 0 };
    global.fetch = neverTerminalFetch(counter);

    const { poll, elapsedMs } = await drivePoll(t, 0);

    // The `attempt > 0` gate: a zero budget must not degrade to "no results", which
    // reads to a model as an ATF run that produced nothing rather than one that ran
    // out of time. And the per-attempt floor keeps that one request survivable — a
    // 0 ms timeout would abort it before any round trip could complete.
    assert.equal(counter.calls, 1);
    assert.equal(poll.status, 200);
    assert.equal(poll.rows.length, 1);
    // Nothing is waited for: there is no second attempt to wait for.
    assert.equal(elapsedMs, 0);
  });
});

test('REV-212 a terminal first response returns immediately without waiting', async (t) => {
  await withEnv(async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ result: [{ sys_id: 'r1', status: 'success', duration: '5' }] }),
      };
    };

    const { poll, elapsedMs } = await drivePoll(t, 30_000);

    assert.equal(calls, 1);
    assert.equal(poll.rows[0].status, 'success');
    assert.equal(elapsedMs, 0);
  });
});
