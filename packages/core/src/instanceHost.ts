// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The bare host form of an instance value.
 *
 * #20: every request URL in this codebase is built as
 * `https://${credentials.instance}/`, so the instance is a HOST, never a URL.
 * A hand-written `.env` almost always holds what the browser address bar shows
 * instead — and `https://https://dev.service-now.com//` fails with
 * `getaddrinfo ENOTFOUND https`, a message that names a hostname the user never
 * typed and blames DNS. Nothing in the error points at the scheme in the value,
 * so `doctor`, `status` and every command reported the same dead end.
 *
 * Deliberately narrow: strip a leading scheme, then everything from the first
 * `/`, `?` or `#`. Case is left alone — the credential store is keyed on this
 * string, so lower-casing would orphan an existing stored login — and no
 * domain is ever appended, because a bare `dev12345` may well be an internal
 * host on a custom domain and guessing `.service-now.com` would send the
 * request somewhere the user did not ask for.
 *
 * It lives in its own module rather than in snClient because it is a pure
 * string helper that both credential resolution and `login` need: a test that
 * mocks the whole axios-carrying snClient must still get the real
 * normalization, or it would be asserting against a stub of the very behaviour
 * under test.
 */
export function normalizeInstanceHost(raw: string): string {
  return raw
    .trim()
    .replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "");
}
