// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleRunAtfTests } = require('../dist/handlers/insightAtfTests.js');

const REAL_GLOBAL_FETCH = global.fetch;

function context() {
  return {
    timeoutMs: 300,
    dryRun: false,
    startedAt: Date.now(),
    makeDryRunAuditResponse: () => {
      throw new Error('not a dry run');
    },
    auditMutatingTool: () => {
      throw new Error('nothing may run');
    },
  };
}

for (const extra of [{ suiteId: 's1' }, { runAll: true }]) {
  test(`sync_run_atf_tests refuses testId combined with ${Object.keys(extra)[0]} before running anything`, async () => {
    const requests = [];
    global.fetch = async (url) => {
      requests.push(String(url));
      throw new Error('no request expected');
    };
    try {
      const res = await handleRunAtfTests(
        { scope: 'x_my_scope', testId: 't1', ...extra, confirmDestructive: true },
        context()
      );
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /testId cannot be combined with suiteId or runAll/);
      assert.equal(requests.length, 0);
    } finally {
      global.fetch = REAL_GLOBAL_FETCH;
    }
  });
}
