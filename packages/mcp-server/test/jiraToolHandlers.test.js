// SPDX-License-Identifier: GPL-3.0-or-later
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handleJiraTool } = require('../dist/handlers/jiraToolHandlers.js');

/** Run a git command in `cwd`, returning trimmed stdout. */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Create a throwaway repo on `branch` with one commit; returns its path. */
function makeRepoOnBranch(branch) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sync-jira-git-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'checkout', '-q', '-b', branch);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

const ENV_KEYS = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_TOKEN', 'JIRA_DEPLOYMENT'];

// A non-existent directory: `git rev-parse` runs with cwd here, fails, and the
// handler's branch fallback resolves to null — making the inference path testable.
const NO_GIT_CTX = { timeoutMs: 1000, projectDir: '/syncrona-nonexistent-test-dir' };

const CLOUD_RAW = {
  key: 'ABC-1',
  fields: {
    summary: 'Do the thing',
    description: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Details here.' }] }],
    },
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    issuetype: { name: 'Story' },
    priority: { name: 'High' },
    assignee: { displayName: 'Alice' },
    reporter: { displayName: 'Bob' },
    labels: ['backend'],
    components: [{ name: 'api' }],
    subtasks: [{ key: 'ABC-2', fields: { summary: 'sub', status: { name: 'To Do' } } }],
    issuelinks: [
      { type: { outward: 'blocks' }, outwardIssue: { key: 'ABC-9', fields: { summary: 'other' } } },
    ],
    fixVersions: [{ name: '1.2.0' }],
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-02T00:00:00.000Z',
    comment: {
      comments: [
        {
          author: { displayName: 'Carol' },
          created: '2026-01-03T00:00:00.000Z',
          body: {
            type: 'doc',
            version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Looks good.' }] }],
          },
        },
      ],
    },
  },
};

const savedEnv = {};
let savedFetch;
let calls;

function clearJiraEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

function setCloudEnv() {
  process.env.JIRA_BASE_URL = 'https://acme.atlassian.net';
  process.env.JIRA_EMAIL = 'me@acme.com';
  process.env.JIRA_TOKEN = 'tok';
  delete process.env.JIRA_DEPLOYMENT;
}

/** Stub global fetch with a fixed status/payload and record each request. */
function stubFetch(status, payload) {
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return { status, text: async () => (payload == null ? '' : JSON.stringify(payload)) };
  };
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  savedFetch = global.fetch;
  calls = [];
  clearJiraEnv();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  global.fetch = savedFetch;
});

test('jira: unknown tool returns null so dispatch can fall through', async () => {
  const res = await handleJiraTool('not_a_real_tool', {}, NO_GIT_CTX);
  assert.equal(res, null);
});

test('jira_get_issue: missing credentials is a clear error', async () => {
  const res = await handleJiraTool('jira_get_issue', { key: 'ABC-1' }, NO_GIT_CTX);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /No Jira credentials configured/);
});

test('jira_get_issue: fetches and returns normalized JSON for an explicit key', async () => {
  setCloudEnv();
  stubFetch(200, CLOUD_RAW);

  const res = await handleJiraTool('jira_get_issue', { key: 'abc-1' }, NO_GIT_CTX);

  assert.equal(res.isError, false);
  const issue = JSON.parse(res.content[0].text);
  assert.equal(issue.key, 'ABC-1');
  assert.equal(issue.summary, 'Do the thing');
  assert.equal(issue.description, 'Details here.');
  assert.equal(issue.status, 'In Progress');
  assert.equal(issue.assignee, 'Alice');
  assert.deepEqual(issue.labels, ['backend']);
  assert.equal(issue.links[0].relationship, 'blocks');
  assert.equal(issue.comments[0].author, 'Carol');

  // Cloud uses the v3 REST base, the uppercased key, and HTTP Basic auth.
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rest\/api\/3\/issue\/ABC-1\?/);
  assert.match(calls[0].init.headers.Authorization, /^Basic /);
});

test('jira_get_issue: maps a 404 to a not-found error', async () => {
  setCloudEnv();
  stubFetch(404, null);

  const res = await handleJiraTool('jira_get_issue', { key: 'ABC-9' }, NO_GIT_CTX);

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /HTTP 404/);
});

test('jira_get_issue: no key and no branch is a clear inference error', async () => {
  setCloudEnv();
  stubFetch(200, CLOUD_RAW);

  const res = await handleJiraTool('jira_get_issue', {}, NO_GIT_CTX);

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /could be inferred/);
  assert.equal(calls.length, 0, 'must not call Jira when no key can be resolved');
});

test('jira_get_issue: infers the key from the current git branch', async () => {
  setCloudEnv();
  stubFetch(200, CLOUD_RAW);
  const repo = makeRepoOnBranch('feature/ABC-7-thing');
  try {
    const res = await handleJiraTool(
      'jira_get_issue',
      {},
      { timeoutMs: 1000, projectDir: repo }
    );
    assert.equal(res.isError, false);
    // The mined key (ABC-7), uppercased, drives the request URL.
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rest\/api\/3\/issue\/ABC-7\?/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('jira_get_issue: detached HEAD yields no branch, so inference fails', async () => {
  setCloudEnv();
  stubFetch(200, CLOUD_RAW);
  const repo = makeRepoOnBranch('feature/ABC-7-thing');
  try {
    // Detach: `git rev-parse --abbrev-ref HEAD` now reports the literal "HEAD".
    const sha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', sha);
    const res = await handleJiraTool(
      'jira_get_issue',
      {},
      { timeoutMs: 1000, projectDir: repo }
    );
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /could be inferred/);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
