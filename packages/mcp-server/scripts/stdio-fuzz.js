// SPDX-License-Identifier: GPL-3.0-or-later
//
// Hostile-input robustness harness for the MCP server's real stdio boundary.
//
//   node scripts/stdio-fuzz.js [--verbose] [--frame <name>]
//
// WHY A PROCESS HARNESS AND NOT UNIT TESTS
// Every other suite in this package calls exported functions directly. That skips the
// only surface a real MCP client ever touches: a byte stream. The transport's framing,
// the SDK's JSON-RPC parser, `console.*` reaching the wrong fd, and an unhandled
// rejection killing the process are all invisible from inside a function call, and all
// four are ways this server can fail a client while every unit test stays green.
//
// THE FOUR INVARIANTS
//   1. STDOUT PURITY. stdout belongs to JSON-RPC (ARCHITECTURE invariant 1). Every
//      non-empty line must be a parseable JSON-RPC 2.0 message — no banner, no stray
//      `console.log`, no half-written frame, no BOM. One log line here corrupts the
//      session for every client.
//   2. LIVENESS. After each hostile frame the server must still answer `ping`. This is
//      what separates "rejected the input" from "died" or "wedged", and it is checked
//      after every single frame so a wedge is attributed to the frame that caused it.
//   3. ID FIDELITY. No response may carry an id that was never sent, and no id may be
//      answered twice. A notification (no id) must produce no response at all.
//   4. NO LEAKAGE. Error payloads on stdout must not carry stack frames, absolute
//      filesystem paths or `node_modules` — a model reads these, and an MCP client
//      shows them to a user.
//   5. HERMETIC. The corpus must not make the server do real work. This is checked, not
//      asserted: the server's own audit log in the throwaway project dir must contain no
//      `tool.call` entry with `ok: true`, because a tool that succeeded is a tool that
//      ran. The claim was wrong the first time it was made — two frames named the real
//      `sync_status` tool and each spawned a 2-4 s `syncrona status` subprocess, which is
//      also what made the run flaky — so it is now enforced rather than believed.
//
// SCOPE: the corpus is therefore built from names that do not exist and argument
// containers the boundary rejects before dispatch, which is what makes it safe and fast
// enough to keep in the default suite.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SERVER_ENTRY = path.join(__dirname, "..", "dist", "index.js");
const PROBE_TIMEOUT_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 3000;

// Frame ids are allocated from disjoint ranges so a stray response is attributable:
// corpus frames own 1000+, liveness probes own 9000+.
const CORPUS_ID_BASE = 1000;
const PROBE_ID_BASE = 9000;

const bigString = (n) => "A".repeat(n);

// Depth 1000 is well inside what JSON.parse accepts and well outside what a hand-written
// recursive validator survives; the point is to prove nothing here recurses unbounded.
function deepNest(depth) {
  let node = { end: true };
  for (let i = 0; i < depth; i += 1) {
    node = { nested: node };
  }
  return node;
}

const json = (value) => JSON.stringify(value);

// The audit log is JSONL under `.syncrona-mcp/` in whatever directory the server was
// started in. A missing file is the expected outcome for a run that never got far enough
// to audit anything, so it is not an error here; an unparseable line is skipped for the
// same reason (invariant 1 already owns malformed output).
function readAuditEntries(projectDir) {
  const auditPath = path.join(projectDir, ".syncrona-mcp", "audit.log");
  let raw;
  try {
    raw = fs.readFileSync(auditPath, "utf8");
  } catch (_) {
    return [];
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (_) {
      // not this check's problem
    }
  }
  return entries;
}

/**
 * Every JSON-RPC id a raw payload actually carries. A frame may hold several messages
 * (the pipelined pair, the batch), so this cannot be `JSON.parse(raw).id` — the first
 * version of the harness did exactly that and then reported the second half of its own
 * pipelined pair as an "unsolicited" response.
 */
