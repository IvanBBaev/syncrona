// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleInsightTool } = require('../dist/handlers/insightToolHandlers.js');
const { handleExportUpdateSet, buildUpdateSetExportPath } = require('../dist/handlers/insightExportUpdateSet.js');
const { handleValidateBeforePush, evaluateValidationStatus } = require('../dist/handlers/insightValidateBeforePush.js');
const {
  handleRunAtfTests,
  buildAtfRunScript,
  parseAtfTrigger,
  summarizeAtfResults,
} = require('../dist/handlers/insightAtfTests.js');
const { handleListRecentChanges } = require('../dist/handlers/insightRecentChanges.js');
const { handleRecordHistory, formatRecordHistory } = require('../dist/handlers/insightRecordHistory.js');
const {
  handleGenerateReleaseNotes,
  buildReleaseNotesMarkdown,
} = require('../dist/handlers/insightReleaseNotes.js');
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

function makeInsightContext(overrides = {}) {
  return {
    timeoutMs: 1000,
    dryRun: false,
    startedAt: Date.now(),
    makeDryRunAuditResponse: (toolName, args, details) => ({
      isError: false,
      content: [{ type: 'text', text: JSON.stringify({ dryRun: true, toolName, details }) }],
    }),
    auditMutatingTool: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// insightToolHandlers.ts — dispatcher
// ---------------------------------------------------------------------------

test('handleInsightTool: unknown tool name returns null', async () => {
  const res = await handleInsightTool('not_a_real_tool', {}, makeInsightContext());
  assert.equal(res, null);
});

test('handleInsightTool: dispatches sync_list_recent_changes', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async () => mkResponse(200, { result: [] });
      const res = await handleInsightTool(
        'sync_list_recent_changes',
        { scope: 'x_my_scope' },
        makeInsightContext()
      );
      assert.equal(res.isError, false);
    }
  );
});

test('handleInsightTool: dispatches sn_get_record_history', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async () => mkResponse(200, { result: [] });
      const res = await handleInsightTool(
        'sn_get_record_history',
        { table: 'sys_script_include', sysId: 'abc' },
        makeInsightContext()
      );
      assert.equal(res.isError, false);
    }
  );
});

test('handleInsightTool: dispatches sync_generate_release_notes error path (missing set)', async () => {
  const res = await handleInsightTool('sync_generate_release_notes', {}, makeInsightContext());
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Provide either updateSetSysId or updateSetName');
});

test('handleInsightTool: dispatches sync_run_atf_tests missing scope', async () => {
  const res = await handleInsightTool('sync_run_atf_tests', {}, makeInsightContext());
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Missing required field: scope');
});

test('handleInsightTool: dispatches sync_validate_before_push missing scope', async () => {
  const res = await handleInsightTool('sync_validate_before_push', {}, makeInsightContext());
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Missing required field: scope');
});

test('handleInsightTool: dispatches sync_export_update_set missing set', async () => {
  const res = await handleInsightTool('sync_export_update_set', {}, makeInsightContext());
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Provide either updateSetSysId or updateSetName');
});

test('handleInsightTool: dispatches sn_search_scripts missing query', async () => {
  const res = await handleInsightTool('sn_search_scripts', {}, makeInsightContext());
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Missing required field: query');
});

test('handleInsightTool: dispatches sync_compare_instances missing profileA', async () => {
  const res = await handleInsightTool('sync_compare_instances', {}, makeInsightContext());
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Missing required field: profileA');
});

// ---------------------------------------------------------------------------
// insightRecentChanges.ts
// ---------------------------------------------------------------------------

test('handleListRecentChanges: missing scope returns error', async () => {
  const res = await handleListRecentChanges({}, 1000);
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Missing required field: scope');
});

test('handleListRecentChanges: blank-only scope is treated as missing', async () => {
  const res = await handleListRecentChanges({ scope: '   ' }, 1000);
  assert.equal(res.isError, true);
});

test('handleListRecentChanges: happy path maps rows and uses default since', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async () =>
        mkResponse(200, {
          result: [
            {
              target_name: 'MyScript',
              type: 'sys_script_include',
              action: 'update',
              sys_created_by: 'admin',
              sys_created_on: '2024-01-01 00:00:00',
            },
          ],
        });
      const res = await handleListRecentChanges({ scope: 'x_my_scope' }, 1000);
      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.scope, 'x_my_scope');
      assert.equal(parsed.rowCount, 1);
      assert.equal(parsed.changes[0].name, 'MyScript');
      assert.equal(parsed.changes[0].action, 'UPDATE');
      assert.ok(parsed.since);
    }
  );
});

test('handleListRecentChanges: respects explicit since and custom limit', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const requestedUrls = [];
      global.fetch = async (url) => {
        requestedUrls.push(String(url));
        return mkResponse(200, { result: [] });
      };
      const res = await handleListRecentChanges(
        { scope: 'x_my_scope', since: '2024-05-01T00:00:00.000Z', limit: 5 },
        1000
      );
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.since, '2024-05-01T00:00:00.000Z');
      assert.match(decodeURIComponent(requestedUrls[0].replace(/\+/g, ' ')), /2024-05-01 00:00:00/);
      assert.match(requestedUrls[0], /sysparm_limit=6\b/);
    }
  );
});

