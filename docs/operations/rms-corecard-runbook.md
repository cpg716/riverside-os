# RMS Charge / CoreCard Operations Runbook

This runbook is for operational monitoring and recovery of the RMS Charge / CoreCard integration already implemented in RiversideOS.

## Daily checks

### Sync health

Review:

- latest repair poll visibility
- pending webhook count
- failed webhook count
- stale account count

### Exception queue

Review:

- new failed posts
- retryable items
- unresolved stale account items
- unresolved reconciliation mismatches

### Failed posts

Look for:

- failed purchases
- failed payments
- failed refunds
- failed reversals

### Webhook health

Confirm:

- webhook events are arriving
- verification results look normal
- processing status is moving forward
- duplicate replay handling remains idempotent

## Weekly checks

### Reconciliation

Review:

- recent reconciliation runs
- open mismatch counts
- repeated mismatch patterns

### Unresolved exceptions

Review:

- long-open exceptions
- items with repeated retries
- items with weak or missing notes

## Incident handling

### CoreCard downtime

1. Confirm whether failures are broad and not isolated.
2. Stop repeated blind retries.
3. Track affected items through the exception queue.
4. Notify store leadership and RMS support owners.

### Webhook failure

1. Confirm webhook verification configuration.
2. Review redacted webhook logs.
3. Confirm repair polling is still running.
4. Use reconciliation to identify records that remain mismatched.

### Duplicate or missing transactions

1. Review the RMS record detail.
2. Review posting-event history and idempotency evidence.
3. Check whether a webhook or repair poll already corrected the state.

## Recovery procedures

### Retry flow

- retry only when the item is retryable and still needs the host action
- confirm the account, program, and customer still look correct
- review for an existing host reference before retrying

### Reconciliation correction flow

- use reconciliation before forcing manual conclusions
- resolve items with notes when the difference is understood
- escalate finance-facing mismatches instead of repeatedly retrying non-retryable items

## Do NOT do this

- Do not expose unmasked account data.
- Do not keep retrying the same failure without review.
- Do not resolve exceptions without notes.
- Do not treat a failed host post as a completed sale or completed payment.

## Companion docs

- architecture:
  [`/Users/cpg/riverside-os/docs/CORECARD_CORECREDIT_FULL_ARCHITECTURE.md`](../CORECARD_CORECREDIT_FULL_ARCHITECTURE.md)
- exceptions:
  [`/Users/cpg/riverside-os/docs/staff/rms-charge-exceptions.md`](../staff/rms-charge-exceptions.md)
- reconciliation:
  [`/Users/cpg/riverside-os/docs/staff/rms-charge-reconciliation.md`](../staff/rms-charge-reconciliation.md)
- finance:
  [`/Users/cpg/riverside-os/docs/finance/rms-charge-qbo.md`](../finance/rms-charge-qbo.md)
