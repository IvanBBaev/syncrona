// SPDX-License-Identifier: GPL-3.0-or-later
//
// Branch-risk coverage for sync_compare_instances. Every existing test stops at the
// argument-validation guards, so the two outcomes that decide whether the answer can be
// trusted — "one instance did not answer" and "the result set was capped" — were never
// exercised. Both must be visible in the payload; a comparison that quietly reports
// "identical" after half of it failed is worse than no comparison at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handleCompareInstances } = require('../dist/handlers/insightCompareInstances.js');
const {
  clearServiceNowSecretsCache,
  clearScopedApiPrefixCache,
} = require('../dist/servicenowCore.js');
const { saveCredentials, clearStoreKeyCache } = require('@syncrona/credential-store');

const PROFILE_A = 'branchrisk-a.service-now.com';
const PROFILE_B = 'branchrisk-b.service-now.com';

const ENV_KEYS = [
  'SN_INSTANCE',
  'SN_USER',
  'SN_PASSWORD',
  'SYNCRONA_SECRETS_FILE',
  'HOME',
  'SYNCRONA_STORE_KEY',
  'SYNCRONA_USE_KEYCHAIN',
];

const REAL_GLOBAL_FETCH = global.fetch;

function snapshotEnv() {
  const snap = {};
  for (const key of ENV_KEYS) {
    snap[key] = process.env[key];
  }
  return snap;
}

function restoreEnv(snap) {
  for (const key of ENV_KEYS) {
    if (snap[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snap[key];
    }
  }
  clearStoreKeyCache();
  clearServiceNowSecretsCache();
  clearScopedApiPrefixCache();
}

// Isolate the credential store in a temp HOME with an explicit at-rest key so the test
// never touches the developer's real store or OS keychain (same harness as REV-157).
async function withTwoStoredProfiles(fn) {
  const snap = snapshotEnv();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-cmp-home-'));
  try {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    process.env.HOME = home;
    process.env.SYNCRONA_USE_KEYCHAIN = '0';
    process.env.SYNCRONA_STORE_KEY = '22'.repeat(32);
    clearStoreKeyCache();
    clearServiceNowSecretsCache();
    clearScopedApiPrefixCache();

    await saveCredentials(PROFILE_A, 'admin', 'secret-a');
    await saveCredentials(PROFILE_B, 'admin', 'secret-b');

    await fn();
  } finally {
    global.fetch = REAL_GLOBAL_FETCH;
    restoreEnv(snap);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function mkResponse(status, payload) {
  return {
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

// Pins: when one instance's request rejects, that table must be reported as an ERROR and
// the run must be flagged incomplete. Without this the failing side contributes zero rows,
// the diff reads as "no differences", and the tool tells the user two instances match when
// it never actually looked at one of them.
test('a failed instance request is reported as a per-table error, not as a clean diff', async () => {
  await withTwoStoredProfiles(async () => {
    global.fetch = async (url) => {
      if (String(url).includes(PROFILE_B)) {
        throw new Error('getaddrinfo ENOTFOUND');
      }
      return mkResponse(200, {
        result: [{ sys_id: 'a1', name: 'SharedUtils', script: 'gs.info("a");' }],
      });
    };

    const res = await handleCompareInstances(
      {
        profileA: PROFILE_A,
        profileB: PROFILE_B,
        scope: 'x_branch_risk',
        tables: ['sys_script_include'],
      },
      1000
    );

    assert.equal(res.isError, true, 'a comparison with a failed side must be an error result');
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.summary.errors, 1);
    assert.equal(payload.summary.complete, false);
    assert.equal(payload.summary.onlyInA, 0, 'the healthy side must not be diffed against nothing');
    assert.equal(payload.summary.onlyInB, 0);

    const tableResult = payload.tables[0];
    assert.equal(tableResult.table, 'sys_script_include');
    assert.equal(tableResult.statusA, 200);
    assert.match(String(tableResult.statusB), /^error: /);
    assert.match(String(tableResult.statusB), /ENOTFOUND/);
    assert.match(String(tableResult.error), /Comparison skipped for this table/);
    assert.deepEqual(tableResult.onlyInA, []);
    assert.deepEqual(tableResult.different, []);
  });
});

// Pins (REV-101): a result set that reaches the row cap must carry an explicit truncation
// note and drop `complete` to false. A capped fetch looks exactly like a complete one to
// the diff, so without the note the tool reports a partial comparison as the whole
// picture and records beyond the cap are silently treated as absent.
test('a per-table row cap is surfaced as a truncation note, not silently swallowed', async () => {
  await withTwoStoredProfiles(async () => {
    global.fetch = async (url) => {
      const suffix = String(url).includes(PROFILE_B) ? 'b' : 'a';
      return mkResponse(200, {
        result: [
          { sys_id: `${suffix}1`, name: 'SharedUtils', script: `gs.info("${suffix}");` },
        ],
      });
    };

    const res = await handleCompareInstances(
      {
        profileA: PROFILE_A,
        profileB: PROFILE_B,
        scope: 'x_branch_risk',
        tables: ['sys_script_include'],
        limit: 1,
      },
      1000
    );

    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.summary.limit, 1);
    assert.equal(payload.summary.truncated, true);
    assert.equal(payload.summary.complete, false, 'a capped comparison is never complete');
    assert.deepEqual(payload.summary.truncatedTables, ['sys_script_include']);

    const tableResult = payload.tables[0];
    assert.equal(tableResult.truncated, true);
    assert.match(String(tableResult.truncationNote), /hit the 1-row limit/);
    assert.match(String(tableResult.truncationNote), /may be incomplete/);
    // The diff itself still ran on what was fetched: the shared record differs.
    assert.deepEqual(tableResult.different.map((entry) => entry.name), ['SharedUtils']);
  });
});

// Pins: an uncapped comparison must NOT claim truncation. This is the control for the
// test above — it proves the note is driven by the row count reaching the limit rather
// than being attached unconditionally.
test('an uncapped comparison reports complete with no truncation note', async () => {
  await withTwoStoredProfiles(async () => {
    global.fetch = async () =>
      mkResponse(200, {
        result: [{ sys_id: 'x1', name: 'SharedUtils', script: 'gs.info("same");' }],
      });

    const res = await handleCompareInstances(
      {
        profileA: PROFILE_A,
        profileB: PROFILE_B,
        scope: 'x_branch_risk',
        tables: ['sys_script_include'],
        limit: 50,
      },
      1000
    );

    assert.equal(res.isError, false);
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.summary.truncated, false);
    assert.equal(payload.summary.complete, true);
    assert.deepEqual(payload.summary.truncatedTables, []);
    assert.equal(payload.tables[0].truncated, false);
    assert.equal(payload.tables[0].truncationNote, undefined);
  });
});
