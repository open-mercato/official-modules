---
name: spec-writing
description: Guide for creating high-quality specifications for community modules in the official-modules repo. Use when starting a new SPEC, designing a new module, or reviewing an existing spec. Follows the same "Martin Fowler" staff-engineer standards as the core repo. Triggers on "write spec", "new spec", "design module", "spec for", "create spec".
---

# Spec Writing — Community Modules

Design and review specifications (SPECs) for `@open-mercato/*` community module packages. Adopt the **"Martin Fowler"** persona. Every community module is an **external extension** — it MUST use UMES extension points (widgets, events, enrichers, API interceptors, custom entities) and MUST NOT modify core packages.

## Workflow

1. **Load Context**: Read `AGENTS.md` at repo root. Skim the target module's folder if it already exists.
2. **Initialize**: Create an empty file with the naming convention:
   - `SPEC-{number}-{date}-{title}.md` in `.ai/specs/`
   - Date format: `YYYY-MM-DD`
   - Title: kebab-case summary (e.g., `loyalty-cards-module`)
3. **Start Minimal**: Write a **Skeleton Spec** (TLDR + Open Questions + 2-3 key sections). Do NOT write the full spec in one pass.
   - Before writing the skeleton, scan the brief for **critical unknowns** — decisions about data model shape, scope, integration points, or UMES extension strategy that would force a rewrite if assumed wrong.
   - If critical unknowns exist, add a numbered **Open Questions** block (`Q1`, `Q2`, …) immediately after the TLDR. **STOP after presenting the skeleton. Do not proceed to Research until all questions are answered. This is a hard gate.**
4. **Iterate**: Apply answers from the Open Questions gate. Remove the block once all are resolved. If new unknowns surface during design, repeat the gate.
5. **Research**: Challenge requirements against open-source or commercial leaders in the domain.
6. **Design**: Architecture, data model, UMES extension points used, API contracts.
7. **Implementation Breakdown**: Break into **Phases** (stories) and **Steps** (testable tasks). Each step should result in a working, buildable package.
8. **Review**: Apply the [Spec Checklist](references/spec-checklist.md).
9. **Compliance Gate**: Apply the [Final Compliance Review](references/compliance-review.md).
10. **Output**: Finalize the spec file.

## Spec Naming

```
SPEC-001-2026-03-20-loyalty-cards.md
SPEC-002-2026-03-21-shipment-tracker.md
```

Always check existing specs to pick the next number. Run `ls .ai/specs/` before creating.

## Output Formats

### 1. New Specification

Use the [Specification Template](references/spec-template.md). Key sections:

- **TLDR**: Package name, module ID, one-line value proposition
- **Problem Statement**: What is missing from core that this module addresses?
- **UMES Extension Points**: Which framework hooks are used (widgets, events, enrichers, interceptors, custom entities)
- **Data Models**: Entities with all required columns
- **API Contracts**: Endpoints with request/response/error shapes
- **Phases**: Ordered delivery steps, each buildable and testable
- **Integration Coverage**: All API paths and key UI paths that need testing

### 2. Architectural Review

```markdown
# Architectural Review: SPEC-XXX — Title

## Summary
{1-3 sentences: what the module does and overall architectural health}

## Findings

### Critical
{UMES violation, direct core modification, tenant isolation leak, missing organization_id scoping}

### High
{Missing phase strategy, wrong package placement, missing undo logic for commands}

### Medium
{Missing failure scenarios, inconsistent naming, spec-bloat on standard CRUD}

### Low
{Stylistic suggestions, diagram improvements}

## Checklist
See references/spec-checklist.md
```

## Review Heuristics (The "Martin Fowler" Lens)

1. **External Extension First**: Is everything achievable via UMES extension points? If the spec implies modifying `packages/core`, that is a red flag — either the module is wrong scope or a new extension point needs to be proposed.
2. **The Architectural Diff**: Is the spec wasting space documenting boilerplate CRUD? Cut the noise. Document only what is unique to this module.
3. **Singularity Law**: Does the spec use `loyalty_cards.card` (PASS) or `loyalty_cards.cards` (FAIL) for events/commands/features?
4. **Undo Contract**: How is the state reversed? Is the "Undo" logic as detailed as the "Execute"?
5. **Module Isolation**: Cross-module side effects via event bus only. No direct imports into other modules' internals.
6. **Tenant Scoping**: Every entity with business data MUST have `organization_id`. Every query MUST filter by it.

## Quick Rule Reference

| Rule | Example |
|------|---------|
| Singular entity/event/command names | `loyalty_cards.card.redeemed` not `loyalty_cards.cards.redeemed` |
| FK IDs only for cross-module links | `customerId: string` not `@ManyToOne(() => Customer)` |
| `organization_id` on all scoped entities | Required column, required in every query |
| Undoability default for state changes | Every command has snapshot + rollback |
| Zod validation for all API inputs | Schemas in `data/validators.ts` |
| Package placement | `packages/<name>/` never inside `packages/core/` |

## Reference Materials

- [Spec Checklist](references/spec-checklist.md)
- [Final Compliance Review](references/compliance-review.md)
- [Specification Template](references/spec-template.md)
- [AGENTS.md](../../AGENTS.md)
