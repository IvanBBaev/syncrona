# Backlog and Roadmap Context

## Source of truth

Active backlog is in repository root TODO.
Completed work archive is in TODO_DONE.

## Current active themes (post-audit)

1. Clarify plan vs apply execution semantics
2. Reduce unnecessary remote dependency in context-generation paths
3. Support non-script deep-analysis scenarios
4. Improve multilingual planner tokenization
5. Add handler-level integration tests for new tools
6. Update README with new MCP capabilities

## Practical implementation order

1. P0 safety/semantics items first
2. P1 capability and reliability items next
3. Documentation and onboarding updates after behavior is stable

## Definition of done guidance

A backlog item is considered done when all of the following are true:

1. code behavior implemented
2. tests updated and passing
3. tool contract unaffected or intentionally versioned
4. docs updated when user-facing behavior changed
5. quality gates and release checklist pass

## AI execution guidance

When continuing work in later sessions:

1. read this context pack first
2. read TODO/TODO_DONE second
3. prefer small, verifiable increments
4. always finish with tests + quality gates