test('handleListRecentChanges: unparseable since falls back and echoes the applied bound', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const requestedUrls = [];
      global.fetch = async (url) => {
        requestedUrls.push(String(url));
        return mkResponse(200, { result: [] });
      };
      const res = await handleListRecentChanges(
        { scope: 'x_my_scope', since: 'not-a-real-date' },
        1000
      );
      const parsed = JSON.parse(res.content[0].text);
      // The payload must not echo the unparseable input as if it bounded the query.
      assert.notEqual(parsed.since, 'not-a-real-date');
      // The applied bound must be a valid ISO timestamp that is actually enforced in
      // the query, so callers cannot mistake all-time results for a bounded window.
      assert.ok(!Number.isNaN(new Date(parsed.since).getTime()));
      const decodedUrl = decodeURIComponent(requestedUrls[0].replace(/\+/g, ' '));
      assert.match(decodedUrl, /sys_created_on>=/);
    }
  );
});

test('handleListRecentChanges: non-2xx response marks isError true', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async () => mkResponse(500, { error: 'boom' });
      const res = await handleListRecentChanges({ scope: 'x_my_scope' }, 1000);
      assert.equal(res.isError, true);
    }
  );
});

// ---------------------------------------------------------------------------
// insightRecordHistory.ts
// ---------------------------------------------------------------------------

test('formatRecordHistory: maps rows and wraps old/new values as untrusted data', () => {
  const rows = [
    {
      sys_created_by: 'admin',
      sys_created_on: '2024-01-01 00:00:00',
      fieldname: 'script',
      oldvalue: 'var a = 1;',
      newvalue: 'var a = 2;',
    },
  ];
  const result = formatRecordHistory(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].changedBy, 'admin');
  assert.equal(result[0].field, 'script');
  assert.match(result[0].oldValue, /var a = 1;/);
  assert.match(result[0].oldValue, /UNTRUSTED_EXTERNAL_DATA/);
});

test('formatRecordHistory: empty rows returns empty array', () => {
  assert.deepEqual(formatRecordHistory([]), []);
});

test('handleRecordHistory: missing table returns error', async () => {
  const res = await handleRecordHistory({ sysId: 'abc' }, 1000);
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Missing required field: table');
});

test('handleRecordHistory: missing sysId returns error', async () => {
  const res = await handleRecordHistory({ table: 'sys_script_include' }, 1000);
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Missing required field: sysId');
});

test('handleRecordHistory: blank-only table/sysId treated as missing', async () => {
  const res1 = await handleRecordHistory({ table: '  ', sysId: 'abc' }, 1000);
  assert.equal(res1.isError, true);
  assert.equal(res1.content[0].text, 'Missing required field: table');

  const res2 = await handleRecordHistory({ table: 'sys_script_include', sysId: '  ' }, 1000);
  assert.equal(res2.isError, true);
  assert.equal(res2.content[0].text, 'Missing required field: sysId');
});

test('handleRecordHistory: happy path returns entryCount and history', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async () =>
        mkResponse(200, {
          result: [
            {
              fieldname: 'name',
              oldvalue: 'Old',
              newvalue: 'New',
              sys_created_by: 'admin',
              sys_created_on: '2024-01-01 00:00:00',
            },
          ],
        });
      const res = await handleRecordHistory(
        { table: 'sys_script_include', sysId: 'abc123' },
        1000
      );
      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.table, 'sys_script_include');
      assert.equal(parsed.sysId, 'abc123');
      assert.equal(parsed.entryCount, 1);
      assert.equal(parsed.history[0].field, 'name');
    }
  );
});

test('handleRecordHistory: non-2xx response marks isError true', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async () => mkResponse(404, { error: 'not found' });
      const res = await handleRecordHistory({ table: 'x', sysId: 'y' }, 1000);
      assert.equal(res.isError, true);
    }
  );
});

// ---------------------------------------------------------------------------
// insightReleaseNotes.ts
// ---------------------------------------------------------------------------

test('buildReleaseNotesMarkdown: groups by type, sorted, with total count', () => {
  const rows = [
    { type: 'sys_script_include', action: 'update', target_name: 'Beta' },
    { type: 'sys_script_include', action: 'insert', target_name: 'Alpha' },
    { type: 'sys_ui_script', action: 'delete', target_name: 'Gamma' },
  ];
  const md = buildReleaseNotesMarkdown('My Update Set', rows);
  assert.match(md, /^# Release Notes — My Update Set/);
  assert.match(md, /Total changes: 3/);
  const scriptIncludeIdx = md.indexOf('## sys_script_include');
  const uiScriptIdx = md.indexOf('## sys_ui_script');
  assert.ok(scriptIncludeIdx >= 0 && uiScriptIdx > scriptIncludeIdx);
  assert.match(md, /- UPDATE: Beta/);
  assert.match(md, /- INSERT: Alpha/);
  assert.match(md, /- DELETE: Gamma/);
});

test('buildReleaseNotesMarkdown: empty rows still produces header with zero total', () => {
  const md = buildReleaseNotesMarkdown('Empty Set', []);
  assert.match(md, /Total changes: 0/);
  assert.ok(!md.includes('##'));
});

test('buildReleaseNotesMarkdown: falls back to "unknown" type and "UPDATE" action, uses name when target_name missing', () => {
  const md = buildReleaseNotesMarkdown('Set', [{ name: 'Fallback' }]);
  assert.match(md, /## unknown/);
  assert.match(md, /- UPDATE: Fallback/);
});

test('handleGenerateReleaseNotes: missing update set identifiers returns error', async () => {
  const res = await handleGenerateReleaseNotes({}, 1000);
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Provide either updateSetSysId or updateSetName');
});

test('handleGenerateReleaseNotes: markdown format happy path (default)', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async () =>
        mkResponse(200, {
          result: [{ type: 'sys_script', action: 'insert', target_name: 'X' }],
        });
      const res = await handleGenerateReleaseNotes({ updateSetSysId: 'set-1' }, 1000);
      assert.equal(res.isError, false);
      assert.match(res.content[0].text, /# Release Notes — set-1/);
      assert.match(res.content[0].text, /- INSERT: X/);
    }
  );
});