function idsIn(raw) {
  const ids = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      if (
        message !== null &&
        typeof message === "object" &&
        Object.prototype.hasOwnProperty.call(message, "id") &&
        message.id !== null
      ) {
        ids.push(message.id);
      }
    }
  }
  return ids;
}

/**
 * The corpus. `raw` is written to stdin verbatim (newline appended by the runner unless
 * `rawIsComplete`), so a frame can be malformed at the byte level and not just the
 * schema level. `expectResponse` says whether a well-formed request id must be answered;
 * frames the transport is entitled to drop set it to false.
 */
function buildCorpus() {
  const id = (n) => CORPUS_ID_BASE + n;
  return [
    // --- byte-level framing -------------------------------------------------
    { name: "empty-line", raw: "", expectResponse: false },
    { name: "whitespace-only", raw: "   \t  ", expectResponse: false },
    { name: "truncated-json", raw: '{"jsonrpc":"2.0","id":', expectResponse: false },
    { name: "trailing-garbage", raw: '{"jsonrpc":"2.0","id":1,"method":"ping"} trailing', expectResponse: false },
    { name: "bare-bracket", raw: "{", expectResponse: false },
    { name: "nul-byte-in-string", raw: json({ jsonrpc: "2.0", id: id(1), method: "ping\u0000" }), expectResponse: false },
    { name: "lone-surrogate", raw: '{"jsonrpc":"2.0","id":1002,"method":"pi\\ud800ng"}', expectResponse: false },
    {
      name: "crlf-terminated",
      raw: `${json({ jsonrpc: "2.0", id: id(3), method: "ping" })}\r\n`,
      rawIsComplete: true,
      expectResponse: false,
    },
    {
      // Two complete frames in a single write: the transport must not lose the second.
      name: "pipelined-pair",
      raw: `${json({ jsonrpc: "2.0", id: id(4), method: "ping" })}\n${json({ jsonrpc: "2.0", id: id(5), method: "ping" })}\n`,
      rawIsComplete: true,
      expectResponse: false,
    },

    // --- JSON-RPC envelope --------------------------------------------------
    { name: "json-null", raw: "null", expectResponse: false },
    { name: "json-number", raw: "42", expectResponse: false },
    { name: "json-string", raw: '"hello"', expectResponse: false },
    { name: "empty-batch", raw: "[]", expectResponse: false },
    {
      name: "batch",
      raw: json([
        { jsonrpc: "2.0", id: id(6), method: "ping" },
        { jsonrpc: "2.0", id: id(7), method: "ping" },
      ]),
      expectResponse: false,
    },
    { name: "missing-jsonrpc", raw: json({ id: id(8), method: "ping" }), expectResponse: false },
    { name: "wrong-jsonrpc-version", raw: json({ jsonrpc: "1.0", id: id(9), method: "ping" }), expectResponse: false },
    { name: "missing-method", raw: json({ jsonrpc: "2.0", id: id(10) }), expectResponse: false },
    { name: "method-not-a-string", raw: json({ jsonrpc: "2.0", id: id(11), method: 7 }), expectResponse: false },
    { name: "method-is-object", raw: json({ jsonrpc: "2.0", id: id(12), method: { a: 1 } }), expectResponse: false },
    { name: "id-is-object", raw: json({ jsonrpc: "2.0", id: { a: 1 }, method: "ping" }), expectResponse: false },
    { name: "id-is-array", raw: json({ jsonrpc: "2.0", id: [1], method: "ping" }), expectResponse: false },
    { name: "id-null", raw: json({ jsonrpc: "2.0", id: null, method: "ping" }), expectResponse: false },
    {
      // A notification is defined by the absence of an id. Answering one desynchronises
      // a client that is counting responses, so silence is the contract.
      name: "notification-no-id",
      raw: json({ jsonrpc: "2.0", method: "notifications/initialized" }),
      expectResponse: false,
      mustNotRespond: true,
    },
    { name: "unknown-method", raw: json({ jsonrpc: "2.0", id: id(13), method: "no/such/method" }), expectResponse: true },
    // A reused id is the client's problem, not the server's: two requests earn two
    // responses. What must never happen is a third — an id answered more times than it
    // was asked. That is what the response-count invariant below checks.
    { name: "duplicate-id-first", raw: json({ jsonrpc: "2.0", id: id(14), method: "ping" }), expectResponse: true },
    { name: "duplicate-id-second", raw: json({ jsonrpc: "2.0", id: id(14), method: "ping" }), expectResponse: true },

    // --- prototype pollution ------------------------------------------------
    {
      name: "proto-in-params",
      raw: '{"jsonrpc":"2.0","id":1015,"method":"tools/call","params":{"name":"no_such_tool","arguments":{"__proto__":{"polluted":true}}}}',
      expectResponse: true,
    },
    {
      name: "constructor-prototype-in-params",
      raw: '{"jsonrpc":"2.0","id":1016,"method":"tools/call","params":{"name":"no_such_tool","arguments":{"constructor":{"prototype":{"polluted":true}}}}}',
      expectResponse: true,
    },
    {
      name: "proto-at-envelope-root",
      raw: '{"jsonrpc":"2.0","id":1017,"method":"ping","__proto__":{"polluted":true}}',
      expectResponse: true,
    },

    // --- tools/call shapes the validator must reject ------------------------
    { name: "call-unknown-tool", raw: json({ jsonrpc: "2.0", id: id(18), method: "tools/call", params: { name: "no_such_tool", arguments: {} } }), expectResponse: true },
    { name: "call-no-params", raw: json({ jsonrpc: "2.0", id: id(19), method: "tools/call" }), expectResponse: true },
    { name: "call-name-missing", raw: json({ jsonrpc: "2.0", id: id(20), method: "tools/call", params: { arguments: {} } }), expectResponse: true },
    { name: "call-name-not-a-string", raw: json({ jsonrpc: "2.0", id: id(21), method: "tools/call", params: { name: 5, arguments: {} } }), expectResponse: true },
    { name: "call-arguments-array", raw: json({ jsonrpc: "2.0", id: id(22), method: "tools/call", params: { name: "sync_status", arguments: [1, 2, 3] } }), expectResponse: true },
    { name: "call-arguments-string", raw: json({ jsonrpc: "2.0", id: id(23), method: "tools/call", params: { name: "sync_status", arguments: "not-an-object" } }), expectResponse: true },
    // Hostile `timeoutMs` values against a name that does not exist. The first draft of
    // these two frames named `sync_status`, and dispatch got far enough to actually run
    // `syncrona status` — a 2-4 s subprocess that made the run slow and flaky, and that
    // broke the hermeticity this file claims above. The timeout semantics themselves are
    // covered directly: `normalizeTimeout('5000')` and `normalizeTimeout(-500)` are
    // asserted in test/toolService.cov.test.js. What is left to prove here is only that
    // these bytes on the wire cannot corrupt the stream, and an unknown name proves that
    // just as well.
    { name: "call-bad-timeout-type", raw: json({ jsonrpc: "2.0", id: id(24), method: "tools/call", params: { name: "no_such_tool", arguments: { timeoutMs: "abc" } } }), expectResponse: true },
    { name: "call-negative-timeout", raw: json({ jsonrpc: "2.0", id: id(25), method: "tools/call", params: { name: "no_such_tool", arguments: { timeoutMs: -1 } } }), expectResponse: true },
    {
      // Path traversal through a tool argument: it must be refused by validation, not
      // normalised into a read outside the project.
      name: "call-path-traversal",
      raw: json({ jsonrpc: "2.0", id: id(26), method: "tools/call", params: { name: "no_such_tool", arguments: { file: "../../../../etc/passwd" } } }),
      expectResponse: true,
    },
    {
      // Bidi overrides render a hostile tool name as a benign one in a terminal — the
      // Trojan Source trick (CVE-2021-42574). The escapes are deliberate: written as
      // literal U+202E/U+202C this file becomes "binary" to grep and diff, and it would
      // itself carry the exact characters a source scanner is meant to flag. Escaped, the
      // file stays pure ASCII while the same bytes still reach the wire.
      name: "call-rtl-override-name",
      raw: json({ jsonrpc: "2.0", id: id(27), method: "tools/call", params: { name: "sync_\u202Estatus\u202C", arguments: {} } }),
      expectResponse: true,
    },

    // --- size and depth -----------------------------------------------------
    { name: "deep-nesting-1000", raw: json({ jsonrpc: "2.0", id: id(28), method: "tools/call", params: { name: "no_such_tool", arguments: deepNest(1000) } }), expectResponse: true },
    { name: "long-method-name-64k", raw: json({ jsonrpc: "2.0", id: id(29), method: bigString(64 * 1024) }), expectResponse: true },
    { name: "large-payload-1mb", raw: json({ jsonrpc: "2.0", id: id(30), method: "tools/call", params: { name: "no_such_tool", arguments: { blob: bigString(1024 * 1024) } } }), expectResponse: true },
  ];
}

