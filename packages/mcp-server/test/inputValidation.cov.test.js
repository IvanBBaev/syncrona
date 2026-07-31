// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TABLE_NAME_REGEX,
  SYS_ID_REGEX,
  validateToolArguments,
} = require('../dist/inputValidation.js');

const VALID_SYS_ID = 'a'.repeat(32);
const VALID_SYS_ID_UPPER = 'A'.repeat(32);
const VALID_SYS_ID_MIXED = '0123456789abcdefABCDEF0123456789'.slice(0, 32);

// ---------------------------------------------------------------------------
// TABLE_NAME_REGEX
// ---------------------------------------------------------------------------

test('TABLE_NAME_REGEX accepts lowercase table names', () => {
  assert.ok(TABLE_NAME_REGEX.test('incident'));
  assert.ok(TABLE_NAME_REGEX.test('sys_script_include'));
  assert.ok(TABLE_NAME_REGEX.test('u_custom_table_123'));
  assert.ok(TABLE_NAME_REGEX.test('a'));
});

test('TABLE_NAME_REGEX rejects names starting with digit or underscore', () => {
  assert.equal(TABLE_NAME_REGEX.test('1incident'), false);
  assert.equal(TABLE_NAME_REGEX.test('_incident'), false);
});

test('TABLE_NAME_REGEX rejects uppercase and special characters', () => {
  assert.equal(TABLE_NAME_REGEX.test('Incident'), false);
  assert.equal(TABLE_NAME_REGEX.test('incident-table'), false);
  assert.equal(TABLE_NAME_REGEX.test('incident table'), false);
  assert.equal(TABLE_NAME_REGEX.test('incident.table'), false);
  assert.equal(TABLE_NAME_REGEX.test(''), false);
});

// ---------------------------------------------------------------------------
// SYS_ID_REGEX
// ---------------------------------------------------------------------------

test('SYS_ID_REGEX accepts 32 hex characters, case-insensitive', () => {
  assert.ok(SYS_ID_REGEX.test(VALID_SYS_ID));
  assert.ok(SYS_ID_REGEX.test(VALID_SYS_ID_UPPER));
  assert.ok(SYS_ID_REGEX.test(VALID_SYS_ID_MIXED));
});

test('SYS_ID_REGEX rejects wrong length or non-hex characters', () => {
  assert.equal(SYS_ID_REGEX.test('a'.repeat(31)), false);
  assert.equal(SYS_ID_REGEX.test('a'.repeat(33)), false);
  assert.equal(SYS_ID_REGEX.test('g'.repeat(32)), false);
  assert.equal(SYS_ID_REGEX.test(''), false);
});

// ---------------------------------------------------------------------------
// validateToolArguments — tools WITHOUT a dedicated schema (pass-through path)
// ---------------------------------------------------------------------------

test('unknown tool name with no identifier fields is valid and echoes args', () => {
  const args = { foo: 'bar' };
  const result = validateToolArguments('sn_totally_unknown_tool', args);
  assert.equal(result.valid, true);
  assert.deepEqual(result.normalizedArgs, args);
});

test('unknown tool still runs top-level identifier validation (table)', () => {
  const result = validateToolArguments('sn_unknown_tool', { table: 'Bad-Table' });
  assert.equal(result.valid, false);
  assert.match(result.error, /^table: /);
});

test('unknown tool still runs top-level identifier validation (sysId)', () => {
  const result = validateToolArguments('sn_unknown_tool', { sysId: 'not-a-sys-id' });
  assert.equal(result.valid, false);
  assert.match(result.error, /^sysId: /);
});

// ---------------------------------------------------------------------------
// validateTopLevelIdentifiers branches, exercised via validateToolArguments
// ---------------------------------------------------------------------------

test('top-level identifier missing from args is skipped entirely', () => {
  const result = validateToolArguments('sn_unknown_tool', { other: 1 });
  assert.equal(result.valid, true);
});

test('top-level identifier present but non-string is rejected with "must be a string"', () => {
  const result = validateToolArguments('sn_unknown_tool', { table: 123 });
  assert.equal(result.valid, false);
  assert.equal(result.error, 'table: must be a string');
});

