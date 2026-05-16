# Pilot freeze rules

**Audience:** Owner, pilot lead, manager on duty, technical owner.

**Purpose:** Keep the pilot stable once the release candidate is frozen.

---

## Allowed during pilot

Allowed without changing the pilot release:

- Staff coaching.
- SOP updates.
- Printed guide updates.
- Pilot issue log updates.
- Daily review notes.
- Temporary manager-only operating rules.
- Hardware setup correction.
- Environment or credential correction approved by owner.

---

## Not allowed during pilot without approval

Do not change during open pilot hours unless owner approves:

- Checkout behavior.
- Refund/exchange behavior.
- Register close behavior.
- RMS charge behavior.
- QBO review or posting behavior.
- Inventory receiving, adjustment, or physical count behavior.
- Wedding pickup or balance handling.
- Alteration intake, due date, or pickup handling.
- Staff access or Manager Access rules.

---

## Changes that require recertification

Recertify before using live when a change touches:

- Payment, refund, balance, tax, RMS, QBO, close, or inventory posting.
- Return window or Manager Access behavior.
- Offline recovery or parked sale recovery.
- Receipt totals or tender evidence.
- Register session open/close rules.
- Any workflow with customer-facing money or garment release.

---

## Emergency fix handling

If an emergency fix is required:

1. Stop the affected workflow.
2. Preserve issue evidence.
3. Make the smallest possible fix.
4. Run targeted validation for the affected workflow.
5. Manager and owner approve return to use.
6. Log what changed and what was tested.

---

## Wording and layout tweak policy

During pilot, do not make cosmetic changes inside critical workflows unless they remove a live confusion issue.

Allowed:

- Clarifying a misleading staff-facing label.
- Fixing wording that causes repeated mistakes.
- Making a blocked state easier to identify.

Not allowed:

- Preference-based polish.
- Rearranging controls after staff have trained.
- Changing button placement without recertifying the workflow.

---

## Rollback expectations

Every pilot day must have:

- Known previous build or fallback procedure.
- Database backup timestamp.
- Owner who can authorize rollback.
- List of workflows to stop first.
- Staff instructions for manual fallback.

**Last reviewed:** 2026-05-16