test('handleGenerateReleaseNotes: json format happy path', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async () =>
        mkResponse(200, {
          result: [{ type: 'sys_script', action: 'insert', target_name: 'X' }],
        });
      const res = await handleGenerateReleaseNotes(
        { updateSetSysId: 'set-1', format: 'json' },
        1000
      );
      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.updateSet, 'set-1');
      assert.equal(parsed.changeCount, 1);
      assert.equal(parsed.changes[0].name, 'X');
      assert.equal(parsed.changes[0].action, 'INSERT');
    }
  );
});

test('handleGenerateReleaseNotes: non-2xx response marks isError true (json format)', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async () => mkResponse(500, { result: [] });
      const res = await handleGenerateReleaseNotes(
        { updateSetSysId: 'set-1', format: 'json' },
        1000
      );
      assert.equal(res.isError, true);
    }
  );
});

test('handleGenerateReleaseNotes: update set not found by name propagates error', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async () => mkResponse(200, { result: [] });
      const res = await handleGenerateReleaseNotes({ updateSetName: 'Nope' }, 1000);
      assert.equal(res.isError, true);
      assert.equal(res.content[0].text, 'Update set not found: Nope');
    }
  );
});

test('handleGenerateReleaseNotes: a rejected update set lookup reports the HTTP status, not "not found"', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const urls = [];
      global.fetch = async (url) => {
        urls.push(String(url));
        return mkResponse(401, { error: { message: 'User Not Authenticated' } });
      };
      const res = await handleGenerateReleaseNotes({ updateSetName: 'Sprint 12' }, 1000);
      assert.equal(res.isError, true);
      assert.equal(res.content[0].text, 'Update set lookup failed with HTTP 401: Sprint 12');
      assert.equal(urls.length, 1, 'the changes are not read for an update set that was never resolved');
    }
  );
});

// ---------------------------------------------------------------------------
// insightExportUpdateSet.ts
// ---------------------------------------------------------------------------

test('buildUpdateSetExportPath: sanitizes unsafe characters in the name', () => {
  const p = buildUpdateSetExportPath('My Set / v1.0!!');
  assert.match(p, /My_Set___v1\.0__\.xml$/);
  assert.match(p, /\.syncrona-mcp[\\/]exports[\\/]/);
});

test('buildUpdateSetExportPath: empty name falls back to "update_set"', () => {
  const p = buildUpdateSetExportPath('');
  assert.match(p, /update_set\.xml$/);
});

test('handleExportUpdateSet: missing update set identifiers returns error', async () => {
  const res = await handleExportUpdateSet({}, 1000);
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Provide either updateSetSysId or updateSetName');
});

test('handleExportUpdateSet: happy path without writeFiles returns xml and counts', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes('export_update_set.do')) {
          return mkResponse(200, '<?xml version="1.0" encoding="UTF-8"?><unload>data</unload>');
        }
        return mkResponse(200, { result: [{ type: 'sys_script' }] });
      };
      const res = await handleExportUpdateSet({ updateSetSysId: 'set-1' }, 1000);
      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.updateSet, 'set-1');
      assert.equal(parsed.sysId, 'set-1');
      assert.equal(parsed.recordCount, 1);
      assert.equal(parsed.savedTo, null);
      assert.match(parsed.xml, /<unload>data<\/unload>/);
    }
  );
});

test('handleExportUpdateSet: empty/blank xml export marks isError true', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes('export_update_set.do')) {
          return mkResponse(200, '   ');
        }
        return mkResponse(200, { result: [] });
      };
      const res = await handleExportUpdateSet({ updateSetSysId: 'set-1' }, 1000);
      assert.equal(res.isError, true);
    }
  );
});

test('handleExportUpdateSet: non-2xx export status marks isError true', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes('export_update_set.do')) {
          return mkResponse(500, 'error page');
        }
        return mkResponse(200, { result: [] });
      };
      const res = await handleExportUpdateSet({ updateSetSysId: 'set-1' }, 1000);
      assert.equal(res.isError, true);
    }
  );
});