test('top-level identifier that is an empty/whitespace string is skipped (continue branch)', () => {
  const result = validateToolArguments('sn_unknown_tool', { table: '   ' });
  assert.equal(result.valid, true);
});

test('top-level identifier empty string skip also applies to sysId', () => {
  const result = validateToolArguments('sn_unknown_tool', { sysId: '' });
  assert.equal(result.valid, true);
});

test('top-level identifier valid string passes regex validation', () => {
  const result = validateToolArguments('sn_unknown_tool', { table: 'incident' });
  assert.equal(result.valid, true);
});

test('top-level identifier invalid string is rejected with formatted zod error', () => {
  const result = validateToolArguments('sn_unknown_tool', { table: 'BadTable!' });
  assert.equal(result.valid, false);
  assert.equal(
    result.error,
    'table: arguments: must match ServiceNow table format: [a-z][a-z0-9_]*'
  );
});

test('tableName identifier is validated like table', () => {
  const bad = validateToolArguments('sn_unknown_tool', { tableName: 'Bad!' });
  assert.equal(bad.valid, false);
  assert.match(bad.error, /^tableName: /);

  const good = validateToolArguments('sn_unknown_tool', { tableName: 'sys_user' });
  assert.equal(good.valid, true);
});

test('updateSetSysId identifier validated as sys_id', () => {
  const bad = validateToolArguments('sn_unknown_tool', { updateSetSysId: 'zzz' });
  assert.equal(bad.valid, false);
  assert.match(bad.error, /^updateSetSysId: /);

  const good = validateToolArguments('sn_unknown_tool', { updateSetSysId: VALID_SYS_ID });
  assert.equal(good.valid, true);
});

test('expectedUpdateSetSysId identifier validated as sys_id', () => {
  const bad = validateToolArguments('sn_unknown_tool', { expectedUpdateSetSysId: '123' });
  assert.equal(bad.valid, false);
  assert.match(bad.error, /^expectedUpdateSetSysId: /);

  const good = validateToolArguments('sn_unknown_tool', {
    expectedUpdateSetSysId: VALID_SYS_ID,
  });
  assert.equal(good.valid, true);
});

