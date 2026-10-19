# Workflow and Safety Model

## Core operating model

The intended workflow is:

1. establish context (scope + update set)
2. run preflight
3. analyze impact/risk
4. dry-run mutation path
5. require approval + rollback evidence
6. apply change
7. validate and update scope knowledge artifacts

## Guardrails

Guardrails are controlled by sync.mcp.guardrails.json.

Important fields:

- enforcePreflightForMutations
- expectedScope
- expectedUpdateSetName
- expectedUpdateSetSysId

When strict mode is enabled, mutating tools are blocked until preflight passes.

## Mutating vs non-mutating behavior

Mutating operations:

- require explicit confirmation where applicable
- are audit-logged
- support dry-run behavior where available

Non-mutating operations:

- remain available even when strict preflight enforcement is enabled
- are commonly used for diagnostics and planning

## Approval and risk semantics

Risk levels are mapped to approval requirements.

Typical policy:

- low: optional approval
- medium: at least one approver
- high: stronger approval and rollback evidence
- critical: strictest gate and explicit sign-off

## Rollback evidence

Rollback evidence validation expects key fields for higher-risk operations.
This protects against apply without recovery plan.

## Known caveat to keep in mind

Some apply/remediation flows are currently mocked internally for patch simulation logic.
AI agents should clearly communicate execution mode and avoid implying remote mutation unless explicitly confirmed by tool output.
