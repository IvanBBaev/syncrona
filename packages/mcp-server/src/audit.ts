// SPDX-License-Identifier: GPL-3.0-or-later
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "fs";
import { createHash, createHmac } from "crypto";
import { homedir } from "os";
import path from "path";
import { getStoreKey } from "@syncrona/credential-store";
import { logger } from "./logger";

const DEFAULT_AUDIT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_AUDIT_MAX_BACKUPS = 5;
// CONC-3 (REV-94): retention cap for `.corrupt.` quarantine files. Without a cap
// a crash-loop that keeps torn/interior-corrupt logs would leak `.corrupt.` files
// unbounded. We keep the newest K and prune the rest.
const DEFAULT_AUDIT_MAX_CORRUPT = 5;

// SEC-5 (REV-86): tamper-evident hash chain. Each record carries a monotonic `seq`
// and `prevHash` = keyed hash of the immediately preceding record line. The first
// record of a chain uses this genesis sentinel (64 hex chars, matching the digest
// width) so the integrity walk can recognise a legitimate chain start.
const GENESIS_PREV_HASH = "0".repeat(64);

// Delete the oldest size-rotated backups so the audit directory stays bounded.
// Rotation alone (rename to a timestamped file) would otherwise let backups
// accumulate forever. `.corrupt.` quarantine files are left untouched — they are
// forensic and rare.
function pruneRotatedAuditFiles(
  dir: string,
  base: string,
  ext: string,
  maxBackups: number
): void {
  try {
    const prefix = `${base}.`;
    const active = `${base}${ext}`;
    const rotated = readdirSync(dir)
      .filter(
        (name) =>
          name.startsWith(prefix) &&
          name.endsWith(ext) &&
          name !== active &&
          !name.includes(".corrupt.")
      )
      .map((name) => {
        const full = path.join(dir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(full).mtimeMs;
        } catch (_) {
          mtimeMs = 0;
        }
        return { full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const stale of rotated.slice(maxBackups)) {
      try {
        unlinkSync(stale.full);
      } catch (_) {
        // best-effort prune
      }
    }
  } catch (_) {
    // Cleanup is best-effort; never let it break an audit write.
  }
}

type AuditIntegrityResult = {
  ok: boolean;
  // `tampered` (SEC-5): hash-chain break, seq gap, or a file shorter/longer than the
  //   persisted high-water seq — an adversarial edit, not accidental corruption.
  // `recovered` (CONC-3): a torn trailing line was dropped and valid history kept.
  status: "missing" | "valid" | "recovered" | "tampered" | "quarantined" | "error";
  totalLines: number;
  malformedLines: number;
  quarantinedFile: string;
  reason?: string;
};

// SEC-5 (REV-86): derive the per-install HMAC key for the tamper-evident chain.
// SYNCRONA_STORE_KEY wins when present (unchanged historical behavior); otherwise the
// credential store's per-install secret keys the chain. Only when neither resolves do we
// fall back to a plain SHA-256 hash chain, which still detects truncation, reordering and
// interior deletion (a naive editor cannot silently drop or shuffle lines without leaving
// a seq gap or high-water mismatch).
//
// REV-127 (honest-limits): the strength of the keyed chain depends on WHICH store key
// backs it. A random OS-keychain secret an attacker cannot read gives real forgery
// resistance. But getStoreKey() may return the MACHINE-derived key, computed from
// public-ish inputs (hostname / username) — an attacker who knows those can recompute it
// and forge the whole downstream chain plus the high-water marker. So the chain is only
// as forgery-resistant as its key is secret: strong under SYNCRONA_STORE_KEY or a random
// keychain secret, weak (tamper-evident against naive edits only) under the recomputable
// machine key. Set SYNCRONA_STORE_KEY (or provision a random keychain secret) for a
// threat model that includes a local attacker.
let cachedChainKey: Buffer | null | undefined;

function auditChainKey(): Buffer | null {
  if (cachedChainKey !== undefined) {
    return cachedChainKey;
  }
  // Prefer an explicit env key (unchanged historical behavior).
  const raw = process.env.SYNCRONA_STORE_KEY;
  if (raw && raw.trim()) {
    cachedChainKey = createHash("sha256")
      .update(`syncrona-audit-integrity:${raw}`)
      .digest();
    return cachedChainKey;
  }
  // SEC-5 follow-up (REV-120): on a default install SYNCRONA_STORE_KEY is unset, but the
  // credential store still resolves a real per-install secret (a random OS-keychain key,
  // or the machine-derived key). Derive the chain HMAC key from it so the chain is keyed
  // even without SYNCRONA_STORE_KEY. Forgery resistance then holds only against an
  // attacker who cannot reconstruct that key (see the REV-127 note above: the machine key
  // is recomputable). Fall back to an unkeyed chain only if no key resolves.
  try {
    const storeKey = getStoreKey();
    cachedChainKey = createHash("sha256")
      .update("syncrona-audit-integrity:")
      .update(storeKey)
      .digest();
  } catch {
    cachedChainKey = null;
  }
  return cachedChainKey;
}

// Test-only: drop the memoized chain key so a test can toggle SYNCRONA_STORE_KEY.
export function __resetAuditChainKeyForTests(): void {
  cachedChainKey = undefined;
}

function hashAuditLine(line: string): string {
  const key = auditChainKey();
  if (key) {
    return createHmac("sha256", key).update(line).digest("hex");
  }
  return createHash("sha256").update(line).digest("hex");
}

// The high-water marker is the truncation tripwire. It is persisted OUTSIDE the audit
// directory (in a per-user state dir keyed by the audit file's absolute path) so it
// never appears as an entry when the audit dir is enumerated, and so rotation/prune of the
// log cannot disturb it. It survives process restarts; if it is absent (first run, or the
// state dir was cleared) tail-truncation across that gap is not detectable, but reordering
// / interior deletion / forgery still are via the in-file seq+hash chain. This is the
// documented reduced guarantee.
// `prefix` (REV-191) is the number of UNCHAINED ("legacy") lines that precede the first
// chained record. It is fixed at the moment the chain starts and can never legitimately
// change afterwards, so a later increase is proof that lines were spliced in ahead of the
// chain. Optional so markers written by an earlier version stay readable.
type HighWater = { seq: number; hash?: string; prefix?: number };

/**
 * SEC-5 follow-up (REV-143): the marker used to live under `os.tmpdir()`. On Linux that
 * is the WORLD-WRITABLE /tmp, at a path any local user can compute (it is just a hash of
 * the audit file's absolute path), so an attacker could (a) pre-plant a symlink there and
 * have us clobber a file of their choosing with our JSON, and (b) pre-plant a bogus marker
 * — or simply keep re-creating one with seq 0 — to disable the truncation tripwire, which
 * is the one control that survives a whole-log deletion. Both defeats are silent because
 * every failure was swallowed. The marker now lives in a per-user state directory
 * (0700), matching the credential store's `~/.syncrona` convention.
 */
function auditStateDir(): string {
  const override = process.env.SYNCRONA_AUDIT_STATE_DIR;
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  const xdgState = process.env.XDG_STATE_HOME;
  if (xdgState && xdgState.trim()) {
    return path.join(path.resolve(xdgState.trim()), "syncrona", "audit-integrity");
  }
  return path.join(homedir(), ".syncrona", "audit-integrity");
}

function highWaterPath(auditFile: string): string {
  const id = createHash("sha256").update(path.resolve(auditFile)).digest("hex").slice(0, 40);
  return path.join(auditStateDir(), `${id}.json`);
}

/** True when `target` exists and is anything other than a regular file (symlink, dir, …). */
function isNonRegularFile(target: string): boolean {
  try {
    return !lstatSync(target).isFile();
  } catch (_) {
    return false; // absent: nothing to refuse
  }
}

/** True when `target` itself is a symbolic link (never follows it). */
function isSymlinkPath(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch (_) {
    return false; // absent: nothing to refuse
  }
}

function readHighWater(auditFile: string): HighWater | null {
  try {
    const p = highWaterPath(auditFile);
    if (!existsSync(p) || isNonRegularFile(p)) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    if (parsed && typeof parsed.seq === "number") {
      return {
        seq: parsed.seq,
        hash: typeof parsed.hash === "string" ? parsed.hash : undefined,
        prefix: typeof parsed.prefix === "number" ? parsed.prefix : undefined,
      };
    }
    return null;
  } catch (_) {
    return null;
  }
}

function writeHighWater(auditFile: string, hw: HighWater): void {
  try {
    const p = highWaterPath(auditFile);
    mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    // SEC-5 follow-up (REV-143): writeFileSync FOLLOWS symlinks, so a pre-planted link at
    // the marker path redirected our write onto the target. Refuse anything that is not a
    // plain regular file.
    if (isNonRegularFile(p)) {
      throw new Error(`refusing to write audit high-water through a non-regular file: ${p}`);
    }
    writeFileSync(p, JSON.stringify(hw), "utf-8");
  } catch (error) {
    // SEC-5 follow-up (REV-143): the old handler was empty, so a marker that could not be
    // written — including one refused as a planted symlink — disabled the truncation
    // tripwire with no trace anywhere. Still non-fatal (a missing marker must never block
    // an audit write), but no longer invisible.
    logger.warn("audit.high_water_write_failed", {
      auditFile,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function resetHighWater(auditFile: string): void {
  try {
    const p = highWaterPath(auditFile);
    if (existsSync(p)) {
      unlinkSync(p);
    }
  } catch (_) {
    // best-effort
  }
}

// CONC-8 (REV-146): the chain append is a read-modify-write — read the tail (readChainTail),
// derive seq/prevHash from it, append, then update the high-water. Nothing serialised it, so
// two writers (two MCP server processes on the same workspace, or the health server and the
// tool dispatcher) could interleave between the read and the append and BOTH emit the same
// seq with the same prevHash. That is unrecoverable: the log then permanently reads as
// `tampered` ("sequence gap"), which destroys the forensic value of every later record. The
// rotation branch had the same race — two writers could both rename, and the second rename
// would drop the first's freshly created file. An O_EXCL lockfile next to the audit file
// serialises the whole critical section across processes.
const AUDIT_LOCK_STALE_MS = 10_000;
const AUDIT_LOCK_RETRY_MS = 2;
const AUDIT_LOCK_MAX_WAIT_MS = 500;

function sleepSyncMs(ms: number): void {
  // writeAuditEvent is synchronous end to end, so the wait has to be too.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireAuditLock(auditFile: string): string | null {
  const lockPath = `${auditFile}.lock`;
  const deadline = Date.now() + AUDIT_LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      // "wx" is O_CREAT|O_EXCL: it fails if anything already exists at the path, and it
      // never follows a symlink, so the lock doubles as a plant-resistant handshake.
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return lockPath;
    } catch (_) {
      // A writer that crashed mid-section would otherwise wedge every later write, so an
      // old lock is reclaimed rather than waited on.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > AUDIT_LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (_) {
        // The lock vanished between the two calls; retry immediately.
      }
      if (Date.now() >= deadline) {
        // Losing the lock must never lose the record: fall through unlocked (the pre-fix
        // behavior) rather than dropping an audit entry.
        return null;
      }
      sleepSyncMs(AUDIT_LOCK_RETRY_MS);
    }
  }
}

function releaseAuditLock(lockPath: string | null): void {
  if (!lockPath) {
    return;
  }
  try {
    unlinkSync(lockPath);
  } catch (_) {
    // best-effort
  }
}

/** True for a line that carries the chain fields (`seq` + `prevHash`). */
function isChainedLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return (
      !!parsed && typeof parsed.seq === "number" && typeof parsed.prevHash === "string"
    );
  } catch (_) {
    return false;
  }
}

/** Number of leading UNCHAINED lines — the legacy prefix the chain walk tolerates. */
function countLegacyPrefix(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    if (isChainedLine(line)) {
      break;
    }
    count += 1;
  }
  return count;
}