test('multiple identifier keys: first invalid one found (by declaration order) short-circuits', () => {
  // Declaration order: table, tableName, sysId, updateSetSysId, expectedUpdateSetSysId
  const result = validateToolArguments('sn_unknown_tool', {
    table: 'BadTable!',
    sysId: 'also-bad',
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /^table: /);
});

// ---------------------------------------------------------------------------
// validateToolArguments — tools WITH a dedicated schema
// ---------------------------------------------------------------------------

test('sn_query_records: happy path with all optional fields', () => {
  const result = validateToolArguments('sn_query_records', {
    table: 'incident',
    query: 'active=true',
    fields: ['number', 'short_description'],
    limit: 10,
    analyzeField: 'short_description',
    timeoutMs: 5000,
  });
  assert.equal(result.valid, true);
  assert.equal(result.normalizedArgs.table, 'incident');
});

test('sn_query_records: minimal happy path (table only)', () => {
  const result = validateToolArguments('sn_query_records', { table: 'incident' });
  assert.equal(result.valid, true);
});

test('sn_query_records: missing required table field fails', () => {
  const result = validateToolArguments('sn_query_records', {});
  assert.equal(result.valid, false);
  assert.match(result.error, /^table: /);
});

test('sn_query_records: invalid table format fails schema validation', () => {
  const result = validateToolArguments('sn_query_records', { table: 'Bad Table' });
  assert.equal(result.valid, false);
  assert.match(result.error, /must match ServiceNow table format/);
});

test('sn_query_records: limit below minimum fails', () => {
  const result = validateToolArguments('sn_query_records', { table: 'incident', limit: 0 });
  assert.equal(result.valid, false);
  assert.match(result.error, /^limit: /);
});

test('sn_query_records: limit above maximum fails', () => {
  const result = validateToolArguments('sn_query_records', { table: 'incident', limit: 501 });
  assert.equal(result.valid, false);
  assert.match(result.error, /^limit: /);
});

test('sn_query_records: non-integer limit fails', () => {
  const result = validateToolArguments('sn_query_records', { table: 'incident', limit: 1.5 });
  assert.equal(result.valid, false);
  assert.match(result.error, /^limit: /);
});

test('sn_query_records: fields must be array of strings', () => {
  const result = validateToolArguments('sn_query_records', {
    table: 'incident',
    fields: [1, 2],
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /^fields\.0: /);
});

test('sn_query_records: timeoutMs below minimum fails', () => {
  const result = validateToolArguments('sn_query_records', {
    table: 'incident',
    timeoutMs: 500,
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /^timeoutMs: /);
});

test('sn_query_records: timeoutMs above maximum fails', () => {
  const result = validateToolArguments('sn_query_records', {
    table: 'incident',
    timeoutMs: 900001,
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /^timeoutMs: /);
});

test('sn_query_records: passthrough keeps unknown extra fields', () => {
  const result = validateToolArguments('sn_query_records', {
    table: 'incident',
    extraField: 'kept',
  });
  assert.equal(result.valid, true);
  assert.equal(result.normalizedArgs.extraField, 'kept');
});

test('sn_query_records: table value is trimmed by schema (normalizedArgs reflects trim)', () => {
  const result = validateToolArguments('sn_query_records', { table: '  incident  ' });
  assert.equal(result.valid, true);
  assert.equal(result.normalizedArgs.table, 'incident');
});

test('sn_create_record: happy path with record object', () => {
  const result = validateToolArguments('sn_create_record', {
    table: 'incident',
    record: { short_description: 'test' },
    confirmDestructive: true,
    dryRun: false,
  });
  assert.equal(result.valid, true);
});

test('sn_create_record: missing table fails', () => {
  const result = validateToolArguments('sn_create_record', { record: {} });
  assert.equal(result.valid, false);
  assert.match(result.error, /^table: /);
});

test('sn_create_record: confirmDestructive wrong type fails', () => {
  const result = validateToolArguments('sn_create_record', {
    table: 'incident',
    confirmDestructive: 'yes',
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /^confirmDestructive: /);
});

test('sn_get_metadata_record: happy path', () => {
  const result = validateToolArguments('sn_get_metadata_record', { sysId: VALID_SYS_ID });
  assert.equal(result.valid, true);
});

test('sn_get_metadata_record: missing sysId fails', () => {
  const result = validateToolArguments('sn_get_metadata_record', {});
  assert.equal(result.valid, false);
  assert.match(result.error, /^sysId: /);
});

test('sn_get_metadata_record: malformed sysId fails with regex message', () => {
  const result = validateToolArguments('sn_get_metadata_record', { sysId: 'not-hex' });
  assert.equal(result.valid, false);
  assert.match(result.error, /must be a 32-character hexadecimal sys_id/);
});

test('sn_update_metadata_record: happy path with updates', () => {
  const result = validateToolArguments('sn_update_metadata_record', {
    sysId: VALID_SYS_ID,
    updates: { active: true },
    dryRun: true,
  });
  assert.equal(result.valid, true);
});

test('sn_update_metadata_record: missing sysId fails', () => {
  const result = validateToolArguments('sn_update_metadata_record', { updates: {} });
  assert.equal(result.valid, false);
  assert.match(result.error, /^sysId: /);
});

test('sync_set_update_set: happy path with no fields (all optional)', () => {
  const result = validateToolArguments('sync_set_update_set', {});
  assert.equal(result.valid, true);
});

test('sync_set_update_set: valid updateSetSysId passes', () => {
  const result = validateToolArguments('sync_set_update_set', {
    updateSetSysId: VALID_SYS_ID,
    createIfMissing: true,
  });
  assert.equal(result.valid, true);
});

test('sync_set_update_set: invalid updateSetSysId fails at schema level', () => {
  const result = validateToolArguments('sync_set_update_set', { updateSetSysId: 'bad' });
  assert.equal(result.valid, false);
  assert.match(result.error, /^updateSetSysId: /);
});

test('sync_prepare_session: happy path with all optionals', () => {
  const result = validateToolArguments('sync_prepare_session', {
    expectedUpdateSetSysId: VALID_SYS_ID,
    expectedScope: 'x_custom_app',
    expectedUpdateSetName: 'My Update Set',
    createUpdateSetIfMissing: false,
    dryRun: true,
  });
  assert.equal(result.valid, true);
});

test('sync_prepare_session: empty object is valid (nothing required)', () => {
  const result = validateToolArguments('sync_prepare_session', {});
  assert.equal(result.valid, true);
});

test('sync_preflight_check: happy path', () => {
  const result = validateToolArguments('sync_preflight_check', {
    expectedScope: 'x_custom_app',
  });
  assert.equal(result.valid, true);
});

test('sync_preflight_check: invalid expectedUpdateSetSysId fails', () => {
  const result = validateToolArguments('sync_preflight_check', {
    expectedUpdateSetSysId: 'short',
  });
  assert.equal(result.valid, false);
});

test('sync_set_scope: happy path requires non-empty scope', () => {
  const result = validateToolArguments('sync_set_scope', { scope: 'x_custom_app' });
  assert.equal(result.valid, true);
});

test('sync_set_scope: missing scope fails', () => {
  const result = validateToolArguments('sync_set_scope', {});
  assert.equal(result.valid, false);
  assert.match(result.error, /^scope: /);
});

test('sync_set_scope: empty-string scope fails min(1) after trim', () => {
  const result = validateToolArguments('sync_set_scope', { scope: '   ' });
  assert.equal(result.valid, false);
  assert.match(result.error, /^scope: /);
});

test('sync_push: happy path requires confirmDestructive boolean', () => {
  const result = validateToolArguments('sync_push', {
    confirmDestructive: true,
    logLevel: 'info',
  });
  assert.equal(result.valid, true);
});

test('sync_push: missing confirmDestructive fails (required, not optional)', () => {
  const result = validateToolArguments('sync_push', {});
  assert.equal(result.valid, false);
  assert.match(result.error, /^confirmDestructive: /);
});

test('sync_push: invalid logLevel enum value fails', () => {
  const result = validateToolArguments('sync_push', {
    confirmDestructive: true,
    logLevel: 'verbose',
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /^logLevel: /);
});

test('sync_push: each valid logLevel enum value passes', () => {
  for (const level of ['error', 'warn', 'info', 'debug', 'silly']) {
    const result = validateToolArguments('sync_push', {
      confirmDestructive: false,
      logLevel: level,
    });
    assert.equal(result.valid, true, `logLevel ${level} should be valid`);
  }
});

test('sn_execute_background_script: happy path', () => {
  const result = validateToolArguments('sn_execute_background_script', {
    script: 'gs.info("hi");',
    confirmDestructive: true,
  });
  assert.equal(result.valid, true);
});

test('sn_execute_background_script: empty script fails min(1)', () => {
  const result = validateToolArguments('sn_execute_background_script', {
    script: '',
    confirmDestructive: true,
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /^script: /);
});

test('sn_execute_background_script: missing confirmDestructive fails', () => {
  const result = validateToolArguments('sn_execute_background_script', {
    script: 'gs.info("hi");',
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /^confirmDestructive: /);
});

test('sync_create_script_include: happy path', () => {
  const result = validateToolArguments('sync_create_script_include', {
    name: 'MyScriptInclude',
    confirmDestructive: true,
  });
  assert.equal(result.valid, true);
});

test('sync_create_script_include: empty name fails min(1) after trim', () => {
  const result = validateToolArguments('sync_create_script_include', {
    name: '   ',
    confirmDestructive: true,
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /^name: /);
});

test('sync_create_script_include: missing confirmDestructive fails', () => {
  const result = validateToolArguments('sync_create_script_include', { name: 'Foo' });
  assert.equal(result.valid, false);
  assert.match(result.error, /^confirmDestructive: /);
});

test('sync_create_script_include_and_sync: happy path', () => {
  const result = validateToolArguments('sync_create_script_include_and_sync', {
    name: 'MyScriptInclude',
    confirmDestructive: false,
  });
  assert.equal(result.valid, true);
});

test('sync_create_script_include_and_sync: missing name fails', () => {
  const result = validateToolArguments('sync_create_script_include_and_sync', {
    confirmDestructive: true,
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /^name: /);
});

test('sync_run_atf_tests: happy path', () => {
  const result = validateToolArguments('sync_run_atf_tests', {
    scope: 'x_custom_app',
    confirmDestructive: true,
    runAll: true,
  });
  assert.equal(result.valid, true);
});

test('sync_run_atf_tests: empty scope fails', () => {
  const result = validateToolArguments('sync_run_atf_tests', {
    scope: '',
    confirmDestructive: true,
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /^scope: /);
});

test('sync_run_atf_tests: missing confirmDestructive fails', () => {
  const result = validateToolArguments('sync_run_atf_tests', { scope: 'x_custom_app' });
  assert.equal(result.valid, false);
  assert.match(result.error, /^confirmDestructive: /);
});

test('sn_autonomous_remediation_workflow: happy path, confirmDestructive optional', () => {
  const result = validateToolArguments('sn_autonomous_remediation_workflow', {
    script: 'gs.info("x");',
  });
  assert.equal(result.valid, true);
});

test('sn_autonomous_remediation_workflow: missing script fails', () => {
  const result = validateToolArguments('sn_autonomous_remediation_workflow', {});
  assert.equal(result.valid, false);
  assert.match(result.error, /^script: /);
});

test('sync_unified_change_workflow: happy path fully populated', () => {
  const result = validateToolArguments('sync_unified_change_workflow', {
    task: 'JIRA-123',
    script: 'gs.info("x");',
    taskType: 'hybrid',
    executionMode: 'mocked',
    allowRemoteApply: false,
    proposedChanges: [{ field: 'value' }],
    footprintBudget: { maxFiles: 5 },
    riskLevel: 'low',
    approval: { approvedBy: 'me' },
    rollbackEvidence: { snapshot: 'x' },
    policy: { requireApproval: true },
    apply: false,
    confirmDestructive: false,
  });
  assert.equal(result.valid, true);
});

test('sync_unified_change_workflow: empty object is valid (all optional)', () => {
  const result = validateToolArguments('sync_unified_change_workflow', {});
  assert.equal(result.valid, true);
});

test('sync_unified_change_workflow: invalid taskType enum fails', () => {
  const result = validateToolArguments('sync_unified_change_workflow', {
    taskType: 'bogus',
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /^taskType: /);
});

test('sync_unified_change_workflow: invalid executionMode enum fails', () => {
  const result = validateToolArguments('sync_unified_change_workflow', {
    executionMode: 'bogus',
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /^executionMode: /);
});

test('sync_unified_change_workflow: invalid riskLevel enum fails', () => {
  const result = validateToolArguments('sync_unified_change_workflow', {
    riskLevel: 'catastrophic',
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /^riskLevel: /);
});

test('sync_unified_change_workflow: proposedChanges must be array of records', () => {
  const result = validateToolArguments('sync_unified_change_workflow', {
    proposedChanges: 'not-an-array',
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /^proposedChanges: /);
});

// ---------------------------------------------------------------------------
// Cross-cutting: schema validation happens BEFORE identifier validation, and
// identifier validation runs against the schema-normalized args.
// ---------------------------------------------------------------------------

test('schema failure short-circuits before top-level identifier validation runs', () => {
  // sn_query_records requires table; omit it AND supply a malformed sysId.
  // Expect the schema (table) error, not the identifier (sysId) error.
  const result = validateToolArguments('sn_query_records', { sysId: 'bad' });
  assert.equal(result.valid, false);
  assert.match(result.error, /^table: /);
});

test('after schema success, identifier validation still applies to normalized args', () => {
  // sn_get_metadata_record schema already validates sysId format, so a bad
  // sysId is caught there; but table (validated only in the identifier pass)
  // on a schema'd tool without a table field should not trigger anything.
  const result = validateToolArguments('sn_get_metadata_record', {
    sysId: VALID_SYS_ID,
    table: 'incident',
  });
  assert.equal(result.valid, true);
});

test('identifier validation catches invalid extra table field passed through a schema-having tool', () => {
  const result = validateToolArguments('sn_get_metadata_record', {
    sysId: VALID_SYS_ID,
    table: 'Bad Table!',
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /^table: /);
});

test('non-string non-empty-object args value for identifier (e.g. number 0) reports must be a string', () => {
  const result = validateToolArguments('sn_unknown_tool', { table: 0 });
  assert.equal(result.valid, false);
  assert.equal(result.error, 'table: must be a string');
});

test('null value for identifier reports must be a string', () => {
  const result = validateToolArguments('sn_unknown_tool', { table: null });
  assert.equal(result.valid, false);
  assert.equal(result.error, 'table: must be a string');
});

// ---------------------------------------------------------------------------
// Mutation-testing findings (stryker, inputValidation.ts)
// ---------------------------------------------------------------------------

// Survivors at 26:40 / 27:12: the `error` option on optionalSysIdSchema's union could be
// emptied or removed outright and every existing test still passed, because the tests that
// exercise a malformed optional sys_id all pass a STRING and assert only the `"<field>: "`
// prefix. Measured against zod 4.4.3, the option changes the surfaced message only for a
// NON-string value: for a string that misses the regex, zod already surfaces the branch's own
// check message, but for a number/null/boolean/object BOTH branches fail on type and zod
// collapses the union to a bare "Invalid input" — so without the option the caller learns
// only that the field is wrong, never that a 32-character hex sys_id was expected. That is
// the regression the zod 4 migration note above the schema was written to prevent, so the
// non-string case is the one that has to be pinned.
test('a malformed optional sys_id surfaces the sys_id format message, not a generic union error', () => {
  const expected = 'must be a 32-character hexadecimal sys_id';

  // Non-string values: the union would otherwise degrade to "Invalid input".
  for (const value of [123, null, true, {}, []]) {
    const result = validateToolArguments('sync_set_update_set', { updateSetSysId: value });
    assert.equal(result.valid, false);
    assert.equal(
      result.error,
      `updateSetSysId: ${expected}`,
      `a non-string updateSetSysId (${JSON.stringify(value)}) must still explain the expected shape`
    );
  }
  const prepare = validateToolArguments('sync_prepare_session', {
    expectedUpdateSetSysId: 42,
  });
  assert.equal(prepare.valid, false);
  assert.equal(prepare.error, `expectedUpdateSetSysId: ${expected}`);

  // A string that misses the regex, and the required (non-union) sys_id field, carry the
  // same message, so the spellings of "this is not a sys_id" cannot drift apart.
  const badString = validateToolArguments('sync_set_update_set', { updateSetSysId: 'bad' });
  assert.equal(badString.valid, false);
  assert.equal(badString.error, `updateSetSysId: ${expected}`);
  const metadata = validateToolArguments('sn_get_metadata_record', { sysId: 'bad' });
  assert.equal(metadata.valid, false);
  assert.equal(metadata.error, `sysId: ${expected}`);
});

// Survivors at 63:18 / 71:18 / 80:18: the whole field map of these three schemas could be
// replaced with `looseObject({})` — i.e. "accept anything" — without a single test noticing.
// The reason is that their only *asserted* rejections are on sys_id fields, and those are
// re-checked afterwards by validateTopLevelIdentifiers regardless of the tool's own schema.
// So for these three tools the schema's independent contribution was untested, and it is
// not decorative: `dryRun` typing is precisely the REV-195 bug documented on sync_set_scope
// above (a `dryRun: "true"` string passed validation, then failed the handler's `=== true`
// test, so a caller asking for a simulation silently got the real mutation), and `timeoutMs`
// bounds are the only thing standing between a caller-supplied number and the transport.
test('sync_set_update_set rejects a non-boolean dryRun and an out-of-range timeoutMs', () => {
  const stringDryRun = validateToolArguments('sync_set_update_set', { dryRun: 'true' });
  assert.equal(stringDryRun.valid, false, 'a string dryRun must never be accepted as a request to simulate');
  assert.match(stringDryRun.error, /^dryRun: /);

  assert.equal(validateToolArguments('sync_set_update_set', { timeoutMs: 10 }).valid, false);
  assert.equal(validateToolArguments('sync_set_update_set', { timeoutMs: 900001 }).valid, false);
  assert.equal(validateToolArguments('sync_set_update_set', { updateSetName: 42 }).valid, false);
});

test('sync_prepare_session rejects a non-boolean dryRun and an out-of-range timeoutMs', () => {
  const stringDryRun = validateToolArguments('sync_prepare_session', { dryRun: 'true' });
  assert.equal(stringDryRun.valid, false, 'a string dryRun must never be accepted as a request to simulate');
  assert.match(stringDryRun.error, /^dryRun: /);

  assert.equal(validateToolArguments('sync_prepare_session', { timeoutMs: 10 }).valid, false);
  assert.equal(
    validateToolArguments('sync_prepare_session', { createUpdateSetIfMissing: 'yes' }).valid,
    false
  );
});

test('sync_preflight_check rejects an out-of-range timeoutMs and a non-string expectedScope', () => {
  assert.equal(validateToolArguments('sync_preflight_check', { timeoutMs: 10 }).valid, false);
  assert.equal(validateToolArguments('sync_preflight_check', { timeoutMs: 900001 }).valid, false);
  assert.equal(validateToolArguments('sync_preflight_check', { expectedScope: 42 }).valid, false);
});

// Survivors at 130:13 / 141:14: dropping `.trim()` from these two schemas survived, because
// the nearest tests use `''` (which `min(1)` rejects on its own) or omit the field. `.trim()`
// does two jobs here and both were unasserted: it makes a whitespace-only value fail — so a
// Script Include literally named "   " cannot be created — and it normalizes a padded value,
// so `"  Foo  "` reaches the instance as `"Foo"` instead of being written with its padding.
// The sibling tools (sync_set_scope, sync_create_script_include) already have the
// whitespace-only case covered; these two were the gap.
test('sync_create_script_include_and_sync trims its name and refuses a whitespace-only one', () => {
  const blank = validateToolArguments('sync_create_script_include_and_sync', {
    name: '   ',
    confirmDestructive: true,
  });
  assert.equal(blank.valid, false, 'a whitespace-only Script Include name must be refused');
  assert.match(blank.error, /^name: /);

  const padded = validateToolArguments('sync_create_script_include_and_sync', {
    name: '  MyScriptInclude  ',
    confirmDestructive: true,
  });
  assert.equal(padded.valid, true);
  assert.equal(padded.normalizedArgs.name, 'MyScriptInclude');
});

test('sync_run_atf_tests trims its scope and refuses a whitespace-only one', () => {
  const blank = validateToolArguments('sync_run_atf_tests', {
    scope: '   ',
    confirmDestructive: true,
  });
  assert.equal(blank.valid, false, 'a whitespace-only scope must be refused');
  assert.match(blank.error, /^scope: /);

  const padded = validateToolArguments('sync_run_atf_tests', {
    scope: '  x_custom_app  ',
    confirmDestructive: true,
  });
  assert.equal(padded.valid, true);
  assert.equal(padded.normalizedArgs.scope, 'x_custom_app');
});

// Survivors at 161:25, 161:35, 162:40, 168:33, 168:43, 168:51: any single member of these
// three enums could be replaced with `""` and no test failed, because only the rejection of
// an out-of-enum value was asserted. These lists are the tool's advertised input contract
// (mirrored in toolSchemas.ts, which is what the model reads), so a dropped member means a
// caller sending a documented value gets INVALID_ARGUMENTS. `riskLevel` in particular feeds
// the approval gate, where the members are not interchangeable. Assert acceptance member by
// member, the same way sync_push already does for logLevel.
test('sync_unified_change_workflow accepts every declared taskType, executionMode and riskLevel', () => {
  for (const taskType of ['script', 'metadata', 'hybrid']) {
    const result = validateToolArguments('sync_unified_change_workflow', { taskType });
    assert.equal(result.valid, true, `taskType "${taskType}" must be accepted`);
    assert.equal(result.normalizedArgs.taskType, taskType);
  }
  for (const executionMode of ['mocked', 'remote']) {
    const result = validateToolArguments('sync_unified_change_workflow', { executionMode });
    assert.equal(result.valid, true, `executionMode "${executionMode}" must be accepted`);
    assert.equal(result.normalizedArgs.executionMode, executionMode);
  }
  for (const riskLevel of ['low', 'medium', 'high', 'critical']) {
    const result = validateToolArguments('sync_unified_change_workflow', { riskLevel });
    assert.equal(result.valid, true, `riskLevel "${riskLevel}" must be accepted`);
    assert.equal(result.normalizedArgs.riskLevel, riskLevel);
  }
});