test('handleExportUpdateSet: writeFiles=true saves file and reports savedTo path', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-export-'));
  const originalCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    await withEnv(
      { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
      async () => {
        global.fetch = async (url) => {
          const u = String(url);
          if (u.includes('export_update_set.do')) {
            return mkResponse(200, '<?xml version="1.0" encoding="UTF-8"?><unload>content</unload>');
          }
          return mkResponse(200, { result: [] });
        };
        const res = await handleExportUpdateSet(
          { updateSetSysId: 'set-1', writeFiles: true },
          1000
        );
        assert.equal(res.isError, false);
        const parsed = JSON.parse(res.content[0].text);
        assert.match(parsed.savedTo, /update_set|set-1/);
        const savedAbs = path.join(tmpDir, parsed.savedTo);
        assert.ok(fs.existsSync(savedAbs));
        assert.equal(fs.readFileSync(savedAbs, 'utf8'), '<?xml version="1.0" encoding="UTF-8"?><unload>content</unload>');
      }
    );
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('handleExportUpdateSet: writeFiles=true does not save the error page of a rejected export', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-export-rejected-'));
  const originalCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    await withEnv(
      { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
      async () => {
        global.fetch = async (url) => {
          const u = String(url);
          if (u.includes('export_update_set.do')) {
            return mkResponse(403, '<html>Access denied</html>');
          }
          return mkResponse(200, { result: [] });
        };
        const res = await handleExportUpdateSet({ updateSetSysId: 'set-1', writeFiles: true }, 1000);
        assert.equal(res.isError, true);
        const parsed = JSON.parse(res.content[0].text);
        assert.equal(parsed.savedTo, null);
        assert.equal(fs.existsSync(path.join(tmpDir, buildUpdateSetExportPath('set-1'))), false);
      }
    );
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('handleExportUpdateSet: writeFiles=true with an unwritable target path reports writeError', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrona-export-fail-'));
  const originalCwd = process.cwd();
  // Pre-create ".syncrona-mcp" as a plain FILE so mkdir(recursive) on
  // ".syncrona-mcp/exports" fails with ENOTDIR.
  fs.writeFileSync(path.join(tmpDir, '.syncrona-mcp'), 'not a directory');
  process.chdir(tmpDir);
  try {
    await withEnv(
      { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
      async () => {
        global.fetch = async (url) => {
          const u = String(url);
          if (u.includes('export_update_set.do')) {
            return mkResponse(200, '<?xml version="1.0" encoding="UTF-8"?><unload>content</unload>');
          }
          return mkResponse(200, { result: [] });
        };
        const res = await handleExportUpdateSet(
          { updateSetSysId: 'set-1', writeFiles: true },
          1000
        );
        assert.equal(res.isError, true);
        const parsed = JSON.parse(res.content[0].text);
        assert.ok(parsed.writeError);
        assert.equal(parsed.savedTo, undefined);
      }
    );
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// insightValidateBeforePush.ts
// ---------------------------------------------------------------------------

test('evaluateValidationStatus: high findings -> blocked', () => {
  const report = { risk: { active: { distribution: { high: 2, medium: 1, low: 0 } } } };
  const result = evaluateValidationStatus(report);
  assert.deepEqual(result, { status: 'blocked', high: 2, medium: 1, low: 0 });
});

test('evaluateValidationStatus: medium only -> warning', () => {
  const report = { risk: { active: { distribution: { high: 0, medium: 3, low: 1 } } } };
  const result = evaluateValidationStatus(report);
  assert.equal(result.status, 'warning');
});

test('evaluateValidationStatus: no findings -> ready', () => {
  const report = { risk: { active: { distribution: { high: 0, medium: 0, low: 0 } } } };
  const result = evaluateValidationStatus(report);
  assert.equal(result.status, 'ready');
});

test('evaluateValidationStatus: missing/malformed shape defaults all counts to 0 and ready', () => {
  assert.deepEqual(evaluateValidationStatus({}), { status: 'ready', high: 0, medium: 0, low: 0 });
  assert.deepEqual(
    evaluateValidationStatus({ risk: 'not-an-object' }),
    { status: 'ready', high: 0, medium: 0, low: 0 }
  );
});

test('handleValidateBeforePush: missing scope returns error', async () => {
  const res = await handleValidateBeforePush({}, 1000);
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Missing required field: scope');
});

test('handleValidateBeforePush: happy path with clean script is ready (no findings)', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes('sys_update_xml')) {
          return mkResponse(200, { result: [] });
        }
        if (u.includes('sys_script_include')) {
          return mkResponse(200, {
            result: [{ sys_id: 's1', name: 'Clean', script: 'gs.info("hi");' }],
          });
        }
        return mkResponse(200, { result: [] });
      };
      const res = await handleValidateBeforePush(
        { scope: 'x_my_scope', tables: ['sys_script_include'] },
        1000
      );
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.scope, 'x_my_scope');
      assert.equal(parsed.fileCount, 1);
      assert.equal(parsed.files[0].table, 'sys_script_include');
      assert.equal(parsed.files[0].name, 'Clean');
      assert.ok(Array.isArray(parsed.recentChanges));
      assert.ok(Array.isArray(parsed.errors));
    }
  );
});

test('handleValidateBeforePush: unknown-only requested tables filter down to none (just the conflict query fires)', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const requestedUrls = [];
      global.fetch = async (url) => {
        requestedUrls.push(String(url));
        return mkResponse(200, { result: [] });
      };
      const res = await handleValidateBeforePush(
        { scope: 'x_my_scope', tables: ['not_a_real_table'] },
        1000
      );
      // requestedTables is non-empty so no fallback to defaults; filtering to known
      // tables yields none, so only the trailing conflict-window query fires.
      assert.equal(requestedUrls.length, 1);
      assert.match(requestedUrls[0], /sys_update_xml\?/);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.fileCount, 0);
      // Nothing was validated, so the gate is not green.
      assert.equal(res.isError, true);
      assert.equal(parsed.ready, false);
      assert.equal(parsed.validated, false);
      assert.deepEqual(parsed.unknownTables, ['not_a_real_table']);
    }
  );
});

