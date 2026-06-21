#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

npm run --workspace=@syncro-now-ai/mcp-server build
npm run --workspace=@syncro-now-ai/mcp-server test
node packages/mcp-server/scripts/check-tool-contract.js
node packages/mcp-server/scripts/check-docs-drift.js
node packages/mcp-server/scripts/check-claude-docs-drift.js
node packages/mcp-server/scripts/validate-release-checklist.js
