// SPDX-License-Identifier: GPL-3.0-or-later
// Shared fetch double for the sys.scripts.do background-script flow:
// login.do -> GET sys.scripts.do (form with the CSRF token) -> POST the form
// -> logout.do. Any other URL goes to the optional `fallback` fetch.

const CSRF_TOKEN = 'ck-test-token';

const FORM_HTML =
  '<html><body><form action="sys.scripts.do" method="post">' +
  `<input name="sysparm_ck" type="hidden" value="${CSRF_TOKEN}">` +
  '<textarea name="script"></textarea></form></body></html>';

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The page's answer to a script POST, with `lines` printed in the <PRE> block. */
function scriptResultHtml(lines, { scope = 'global', historyId = 'a'.repeat(32) } = {}) {
  const body = (Array.isArray(lines) ? lines : [lines]).map(escapeHtml).join('<BR/>');
  return (
    `[0:00:00.012] <HTML><BODY>Script completed in scope ${scope}: script<HR/>` +
    `Script execution history <A HREF='sys_script_execution_history.do?sys_id=${historyId}'>link</A>` +
    `<PRE>${body}<BR/></PRE></BODY></HTML>`
  );
}

function mkHtmlResponse(status, text, { cookies = [], location = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      getSetCookie: () => cookies,
      get: (name) => (String(name).toLowerCase() === 'location' ? location || null : null),
    },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

/**
 * Builds a fetch double. Options:
 *  - result: HTML (or a function of the posted form) the script POST answers
 *  - resultStatus: status of the script POST (default 200)
 *  - formHtml / formStatus / formLocation: the GET of the form
 *  - loginStatus: status of the login.do POST (default 302)
 *  - calls: array that receives { method, url, form, headers } per request
 *  - fallback: fetch for every other URL
 */
function scriptsBackgroundFetch(options = {}) {
  const calls = options.calls || [];
  return async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const href = String(url);
    const form =
      typeof init.body === 'string' && /x-www-form-urlencoded/.test(String((init.headers || {})['Content-Type']))
        ? Object.fromEntries(new URLSearchParams(init.body))
        : undefined;
    calls.push({ method, url: href, form, headers: init.headers || {} });
    if (/\/login\.do$/.test(href)) {
      return mkHtmlResponse(options.loginStatus ?? 302, '', {
        cookies: ['JSESSIONID=session-1; Path=/; HttpOnly', 'glide_user_route=glide.1; Path=/'],
        location: 'welcome.do',
      });
    }
    if (/\/logout\.do$/.test(href)) {
      return mkHtmlResponse(302, '', { location: 'logout_success.do' });
    }
    if (/\/sys\.scripts\.do$/.test(href)) {
      if (method === 'GET') {
        return mkHtmlResponse(options.formStatus ?? 200, options.formHtml ?? FORM_HTML, {
          location: options.formLocation || '',
        });
      }
      const result =
        typeof options.result === 'function' ? options.result(form || {}) : options.result ?? scriptResultHtml('*** Script: ok');
      return mkHtmlResponse(options.resultStatus ?? 200, result);
    }
    if (options.fallback) {
      return options.fallback(url, init);
    }
    throw new Error(`unexpected fetch ${method} ${href}`);
  };
}

/**
 * Wraps a test's own fetch double: login.do, logout.do and the form GET are
 * answered here, and only the script POST to sys.scripts.do (plus every other
 * URL) reaches `fetchFn`, so a test can keep answering the script itself.
 */
function withScriptsBackgroundSession(fetchFn) {
  return async (url, init = {}) => {
    const href = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    if (/\/login\.do$/.test(href)) {
      return mkHtmlResponse(302, '', { cookies: ['JSESSIONID=session-1; Path=/'], location: 'welcome.do' });
    }
    if (/\/logout\.do$/.test(href)) {
      return mkHtmlResponse(302, '', { location: 'logout_success.do' });
    }
    if (/\/sys\.scripts\.do$/.test(href) && method === 'GET') {
      return mkHtmlResponse(200, FORM_HTML);
    }
    return fetchFn(url, init);
  };
}

module.exports = {
  CSRF_TOKEN,
  FORM_HTML,
  scriptResultHtml,
  mkHtmlResponse,
  scriptsBackgroundFetch,
  withScriptsBackgroundSession,
};