test('handleValidateBeforePush: an unknown table next to a known one withholds the green gate', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async () => mkResponse(200, { result: [] });
      const res = await handleValidateBeforePush(
        { scope: 'x_my_scope', tables: ['sys_script_include', 'sys_ui_action'] },
        1000
      );
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.ready, false);
      assert.equal(parsed.validated, false);
      assert.deepEqual(parsed.unknownTables, ['sys_ui_action']);
    }
  );
});

test('handleValidateBeforePush: no tables argument uses the full default table set', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      const requestedUrls = [];
      global.fetch = async (url) => {
        requestedUrls.push(String(url));
        return mkResponse(200, { result: [] });
      };
      await handleValidateBeforePush({ scope: 'x_my_scope' }, 1000);
      // Object.keys(SCRIPT_SEARCH_TABLES).length (6) table queries + 1 conflict query.
      assert.equal(requestedUrls.length, 7);
    }
  );
});

test('handleValidateBeforePush: table request error is recorded in errors array', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes('sys_script_include')) {
          return mkResponse(500, { error: 'boom' });
        }
        return mkResponse(200, { result: [] });
      };
      const res = await handleValidateBeforePush(
        { scope: 'x_my_scope', tables: ['sys_script_include'] },
        1000
      );
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.fileCount, 0);
      assert.equal(parsed.errors.length, 1);
      assert.equal(parsed.errors[0].table, 'sys_script_include');
      assert.equal(parsed.errors[0].status, 500);
    }
  );
});

test('handleValidateBeforePush: conflictWindowHours out of range/invalid uses default 24', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async () => mkResponse(200, { result: [] });
      const res = await handleValidateBeforePush(
        { scope: 'x_my_scope', tables: ['sys_script_include'], conflictWindowHours: -5 },
        1000
      );
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.conflictWindowHours, 24);
    }
  );
});

test('handleValidateBeforePush: conflictWindowHours is clamped to 720 max', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async () => mkResponse(200, { result: [] });
      const res = await handleValidateBeforePush(
        { scope: 'x_my_scope', tables: ['sys_script_include'], conflictWindowHours: 10000 },
        1000
      );
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.conflictWindowHours, 720);
    }
  );
});

// ---------------------------------------------------------------------------
// insightAtfTests.ts
// ---------------------------------------------------------------------------

test('buildAtfRunScript: embeds scope, suiteIds and testIds as JSON in the script', () => {
  const script = buildAtfRunScript({ scope: 'x_my_scope', suiteIds: ['s1'], testIds: ['t1'] });
  assert.match(script, /"scope":"x_my_scope"/);
  assert.match(script, /"suiteIds":\["s1"\]/);
  assert.match(script, /"testIds":\["t1"\]/);
  assert.match(script, /SYNCRONA_ATF_TRIGGERED:/);
});

test('parseAtfTrigger: extracts and parses JSON after the marker', () => {
  const text = 'some log\nSYNCRONA_ATF_TRIGGERED:{"suites":["a"],"tests":[],"errors":[]}\nmore log';
  const result = parseAtfTrigger(text);
  assert.deepEqual(result, { suites: ['a'], tests: [], errors: [] });
});

test('parseAtfTrigger: missing marker returns empty defaults', () => {
  const result = parseAtfTrigger('no marker here');
  assert.deepEqual(result, { suites: [], tests: [], errors: [] });
});

test('parseAtfTrigger: malformed JSON after marker returns empty defaults', () => {
  const result = parseAtfTrigger('SYNCRONA_ATF_TRIGGERED:{not valid json');
  assert.deepEqual(result, { suites: [], tests: [], errors: [] });
});

test('parseAtfTrigger: non-string input returns empty defaults', () => {
  assert.deepEqual(parseAtfTrigger(undefined), { suites: [], tests: [], errors: [] });
});

test('summarizeAtfResults: counts passed/failed and wraps output as untrusted data', () => {
  const rows = [
    { sys_id: '1', name: 'Test A', status: 'success', output: 'ok', duration: '10' },
    { sys_id: '2', test: 'Test B', status: 'FAILED', output: 'bad', run_time: '20' },
    { sys_id: '3', test_suite: 'Suite C', status: 'passed' },
  ];
  const summary = summarizeAtfResults(rows);
  assert.equal(summary.total, 3);
  assert.equal(summary.passed, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.results[0].name, 'Test A');
  assert.equal(summary.results[1].name, 'Test B');
  assert.equal(summary.results[2].name, 'Suite C');
  assert.match(summary.results[0].output, /UNTRUSTED_EXTERNAL_DATA/);
  assert.equal(summary.results[2].status, 'passed');
});

