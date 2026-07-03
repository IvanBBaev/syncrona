# Testing and Quality Context

## Current test structure

Node test runner is used with JavaScript tests over built output.

Primary test files:

- test/index.test.js
- test/analysis.test.js
- test/contract.test.js

## What each suite covers

index.test.js:

- runtime utility behavior
- guardrail parsing and preflight logic
- command safety checks
- mutation classification and helper gates

analysis.test.js:

- graph extraction and impact algorithms
- analysis rule behavior
- suppression and policy scoring
- markdown/report generation
- planner and scope-knowledge helper behavior

contract.test.js:

- required MCP tool declarations
- contract hash stability
- duplicate detection

## Quality gates

scripts:

- npm run --workspace=@syncrona/mcp-server test
- npm run --workspace=@syncrona/mcp-server quality-gates
- npm run --workspace=@syncrona/mcp-server validate-release-checklist

## Recommended next quality step

Add handler-level integration tests that exercise full call-tool argument/response paths for newly added tools.
This closes the gap between helper-level unit coverage and end-to-end runtime behavior.
