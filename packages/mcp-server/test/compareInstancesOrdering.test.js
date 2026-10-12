// SPDX-License-Identifier: GPL-3.0-or-later
// sync_compare_instances must read both instances in the same order. A capped read
// with no ORDERBY takes whatever rows each instance returns first, so two instances
// holding identical records reported spurious onlyInA/onlyInB entries.
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

const PROFILE_A = 'ordering-a.service-now.com';
const PROFILE_B = 'ordering-b.service-now.com';
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

// Isolate the credential store in a temp HOME, as branchRisk.compareInstances does.
async function withTwoStoredProfiles(fn) {
  const snap = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-cmp-order-'));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.HOME = home;
    process.env.SYNCRONA_USE_KEYCHAIN = '0';
    process.env.SYNCRONA_STORE_KEY = '33'.repeat(32);
    clearStoreKeyCache();
    clearServiceNowSecretsCache();
    clearScopedApiPrefixCache();
    await saveCredentials(PROFILE_A, 'admin', 'secret-a');
    await saveCredentials(PROFILE_B, 'admin', 'secret-b');
    await fn();
  } finally {
    global.fetch = REAL_GLOBAL_FETCH;
    for (const k of ENV_KEYS) {
      if (snap[k] === undefined) delete process.env[k];
      else process.env[k] = snap[k];
    }
    clearStoreKeyCache();
    clearServiceNowSecretsCache();
    clearScopedApiPrefixCache();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// Both instances hold the same five script includes, stored in a different order.
// Each honours sysparm_limit and the ORDERBY terms of sysparm_query, and otherwise
// returns rows in its own storage order, like a real instance.
const RECORDS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map((name, i) => ({
  sys_id: `id${i}`,
  name,
  script: `// ${name}`,
}));
const STORAGE = {
  [PROFILE_A]: RECORDS,
  [PROFILE_B]: [...RECORDS].reverse(),
};

function instanceFetch(url) {
  const parsed = new URL(String(url));
  const stored = STORAGE[parsed.hostname];
  const orderBy = (parsed.searchParams.get('sysparm_query') || '')
    .split('^')
    .filter((term) => term.startsWith('ORDERBY'))
    .map((term) => term.replace(/^ORDERBY(DESC)?/, ''));
  const rows = [...stored];
  if (orderBy.length > 0) {
    rows.sort((a, b) => {
      for (const field of orderBy) {
        const cmp = String(a[field]).localeCompare(String(b[field]));
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
  }
  const limit = Number(parsed.searchParams.get('sysparm_limit'));
  return {
    status: 200,
    text: async () => JSON.stringify({ result: rows.slice(0, limit) }),
  };
}

test('sync_compare_instances orders each capped read so identical instances compare equal', async () => {
  await withTwoStoredProfiles(async () => {
    const queries = [];
    global.fetch = async (url) => {
      queries.push(new URL(String(url)).searchParams.get('sysparm_query'));
      return instanceFetch(url);
    };

    const res = await handleCompareInstances(
      {
        profileA: PROFILE_A,
        profileB: PROFILE_B,
        scope: 'x_ordering',
        tables: ['sys_script_include'],
        limit: 3,
      },
      1000
    );

    const payload = JSON.parse(res.content[0].text);
    const table = payload.tables[0];
    assert.equal(table.truncated, true, 'the cap is still reported');
    assert.deepEqual(table.onlyInA, []);
    assert.deepEqual(table.onlyInB, []);
    assert.deepEqual(table.different, []);
    for (const query of queries) {
      assert.match(query, /\^ORDERBYname\^ORDERBYsys_id$/);
    }
  });
});