test('summarizeAtfResults: empty rows returns zeroed summary', () => {
  const summary = summarizeAtfResults([]);
  assert.deepEqual(summary, { total: 0, passed: 0, failed: 0, pending: 0, results: [] });
});

test('summarizeAtfResults: unrecognized status is not counted as passed (falls to failed)', () => {
  const summary = summarizeAtfResults([{ sys_id: '1', status: 'cancelled' }]);
  assert.equal(summary.passed, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.results[0].status, 'cancelled');
});

test('summarizeAtfResults: missing status defaults to "unknown" and counts as pending', () => {
  const summary = summarizeAtfResults([{ sys_id: '1' }]);
  assert.equal(summary.results[0].status, 'unknown');
  assert.equal(summary.failed, 0);
  assert.equal(summary.pending, 1);
});

test('summarizeAtfResults: queued and running results count as pending, not failed', () => {
  const summary = summarizeAtfResults([
    { sys_id: '1', status: 'running' },
    { sys_id: '2', status: 'Queued' },
    { sys_id: '3', status: 'failure' },
  ]);
  assert.equal(summary.pending, 2);
  assert.equal(summary.failed, 1);
});

test('handleRunAtfTests: missing scope returns error', async () => {
  const res = await handleRunAtfTests({}, makeInsightContext());
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Missing required field: scope');
});

test('handleRunAtfTests: no suiteId/testId/runAll returns error', async () => {
  const res = await handleRunAtfTests({ scope: 'x_my_scope' }, makeInsightContext());
  assert.equal(res.isError, true);
  assert.equal(
    res.content[0].text,
    'Provide suiteId, testId, or set runAll=true.'
  );
});

test('handleRunAtfTests: missing confirmDestructive returns error', async () => {
  const res = await handleRunAtfTests(
    { scope: 'x_my_scope', runAll: true },
    makeInsightContext()
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /confirmDestructive=true/);
});

test('handleRunAtfTests: dryRun short-circuits with makeDryRunAuditResponse', async () => {
  let dryRunArgsCaptured = null;
  const context = makeInsightContext({
    dryRun: true,
    makeDryRunAuditResponse: (toolName, args, details) => {
      dryRunArgsCaptured = { toolName, details };
      return { isError: false, content: [{ type: 'text', text: 'dry-run-ok' }] };
    },
  });
  const res = await handleRunAtfTests(
    { scope: 'x_my_scope', runAll: true, confirmDestructive: true },
    context
  );
  assert.equal(res.content[0].text, 'dry-run-ok');
  assert.equal(dryRunArgsCaptured.toolName, 'sync_run_atf_tests');
  assert.equal(dryRunArgsCaptured.details.scope, 'x_my_scope');
  assert.equal(dryRunArgsCaptured.details.runAll, true);
});

test('handleRunAtfTests: runAll happy path triggers background script, polls (immediately terminal) and audits', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes('runBackgroundScript')) {
          return mkResponse(200, 'SYNCRONA_ATF_TRIGGERED:{"suites":["suite1"],"tests":[],"errors":[]}');
        }
        if (u.includes('sys_atf_test_suite_result')) {
          return mkResponse(200, {
            result: [{ sys_id: 'r1', status: 'success', test_suite: 'suite1', duration: '5' }],
          });
        }
        return mkResponse(200, { result: [] });
      };

      let auditCalled = null;
      const context = makeInsightContext({
        auditMutatingTool: (toolName, args, outcome, durationMs) => {
          auditCalled = { toolName, outcome, durationMs };
        },
      });

      const res = await handleRunAtfTests(
        { scope: 'x_my_scope', runAll: true, confirmDestructive: true },
        context
      );
      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.scope, 'x_my_scope');
      assert.equal(parsed.mode, 'all');
      assert.equal(parsed.completed, true);
      assert.equal(parsed.summary.total, 1);
      assert.equal(parsed.summary.passed, 1);
      assert.deepEqual(parsed.triggered, { suites: ['suite1'], tests: [], errors: [] });
      assert.ok(auditCalled);
      assert.equal(auditCalled.toolName, 'sync_run_atf_tests');
      assert.equal(auditCalled.outcome.mode, 'all');
      assert.equal(auditCalled.outcome.passed, 1);
    }
  );
});

test('handleRunAtfTests: testId-only mode uses sys_atf_test_result table and reports failed test as error', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes('runBackgroundScript')) {
          return mkResponse(200, 'SYNCRONA_ATF_TRIGGERED:{"suites":[],"tests":["t1"],"errors":[]}');
        }
        if (u.includes('sys_atf_test_result')) {
          return mkResponse(200, {
            result: [{ sys_id: 'r1', status: 'failure', test: 't1' }],
          });
        }
        return mkResponse(200, { result: [] });
      };
      const res = await handleRunAtfTests(
        { scope: 'x_my_scope', testId: 't1', confirmDestructive: true },
        makeInsightContext()
      );
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.mode, 'test');
      assert.equal(parsed.testId, 't1');
      assert.equal(res.isError, true); // failed > 0
      assert.equal(parsed.summary.failed, 1);
    }
  );
});

