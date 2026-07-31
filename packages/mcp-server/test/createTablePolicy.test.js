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

// Mutation-testing finding (stryker, createTablePolicy.ts:61): every mutant that
// removed the `normalized.length > 0` filter from parseExtraAllowedTables survived,
// because no test asked what an EMPTY allowlist entry admits. It matters: operators
// write these lists by hand, so a trailing comma or a stray ", ," is routine. Without
// the length filter those empty entries land in the extras set as "", and because ""
// is on neither the deny list nor the default allowlist, `evaluateCreateTablePolicy("")`
// then reports allowed — a table name the policy never opted into. The tool schema's
// table regex would normally reject "" first, but this policy is exported and evaluated
// on its own, so its contract is pinned here rather than assumed.
test('an empty allowlist entry never makes an empty or whitespace table name allowed', () => {
  const env = { [CREATE_TABLE_ALLOWLIST_ENV]: 'u_custom_table,, ,' };
  // The real entry still works, so the list is genuinely being parsed.
  assert.deepEqual(evaluateCreateTablePolicy('u_custom_table', env), { allowed: true });
  assert.equal(
    evaluateCreateTablePolicy('', env).allowed,
    false,
    'an empty table name must never be allowed by a stray separator in the env var'
  );
  assert.equal(
    evaluateCreateTablePolicy('   ', env).allowed,
    false,
    'a whitespace-only table name normalizes to "" and must be refused too'
  );
});

// Mutation-testing finding (stryker, createTablePolicy.ts:96): the refusal reason for a
// table that is merely missing from the allowlist could be emptied of the allowlist
// enumeration without any test noticing. That enumeration is the actionable half of the
// message — it is how the caller (usually a model) learns which tables it MAY create in
// instead of retrying blindly — so it is asserted, while the surrounding prose is not.
test('the not-on-allowlist reason enumerates the default allowlist', () => {
  const decision = evaluateCreateTablePolicy('incident', {});
  assert.equal(decision.allowed, false);
  const enumerated = /only scoped-app artifact tables are allowed \(([^)]*)\)/.exec(
    decision.reason
  );
  assert.ok(enumerated, `expected the reason to enumerate the allowlist, got: ${decision.reason}`);
  const listed = enumerated[1].split(', ');
  for (const table of ['sys_dictionary', 'sys_script', 'sys_script_include']) {
    assert.ok(listed.includes(table), `expected "${table}" in the enumerated allowlist`);
  }
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
