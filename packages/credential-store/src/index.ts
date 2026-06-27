// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * @syncro-now-ai/credential-store
 *
 * Single source of truth for SyncroNow AI's at-rest credential storage. Both the
 * core CLI (async API) and the MCP server (sync API) consume this package so
 * the crypto format, key derivation, file naming, and on-disk layout never
 * diverge between the two processes.
 *
 * Security note: the encryption key is resolved by `getStoreKey()` (AR2/D5) with
 * the precedence SYNCRONA_STORE_KEY (explicit, for CI / secrets managers) > OS
 * keychain (DEFAULT backend; needs the optional @napi-rs/keyring, opt out with
 * SYNCRONA_USE_KEYCHAIN=0) > the legacy machine-derived key. When the keychain
 * or @napi-rs/keyring is unavailable the resolver falls back to the
 * machine-derived key automatically, and reads retry with it so stores written
 * before D5 keep decrypting. The machine-derived key is only obfuscation-grade —
 * anyone able to run as the same user on the same host can decrypt files written
 * with it; the keychain (now default) or an explicit key gives real at-rest
 * protection. See the core README "Credential storage security" section.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "crypto";
import { existsSync, promises as fsp, readFileSync } from "fs";
import os from "os";
import path from "path";

export type StoredCredentials = {
  instance: string;
  user: string;
  password: string;
};

type GlobalConfig = {
  activeInstance?: string;
};

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const STORE_SALT = "syncrona-credential-store-v1";

export function getSyncronaDir(): string {
  return path.join(os.homedir(), ".syncrona");
}

function getCredentialsDir(): string {
  return path.join(getSyncronaDir(), "credentials");
}

function getConfigFile(): string {
  return path.join(getSyncronaDir(), "config.json");
}

export function instanceToFilename(instance: string): string {
  return instance.replace(/[^a-zA-Z0-9.-]/g, "_") + ".enc";
}

export function filenameToInstance(filename: string): string {
  return filename.replace(/\.enc$/, "");
}

function credentialFilePath(instance: string): string {
  return path.join(getCredentialsDir(), instanceToFilename(instance));
}

export function getMachineKey(): Buffer {
  let userName = "";
  try {
    userName = os.userInfo().username;
  } catch {
    userName = "";
  }
  const machineId = `${os.hostname()}:${userName}:${STORE_SALT}`;
  return scryptSync(machineId, STORE_SALT, KEY_LENGTH);
}

/* ----------------------------------------------------------------------------
 * At-rest key resolution (AR2 + D5)
 *
 * The file-encryption key is resolved with this precedence:
 *   1. SYNCRONA_STORE_KEY  — an explicit 32-byte key (64 hex chars or base64),
 *      for CI and secrets managers.
 *   2. OS keychain         — a random 256-bit master key kept in the OS keychain.
 *      DEFAULT backend (D5); needs the optional @napi-rs/keyring. Opt out with
 *      SYNCRONA_USE_KEYCHAIN=0 (e.g. headless CI with no keychain).
 *   3. Machine-derived key — the legacy obfuscation-grade fallback, used
 *      automatically when the keychain / @napi-rs/keyring is unavailable.
 *
 * Reads fall back to the legacy machine key so stores written before this
 * change keep decrypting; the next `login` re-encrypts with the resolved key.
 * ------------------------------------------------------------------------- */

const STORE_KEY_ENV = "SYNCRONA_STORE_KEY";
const USE_KEYCHAIN_ENV = "SYNCRONA_USE_KEYCHAIN";
const KEYCHAIN_SERVICE = "syncrona-credential-store";
const KEYCHAIN_ACCOUNT = "store-master-key";

export type StoreKeySource = "env" | "keychain" | "machine";

type KeyringEntry = {
  getPassword(): string | null;
  setPassword(pw: string): void;
};
type KeyringModule = {
  Entry: new (service: string, account: string) => KeyringEntry;
};

let cachedStoreKey: { key: Buffer; source: StoreKeySource } | null = null;

