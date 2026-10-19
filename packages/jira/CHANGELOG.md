# @syncrona/jira

## 1.2.0-beta.0

### Patch Changes

- @syncrona/credential-store@1.2.0-beta.0

## 1.1.0

### Patch Changes

- 76458e2: - Branch-name issue-key extraction no longer returns a non-key once a branch-type word is stripped: `release_2026-10` and `hotfix_1-2` yield no key, and `feature__abc-1` yields `ABC-1` instead of `_ABC-1`.
  - A network-level request failure now names its real reason: Node's bare `fetch failed` is reported with the underlying cause, e.g. `Jira request failed: fetch failed (ENOTFOUND)`.
  - ADF rendering keeps the target of a `link` mark: linked text renders as `text (href)` unless the text already is the URL.
  - ADF ordered lists honor `attrs.order`, so a list that starts at 3 is numbered from 3 instead of 1.
  - `JIRA_TOKEN` and stored Jira tokens are trimmed, so a trailing `\r`/`\n` from a file or a CRLF `.env` no longer corrupts the Cloud Basic-auth header into a 401.
- Updated dependencies [e33dd3e]
  - @syncrona/credential-store@1.1.0

## 1.0.0

### Patch Changes

- @syncrona/credential-store@1.0.0

## 0.9.4

### Patch Changes

- @syncrona/credential-store@0.9.4

## 0.9.3

### Patch Changes

- Instance filenames are reversible, and the ADF renderer no longer trips over a node shape it does not know.
- Input that was silently ignored is now either honored or reported.

## 0.9.1

### Patch Changes

- Package metadata: set the npm `homepage` to the project site
  (https://ivanbbaev.github.io/syncrona/) and sharpen the package descriptions.
  No runtime or API changes.
- Updated dependencies
  - @syncrona/credential-store@0.9.1
