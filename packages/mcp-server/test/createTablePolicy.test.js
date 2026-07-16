// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CREATE_TABLE_ALLOWLIST_ENV,
  evaluateCreateTablePolicy,
} = require('../dist/createTablePolicy.js');

// The policy takes the environment as a parameter, so every case below runs
// against an explicit env object instead of mutating process.env.

test('policy allows every table from the metadata registry plus sys_script_include', () => {
  const registryTables = [
    'sys_script',
    'sys_script_client',
    'sys_ui_script',
    'sys_ui_action',
    'sys_ui_formatter',
    'sys_security_acl',
    'sys_dictionary',
    'sys_ui_policy',
    'sys_ws_operation',
    'sys_trigger',
    'sys_script_include',
  ];
  for (const table of registryTables) {
    assert.deepEqual(evaluateCreateTablePolicy(table, {}), { allowed: true });
  }
});

test('policy refuses a table outside the allowlist and names it in the reason', () => {
  const decision = evaluateCreateTablePolicy('incident', {});
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /"incident"/);
  assert.match(decision.reason, /not on the sn_create_record table allowlist/);
  assert.match(decision.reason, new RegExp(CREATE_TABLE_ALLOWLIST_ENV));
});

test('policy denies high-risk system tables with a reason that names the table', () => {
  for (const table of [
    'sys_user',
    'sys_user_has_role',
    'sys_user_role',
    'sys_user_group',
    'sys_properties',
    'cmdb_ci',
  ]) {
    const decision = evaluateCreateTablePolicy(table, {});
    assert.equal(decision.allowed, false, `${table} must be denied`);
    assert.match(decision.reason, new RegExp(`"${table}"`));
    assert.match(decision.reason, /denied for sn_create_record/);
    assert.match(decision.reason, new RegExp(CREATE_TABLE_ALLOWLIST_ENV));
  }
});

test('env var extends the allowlist with trimmed, case-normalized entries', () => {
  const env = { [CREATE_TABLE_ALLOWLIST_ENV]: ' Incident , u_custom_table ,, ' };
  assert.deepEqual(evaluateCreateTablePolicy('incident', env), { allowed: true });
  assert.deepEqual(evaluateCreateTablePolicy('u_custom_table', env), { allowed: true });
  assert.equal(evaluateCreateTablePolicy('u_other_table', env).allowed, false);
});

test('denied tables stay denied even when listed in the env var', () => {
  const env = {
    [CREATE_TABLE_ALLOWLIST_ENV]: 'sys_user,sys_user_has_role,sys_properties,cmdb_ci',
  };
  for (const table of ['sys_user', 'sys_user_has_role', 'sys_properties', 'cmdb_ci']) {
    const decision = evaluateCreateTablePolicy(table, env);
    assert.equal(decision.allowed, false, `${table} must remain denied`);
    assert.match(decision.reason, /denied for sn_create_record/);
  }
});

test('table comparison normalizes case and surrounding whitespace', () => {
  assert.deepEqual(evaluateCreateTablePolicy('  SYS_SCRIPT  ', {}), { allowed: true });
  assert.equal(evaluateCreateTablePolicy(' SYS_USER ', {}).allowed, false);
});

test('an unset or empty env var leaves the default allowlist unchanged', () => {
  assert.equal(evaluateCreateTablePolicy('incident', {}).allowed, false);
  assert.equal(
    evaluateCreateTablePolicy('incident', { [CREATE_TABLE_ALLOWLIST_ENV]: '' }).allowed,
    false
  );
});

test('policy defaults to process.env when no env object is passed', () => {
  const previous = process.env[CREATE_TABLE_ALLOWLIST_ENV];
  process.env[CREATE_TABLE_ALLOWLIST_ENV] = 'u_from_process_env';
  try {
    assert.deepEqual(evaluateCreateTablePolicy('u_from_process_env'), { allowed: true });
  } finally {
    if (previous === undefined) {
      delete process.env[CREATE_TABLE_ALLOWLIST_ENV];
    } else {
      process.env[CREATE_TABLE_ALLOWLIST_ENV] = previous;
    }
  }
});
