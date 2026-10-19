// SPDX-License-Identifier: GPL-3.0-or-later
// The sys.scripts.do page parser and the transport branches around it:
// login, the CSRF token, the probe and the custom-endpoint path.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeHtmlEntities,
  extractCsrfToken,
  parseScriptsBackgroundResponse,
} = require('../dist/scriptsBackgroundPage.js');
const {
  runBackgroundScript,
  probeBackgroundScriptPage,
  clearServiceNowSecretsCache,
} = require('../dist/servicenowCore.js');
const {
  CSRF_TOKEN,
  scriptResultHtml,
  scriptsBackgroundFetch,
  mkHtmlResponse,
} = require('./scriptsBackgroundFetchMock.cjs');

const REAL_GLOBAL_FETCH = global.fetch;
const KEYS = ['SN_INSTANCE', 'SN_USER', 'SN_PASSWORD'];

async function withInstance(fetchFn, fn) {
  const old = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.SN_INSTANCE = 'dev123.service-now.com';
  process.env.SN_USER = 'admin';
  process.env.SN_PASSWORD = 'secret';
  clearServiceNowSecretsCache();
  global.fetch = fetchFn;
  try {
    return await fn();
  } finally {
    global.fetch = REAL_GLOBAL_FETCH;
    for (const k of KEYS) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
    clearServiceNowSecretsCache();
  }
}

test('decodeHtmlEntities decodes named, decimal and hex entities', () => {
  assert.equal(decodeHtmlEntities('&lt;a&gt; &amp; &quot;b&quot; &#39;c&apos;'), '<a> & "b" \'c\'');
  assert.equal(decodeHtmlEntities('&#65;&#x42;&#X43;'), 'ABC');
  assert.equal(decodeHtmlEntities('&nbsp; &unknown; stays'), '&nbsp; &unknown; stays');
});

test('extractCsrfToken reads the hidden input in either attribute order', () => {
  assert.equal(extractCsrfToken('<input type="hidden" name="sysparm_ck" value="t1">'), 't1');
  assert.equal(extractCsrfToken("<INPUT value='t2' name='sysparm_ck'>"), 't2');
  assert.equal(extractCsrfToken('<input name="other" value="x"><input name="sysparm_ck" value="">'), null);
  assert.equal(extractCsrfToken("<script>var g_ck = 'from-script';</script>"), 'from-script');
  assert.equal(extractCsrfToken('<html>no token</html>'), null);
});

test('parseScriptsBackgroundResponse reads output, scope and history id', () => {
  const html = scriptResultHtml(['*** Script: a < b', '*** Script: done'], {
    scope: 'x_acme_app',
    historyId: 'b'.repeat(32),
  });
  assert.deepEqual(parseScriptsBackgroundResponse(html), {
    output: '*** Script: a < b\n*** Script: done',
    scope: 'x_acme_app',
    executionHistoryId: 'b'.repeat(32),
  });
});

test('parseScriptsBackgroundResponse flags compile and execution errors', () => {
  const html = scriptResultHtml(['Script compilation error: Script parse error (<refname>; line 1)', 'more']);
  const parsed = parseScriptsBackgroundResponse(html);
  assert.equal(parsed.error, 'Script compilation error: Script parse error (<refname>; line 1)');

  const last = parseScriptsBackgroundResponse(scriptResultHtml('Script execution error: boom'));
  assert.equal(last.error, 'Script execution error: boom');
});

test('parseScriptsBackgroundResponse tolerates a result without PRE or history link', () => {
  assert.deepEqual(parseScriptsBackgroundResponse('<HTML>Script completed in scope global: script</HTML>'), {
    output: '',
    scope: 'global',
    executionHistoryId: '',
  });
  assert.equal(parseScriptsBackgroundResponse('<html>not authorized</html>'), null);
  assert.equal(parseScriptsBackgroundResponse(''), null);
});

test('runBackgroundScript reports a CSRF rejection when the POST answers "not authorized"', async () => {
  const res = await withInstance(
    scriptsBackgroundFetch({ result: 'not authorized' }),
    () => runBackgroundScript("gs.info('x');", 2000)
  );
  assert.equal(res.usedEndpoint, '/sys.scripts.do');
  assert.equal(res.status, 502);
  assert.match(JSON.stringify(res.data), /CSRF token/);

  const other = await withInstance(
    scriptsBackgroundFetch({ result: '<html>unexpected</html>' }),
    () => runBackgroundScript("gs.info('x');", 2000)
  );
  assert.equal(other.status, 502);
  assert.match(JSON.stringify(other.data), /without a script result/);
});

test('runBackgroundScript reports a page without a CSRF token as 401', async () => {
  const res = await withInstance(
    scriptsBackgroundFetch({ formHtml: '<html>no form here</html>' }),
    () => runBackgroundScript("gs.info('x');", 2000)
  );
  assert.equal(res.status, 401);
  assert.equal(res.usedEndpoint, '/sys.scripts.do');
});

test('runBackgroundScript stops when login.do fails', async () => {
  const calls = [];
  const res = await withInstance(
    scriptsBackgroundFetch({ loginStatus: 403, calls }),
    () => runBackgroundScript("gs.info('x');", 2000)
  );
  assert.equal(res.status, 403);
  assert.match(JSON.stringify(res.data), /login\.do failed with HTTP 403/);
  assert.equal(calls.some((c) => c.url.endsWith('/sys.scripts.do')), false);
});

test('runBackgroundScript posts JSON to a custom endpointPath instead', async () => {
  const seen = [];
  const res = await withInstance(
    async (url, init) => {
      seen.push({ url: String(url), method: init.method, body: init.body });
      return mkHtmlResponse(200, JSON.stringify({ result: { output: 'custom' } }));
    },
    () => runBackgroundScript("gs.info('x');", 2000, '/api/acme/run')
  );
  assert.equal(res.usedEndpoint, '/api/acme/run');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url.endsWith('/api/acme/run'), true);
  assert.deepEqual(JSON.parse(seen[0].body), { script: "gs.info('x');" });
});

test('probeBackgroundScriptPage renders the form without running a script', async () => {
  const calls = [];
  const ok = await withInstance(scriptsBackgroundFetch({ calls }), () => probeBackgroundScriptPage(2000));
  assert.equal(ok.status, 200);
  assert.equal(ok.usedEndpoint, '/sys.scripts.do');
  assert.equal(calls.some((c) => c.method === 'POST' && c.url.endsWith('/sys.scripts.do')), false);
  assert.equal(calls.some((c) => c.form && c.form.sysparm_ck === CSRF_TOKEN), false);

  const denied = await withInstance(
    scriptsBackgroundFetch({ formHtml: '<html>login</html>' }),
    () => probeBackgroundScriptPage(2000)
  );
  assert.equal(denied.status, 401);
});
