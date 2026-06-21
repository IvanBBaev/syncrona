# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).
It records intended version bumps and changelog entries for the publishable
`@syncro-now-ai/*` packages.

## Workflow

1. After a user-facing change, add a changeset:

   ```bash
   npm run changeset
   ```

   Pick the affected package(s) and bump type (patch / minor / major) and write
   a one-line summary. This writes a markdown file in this folder.

2. When cutting a release, apply the accumulated changesets:

   ```bash
   npm run version-packages   # bumps versions + writes CHANGELOG entries
   ```

3. Publish (owner step — needs npm scope ownership + 2FA):

   ```bash
   npm run release            # builds, then `changeset publish`
   ```

## Notes

- All `@syncro-now-ai/*` packages are versioned in lockstep (`fixed` group in
  `config.json`), so a single changeset bumps every published package together.
- `access` is `public`; `commit` is `false` (we never auto-commit — see the
  repo policy on explicit commits).
- For an alpha/prerelease line, enter prerelease mode first with
  `npx changeset pre enter alpha` and exit with `npx changeset pre exit`.
