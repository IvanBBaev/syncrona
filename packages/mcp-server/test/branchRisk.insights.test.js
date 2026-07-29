// SPDX-License-Identifier: GPL-3.0-or-later
//
// Branch-risk coverage for the insight handlers: until now no test drove
// sync_validate_before_push or sync_list_recent_changes with actual ROWS, so the whole
// per-row projection (severity counting, field mapping, conflict listing) was unpinned —
// a wrong field name or a dropped counter would have produced a confident, wrong verdict
// with every test still green.
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleValidateBeforePush } = require('../dist/handlers/insightValidateBeforePush.js');
const { handleListRecentChanges } = require('../dist/handlers/insightRecentChanges.js');
const {
  clearServiceNowSecretsCache,
  clearScopedApiPrefixCache,
} = require('../dist/servicenowCore.js');

const REAL_GLOBAL_FETCH = global.fetch;
test.afterEach(() => {
  global.fetch = REAL_GLOBAL_FETCH;
});

function mkResponse(status, payload) {
  return {
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

function withEnv(vars, fn) {
  const old = {
    SN_INSTANCE: process.env.SN_INSTANCE,
    SN_USER: process.env.SN_USER,
    SN_PASSWORD: process.env.SN_PASSWORD,
  };
  process.env.SN_INSTANCE = vars.SN_INSTANCE;
  process.env.SN_USER = vars.SN_USER;
  process.env.SN_PASSWORD = vars.SN_PASSWORD;
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

const ENV = {
  SN_INSTANCE: 'branchrisk.service-now.com',
  SN_USER: 'admin',
  SN_PASSWORD: 'secret',
};

// Scores medium (sec.workflow.bypass) + low (sec.gliderecord.review), no high finding —
// exactly the "warning, not blocked" band.
const MEDIUM_RISK_SCRIPT = [
  "var gr = new GlideRecord('incident');",
  'gr.setWorkflow(false);',
  'gr.query();',
].join('\n');

// Pins: a script whose findings are medium-only must be counted as a WARNING. If the
// warning branch were skipped the tool would report `warningCount: 0` on a run that
// found real medium-severity issues — a green "nothing to review" verdict handed to a
// user about to push a business-rule bypass.
test('sync_validate_before_push counts a medium-severity script as a warning', async () => {
  await withEnv(ENV, async () => {
    global.fetch = async (url) => {
      if (String(url).includes('/api/now/table/sys_script_include')) {
        return mkResponse(200, {
          result: [
            { sys_id: 'abc123', name: 'RiskyUtils', script: MEDIUM_RISK_SCRIPT },
          ],
        });
      }
      if (String(url).includes('/api/now/table/sys_update_xml')) {
        return mkResponse(200, { result: [] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const res = await handleValidateBeforePush(
      { scope: 'x_branch_risk', tables: ['sys_script_include'] },
      1000
    );
    const payload = JSON.parse(res.content[0].text);

    assert.equal(payload.warningCount, 1, 'a medium-only script is a warning');
    assert.equal(payload.blockedCount, 0, 'a medium-only script must not block the push');
    assert.equal(payload.fileCount, 1);

    const file = payload.files[0];
    assert.equal(file.status, 'warning');
    assert.equal(file.name, 'RiskyUtils', 'the row name field must be projected');
    assert.equal(file.sys_id, 'abc123');
    assert.equal(file.table, 'sys_script_include');
    assert.equal(file.findings.high, 0);
    assert.ok(file.findings.medium >= 1, 'the medium finding must be reported');
    assert.ok(Array.isArray(file.topFindings) && file.topFindings.length > 0);

    // A warning does not fail the gate; only a blocked file or a failed query does.
    assert.equal(payload.ready, true);
    assert.equal(payload.validated, true);
    assert.equal(res.isError, false);
  });
});

// Pins: the concurrent-change list must actually carry the sys_update_xml fields. An
// empty or misnamed projection here reads as "nobody else touched the scope" and invites
// a push straight over a colleague's in-flight update-set changes.
test('sync_validate_before_push surfaces concurrent changes with their real fields', async () => {
  await withEnv(ENV, async () => {
    global.fetch = async (url) => {
      if (String(url).includes('/api/now/table/sys_script_include')) {
        return mkResponse(200, { result: [] });
      }
      if (String(url).includes('/api/now/table/sys_update_xml')) {
        return mkResponse(200, {
          result: [
            {
              target_name: 'IncidentUtils',
              type: 'Script Include',
              action: 'update',
              sys_created_by: 'colleague',
              sys_created_on: '2026-07-27 10:11:12',
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const res = await handleValidateBeforePush(
      { scope: 'x_branch_risk', tables: ['sys_script_include'] },
      1000
    );
    const payload = JSON.parse(res.content[0].text);

    assert.equal(payload.conflictCheckPerformed, true);
    assert.equal(payload.recentChanges.length, 1);
    assert.deepEqual(payload.recentChanges[0], {
      name: 'IncidentUtils',
      type: 'Script Include',
      action: 'UPDATE',
      changedBy: 'colleague',
      changedAt: '2026-07-27 10:11:12',
    });
  });
});

// Pins: sys_update_xml rows do not always populate `target_name` — the fallback to `name`
// is what keeps the change list from rendering a row of blank entries the user cannot
// match to anything on the instance.
test('sync_list_recent_changes falls back to row.name when target_name is absent', async () => {
  await withEnv(ENV, async () => {
    global.fetch = async (url) => {
      if (String(url).includes('/api/now/table/sys_update_xml')) {
        return mkResponse(200, {
          result: [
            {
              name: 'sys_script_include_9f1c',
              type: 'Script Include',
              action: 'INSERT_OR_UPDATE',
              sys_created_by: 'admin',
              sys_created_on: '2026-07-26 08:00:00',
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const res = await handleListRecentChanges({ scope: 'x_branch_risk' }, 1000);
    const payload = JSON.parse(res.content[0].text);

    assert.equal(payload.changes.length, 1);
    assert.equal(
      payload.changes[0].name,
      'sys_script_include_9f1c',
      'a row without target_name must not render an empty name'
    );
    assert.equal(payload.changes[0].changedBy, 'admin');
    assert.equal(payload.changes[0].changedAt, '2026-07-26 08:00:00');
  });
});