test('handleRunAtfTests: suiteId-only mode uses sys_atf_test_suite_result table', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes('runBackgroundScript')) {
          return mkResponse(200, 'SYNCRONA_ATF_TRIGGERED:{"suites":["s1"],"tests":[],"errors":[]}');
        }
        return mkResponse(200, {
          result: [{ sys_id: 'r1', status: 'success', test_suite: 's1' }],
        });
      };
      const res = await handleRunAtfTests(
        { scope: 'x_my_scope', suiteId: 's1', confirmDestructive: true },
        makeInsightContext()
      );
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.mode, 'suite');
      assert.equal(parsed.suiteId, 's1');
      assert.equal(res.isError, false);
    }
  );
});

test('handleRunAtfTests: non-2xx poll status marks response as error', async () => {
  await withEnv(
    { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' },
    async () => {
      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes('runBackgroundScript')) {
          return mkResponse(200, 'SYNCRONA_ATF_TRIGGERED:{"suites":["s1"],"tests":[],"errors":[]}');
        }
        return mkResponse(500, { result: [] });
      };
      const res = await handleRunAtfTests(
        { scope: 'x_my_scope', suiteId: 's1', confirmDestructive: true },
        makeInsightContext()
      );
      assert.equal(res.isError, true);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.status, 500);
      // empty rows -> not terminal (isAtfTerminal returns false for empty array)
      assert.equal(parsed.completed, false);
    }
  );
});

// ---------------------------------------------------------------------------
// Record history / recent changes: login pages and cut pages
// ---------------------------------------------------------------------------

const SN_ENV = { SN_INSTANCE: 'dev123.service-now.com', SN_USER: 'admin', SN_PASSWORD: 'secret' };

test('handleRecordHistory: an HTML 200 body is an error, not a record with no history', async () => {
  await withEnv(SN_ENV, async () => {
    global.fetch = async () => mkResponse(200, '<html><body>Log in</body></html>');
    const res = await handleRecordHistory({ table: 'incident', sysId: 'abc' }, 1000);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /HTTP 200 with a non-JSON body instead of a Table API result/);
  });
});

test('handleRecordHistory: requests limit+1 with a sys_id tiebreak and reports truncation', async () => {
  await withEnv(SN_ENV, async () => {
    const requestedUrls = [];
    global.fetch = async (url) => {
      requestedUrls.push(String(url));
      return mkResponse(200, {
        result: [1, 2, 3].map((n) => ({ fieldname: `f${n}`, sys_created_on: '2024-01-01 00:00:00' })),
      });
    };
    const res = await handleRecordHistory({ table: 'incident', sysId: 'abc', limit: 2 }, 1000);
    assert.equal(res.isError, false);
    assert.match(requestedUrls[0], /sysparm_limit=3\b/);
    assert.match(decodeURIComponent(requestedUrls[0]), /ORDERBYDESCsys_created_on\^ORDERBYsys_id/);
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.entryCount, 2);
    assert.equal(parsed.truncated, true);
    assert.deepEqual(parsed.history.map((h) => h.field), ['f1', 'f2']);
  });
});

test('handleRecordHistory: a page within the limit is not truncated', async () => {
  await withEnv(SN_ENV, async () => {
    global.fetch = async () => mkResponse(200, { result: [{ fieldname: 'f1' }] });
    const res = await handleRecordHistory({ table: 'incident', sysId: 'abc', limit: 2 }, 1000);
    assert.equal(JSON.parse(res.content[0].text).truncated, false);
  });
});

test('handleListRecentChanges: an HTML 200 body is an error, not a scope with no changes', async () => {
  await withEnv(SN_ENV, async () => {
    global.fetch = async () => mkResponse(200, '<html><body>Maintenance</body></html>');
    const res = await handleListRecentChanges({ scope: 'x_my_scope' }, 1000);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Recent changes request returned HTTP 200 with a non-JSON body/);
  });
});

test('handleListRecentChanges: reports truncation when more changes match than the limit', async () => {
  await withEnv(SN_ENV, async () => {
    global.fetch = async () =>
      mkResponse(200, { result: [1, 2, 3].map((n) => ({ target_name: `S${n}` })) });
    const res = await handleListRecentChanges({ scope: 'x_my_scope', limit: 2 }, 1000);
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.rowCount, 2);
    assert.equal(parsed.truncated, true);
    assert.deepEqual(parsed.changes.map((c) => c.name), ['S1', 'S2']);
  });
});

test('handleValidateBeforePush: a login page served with 200 is an error, not a clean table', async () => {
  await withEnv(SN_ENV, async () => {
    global.fetch = async (url) => {
      if (String(url).includes('sys_update_xml')) return mkResponse(200, { result: [] });
      return mkResponse(200, '<html><body>Log in</body></html>');
    };
    const res = await handleValidateBeforePush(
      { scope: 'x_my_scope', tables: ['sys_script_include'] },
      1000
    );
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.validated, false);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.errors.length, 1);
    assert.equal(parsed.errors[0].table, 'sys_script_include');
    assert.match(parsed.errors[0].reason, /non-JSON body instead of a Table API result/);
  });
});