// Stack frames, absolute paths and module paths must never reach a client. `at ` is the
// V8 stack-frame marker; the path patterns catch a raw fs error being echoed back.
const LEAK_PATTERNS = [
  { name: "stack-frame", re: /\bat [A-Za-z_$][\w$.]*\s+\(/ },
  { name: "node_modules-path", re: /node_modules[\\/]/ },
  { name: "absolute-posix-path", re: /"[^"]*\/(?:Users|home|root)\// },
  { name: "windows-path", re: /[A-Za-z]:\\\\(?:Users|Windows)\\\\/ },
];

class StdioSession {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.messages = [];
    this.stdoutRaw = "";
    this.stderrRaw = "";
    this.violations = [];
    this.waiters = new Map();
    this.exited = false;
    this.exitInfo = null;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderrRaw += chunk;
    });
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      for (const [, waiter] of this.waiters) {
        waiter.reject(new Error(`server exited (code=${code}, signal=${signal})`));
      }
      this.waiters.clear();
    });
  }

  #violation(kind, detail) {
    this.violations.push({ kind, detail });
  }

  #onStdout(chunk) {
    this.stdoutRaw += chunk;
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim().length > 0) {
        this.#onLine(line);
      }
      index = this.buffer.indexOf("\n");
    }
  }

  #onLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      // INVARIANT 1. Anything unparseable on stdout is a corrupted session — a log
      // line, a banner, or a frame written in two pieces.
      this.#violation("stdout-not-json", `${err.message}: ${line.slice(0, 200)}`);
      return;
    }
    if (parsed === null || typeof parsed !== "object" || parsed.jsonrpc !== "2.0") {
      this.#violation("stdout-not-jsonrpc", line.slice(0, 200));
      return;
    }
    for (const pattern of LEAK_PATTERNS) {
      if (pattern.re.test(line)) {
        // INVARIANT 4.
        this.#violation(`leak:${pattern.name}`, line.slice(0, 300));
      }
    }
    this.messages.push(parsed);
    if (Object.prototype.hasOwnProperty.call(parsed, "id") && parsed.id !== null) {
      const waiter = this.waiters.get(parsed.id);
      if (waiter) {
        this.waiters.delete(parsed.id);
        waiter.resolve(parsed);
      }
    }
  }

  write(payload) {
    if (this.exited) {
      throw new Error("cannot write: server already exited");
    }
    this.child.stdin.write(payload);
  }

  request(message, timeoutMs = PROBE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(message.id);
        reject(new Error(`timeout waiting for id ${message.id}`));
      }, timeoutMs);
      this.waiters.set(message.id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.write(`${JSON.stringify(message)}\n`);
    });
  }

  responsesFor(id) {
    return this.messages.filter((m) => m.id === id);
  }
}

