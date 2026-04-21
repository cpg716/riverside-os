# RMS Charge Transactions

**Audience:** Sales support, managers, finance/admin, and staff reviewing RMS activity after the fact.

**Where in ROS:** Back Office → **Customers** → **RMS charge** → `Transactions`

## What this section is for

The `Transactions` section shows RMS activity recorded by Riverside.

That includes:

- purchases
- payments
- refunds
- reversals

## How to read RMS transaction types

### Purchase

A purchase is a new sale financed through `RMS Charge`.

### Payment

A payment is a collection against an existing RMS balance using the internal `RMS CHARGE PAYMENT` flow.

### Refund

A refund is a follow-on financial correction that credits back an RMS-financed action.

### Reversal

A reversal is a host-side correction of a previously posted RMS action.

## Posting status meanings

- `pending`
  Riverside is waiting for confirmation or still processing the host action.
- `posted`
  CoreCard accepted the action and Riverside has stored the result.
- `failed`
  The host action did not complete successfully. Staff should not treat the financial action as complete.
- `retried`
  Staff used the exception tools to retry a failed or stale action.
- `reconciled`
  The RMS record has been included in a successful reconciliation review.

## What host reference means

The `host reference` is the CoreCard-side identifier or reference Riverside stores after a successful post.

It matters because Riverside uses it for:

- refunds
- reversals
- audit tracing
- reconciliation follow-up

## When to escalate

Escalate when:

- posting status is `failed`
- the host reference is missing after a supposed success
- a refund or reversal is unclear
- the transaction does not match the receipt or customer expectation
- the account or program appears mismatched
