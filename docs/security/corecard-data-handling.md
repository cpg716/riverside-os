# CoreCard Data Handling and Security

Status: **Canonical RMS Charge security and data-handling reference**. For the complete documentation map, start with [RMS_CHARGE.md](../RMS_CHARGE.md).

This document describes the current security and data-handling expectations for the RiversideOS RMS Charge / CoreCard integration.

## Core rules

- CoreCard authentication stays server-side only.
- CoreCard secrets and tokens must remain in environment or server configuration only.
- No browser, PWA, or Tauri client storage may hold CoreCard credentials or tokens.
- Raw PAN and CVV must not be stored.
- UI-facing account values must remain masked.

## Masking requirements

Allowed in UI-facing payloads:

- masked account
- program label
- posting status
- host reference when appropriate

Not allowed in UI-facing payloads:

- raw account numbers
- raw PAN
- CVV
- bearer tokens
- client secret values

## Logging and redaction

All CoreCard request and response logging must be redacted.

Expected protections:

- payload masking before persistence or logging
- retention limits for stored snapshots
- webhook log redaction
- no ad hoc debug printing of secrets

## Role-based access rules

### Standard POS staff

May use:

- RMS Charge tender
- account selection and program selection needed for the active sale
- slim RMS history only when the assigned permission allows it

May not use:

- Back Office exception tools
- reconciliation tools
- account link management
- refund or reversal controls without elevated permission

### Managers and Back Office staff

May receive broader RMS permissions for:

- exception handling
- account linking
- refunds or reversals
- reconciliation

### Finance/admin

Should have the reconciliation and reporting access needed for RMS accounting review.

## Audit requirements

The following actions must remain auditable:

- link account
- unlink account
- purchase post
- payment post
- refund
- reversal
- failed host post
- retry
- assign
- resolve
- reconciliation run

## Operational reminders

- Do not paste secrets into docs, tickets, or screenshots.
- Do not enable unsigned webhook handling outside approved validation scenarios.
- Do not share support screenshots that expose more than masked account values.
