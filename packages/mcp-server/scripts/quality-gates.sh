#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

npm run --workspace=@syncrona/mcp-server build

# gap-analysis #24: the aggregate `npm run check` already runs the mcp suite twice
# (test:mcp + the coverage gate), so re-running it here is a wasted third pass.
# The check chain sets SKIP_TESTS=1 to skip it; a standalone `npm run quality:mcp`
# (SKIP_TESTS unset) still runs the full suite. The governance checks below only
# need the freshly built dist above, not the test run.
if [ "${SKIP_TESTS:-}" != "1" ]; then
  npm run --workspace=@syncrona/mcp-server test
fi
node packages/mcp-server/scripts/check-tool-contract.js
node packages/mcp-server/scripts/check-docs-drift.js
node packages/mcp-server/scripts/generate-tool-reference.js --check
node packages/mcp-server/scripts/check-claude-docs-drift.js
node packages/mcp-server/scripts/check-claims-drift.js
node packages/mcp-server/scripts/validate-release-checklist.js
