# RMS Charge / CoreCard Validation Checklist

Status: **Operator validation checklist** for sandbox/live RMS Charge signoff. For setup and context, start with [RMS_CHARGE.md](../RMS_CHARGE.md) and [CORECARD_SANDBOX_LIVE_VALIDATION_RUNBOOK.md](../CORECARD_SANDBOX_LIVE_VALIDATION_RUNBOOK.md).

## SECTION 1 — BEFORE YOU START

- [ ] I have sandbox/live CoreCard credentials configured
- [ ] I ran: `npm run validate:corecard:sandbox` (or live)
- [ ] No errors were reported in the preflight check
- [ ] I have a test customer linked to a CoreCard account
- [ ] I have POS access and Back Office access

## SECTION 2 — BASIC VALIDATION

- [ ] Open POS
- [ ] Attach a customer with an RMS account
- [ ] Select RMS Charge
- [ ] Choose the plan when prompted
- [ ] Confirm account appears correctly
- [ ] Complete a financed purchase
- [ ] Receipt shows:
  - [ ] RMS Charge
  - [ ] Correct program (e.g., RMS 90 or standard)
- [ ] Transaction appears in RMS Charge workspace

## SECTION 3 — PAYMENT COLLECTION

- [ ] Run an RMS payment collection
- [ ] Payment completes successfully
- [ ] Receipt shows RMS payment reference
- [ ] Payment appears in RMS Charge workspace

## SECTION 4 — ERROR HANDLING

- [ ] Attempt a scenario that should fail (e.g., insufficient credit if available)
- [ ] System blocks the transaction correctly
- [ ] No incorrect "success" message is shown
- [ ] Error message is clear

## SECTION 5 — WEBHOOK & SYNC

- [ ] After a transaction, wait for system update
- [ ] RMS workspace reflects correct status
- [ ] No duplicate or incorrect updates appear

## SECTION 6 — RECONCILIATION

- [ ] Open RMS Charge workspace (Back Office)
- [ ] Check transaction list
- [ ] Check reconciliation or sync health view
- [ ] No unexpected mismatches appear

## SECTION 7 — ACCOUNTING CHECK

- [ ] Confirm sale appears correctly in Riverside
- [ ] Confirm RMS Charge behavior looks correct (no duplicate or missing records)
- [ ] Note: external accounting system confirmation may happen later

## SECTION 8 — FINAL CHECK

- [ ] No failed transactions are stuck
- [ ] No unresolved exceptions remain
- [ ] System behaves consistently across POS and Back Office
- [ ] No unexpected errors occurred

## SECTION 9 — IF SOMETHING FAILS

- Stop testing immediately
- Do not retry repeatedly
- Notify system administrator or engineering
- Provide:
  - what step failed
  - screenshot if possible
  - time of issue

## SECTION 10 — SIGNOFF

- [ ] All steps completed successfully
- [ ] No critical issues found
- [ ] Validation is approved

Name:

Date:

Environment (Sandbox / Live):

Notes:
