// Hermetic credential tests. As of D5 the OS keychain is the DEFAULT at-rest
// backend, which means any test that exercises the credential store would
// otherwise reach for the real @napi-rs/keyring / OS keychain — a side effect
// that is non-deterministic across machines and workers and made the suite
// flaky. Force the keychain OFF for every test by default; the storeKey suite
// opts back in explicitly with a mocked @napi-rs/keyring to test the keychain
// path in isolation.
process.env.SYNCRONA_USE_KEYCHAIN = "0";