// Read the last CHAINED line of the active log so a new record can extend the chain.
// `link` is null when the file is absent/empty or its last line is legacy (no seq/prevHash)
// or unparseable — in which case a fresh chain is started (seq 1, genesis prevHash). This
// reads the authoritative file rather than the volatile high-water marker so a cleared
// marker can never cause a duplicate-seq false positive. `prefix` is reported from the same
// read so the caller never has to walk the file twice (REV-191).
function readChainTail(auditFile: string): {
  link: { seq: number; hashOfLine: string } | null;
  prefix: number;
} {
  try {
    if (!existsSync(auditFile)) {
      return { link: null, prefix: 0 };
    }
    const lines = readFileSync(auditFile, "utf-8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) {
      return { link: null, prefix: 0 };
    }
    const prefix = countLegacyPrefix(lines);
    const last = lines[lines.length - 1];
    const parsed = JSON.parse(last) as Record<string, unknown>;
    if (parsed && typeof parsed.seq === "number" && typeof parsed.prevHash === "string") {
      return { link: { seq: parsed.seq, hashOfLine: hashAuditLine(last) }, prefix };
    }
    return { link: null, prefix };
  } catch (_) {
    return { link: null, prefix: 0 };
  }
}

// SEC-6 (REV-87): decide whether a failed write belongs to a MUTATING tool. Mutating
// records must fail loudly (logger.error), read-only/lifecycle records stay tolerant
// (logger.debug). `auditToolCall` sets an explicit `mutating` flag; `auditMutatingTool`
// emits a tool record with no `event` field and is mutating by construction.
function isMutatingAuditRecord(entry: Record<string, unknown>): boolean {
  if (entry.mutating === true) {
    return true;
  }
  if (entry.mutating === false) {
    return false;
  }
  return typeof entry.event === "undefined" && typeof entry.tool === "string";
}

