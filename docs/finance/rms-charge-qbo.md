# RMS Charge and QBO Guide

Status: **Canonical RMS Charge QBO/accounting reference**. For the complete documentation map, start with [RMS_CHARGE.md](../RMS_CHARGE.md).

This guide explains the implemented RiversideOS accounting expectations for RMS Charge activity.

## Two RMS financial paths

### RMS financing purchase

This is a new sale financed through `RMS Charge`.

Expected Riverside behavior:

- the underlying sale, tax, and COGS behavior still follows the normal sale flow
- the tender-side clearing expectation uses `RMS_CHARGE_FINANCING_CLEARING`

### RMS payment collection

This is a payment collected against an existing RMS balance using the internal `RMS CHARGE PAYMENT` flow.

Expected Riverside behavior:

- the flow preserves the existing RMS payment collection model
- the expected clearing path uses `RMS_R2S_PAYMENT_CLEARING`

## Clearing accounts

### RMS_CHARGE_FINANCING_CLEARING

Use this clearing path for:

- RMS financed purchases
- RMS financing-side refund or reversal support where the tender clearing path must remain explicit

### RMS_R2S_PAYMENT_CLEARING

Use this clearing path for:

- RMS payment collection
- RMS payment reversals that must stay balanced against the original collection path

## Expected accounting behavior

### Financed purchase

What should remain true:

- sale behavior is still a normal Riverside sale
- revenue and tax behavior is not replaced by RMS logic
- RMS changes the tender-side clearing expectation, not the underlying item or tax model

### Payment collection

What should remain true:

- the customer is paying toward RMS, not buying normal inventory again
- the collection behaves like pass-through or clearing treatment
- the payment line should not behave like normal revenue

### Refunds and reversals

What should remain true:

- Riverside stores the linkage back to the original RMS record and host references
- the correction path should remain consistent with the original clearing model

## What Riverside validates

Riverside can validate or expose:

- RMS record type
- posting status
- host references
- exception state
- reconciliation mismatch state
- the expected clearing path used by RMS support views

## What still needs external accounting confirmation

Riverside does not replace external accounting review.

Finance/admin should still confirm in external systems:

- final journal acceptance in QBO
- accounting period treatment
- any downstream bookkeeping interpretation outside Riverside's mapped journal behavior

## Related docs

- reconciliation:
  [`staff/rms-charge-reconciliation.md`](../staff/rms-charge-reconciliation.md)
- architecture:
  [`CORECARD_CORECREDIT_FULL_ARCHITECTURE.md`](../CORECARD_CORECREDIT_FULL_ARCHITECTURE.md)
