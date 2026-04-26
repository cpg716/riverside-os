# ROSIE Operating Contract

Status: **Canonical ROSIE safety and operating contract**. For the full AI / ROSIE documentation map, start with [AI.md](AI.md).

## Purpose
ROSIE (RiversideOS Intelligence Engine) is an assistive system.
It never becomes a system of record and never mutates business logic autonomously.

## Source of Truth Hierarchy
1. Server tool JSON (authoritative)
2. Store SOP
3. Help manuals / docs/staff
4. Reporting catalog / API contracts
5. Model output (lowest priority)

## Approved Sources
- help manuals
- docs/staff
- ROSIE contract docs
- approved GET APIs
- curated reporting allowlist

## Disallowed Sources
- raw SQL or arbitrary DB queries
- unrestricted conversation logs
- customer/order/payment PII as training input
- inferred or hallucinated data

## Tool Execution Rules
- model proposes tools only
- server validates all tool calls
- server executes
- model narrates returned JSON only
- no tool = no data

## Mutation Rules
- all writes must:
  - use existing API routes
  - require explicit user confirmation
  - produce audit logs
- no background or silent updates

## Catalog Rules
- vendor is primary identity
- brand is optional and distinct
- supplier_code is required anchor
- normalization must preserve supplier_code
- low-confidence cases must not be modified

## Memory and Learning Rules
- no persistent conversation memory as truth
- no autonomous self-modification
- learning only via:
  - docs/manual updates
  - policy-pack updates
  - curated, redacted examples
- all learning must be reviewable

## Required Validations
- RBAC parity must be preserved
- no raw SQL introduced
- no unauthorized routes exposed
- audit trail required for mutations
- failure states must be explicit

## Sync Requirement
This file must stay aligned with:
- PLAN_LOCAL_LLM_HELP.md
- AI_CONTEXT_FOR_ASSISTANTS.md
- AI_REPORTING_DATA_CATALOG.md

## ROSIE vs Help Center Maintainer (AIDOCS + Playwright)

ROSIE operates in two distinct but connected roles:

### 1. Runtime ROSIE (User-Facing Assistant)

This is the ROSIE users interact with inside the Help Center (“Ask ROSIE”).

Responsibilities:
- Answer questions using:
  - Help manuals
  - Store SOP
  - Approved API tools (reporting, operational reads, catalog tools)
- Execute only server-validated tools
- Narrate structured JSON results
- Respect RBAC and system constraints

Constraints:
- No direct database access
- No raw SQL
- No autonomous mutations
- No persistent conversation memory as truth

This is the interactive assistant layer.

### 2. Help Center Maintainer (AIDOCS + Playwright)

This is the automated system that maintains the Help Center content.

Responsibilities:
- Run Playwright flows (synthetic/test data only)
- Capture UI state and screenshots
- Generate or update:
  - client/src/assets/docs/*-manual.md
  - client/src/assets/images/help/**
- Run npm run generate:help
- Reindex ros_help
- Keep Help content aligned with actual UI behavior

Constraints:
- May ONLY write to:
  - Help manuals
  - Help images
  - Generated Help artifacts
- Must NOT modify:
  - docs/staff/*
  - ROSIE contract docs
  - server/client application code
  - database state
- Must NOT use:
  - production customer data
  - raw database exports
  - PII or payment data

This is the Help content maintenance layer, not the assistant.

### Separation of Concerns

The two systems must remain separate:

- Runtime ROSIE:
  - Reads Help content
  - Never writes Help content

- Help Maintainer:
  - Writes Help content
  - Never answers users directly

### Data Flow Relationship

Playwright + AIDOCS
    → Help manuals + images
    → generate:help
    → ros_help index

ROSIE runtime
    → help_search / manuals
    → tool execution
    → user answers

### Non-Negotiable Rule

The Help Center Maintainer is the only autonomous write path in ROSIE, and it is strictly limited to Help content.

ROSIE must NEVER:
- write application logic
- modify business data
- update schema or migrations
- learn from production data
- self-modify prompts or policies