export type AuditWriteResult = { ok: boolean; mutating: boolean; error?: string };

// SEC-8 (REV-96): broaden the key allow-list. The old `/(^|[_-])key($|[_-])/` required a
// separator, so camelCase creds (`apiKey`, `privateKey`, `signingKey`, `clientKey`) slipped
// through unredacted. We drop the separator and add explicit credential-ish tokens.
function isSensitiveAuditKey(key: string): boolean {
  const normalized = key.toLowerCase();
  const patterns = [
    /password/,
    /passwd/,
    /pwd/,
    /token/,
    /authorization/,
    /(^|[^a-z])auth([^a-z]|$)/,
    /secret/,
    /api[_-]?key/,
    /key/,
    /credential/,
    /jwt/,
    /assertion/,
    /bearer/,
    /cert/,
    /cookie/,
    /session/,
    /(^|[^a-z])sid([^a-z]|$)/,
    /passphrase/,
    /(^|[^a-z])otp([^a-z]|$)/,
    /(^|[^a-z])mfa([^a-z]|$)/,
    /(^|[^a-z])pin([^a-z]|$)/,
    /nonce/,
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

// SEC-8 (REV-96): inspect VALUES, not just keys. A secret smuggled under a benign key
// (a connection string with `user:pass@host`, a JWT, a PEM private key, an inline
// `Authorization` value, an AWS access key id) must still be redacted.
//
// SEC-8 follow-up (REV-126): the original six patterns missed the most common
// vendor-prefixed API-key / token formats and raw high-entropy secrets. Each added
// pattern is anchored on a vendor-assigned prefix (or a full 256-bit hex blob), which
// keeps precision high — ordinary forensic values (URLs, table paths, prose, 32-char
// sys_ids, 40-char git SHAs) do not match — while closing the gap.
// SEC-8 follow-up (REV-147): the inline-Authorization pattern was the scheme keyword plus
// 8 characters of a charset that contains every letter, so ordinary PROSE matched — "Basic
// authentication failed for user admin" was classified as a secret and, because a match
// redacts the WHOLE value, the entire message became "<redacted>". That silently destroys
// the forensic detail of exactly the auth-failure records an operator needs. The keyword
// alone is not evidence: either the value carries the header/assignment context, or the
// token itself has to look like credential material (base64/hex carries digits or base64
// symbols; an English word following "Basic" carries neither).
//
// Honest limit: a digit-free, symbol-free base64 token in bare prose is not caught by the
// second form. The header-context form, the sensitive-key allow-list and the JWT pattern
// cover the realistic carriers, and widening this one back out costs more (whole-value
// redaction of benign prose) than it buys.
const AUTH_HEADER_SECRET =
  /\bauthorization["']?\s*[:=]\s*["']?\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i;
const AUTH_SCHEME_TOKEN = /\b(?:bearer|basic)\s+([A-Za-z0-9._~+/=-]{12,})/i;

// SEC-8 follow-up (REV-190): the same whole-value over-redaction hit the bare
// `user:pass@host` form, which accepted ANY `[\w.-]+` as the host. Ordinary forensic values
// shaped `name:value@thing` therefore matched — a package spec ("npm:lodash@4.17.21
// installed") or a record reference ("incident:INC0010001@dev12345 failed") was classified
// as a credential and the whole message was replaced with "<redacted>", losing exactly the
// detail an operator needs. Require the host to actually look like a host: an FQDN with an
// alphabetic TLD, `localhost`, or a dotted-quad IPv4.
//
// Honest limit: credentials against a single-label internal hostname (`admin:pw@snprod`)
// are no longer caught by THIS form. The `scheme://user:pass@host` pattern below, the
// sensitive-key allow-list and the vendor-token patterns cover the realistic carriers, and
// widening it back out costs whole-value redaction of benign prose.
const BARE_USERPASS_HOST =
  /(^|\s)[\w.-]+:[^\s:@/]+@(?:(?:[\w-]+\.)+[A-Za-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})\b/i;

function looksLikeInlineAuthorization(value: string): boolean {
  if (AUTH_HEADER_SECRET.test(value)) {
    return true;
  }
  const match = AUTH_SCHEME_TOKEN.exec(value);
  return match ? /[0-9]/.test(match[1]) || /[+/=]/.test(match[1]) : false;
}

// SEC-8 follow-up (REV-145): the length guard used to `return false` for anything over the
// budget — a plain fail-OPEN. Padding a secret past 8 KB (trivial for a model-supplied
// argument, a pasted PEM bundle or a verbose remote error body) was all it took to get it
// written to the audit log in cleartext. The budget exists to bound regex work, not to
// whitelist large strings, so a value that cannot be scanned in full is now redacted
// instead of trusted.
const SECRET_SCAN_BUDGET = 8192;

function looksLikeSecretValue(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  if (value.length > SECRET_SCAN_BUDGET) {
    return true;
  }
  return (
    /\/\/[^/\s:@]+:[^/\s:@]+@/.test(value) || // scheme://user:pass@host
    BARE_USERPASS_HOST.test(value) || // user:pass@host (REV-190)
    /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/.test(value) || // JWT (embedded)
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) || // PEM private key
    looksLikeInlineAuthorization(value) || // inline Authorization
    /\bAKIA[0-9A-Z]{16}\b/.test(value) || // AWS access key id
    // REV-126: vendor-prefixed API keys / tokens (Stripe, OpenAI, GitHub, Slack,
    // GitLab, Google). Each prefix is a high-signal marker, so a broad trailing
    // charset does not over-match ordinary text.
    /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/i.test(value) || // Stripe-style
    /\bsk-[A-Za-z0-9]{20,}/.test(value) || // OpenAI-style
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/.test(value) || // GitHub token
    /\bgithub_pat_[A-Za-z0-9_]{20,}/.test(value) || // GitHub fine-grained PAT
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/.test(value) || // Slack token
    /\bglpat-[A-Za-z0-9_-]{16,}/.test(value) || // GitLab PAT
    /\bAIza[A-Za-z0-9_-]{20,}/.test(value) || // Google API key
    /\baws_?secret_?access_?key\b/i.test(value) || // labelled AWS secret key
    /\b[A-Fa-f0-9]{64}\b/.test(value) // raw 256-bit hex secret / key material
  );
}

export function sanitizeForAudit(value: unknown): unknown {
  // SEC-8 follow-up (REV-123): a BARE string (not an object property) reaches here when
  // a raw error message is audited directly. It must be inspected too, else a
  // secret-shaped error string is logged in cleartext.
  if (typeof value === "string") {
    return looksLikeSecretValue(value) ? "<redacted>" : value;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeForAudit);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isSensitiveAuditKey(k)) {
      out[k] = "<redacted>";
    } else if (k.toLowerCase() === "script" && typeof v === "string") {
      out[k] = `<script:${v.length} chars>`;
    } else if (typeof v === "string" && looksLikeSecretValue(v)) {
      out[k] = "<redacted>";
    } else {
      out[k] = sanitizeForAudit(v);
    }
  }
  return out;
}

