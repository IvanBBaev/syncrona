# Release and Governance Checklist

## Versioning

- Follow semantic versioning for `@syncrona/mcp-server`.
- Increment minor for backward-compatible feature additions.
- Increment major for breaking tool contract changes.

## Version bump procedure

`npx changeset version` bumps the packages and nothing else. The claims gate
compares the version badge in the repository-root `docs/index.html` against
`packages/core/package.json`, and `packages/mcp-server/test/contract.test.js` runs
that gate as a unit test — so a forgotten badge fails the **test** phase of
`npm run check`, well before the gate that would have named the cause. Bump the
site before running anything:

1. Run `npx changeset version`. Every `@syncrona/*` package moves in lockstep; the
   root `package.json` version stays behind by design and must not be "fixed".
2. In the repository-root `docs/index.html`, set both the visible badge
   (`<span class="version">vX.Y.Z`) and the JSON-LD `"softwareVersion"` to the new
   `packages/core/package.json` version.
3. Add the release heading to the repository-root `CHANGELOG.md`.
4. Only then run `npm run check`, which runs the test suites first and the
   governance gates after them.
5. Publish with `npm run release`.

## Changelog policy

- Update top-level `CHANGELOG.md` for every release.
- Include: added tools, behavioral changes, migration notes.

## Backward compatibility notes

- Keep existing tool names stable.
- Additive schema updates are preferred.
- For removals/renames, provide deprecation window and migration guidance.

## Audit retention guidance

- Keep `.syncrona-mcp/audit.log` under retention policy aligned with compliance needs.
- Rotate or archive log when size threshold is exceeded.

## Incident response guidance

1. Freeze mutating operations.
2. Collect audit logs and diagnostics timeline.
3. Reproduce with `dryRun=true` flows.
4. Roll forward with explicit remediation plan.
5. Document root cause and prevention actions.
