// SPDX-License-Identifier: GPL-3.0-or-later
import { getStoreKeySource, clearStoreKeyCache } from "../src/index";

// D5: the keychain is the default backend. These tests pin the precedence and
// the opt-out, using only deterministic cases (the default-on path resolves to
// "keychain" or "machine" depending on whether @napi-rs/keyring is present).
const STORE_KEY = "SYNCRONA_STORE_KEY";
const USE_KEYCHAIN = "SYNCRONA_USE_KEYCHAIN";

let savedStoreKey: string | undefined;
let savedUseKeychain: string | undefined;

beforeAll(() => {
  savedStoreKey = process.env[STORE_KEY];
  savedUseKeychain = process.env[USE_KEYCHAIN];
});

beforeEach(() => {
  clearStoreKeyCache();
  delete process.env[STORE_KEY];
  // D5: the keychain is the default backend, so absence of the flag means "on"
  // and would reach the real OS keychain. Force it OFF to keep these tests
  // hermetic; the keychain path itself is covered with a mocked @napi-rs/keyring
  // in the core storeKey suite.
  process.env[USE_KEYCHAIN] = "0";
});

afterEach(() => {
  clearStoreKeyCache();
  if (savedStoreKey === undefined) delete process.env[STORE_KEY];
  else process.env[STORE_KEY] = savedStoreKey;
  if (savedUseKeychain === undefined) delete process.env[USE_KEYCHAIN];
  else process.env[USE_KEYCHAIN] = savedUseKeychain;
});

test("explicit SYNCRONA_STORE_KEY takes precedence (source: env)", () => {
  process.env[STORE_KEY] = "a".repeat(64);
  expect(getStoreKeySource()).toBe("env");
});

test("keychain opt-out falls back to the machine key (source: machine)", () => {
  process.env[USE_KEYCHAIN] = "0";
  expect(getStoreKeySource()).toBe("machine");
});

test("'false' and 'no' also opt out of the keychain", () => {
  process.env[USE_KEYCHAIN] = "false";
  expect(getStoreKeySource()).toBe("machine");
  clearStoreKeyCache();
  process.env[USE_KEYCHAIN] = "no";
  expect(getStoreKeySource()).toBe("machine");
});

// Note: the D5 default-on path (keychain selected when @napi-rs/keyring is
// present) is covered hermetically in the core `storeKey` suite with a mocked
// keyring, so it is intentionally not re-tested here against the real keychain.