function spawnServer(cwd, serverEntry) {
  const env = { ...process.env };
  // Deny the server every credential source, so a corpus frame that slipped past
  // validation still cannot reach a real instance.
  for (const key of Object.keys(env)) {
    if (/^(SN_|SYNCRONA_|JIRA_)/.test(key)) {
      delete env[key];
    }
  }
  env.SYNCRONA_MCP_AUTO_PULL_ALL_SCOPES = "false";
  // The audit state dir is not a credential source. Keep it, so a test run that
  // isolates it does not have the server write markers into the real home.
  if (process.env.SYNCRONA_AUDIT_STATE_DIR) {
    env.SYNCRONA_AUDIT_STATE_DIR = process.env.SYNCRONA_AUDIT_STATE_DIR;
  }
  return spawn(process.execPath, [serverEntry], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
}

async function shutdown(session) {
  if (session.exited) {
    return;
  }
  session.child.stdin.end();
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      session.child.kill("SIGKILL");
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);
    session.child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Run the corpus against a freshly spawned server.
 *
 * @param {{serverEntry?: string, cwd?: string, only?: string}} [options]
 * @returns {Promise<{violations: Array, frames: Array, exitInfo: object|null, stderr: string}>}
 */
async function runStdioFuzz(options = {}) {
  const serverEntry = options.serverEntry || SERVER_ENTRY;
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`server entry not found: ${serverEntry} (run \`npm run build\` first)`);
  }
  const cwd = options.cwd || fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-stdio-fuzz-"));
  const ownsCwd = !options.cwd;
  const child = spawnServer(cwd, serverEntry);
  const session = new StdioSession(child);
  const frames = [];

  try {
    await session.request({
      jsonrpc: "2.0",
      id: PROBE_ID_BASE,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "stdio-fuzz", version: "1.0.0" },
      },
    });

    const corpus = buildCorpus().filter((f) => !options.only || f.name === options.only);
    let probeId = PROBE_ID_BASE + 1;
    // id → how many requests carried it. `tools/call` dispatch is genuinely async, so a
    // ping answered in between proves liveness but is NOT a barrier for the tool
    // response — the first version of this harness treated it as one and reported eight
    // healthy requests as unanswered. Response accounting is therefore settled once, at
    // the end, after an explicit drain.
    const sentCounts = new Map([[PROBE_ID_BASE, 1]]); // the initialize handshake above
    const expectedIds = [];

    for (const frame of corpus) {
      const before = session.messages.length;
      for (const frameId of idsIn(frame.raw)) {
        sentCounts.set(frameId, (sentCounts.get(frameId) || 0) + 1);
        if (frame.expectResponse) {
          expectedIds.push(frameId);
        }
      }
      session.write(frame.rawIsComplete ? frame.raw : `${frame.raw}\n`);

      let alive = true;
      let probeError = null;
      try {
        // INVARIANT 2, checked per frame so a wedge names its own cause. The probe also
        // acts as a barrier: the server has finished with the hostile frame by the time
        // it answers, so anything it emitted is already in `session.messages`.
        // eslint-disable-next-line no-await-in-loop
        await session.request({ jsonrpc: "2.0", id: probeId, method: "ping" });
      } catch (err) {
        alive = false;
        probeError = err.message;
      }
      sentCounts.set(probeId, (sentCounts.get(probeId) || 0) + 1);
      probeId += 1;

      if (!alive) {
        session.violations.push({ kind: "wedged-or-died", detail: `${frame.name}: ${probeError}` });
        frames.push({ name: frame.name, alive: false });
        break;
      }

      const emitted = session.messages.slice(before, session.messages.length - 1);

      if (frame.mustNotRespond && emitted.length > 0) {
        // INVARIANT 3: a notification has no id, so it has no response.
        session.violations.push({
          kind: "responded-to-notification",
          detail: `${frame.name}: ${JSON.stringify(emitted[0]).slice(0, 200)}`,
        });
      }

      frames.push({ name: frame.name, alive: true, emitted: emitted.length });
    }

    // INVARIANT 2, end-to-end: the server is not merely answering pings, it still does
    // real work after the whole corpus.
    sentCounts.set(probeId, (sentCounts.get(probeId) || 0) + 1);
    const listed = await session.request({ jsonrpc: "2.0", id: probeId, method: "tools/list", params: {} });
    if (!listed.result || !Array.isArray(listed.result.tools) || listed.result.tools.length === 0) {
      session.violations.push({ kind: "tools-list-degraded", detail: JSON.stringify(listed).slice(0, 200) });
    }

    // Drain: give every still-outstanding response a bounded window to arrive before
    // the accounting below calls it missing.
    const drainDeadline = Date.now() + PROBE_TIMEOUT_MS;
    while (
      Date.now() < drainDeadline &&
      expectedIds.some((expected) => session.responsesFor(expected).length === 0)
    ) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // INVARIANT 3, settled in one place: every request with an id is answered exactly
    // once, and nothing on the wire was never asked for.
    for (const expected of new Set(expectedIds)) {
      if (session.responsesFor(expected).length === 0) {
        session.violations.push({
          kind: "unanswered-request",
          detail: `id ${JSON.stringify(expected)} got no result and no error`,
        });
      }
    }
    const responseCounts = new Map();
    for (const message of session.messages) {
      if (!Object.prototype.hasOwnProperty.call(message, "id") || message.id === null) {
        continue;
      }
      responseCounts.set(message.id, (responseCounts.get(message.id) || 0) + 1);
    }
    for (const [answeredId, count] of responseCounts) {
      const sent = sentCounts.get(answeredId) || 0;
      if (sent === 0) {
        session.violations.push({
          kind: "unsolicited-id",
          detail: `response for never-sent id ${JSON.stringify(answeredId)}`,
        });
      } else if (count > sent) {
        session.violations.push({
          kind: "duplicate-response",
          detail: `id ${JSON.stringify(answeredId)} answered ${count} times for ${sent} request(s)`,
        });
      }
    }
    if (Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")) {
      session.violations.push({ kind: "prototype-polluted-in-harness", detail: "Object.prototype.polluted set" });
    }

    // Trailing bytes with no newline mean a frame was written in pieces and never closed.
    if (session.buffer.trim().length > 0) {
      session.violations.push({ kind: "unterminated-stdout-frame", detail: session.buffer.slice(0, 200) });
    }

    // INVARIANT 5, read from the server's own audit trail rather than from anything the
    // harness controls: an `ok: true` tool call is a tool that actually ran.
    for (const entry of readAuditEntries(cwd)) {
      if (entry.event === "tool.call" && entry.ok === true) {
        session.violations.push({
          kind: "corpus-executed-a-real-tool",
          detail: `${entry.tool} succeeded in ${entry.durationMs}ms — the corpus must stay non-executing`,
        });
      }
    }
  } finally {
    await shutdown(session);
    if (ownsCwd) {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }

  return {
    violations: session.violations,
    frames,
    messages: session.messages.length,
    exitInfo: session.exitInfo,
    stderr: session.stderrRaw,
    stdoutBytes: session.stdoutRaw.length,
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const verbose = argv.includes("--verbose");
  const onlyIndex = argv.indexOf("--frame");
  const only = onlyIndex !== -1 ? argv[onlyIndex + 1] : undefined;

  const report = await runStdioFuzz({ only });
  console.log(
    `frames=${report.frames.length} messages=${report.messages} stdout=${report.stdoutBytes}B ` +
      `violations=${report.violations.length}`
  );
  if (verbose) {
    for (const frame of report.frames) {
      console.log(`  ${frame.alive ? "ok  " : "DEAD"} ${frame.name} (emitted ${frame.emitted ?? 0})`);
    }
  }
  for (const violation of report.violations) {
    console.error(`VIOLATION ${violation.kind}: ${violation.detail}`);
  }
  return report.violations.length === 0 ? 0 : 1;
}

module.exports = { runStdioFuzz, runCli, buildCorpus, LEAK_PATTERNS, SERVER_ENTRY };

if (require.main === module) {
  runCli()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(2);
    });
}
