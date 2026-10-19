// SPDX-License-Identifier: GPL-3.0-or-later
// setCurrentUpdateSet by name must resolve to an in-progress update set. Names are
// not unique and a completed or ignored set keeps its name, so a lookup by name
// alone could make a closed set current.
//
// Technique: sessionContext calls `servicenowCore_1.snRequest(...)` at call time,
// so overwriting the export on the loaded module swaps the transport.
const test = require('node:test');
const assert = require('node:assert/strict');

const servicenowCore = require('../dist/servicenowCore.js');
const sessionContext = require('../dist/sessionContext.js');

// `sets` is the instance's sys_update_set table; a GET honours name= and
// state= filters only, like an instance would, and returns rows in table order.
async function withInstance(sets, fn) {
  const prevRequest = servicenowCore.snRequest;
  const prevConfig = servicenowCore.getServiceNowConfig;
  const calls = [];
  const ok = (result) => ({ status: 200, data: { result }, text: '' });
  try {
    servicenowCore.getServiceNowConfig = () => ({
      instance: 'example.service-now.com',
      user: 'admin',
      password: 'x',
    });
    servicenowCore.snRequest = async (method, endpoint, body) => {
      calls.push({ method, endpoint, body });
      const url = new URL(endpoint, 'https://example.service-now.com');
      if (method === 'GET' && url.pathname.endsWith('/sys_update_set')) {
        const query = url.searchParams.get('sysparm_query') || '';
        const terms = query.split('^').filter((t) => !t.startsWith('ORDERBY'));
        const rows = sets.filter((row) =>
          terms.every((term) => {
            const [field, value] = term.split('=');
            return field === 'sys_id' || field === 'name' || field === 'state'
              ? row[field] === value
              : true;
          })
        );
        const limit = Number(url.searchParams.get('sysparm_limit'));
        return ok(rows.slice(0, limit));
      }
      if (method === 'GET' && url.pathname.endsWith('/sys_user')) {
        return ok([{ sys_id: 'user1', user_name: 'admin' }]);
      }
      if (method === 'GET') {
        return ok([]);
      }
      return { status: 201, data: { result: { sys_id: 'new1', name: 'Dev', state: 'in progress' } }, text: '' };
    };
    return { result: await fn().catch((error) => ({ error })), calls };
  } finally {
    servicenowCore.snRequest = prevRequest;
    servicenowCore.getServiceNowConfig = prevConfig;
  }
}

test('setCurrentUpdateSet by name skips a completed set with the same name', async () => {
  const { result } = await withInstance(
    [
      { sys_id: 'done1', name: 'Dev', state: 'complete' },
      { sys_id: 'open1', name: 'Dev', state: 'in progress' },
    ],
    () => sessionContext.setCurrentUpdateSet({ updateSetName: 'Dev', createIfMissing: false }, 1000)
  );
  assert.equal(result.error, undefined, result.error && result.error.message);
  assert.equal(result.targetUpdateSet.sysId, 'open1');
  assert.equal(result.targetUpdateSet.state, 'in progress');
});

test('setCurrentUpdateSet by name orders the lookup so duplicates resolve deterministically', async () => {
  const { calls } = await withInstance(
    [{ sys_id: 'open1', name: 'Dev', state: 'in progress' }],
    () => sessionContext.setCurrentUpdateSet({ updateSetName: 'Dev', createIfMissing: false }, 1000)
  );
  const lookup = calls.find(
    (c) => c.method === 'GET' && c.endpoint.includes('/sys_update_set?') && c.endpoint.includes('name')
  );
  const query = new URL(lookup.endpoint, 'https://x').searchParams.get('sysparm_query');
  assert.match(query, /\^state=in progress/);
  assert.match(query, /\^ORDERBY/);
});

test('setCurrentUpdateSet by name names the state of a set that is not in progress', async () => {
  const { result, calls } = await withInstance(
    [{ sys_id: 'done1', name: 'Dev', state: 'complete' }],
    () => sessionContext.setCurrentUpdateSet({ updateSetName: 'Dev', createIfMissing: false }, 1000)
  );
  assert.ok(result.error instanceof Error, 'a completed set must not become current');
  assert.match(result.error.message, /not in progress/);
  assert.match(result.error.message, /complete/);
  assert.ok(!calls.some((c) => c.method !== 'GET'), 'no preference was written');
});

test('setCurrentUpdateSet by name creates a new set when only a completed one exists', async () => {
  const { result, calls } = await withInstance(
    [{ sys_id: 'done1', name: 'Dev', state: 'complete' }],
    () => sessionContext.setCurrentUpdateSet({ updateSetName: 'Dev' }, 1000)
  );
  assert.equal(result.error, undefined, result.error && result.error.message);
  assert.ok(
    calls.some((c) => c.method === 'POST' && c.endpoint.includes('/sys_update_set')),
    'a new update set was created'
  );
  assert.equal(result.targetUpdateSet.sysId, 'new1');
});