export function writeAuditEvent(
  auditDir: string,
  auditFile: string,
  entry: Record<string, unknown>,
  maxBytes = DEFAULT_AUDIT_MAX_BYTES,
  maxBackups = DEFAULT_AUDIT_MAX_BACKUPS
): AuditWriteResult {
  const mutating = isMutatingAuditRecord(entry);
  try {
    if (!existsSync(auditDir)) {
      mkdirSync(auditDir, { recursive: true });
    }

    // SEC-6 follow-up (REV-121): the final-component symlink check below is not enough —
    // a symlinked audit DIRECTORY (pre-planted `.syncrona-mcp` -> attacker dir) would be
    // followed silently. Refuse when the audit dir itself is a symlink. (Portable; no
    // O_NOFOLLOW needed.)
    //
    // REV-128 (honest-limits): this checks only the audit dir (final component) and,
    // below, the audit file — NOT every ANCESTOR of the path. A symlinked ANCESTOR
    // directory higher up (e.g. the project root) is not resolved here. We do not fully
    // realpath the ancestor chain on purpose: PROJECT_DIR is process.cwd(), which the OS
    // already resolves through symlinks at capture, and a strict realpath guard would
    // reject legitimately symlinked working roots (macOS /var -> /private/var, a symlinked
    // temp dir) and our own tests. The guarantee here is therefore: the audit dir and file
    // are not themselves attacker-planted symlinks — not that no ancestor is.
    let dirStat: ReturnType<typeof lstatSync> | null = null;
    try {
      dirStat = lstatSync(auditDir);
    } catch (_) {
      dirStat = null;
    }
    if (dirStat && dirStat.isSymbolicLink()) {
      throw new Error(`refusing to write audit through a symlinked directory: ${auditDir}`);
    }

    // CONC-8 (REV-146): everything below is the critical section — the rotation decision,
    // the chain-tail read, the append and the high-water update must be one indivisible
    // step, or two concurrent writers duplicate a seq (permanently `tampered`) or drop one
    // another's rotated file.
    const lockPath = acquireAuditLock(auditFile);
    try {
      // SEC-6 (REV-87): never follow a symlink. An attacker who pre-plants `audit.log` as a
      // symlink (e.g. -> /dev/null) must not silently redirect the audit stream. lstat the
      // final component and refuse if it is a link. (There is a small TOCTOU window between
      // lstat and append; O_NOFOLLOW would close it but is not portable, so we refuse here.)
      let stat: ReturnType<typeof lstatSync> | null = null;
      try {
        stat = lstatSync(auditFile);
      } catch (_) {
        stat = null;
      }
      if (stat && stat.isSymbolicLink()) {
        throw new Error(`refusing to write audit through a symlink: ${auditFile}`);
      }

      let rotated = false;
      if (stat && stat.isFile() && stat.size >= maxBytes) {
        const dir = path.dirname(auditFile);
        const ext = path.extname(auditFile);
        const base = path.basename(auditFile, ext);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        let rotatedPath = path.join(dir, `${base}.${stamp}${ext}`);
        let suffix = 0;
        while (existsSync(rotatedPath)) {
          suffix += 1;
          rotatedPath = path.join(dir, `${base}.${stamp}.${suffix}${ext}`);
        }
        renameSync(auditFile, rotatedPath);
        pruneRotatedAuditFiles(dir, base, ext, maxBackups);
        // Fresh active file: reset the high-water so a failed append below cannot leave a
        // stale marker that would later be misread as truncation.
        resetHighWater(auditFile);
        rotated = true;
      }

      // SEC-5 (REV-86): extend the tamper-evident chain. `seq` is monotonic within the
      // active file; `prevHash` links to the previous line's keyed hash (or genesis when a
      // new chain begins on an empty/rotated/legacy-tailed file).
      const tail = rotated ? { link: null, prefix: 0 } : readChainTail(auditFile);
      const prev = tail.link;
      // SEC-5 follow-up (REV-142): the seq used to be derived from the FILE alone, so an
      // attacker who deleted (or truncated) the log got a chain restarting at seq 1 and a
      // high-water marker overwritten with that 1 — the erasure erased its own evidence
      // too, and the next integrity check reported a clean log. The out-of-band marker is
      // authoritative for "how far this chain has already got": never move backwards from
      // it. Continuing at hw.seq + 1 over an emptied file leaves a chain that does not
      // start at genesis, which is precisely the durable evidence the tripwire owes us.
      // Legitimate fresh starts (rotation, quarantine) reset the marker explicitly.
      const hw = rotated ? null : readHighWater(auditFile);
      const seq = Math.max(prev ? prev.seq : 0, hw ? hw.seq : 0) + 1;
      const prevHash = prev ? prev.hashOfLine : GENESIS_PREV_HASH;
      const record = { ...entry, seq, prevHash };
      const line = JSON.stringify(record);

      appendFileSync(auditFile, `${line}\n`, "utf-8");
      // SEC-5 follow-up (REV-191): the chain walk tolerates a legacy prefix for backward
      // compatibility, so an attacker could PREPEND forged unchained records ("approved by
      // admin") to an intact chain and the integrity check still reported `valid` — nothing
      // pinned how long that prefix is allowed to be. Pin it in the marker at the moment the
      // chain starts and never move it afterwards, so a later splice is detectable even
      // though the forged lines carry no chain fields of their own.
      const prefix = hw && typeof hw.prefix === "number" ? hw.prefix : tail.prefix;
      writeHighWater(auditFile, { seq, hash: hashAuditLine(line), prefix });
    } finally {
      releaseAuditLock(lockPath);
    }
    return { ok: true, mutating };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // SEC-6 (REV-87): fail-closed for mutating tools — surface the failure loudly instead
    // of the old blanket `logger.debug`. Read-only / lifecycle records stay tolerant so
    // accidental corruption never breaks core flows.
    if (mutating) {
      logger.error("audit.write_failed", { auditFile, error: message });
    } else {
      logger.debug("audit.write_failed", { auditFile, error: message });
    }
    return { ok: false, mutating, error: message };
  }
}

function toCorruptAuditPath(auditFile: string): string {
  const dir = path.dirname(auditFile);
  const ext = path.extname(auditFile);
  const base = path.basename(auditFile, ext);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let candidate = path.join(dir, `${base}.corrupt.${stamp}${ext}`);
  let suffix = 0;
  while (existsSync(candidate)) {
    suffix += 1;
    candidate = path.join(dir, `${base}.corrupt.${stamp}.${suffix}${ext}`);
  }
  return candidate;
}

// CONC-3 (REV-94): prune old `.corrupt.` quarantine files so a crash-loop that keeps
// producing torn/interior-corrupt logs cannot leak them unbounded. Keeps the newest
// `maxCorrupt` (the just-created one is always newest, so it is never the pruned one) and
// deletes the rest. Best-effort — never let cleanup break the integrity check.
function pruneCorruptAuditFiles(
  dir: string,
  base: string,
  ext: string,
  maxCorrupt: number
): void {
  try {
    const prefix = `${base}.corrupt.`;
    const corrupt = readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(ext))
      .map((name) => {
        const full = path.join(dir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(full).mtimeMs;
        } catch (_) {
          mtimeMs = 0;
        }
        return { full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const stale of corrupt.slice(Math.max(maxCorrupt, 0))) {
      try {
        unlinkSync(stale.full);
      } catch (_) {
        // best-effort prune
      }
    }
  } catch (_) {
    // Cleanup is best-effort; never let it break the integrity check.
  }
}

// SEC-5 (REV-86): walk the tamper-evident chain. Legacy lines (no seq/prevHash) that
// precede the first chained record are tolerated for backward compatibility, and a
// fully-legacy log is considered valid (returns null). Once the chain starts it must begin
// at genesis (seq 1, genesis prevHash) and every subsequent line must be chained, carry the
// expected monotonic seq, and reference the keyed hash of the preceding line. The persisted
// high-water marker is the truncation tripwire. Returns the first violation reason, or null
// when the chain is intact. NOTE: the guarantee assumes SYNCRONA_STORE_KEY presence is
// stable across writes and this check — a key that appears/disappears between the two
// changes every recomputed hash and would read as a chain break.
function validateAuditChain(lines: string[], auditFile: string): string | null {
  let started = false;
  let expectedSeq = 0;
  let prevLineHash = GENESIS_PREV_HASH;
  let legacyPrefix = 0;

  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch (_) {
      // Callers only pass JSON-valid lines here; a surprise parse failure is a break.
      return "unparseable line inside chain";
    }
    const hasChain =
      typeof parsed.seq === "number" && typeof parsed.prevHash === "string";

    if (!started) {
      if (!hasChain) {
        legacyPrefix += 1;
        continue; // tolerate a legacy prefix (bounded by the marker — REV-191)
      }
      started = true;
      if (parsed.prevHash !== GENESIS_PREV_HASH || parsed.seq !== 1) {
        return "chain does not start at genesis";
      }
      expectedSeq = 1;
      prevLineHash = hashAuditLine(line);
    } else {
      if (!hasChain) {
        return "legacy line inside chain";
      }
      expectedSeq += 1;
      if (parsed.seq !== expectedSeq) {
        return "sequence gap";
      }
      if (parsed.prevHash !== prevLineHash) {
        return "hash-chain break";
      }
      prevLineHash = hashAuditLine(line);
    }
  }

  // Truncation tripwire: the high-water records the seq (and hash) of the last line written
  // in a previous session. A last chained seq BELOW the high-water means complete lines were
  // removed after the fact; an in-place edit of the last line is caught by the hash compare
  // at equal seq. More lines than the high-water is a legitimate append (the marker is
  // best-effort) and is not flagged.
  const hw = readHighWater(auditFile);

  if (!started) {
    // SEC-5 follow-up (REV-142): this used to `return null` BEFORE the marker was read, so
    // the two cheapest attacks on the chain — empty the log, or overwrite it with
    // legacy-shaped JSON that carries no seq/prevHash — both reported `valid`. The whole
    // point of an OUT-OF-BAND marker is that it survives destruction of the file, so it has
    // to be consulted exactly when the file has nothing left to say. A genuinely legacy log
    // (pre-REV-86 install, no marker ever written) still validates.
    if (hw && hw.seq >= 1) {
      return "chain erased below high-water seq";
    }
    return null; // fully-legacy log: nothing to verify
  }

  if (hw) {
    if (expectedSeq < hw.seq) {
      return "truncated below high-water seq";
    }
    if (expectedSeq === hw.seq && hw.hash && prevLineHash !== hw.hash) {
      return "last line altered in place";
    }
    // SEC-5 follow-up (REV-191): the tolerated legacy prefix was unbounded, so unchained
    // lines spliced in AHEAD of the chain (which the walk skips by design) left no trace at
    // all. The prefix is pinned when the chain starts and nothing legitimate ever changes
    // it, so any difference is an insertion or a deletion in that region.
    if (typeof hw.prefix === "number" && legacyPrefix !== hw.prefix) {
      return "legacy prefix line count changed";
    }
  }
  return null;
}