function parseKeyMaterial(raw: string): Buffer | null {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  try {
    const b = Buffer.from(value, "base64");
    if (b.length === KEY_LENGTH) return b;
  } catch {
    // not valid base64 — fall through
  }
  return null;
}

function keyFromEnv(): Buffer | null {
  const raw = process.env[STORE_KEY_ENV];
  if (!raw || !raw.trim()) return null;
  const key = parseKeyMaterial(raw);
  if (!key) {
    throw new Error(
      `${STORE_KEY_ENV} must be a 32-byte key encoded as 64 hex characters or base64.`
    );
  }
  return key;
}

function isKeychainEnabled(): boolean {
  // D5: the OS keychain is the DEFAULT at-rest backend. Only an explicit falsey
  // opt-out disables it (e.g. SYNCRONA_USE_KEYCHAIN=0 on a headless CI box with
  // no keychain). When enabled but the keychain / @napi-rs/keyring is
  // unavailable, keyFromKeychain returns null and getStoreKey falls back to the
  // legacy machine-derived key, so this is safe to default on.
  const flag = (process.env[USE_KEYCHAIN_ENV] || "").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "no") {
    return false;
  }
  return true;
}

function openKeychainEntry(): KeyringEntry | null {
  try {
    // Optional native dependency — absent or unloadable on unsupported platforms.
    const mod = require("@napi-rs/keyring") as KeyringModule;
    return new mod.Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  } catch {
    return null;
  }
}

function keyFromKeychain(): Buffer | null {
  if (!isKeychainEnabled()) return null;
  const entry = openKeychainEntry();
  if (!entry) return null;
  try {
    const existing = entry.getPassword();
    if (existing) {
      const parsed = parseKeyMaterial(existing);
      if (parsed) return parsed;
    }
    const generated = randomBytes(KEY_LENGTH);
    entry.setPassword(generated.toString("hex"));
    return generated;
  } catch {
    // keychain locked or unavailable — fall through to the machine key.
    return null;
  }
}

export function getStoreKey(): Buffer {
  if (cachedStoreKey) return cachedStoreKey.key;
  const envKey = keyFromEnv();
  if (envKey) {
    cachedStoreKey = { key: envKey, source: "env" };
    return envKey;
  }
  const keychainKey = keyFromKeychain();
  if (keychainKey) {
    cachedStoreKey = { key: keychainKey, source: "keychain" };
    return keychainKey;
  }
  const machineKey = getMachineKey();
  cachedStoreKey = { key: machineKey, source: "machine" };
  return machineKey;
}

export function getStoreKeySource(): StoreKeySource {
  getStoreKey();
  return (cachedStoreKey as { key: Buffer; source: StoreKeySource }).source;
}

/** Reset the resolved-key cache so a later env change is re-evaluated (tests). */
export function clearStoreKeyCache(): void {
  cachedStoreKey = null;
}

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(ciphertext: string, key: Buffer): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid credential file format.");
  }
  const [ivHex, authTagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted).toString("utf8") + decipher.final("utf8");
}

/**
 * Decrypt with the resolved store key, retrying with the legacy machine-derived
 * key so credential files written before AR2 keep opening.
 */
function decryptWithFallback(ciphertext: string): string {
  try {
    return decrypt(ciphertext, getStoreKey());
  } catch (primaryError) {
    if (getStoreKeySource() !== "machine") {
      try {
        return decrypt(ciphertext, getMachineKey());
      } catch {
        // legacy key did not match either — surface the primary error below
      }
    }
    throw primaryError;
  }
}

async function ensureDirs(): Promise<void> {
  await fsp.mkdir(getCredentialsDir(), { recursive: true, mode: 0o700 });
}

/* ----------------------------------------------------------------------------
 * Async API — used by the core CLI (read + write).
 * ------------------------------------------------------------------------- */

export async function saveCredentials(
  instance: string,
  user: string,
  password: string
): Promise<void> {
  await ensureDirs();
  const key = getStoreKey();
  const data = JSON.stringify({ instance, user, password });
  const encrypted = encrypt(data, key);
  const filePath = credentialFilePath(instance);
  await fsp.writeFile(filePath, encrypted, { encoding: "utf8", mode: 0o600 });
}