test('handleValidateBeforePush: a table with more scripts than the limit withholds the green gate', async () => {
  await withEnv(SN_ENV, async () => {
    const requestedUrls = [];
    global.fetch = async (url) => {
      const u = String(url);
      requestedUrls.push(u);
      if (u.includes('sys_update_xml')) return mkResponse(200, { result: [] });
      return mkResponse(200, {
        result: [1, 2, 3].map((n) => ({ sys_id: `s${n}`, name: `Inc${n}`, script: 'gs.info("hi");' })),
      });
    };
    const res = await handleValidateBeforePush(
      { scope: 'x_my_scope', tables: ['sys_script_include'], limit: 2 },
      1000
    );
    const scriptUrl = decodeURIComponent(requestedUrls.find((u) => u.includes('sys_script_include')));
    assert.match(scriptUrl, /sysparm_limit=3\b/);
    assert.match(scriptUrl, /ORDERBYname\^ORDERBYsys_id/);
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.fileCount, 2);
    assert.deepEqual(parsed.truncatedTables, ['sys_script_include']);
    assert.equal(parsed.validated, false);
    assert.equal(parsed.ready, false);
  });
});

test('handleValidateBeforePush: a login page on the conflict query means no conflict check ran', async () => {
  await withEnv(SN_ENV, async () => {
    global.fetch = async (url) => {
      if (String(url).includes('sys_update_xml')) return mkResponse(200, '<html>Log in</html>');
      return mkResponse(200, { result: [] });
    };
    const res = await handleValidateBeforePush(
      { scope: 'x_my_scope', tables: ['sys_script_include'] },
      1000
    );
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.conflictCheckPerformed, false);
    assert.equal(parsed.validated, false);
    const conflictError = parsed.errors.find((e) => e.table === 'sys_update_xml');
    assert.ok(conflictError);
    assert.match(conflictError.reason, /instead of a Table API result/);
  });
});

test('handleValidateBeforePush: more recent changes than listed are flagged', async () => {
  await withEnv(SN_ENV, async () => {
    const requestedUrls = [];
    global.fetch = async (url) => {
      const u = String(url);
      requestedUrls.push(u);
      if (u.includes('sys_update_xml')) {
        return mkResponse(200, {
          result: Array.from({ length: 51 }, (_, i) => ({
            name: `sys_script_include_${i}`,
            type: 'Script Include',
            target_name: `Inc${i}`,
            sys_created_on: '2026-01-01 00:00:00',
            sys_created_by: 'admin',
          })),
        });
      }
      return mkResponse(200, { result: [] });
    };
    const res = await handleValidateBeforePush(
      { scope: 'x_my_scope', tables: ['sys_script_include'] },
      1000
    );
    assert.match(requestedUrls.find((u) => u.includes('sys_update_xml')), /sysparm_limit=51\b/);
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.recentChanges.length, 50);
    assert.equal(parsed.recentChangesTruncated, true);
  });
});

test('handleExportUpdateSet: a login page served with 200 is an error and is never saved', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'export-login-'));
  const prevCwd = process.cwd();
  process.chdir(tmp);
  try {
    await withEnv(SN_ENV, async () => {
      global.fetch = async (url) => {
        if (String(url).includes('export_update_set.do')) {
          return mkResponse(200, '<html><body>Log in</body></html>');
        }
        return mkResponse(200, { result: [] });
      };
      const res = await handleExportUpdateSet({ updateSetSysId: 'set-1', writeFiles: true }, 1000);
      assert.equal(res.isError, true);
      const parsed = JSON.parse(res.content[0].text);
      assert.match(parsed.error, /not an update set unload/);
      assert.equal(parsed.savedTo, null);
      assert.equal(fs.existsSync(path.join(tmp, '.syncrona-mcp')), false);
    });
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('handleExportUpdateSet: a failed or non-table count query reports an unknown record count', async () => {
  await withEnv(SN_ENV, async () => {
    for (const countReply of [mkResponse(500, { error: 'boom' }), mkResponse(200, '<html>Log in</html>')]) {
      global.fetch = async (url) => {
        if (String(url).includes('export_update_set.do')) {
          return mkResponse(200, '<?xml version="1.0" encoding="UTF-8"?><unload></unload>');
        }
        return countReply;
      };
      const res = await handleExportUpdateSet({ updateSetSysId: 'set-1' }, 1000);
      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.recordCount, null);
      assert.equal(parsed.recordCountTruncated, false);
    }
  });
});

test('handleExportUpdateSet: a record count past the limit is capped and flagged', async () => {
  await withEnv(SN_ENV, async () => {
    const requestedUrls = [];
    global.fetch = async (url) => {
      const u = String(url);
      requestedUrls.push(u);
      if (u.includes('export_update_set.do')) {
        return mkResponse(200, '<unload></unload>');
      }
      return mkResponse(200, { result: Array.from({ length: 1001 }, (_, i) => ({ sys_id: `x${i}` })) });
    };
    const res = await handleExportUpdateSet({ updateSetSysId: 'set-1' }, 1000);
    assert.match(requestedUrls.find((u) => u.includes('sys_update_xml')), /sysparm_limit=1001\b/);
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.recordCount, 1000);
    assert.equal(parsed.recordCountTruncated, true);
  });
});