export function checkAuditLogIntegrity(
  auditDir: string,
  auditFile: string,
  maxCorrupt = DEFAULT_AUDIT_MAX_CORRUPT
): AuditIntegrityResult {
  try {
    if (!existsSync(auditDir)) {
      mkdirSync(auditDir, { recursive: true });
    }

    // SEC-6 follow-up (REV-144): the WRITE path refuses a symlinked audit dir/file, but this
    // path had no guard at all — and it does far more than read: the torn-tail branch
    // `writeFileSync`s the audit file and the quarantine branch `renameSync`s it. Both
    // follow symlinks, so a pre-planted `audit.log -> /victim/file` had this check
    // truncate-and-rewrite (or rename away) an arbitrary file the process can reach, at
    // server startup, before any tool ran. Refuse instead of operating on the link.
    if (isSymlinkPath(auditDir) || isSymlinkPath(auditFile)) {
      logger.warn("audit.integrity_symlink_refused", { auditDir, auditFile });
      return {
        ok: false,
        status: "error",
        totalLines: 0,
        malformedLines: 0,
        quarantinedFile: "",
        reason: "audit path is a symlink",
      };
    }

    if (!existsSync(auditFile)) {
      // SEC-5 follow-up (REV-142): "missing" was reported as ok WITHOUT ever consulting the
      // high-water marker. Deleting the entire log is the most obvious tamper there is, and
      // it was the single case this check waved through — while the next writeAuditEvent
      // quietly restarted the chain at seq 1 and overwrote the marker, destroying the last
      // evidence. index.ts surfaces this status at startup, so it has to be honest.
      const hw = readHighWater(auditFile);
      if (hw && hw.seq >= 1) {
        return {
          ok: false,
          status: "tampered",
          totalLines: 0,
          malformedLines: 0,
          quarantinedFile: "",
          reason: "audit log deleted below high-water seq",
        };
      }
      return {
        ok: true,
        status: "missing",
        totalLines: 0,
        malformedLines: 0,
        quarantinedFile: "",
      };
    }

    const raw = readFileSync(auditFile, "utf-8");
    let lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const malformedIndices: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      try {
        JSON.parse(lines[i]);
      } catch (_) {
        malformedIndices.push(i);
      }
    }
    const malformedLines = malformedIndices.length;
    const originalTotal = lines.length;

    let recovered = false;
    if (malformedLines > 0) {
      // CONC-3 (REV-94): a lone malformed line that is the physical LAST line AND was never
      // terminated with a newline is a torn tail (a crash mid-append). Drop just that line and
      // keep the valid history instead of quarantining the whole log. The missing terminator
      // is what distinguishes a genuinely interrupted write from a complete-but-garbage line:
      // a fully written line ends in "\n" (and would normally parse), so a newline-terminated
      // malformed line is treated as corruption and quarantined. Interior corruption or
      // multiple malformed lines also quarantine — we cannot tell which side is trustworthy.
      const rawEndsWithNewline = raw.endsWith("\n") || raw.endsWith("\r");
      const tornTail =
        malformedLines === 1 &&
        malformedIndices[0] === lines.length - 1 &&
        !rawEndsWithNewline;
      if (tornTail) {
        lines = lines.slice(0, -1);
        try {
          writeFileSync(
            auditFile,
            lines.length > 0 ? `${lines.join("\n")}\n` : "",
            "utf-8"
          );
          recovered = true;
        } catch (error) {
          logger.debug("audit.torn_tail_rewrite_failed", {
            auditFile,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (!recovered) {
        const dir = path.dirname(auditFile);
        const ext = path.extname(auditFile);
        const base = path.basename(auditFile, ext);
        const quarantinedFile = toCorruptAuditPath(auditFile);
        renameSync(auditFile, quarantinedFile);
        pruneCorruptAuditFiles(dir, base, ext, maxCorrupt);
        // SEC-5 follow-up (REV-142): quarantine is a LEGITIMATE fresh start, exactly like
        // rotation — the old chain moved to the `.corrupt.` file. Now that writeAuditEvent
        // refuses to move backwards from the marker, the marker has to be cleared here too,
        // otherwise the replacement log would open at hw.seq + 1 and read as tampered
        // forever.
        resetHighWater(auditFile);
        writeAuditEvent(auditDir, auditFile, {
          timestamp: new Date().toISOString(),
          event: "audit.integrity.recovered",
          malformedLines,
          totalLines: originalTotal,
          quarantinedFile,
        });

        return {
          ok: false,
          status: "quarantined",
          totalLines: originalTotal,
          malformedLines,
          quarantinedFile,
        };
      }
    }

    // SEC-5 (REV-86): verify the tamper-evident chain over the (possibly tail-recovered)
    // lines. A broken chain, a seq gap, or a truncation below the high-water is an
    // adversarial edit rather than accidental corruption.
    const chainReason = validateAuditChain(lines, auditFile);
    if (chainReason) {
      return {
        ok: false,
        status: "tampered",
        totalLines: lines.length,
        malformedLines,
        quarantinedFile: "",
        reason: chainReason,
      };
    }

    if (recovered) {
      return {
        ok: true,
        status: "recovered",
        totalLines: lines.length,
        malformedLines,
        quarantinedFile: "",
        reason: "dropped torn trailing line",
      };
    }

    return {
      ok: true,
      status: "valid",
      totalLines: lines.length,
      malformedLines: 0,
      quarantinedFile: "",
    };
  } catch (error) {
    logger.debug("audit.integrity_check_failed", {
      auditFile,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      status: "error",
      totalLines: 0,
      malformedLines: 0,
      quarantinedFile: "",
    };
  }
}