export async function loadCredentials(
  instance: string
): Promise<StoredCredentials> {
  const filePath = credentialFilePath(instance);
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch {
    throw new Error(
      `No credentials found for "${instance}". Run: syncro-now-ai login ${instance}`
    );
  }
  const data = decryptWithFallback(raw.trim());
  return JSON.parse(data) as StoredCredentials;
}

export async function listInstances(): Promise<string[]> {
  try {
    await ensureDirs();
    const files = await fsp.readdir(getCredentialsDir());
    return files
      .filter((f) => f.endsWith(".enc"))
      .map((f) => filenameToInstance(f));
  } catch {
    return [];
  }
}

export async function removeCredentials(instance: string): Promise<void> {
  const filePath = credentialFilePath(instance);
  try {
    await fsp.unlink(filePath);
  } catch {
    // not found — silently ignore
  }
}

export async function removeAllCredentials(): Promise<number> {
  const instances = await listInstances();
  for (const inst of instances) {
    await removeCredentials(inst);
  }
  return instances.length;
}

async function loadGlobalConfig(): Promise<GlobalConfig> {
  try {
    const raw = await fsp.readFile(getConfigFile(), "utf8");
    return JSON.parse(raw) as GlobalConfig;
  } catch {
    return {};
  }
}

async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
  await ensureDirs();
  const target = getConfigFile();
  // Write to a sibling temp file then rename — rename is atomic on the same
  // filesystem, so a crash or a concurrent reader mid-write can never observe a
  // truncated/corrupt config.json (the previous version stays intact until the
  // rename completes). The random suffix keeps concurrent writers in the same
  // process from colliding on one temp path (pid alone is not unique there).
  const tmpPath = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await fsp.writeFile(tmpPath, JSON.stringify(config, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fsp.rename(tmpPath, target);
}

export async function setActiveInstance(instance: string): Promise<void> {
  const config = await loadGlobalConfig();
  config.activeInstance = instance;
  await saveGlobalConfig(config);
}

export async function getActiveInstance(): Promise<string | null> {
  const config = await loadGlobalConfig();
  return config.activeInstance || null;
}

export async function resolveCredentialsFromStore(
  instance?: string
): Promise<StoredCredentials | null> {
  try {
    const target = instance || (await getActiveInstance());
    if (!target) return null;
    return await loadCredentials(target);
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------------------
 * Sync API — used by the MCP server during synchronous secrets resolution.
 *
 * These never throw: any missing file, decrypt failure, or parse error returns
 * null so the caller can fall through to the next secrets provider. They also
 * do NOT enforce non-empty user/password — that policy is left to the caller.
 * ------------------------------------------------------------------------- */

export function getActiveInstanceSync(): string | null {
  try {
    const raw = readFileSync(getConfigFile(), "utf8");
    const config = JSON.parse(raw) as GlobalConfig;
    const active = String(config.activeInstance || "").trim();
    return active || null;
  } catch {
    return null;
  }
}

export function loadCredentialsSync(
  instance: string
): StoredCredentials | null {
  const filePath = credentialFilePath(instance);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = readFileSync(filePath, "utf8").trim();
    const data = decryptWithFallback(raw);
    const creds = JSON.parse(data) as Partial<StoredCredentials>;
    return {
      instance: String(creds.instance || instance || ""),
      user: String(creds.user || ""),
      password: String(creds.password || ""),
    };
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------------------
 * Jira credential family
 *
 * Mirrors the ServiceNow credential API above and reuses the exact same crypto
 * (getStoreKey + encrypt/decrypt + decryptWithFallback). Jira logins are keyed by
 * a free-form *profile* name (default "default") rather than an instance host, so
 * a developer can keep more than one Jira site configured. Files live under
 * ~/.syncrona/jira/<profile>.enc, separate from the ServiceNow credentials dir.
 * ------------------------------------------------------------------------- */

export type JiraDeploymentKind = "cloud" | "server";

export type StoredJiraCredentials = {
  profile: string;
  baseUrl: string;
  deployment: JiraDeploymentKind;
  /** Account email — Cloud only. */
  email?: string;
  /** API token (Cloud) or personal access token (Server/DC). */
  token: string;
};

const DEFAULT_JIRA_PROFILE = "default";

function getJiraDir(): string {
  return path.join(getSyncronaDir(), "jira");
}

export function jiraProfileToFilename(profile: string): string {
  return profile.replace(/[^a-zA-Z0-9.-]/g, "_") + ".enc";
}

export function filenameToJiraProfile(filename: string): string {
  return filename.replace(/\.enc$/, "");
}

function jiraCredentialFilePath(profile: string): string {
  return path.join(getJiraDir(), jiraProfileToFilename(profile));
}

function normalizeJiraProfile(profile?: string): string {
  const trimmed = String(profile || "").trim();
  return trimmed || DEFAULT_JIRA_PROFILE;
}

async function ensureJiraDir(): Promise<void> {
  await fsp.mkdir(getJiraDir(), { recursive: true, mode: 0o700 });
}

function normalizeStoredJira(
  data: Partial<StoredJiraCredentials>,
  profile: string
): StoredJiraCredentials {
  const deployment: JiraDeploymentKind = data.deployment === "cloud" ? "cloud" : "server";
  const stored: StoredJiraCredentials = {
    profile: String(data.profile || profile || DEFAULT_JIRA_PROFILE),
    baseUrl: String(data.baseUrl || ""),
    deployment,
    // Do not coerce/trim the token — surrounding whitespace can be significant.
    token: String(data.token || ""),
  };
  const email = String(data.email || "").trim();
  if (email) {
    stored.email = email;
  }
  return stored;
}

export async function saveJiraCredentials(
  creds: StoredJiraCredentials
): Promise<void> {
  await ensureJiraDir();
  const profile = normalizeJiraProfile(creds.profile);
  const key = getStoreKey();
  const payload = normalizeStoredJira(creds, profile);
  const encrypted = encrypt(JSON.stringify(payload), key);
  const filePath = jiraCredentialFilePath(profile);
  await fsp.writeFile(filePath, encrypted, { encoding: "utf8", mode: 0o600 });
}

export async function loadJiraCredentials(
  profile?: string
): Promise<StoredJiraCredentials | null> {
  const normalized = normalizeJiraProfile(profile);
  const filePath = jiraCredentialFilePath(normalized);
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const data = decryptWithFallback(raw.trim());
    return normalizeStoredJira(JSON.parse(data) as Partial<StoredJiraCredentials>, normalized);
  } catch {
    return null;
  }
}

export async function listJiraProfiles(): Promise<string[]> {
  try {
    await ensureJiraDir();
    const files = await fsp.readdir(getJiraDir());
    return files
      .filter((f) => f.endsWith(".enc"))
      .map((f) => filenameToJiraProfile(f));
  } catch {
    return [];
  }
}

export async function removeJiraCredentials(profile?: string): Promise<void> {
  const filePath = jiraCredentialFilePath(normalizeJiraProfile(profile));
  try {
    await fsp.unlink(filePath);
  } catch {
    // not found — silently ignore
  }
}

export async function removeAllJiraCredentials(): Promise<number> {
  const profiles = await listJiraProfiles();
  for (const profile of profiles) {
    await removeJiraCredentials(profile);
  }
  return profiles.length;
}

/**
 * Sync read for the MCP runtime. Never throws: a missing file, decrypt failure,
 * or parse error returns null so the caller can fall through to env resolution.
 */
export function loadJiraCredentialsSync(
  profile?: string
): StoredJiraCredentials | null {
  const normalized = normalizeJiraProfile(profile);
  const filePath = jiraCredentialFilePath(normalized);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = readFileSync(filePath, "utf8").trim();
    const data = decryptWithFallback(raw);
    return normalizeStoredJira(JSON.parse(data) as Partial<StoredJiraCredentials>, normalized);
  } catch {
    return null;
  }
}
