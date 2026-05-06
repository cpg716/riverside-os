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
- R2S reporting follow-up

## How to read RMS transaction types

### Purchase

A purchase is a new sale financed through `RMS Charge`.

### Payment

A payment is a collection against an existing RMS balance using the internal `RMS CHARGE PAYMENT` flow.

### Refund

A refund is a follow-on financial correction that credits back an RMS-financed action.

### Reversal

A reversal is a correction against a previously recorded RMS action.

## Report to R2S status

Every RMS Charge Sale and RMS Charge Payment created through POS starts as `Unreported` and is due the next day.

Phase 1 R2S reporting applies to POS-created Sales and Payments. Manual refund and reversal corrections remain tracked on the RMS Charge record/reference trail, but they do not create a separate R2S reporting checklist item.

R2S reporting applies to new manual RMS Charge Sales and Payments created after reporting metadata was added. Earlier historical rows without explicit reporting metadata remain in transaction history, but they do not create R2S reporting reminders unless they are explicitly marked reporting-required.

Use the `Report to R2S` filter to review:

- `All`
- `Unreported`
- `Reported`
- `Overdue`

Open a record and choose `Mark Reported` after staff complete the R2S reporting step. Add the optional note/reference if R2S gave one.

Marking reported:

- records the staff member
- records the timestamp
- stores the optional note/reference
- clears the related reminder
- does not change financial amounts
- does not imply live API posting

## Posting status meanings

- `recorded_manually`
  Riverside recorded the RMS Charge action with staff-entered account/program/reference details.
- `pending`
  Riverside is waiting for a future live posting confirmation or another support update.
- `posted`
  A future live posting path accepted the action and Riverside stored the result.
- `failed`
  A live posting action did not complete successfully. Staff should review before relying on that live result.
- `retried`
  Staff used the exception tools to retry a failed or stale action.
- `reconciled`
  The RMS record has been included in a successful reconciliation review.

## What Reference Number means

The `Reference Number` is the approval, authorization, merchant, or support reference staff collect from the R2S-approved process.

It matters because Riverside uses it for:

- refunds
- reversals
- audit tracing
- reconciliation follow-up
- R2S reporting follow-up

## Optional live integration proof

Manual RMS Charge records do not need a live API proof to be operationally complete. They need accurate customer/account/program/amount/reference details and `Report to R2S` completion.

Future live API activation still requires Settings → `CoreCard` live-read proof before staff rely on automatic posting.

## When to escalate

Escalate when:

- an RMS Charge Sale or RMS Charge Payment is overdue for R2S reporting
- posting status is `failed`
- a refund or reversal is unclear
- the transaction does not match the receipt or customer expectation
- the account or program appears mismatched
