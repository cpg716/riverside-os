# CoreCard Sandbox / Live Validation Runbook

This runbook is the operational checklist for validating the existing RiversideOS RMS Charge / CoreCredit / CoreCard integration against a real CoreCard sandbox or live tenant.

It is intentionally narrow. It does not redesign the integration and it does not replace the fake-host E2E suite.

## Purpose

What is already validated locally:

- deterministic Playwright coverage against the fake CoreCard host
- RMS financed purchase success and decline
- no-customer checkout blocking
- multi-account resolution and metadata persistence
- RMS payment collection success and failure
- webhook ingestion and idempotent replay
- exception retry flow
- reconciliation visibility
- POS vs Back Office permission split
- program-specific receipt wording
- legacy RMS / RMS90 history compatibility

What still must be validated against real CoreCard behavior:

- real token acquisition against the tenant
- real account summary, balances, transactions, and program eligibility payloads
- real host posting behavior for purchase, payment, refund, and reversal
- real webhook delivery and verification behavior
- polling fallback when webhook delivery is delayed or missed
- real-world timeout / retry / bad-credential failure behavior
- operator-facing results with tenant-specific programs and account states
- Riverside-visible QBO support artifacts under real host references

## Environment prerequisites

Riverside processes and services:

- PostgreSQL with the current migrations applied
- `server/` API running with the CoreCard env vars loaded
- `client/` UI running against that API
- background CoreCard repair polling enabled in the server process
- webhook delivery route reachable from the CoreCard sandbox/live environment:
  - `POST /api/webhooks/corecard`
  - `POST /api/integrations/corecard/webhooks`

Required CoreCard env vars:

- `RIVERSIDE_CORECARD_BASE_URL`
- `RIVERSIDE_CORECARD_CLIENT_ID`
- `RIVERSIDE_CORECARD_CLIENT_SECRET`
- `RIVERSIDE_CORECARD_REGION`
- `RIVERSIDE_CORECARD_ENVIRONMENT`

Recommended CoreCard env vars to confirm before validation:

- `RIVERSIDE_CORECARD_TIMEOUT_SECS`
- `RIVERSIDE_CORECARD_REDACTION`
- `RIVERSIDE_CORECARD_LOG_PAYLOADS`
- `RIVERSIDE_CORECARD_WEBHOOK_SECRET`
- `RIVERSIDE_CORECARD_WEBHOOK_ALLOW_UNSIGNED`
- `RIVERSIDE_CORECARD_REPAIR_POLL_SECS`
- `RIVERSIDE_CORECARD_SNAPSHOT_RETENTION_DAYS`

Recommended preflight command:

```bash
npm run validate:corecard:sandbox
```

For live:

```bash
npm run validate:corecard:live
```

Tenant-specific prerequisites a human must provide:

- the correct CoreCard sandbox/live base URL
- client ID and client secret
- tenant region/environment values
- approved webhook secret or verification method
- at least one Riverside customer already linked to a valid CoreCard sandbox/live account
- if applicable, one account eligible for Standard only and one eligible for RMS 90 / promo financing
- at least one operator with `pos.rms_charge.use`
- at least one Back Office user with:
  - `customers.rms_charge.view`
  - `customers.rms_charge.resolve_exceptions`
  - `customers.rms_charge.reconcile`
  - `customers.rms_charge.reporting`
- if QBO support views will be reviewed, a staff user who can access RMS reconciliation and QBO mapping/review surfaces

Sample linked-data expectations:

- Riverside customer is the source of truth
- linked account must exist in `customer_corecredit_accounts`
- masked identifiers only should appear in UI
- program availability should be tenant-realistic

## Secret handling

Credentials belong only in:

- `server/.env` for local operator validation
- deployment/runtime secret stores for hosted validation
- CI/secret-management systems if a controlled remote validation pass is later required

Credentials must never be:

- committed to git
- placed in `client/.env`
- logged in raw form
- pasted into screenshots, tickets, or receipts

Safe confirmation steps:

- run `npm run validate:corecard:sandbox` or `npm run validate:corecard:live`
- confirm the script shows required vars present without printing full secret values
- confirm Riverside starts without “CoreCard integration is not configured” behavior
- confirm UI-facing payloads remain masked

Rotation/removal after validation:

- remove sandbox/live credentials from local `server/.env`
- rotate test credentials if they were shared with multiple operators
- rotate webhook secrets if a temporary test secret was created
- capture who used the credentials and when validation occurred

## Validation sequence

Run in this exact order:

1. CoreCard config preflight
2. Auth/token test
3. Linked account read test
4. Program eligibility test
5. Financed purchase test
6. RMS 90 / promo program test if tenant supports it
7. RMS payment collection test
8. Refund/reversal test
9. Webhook delivery/verification test
10. Repair polling / sync-health fallback test
11. Exception / retry test
12. Reconciliation test
13. QBO-sensitive verification review

Do not run live financial actions out of order.

## Step-by-step validation

### 1. CoreCard config preflight

Preconditions:

- `server/.env` or runtime env is populated
- operator has shell access to the Riverside host

Action:

- run `npm run validate:corecard:sandbox` or `npm run validate:corecard:live`

Expected Riverside behavior:

- preflight reports required vars present
- webhook and polling settings are visible for review

Expected CoreCard-side behavior:

- none; this step should not hit CoreCard

Expected RMS workspace visibility:

- none required

Expected receipt behavior:

- none

Expected logging/audit behavior:

- shell output only, no live transaction logs

Pass/fail criteria:

- pass if all required vars are present and mode-specific warnings are understood
- fail if any required var is missing or obviously pointed at the wrong environment

Rollback/recovery:

- stop immediately and correct env/config before proceeding

### 2. Auth/token test

Preconditions:

- Riverside API running with CoreCard env vars
- one operator with Back Office RMS visibility

Action:

- open a linked customer in Customers → RMS Charge
- load balances/account summary or programs for a linked account

Expected Riverside behavior:

- the first live CoreCard-backed request succeeds without exposing credentials
- account summary/programs load normally

Expected CoreCard-side behavior:

- token grant and at least one read call recorded in tenant logs if available

Expected RMS workspace visibility:

- masked account, account status, balances/history if supported

Expected receipt behavior:

- none

Expected logging/audit behavior:

- server logs show success or understandable auth failure
- no raw secret values in logs

Pass/fail criteria:

- pass if the tenant accepts auth and Riverside loads a live account read
- fail if auth is rejected, loops, times out consistently, or logs are too opaque

Rollback/recovery:

- if credentials are wrong, stop and correct them before continuing

### 3. Linked account read test

Preconditions:

- at least one Riverside customer linked to a real CoreCard account

Action:

- in Back Office RMS Charge, open the linked account
- in POS RMS Charge, view the same customer if permissions allow

Expected Riverside behavior:

- balances, status, restrictions, recent activity, and masked identifiers render correctly
- no unmasked PAN/CVV appears anywhere

Expected CoreCard-side behavior:

- account summary / balances / transaction read activity only

Expected RMS workspace visibility:

- Back Office shows the richer linked-account view
- POS shows the slim masked summary only

Expected receipt behavior:

- none

Expected logging/audit behavior:

- standard read logs only

Pass/fail criteria:

- pass if the linked customer resolves correctly and all identifiers remain masked
- fail if name-only fallback appears to be in use or masking is broken

Rollback/recovery:

- if account linkage is wrong, stop validation and correct the linked account first

### 4. Program eligibility test

Preconditions:

- linked account with known program eligibility

Action:

- from POS, start RMS Charge tender flow for the active customer
- inspect eligible programs

Expected Riverside behavior:

- one unified RMS Charge tender
- program selection appears after account resolution
- only eligible programs are shown

Expected CoreCard-side behavior:

- live program eligibility lookup

Expected RMS workspace visibility:

- programs visible in Back Office and/or POS as appropriate

Expected receipt behavior:

- none yet

Expected logging/audit behavior:

- read-only request logs, redacted

Pass/fail criteria:

- pass if Standard and RMS 90 visibility matches tenant expectations
- fail if ineligible programs appear or eligible programs are missing without explanation

Rollback/recovery:

- stop before posting any live transaction if eligibility looks wrong

### 5. Financed purchase test

Preconditions:

- active POS register session
- linked customer with a valid account and available credit
- a small, intentionally chosen validation item

Action:

- attach the customer to the sale
- choose RMS Charge
- resolve the account
- select Standard or the appropriate program
- complete checkout

Expected Riverside behavior:

- checkout succeeds only after host posting succeeds
- transaction metadata stores tender family, program label, masked account, host reference, and posting status

Expected CoreCard-side behavior:

- one purchase post created with a tenant-side reference/auth if supported

Expected RMS workspace visibility:

- new RMS purchase record appears with `posted` status and host reference

Expected receipt behavior:

- receipt prints:
  - Tender: RMS Charge
  - saved program label
  - masked account if available
  - host reference if available

Expected logging/audit behavior:

- audit trail for purchase post and selection metadata
- redacted request/response logging only

Pass/fail criteria:

- pass if host-gated checkout succeeds and persisted metadata/receipt wording are correct
- fail if checkout falsely succeeds without a host post or the receipt wording is wrong

Rollback/recovery:

- if the host post fails, do not retry blindly; review exception state first

### 6. RMS 90 / promo program test

Preconditions:

- tenant has a real promo/RMS 90 eligible account

Action:

- repeat the financed purchase with the promo program

Expected Riverside behavior:

- saved program label remains program-driven, not tender-code-driven

Expected CoreCard-side behavior:

- purchase is posted using the selected eligible program

Expected RMS workspace visibility:

- record shows the correct program label and host reference

Expected receipt behavior:

- receipt reflects the saved promo label

Expected logging/audit behavior:

- standard purchase audit trail

Pass/fail criteria:

- pass if Riverside and CoreCard agree on the selected program
- fail if RMS 90 is inferred incorrectly or misposted

Rollback/recovery:

- if the promo program is not available, stop and document that the tenant does not currently support this case

### 7. RMS payment collection test

Preconditions:

- linked customer with a valid RMS/CoreCard account
- known small payment amount approved for validation

Action:

- use the RMS payment collection flow with the internal RMS CHARGE PAYMENT line
- complete a cash or check collection

Expected Riverside behavior:

- payment collection succeeds only after live host payment posting succeeds
- payment-specific receipt wording is preserved

Expected CoreCard-side behavior:

- one payment post created against the linked account

Expected RMS workspace visibility:

- RMS record appears as `payment` with `posted` status and host reference

Expected receipt behavior:

- payment receipt/summary shows RMS collection wording and reference

Expected logging/audit behavior:

- payment post audit event recorded

Pass/fail criteria:

- pass if the payment succeeds cleanly and does not masquerade as a financed sale
- fail if it silently succeeds after a host failure

Rollback/recovery:

- if host payment fails, inspect exception state before retrying

### 8. Refund / reversal test

Preconditions:

- one posted validation purchase or payment that CoreCard sandbox/live permits reversing
- manager/admin approval path available if required

Action:

- perform one correction scenario:
  - financed purchase refund or reversal
  - RMS payment reversal if the tenant supports it

Expected Riverside behavior:

- follow-on action uses stored host references
- audit trail is recorded

Expected CoreCard-side behavior:

- linked refund/reversal transaction against the original host reference

Expected RMS workspace visibility:

- record state transitions to `refunded` or `reversed`

Expected receipt behavior:

- any reversal/refund reference shown where Riverside currently exposes it

Expected logging/audit behavior:

- refund/reversal audit event

Pass/fail criteria:

- pass if the correction links back to the original host reference cleanly
- fail if Riverside cannot correlate the follow-on action to the original transaction

Rollback/recovery:

- stop immediately if the tenant shows duplicate or contradictory follow-on actions

### 9. Webhook delivery / verification test

Preconditions:

- CoreCard webhook endpoint reachable
- webhook secret configured correctly

Action:

- perform a transaction that should generate a webhook
- confirm Riverside receives it
- if the sandbox supports replay, replay the same event once

Expected Riverside behavior:

- webhook is accepted and processed once
- replay is idempotent

Expected CoreCard-side behavior:

- delivery attempts visible in the tenant or operator tooling if available

Expected RMS workspace visibility:

- posting status updates to the final state
- webhook health remains normal

Expected receipt behavior:

- unchanged

Expected logging/audit behavior:

- redacted event log row in `corecredit_event_log`
- verification result visible in logs

Pass/fail criteria:

- pass if Riverside processes the event and ignores replay duplicates safely
- fail if verification is broken or replay creates duplicate effects

Rollback/recovery:

- if the webhook secret is wrong, disable further tenant sends until verification is corrected

### 10. Repair polling / sync-health fallback test

Preconditions:

- repair polling enabled

Action:

- temporarily rely on polling instead of immediate webhook completion, if the tenant allows it
- review `Customers → RMS Charge → Sync health`

Expected Riverside behavior:

- sync health updates
- last repair poll timestamp moves forward
- stale or failed states are surfaced clearly

Expected CoreCard-side behavior:

- read-only refresh calls only

Expected RMS workspace visibility:

- sync-health / stale account indicators update

Expected receipt behavior:

- none

Expected logging/audit behavior:

- repair poll summary logs

Pass/fail criteria:

- pass if Riverside converges back to the correct state without duplicate financial effects
- fail if polling creates duplicate posts or never resolves stale state

Rollback/recovery:

- if repair polling behaves unexpectedly, stop validation and disable further live actions

### 11. Exception / retry test

Preconditions:

- one intentionally failed or blocked host case if sandbox behavior allows it

Action:

- review the exception in Back Office RMS Charge
- retry only once after correcting the cause

Expected Riverside behavior:

- exception queue shows the failure
- retry is permission-gated and auditable

Expected CoreCard-side behavior:

- one corrected retry attempt if applicable

Expected RMS workspace visibility:

- exception moves from active to resolved or clearly remains failed

Expected receipt behavior:

- none unless the retry corresponds to a customer-facing correction flow

Expected logging/audit behavior:

- failed host post audit
- retry audit

Pass/fail criteria:

- pass if the exception is understandable and retry behavior is controlled
- fail if retrying obscures the original failure or duplicates host effects

Rollback/recovery:

- do not keep retrying; capture logs and stop after one controlled retry attempt

### 12. Reconciliation test

Preconditions:

- at least one validated RMS purchase/payment present

Action:

- open Customers → RMS Charge → Reconciliation
- run manual reconciliation

Expected Riverside behavior:

- reconciliation run completes
- RMS vs CoreCard vs QBO-support expectations are visible

Expected CoreCard-side behavior:

- read-only comparison activity only

Expected RMS workspace visibility:

- reconciliation run appears with mismatch/support details

Expected receipt behavior:

- none

Expected logging/audit behavior:

- reconciliation run log entry

Pass/fail criteria:

- pass if the run completes and results are intelligible
- fail if all items are opaque or obviously mismatched without explanation

Rollback/recovery:

- if mismatches appear, stop further live actions until the cause is understood

### 13. QBO-sensitive verification

Preconditions:

- at least one financed purchase and one RMS payment collection validated

Action:

- inspect Riverside-visible RMS reconciliation/QBO support surfaces
- if the shop uses QBO staging, review the relevant daily journal proposal separately

Expected Riverside behavior:

- financed purchases still preserve normal sale behavior and expose `RMS_CHARGE_FINANCING_CLEARING`
- RMS payment collection exposes `RMS_R2S_PAYMENT_CLEARING`
- refund/reversal support views appear consistent

Expected CoreCard-side behavior:

- none beyond the already-posted host actions

Expected RMS workspace visibility:

- QBO-support summary reflects financing clearing vs payment clearing

Expected receipt behavior:

- unchanged

Expected logging/audit behavior:

- none beyond normal reconciliation/audit entries

Pass/fail criteria:

- pass if Riverside shows the expected clearing path choices and underlying sale behavior remains intact
- fail if RMS payment collection looks like retail revenue or financed sales lose normal sale semantics

Rollback/recovery:

- if the accounting path looks wrong, stop and escalate before any further live validation

## Concise smoke checklist

Run this in one controlled operator session:

1. Auth/token
   - run `npm run validate:corecard:sandbox`
   - load one linked account summary
   - confirm bad-credential behavior is understandable if you intentionally test it in a separate window
2. Linked account lookup
   - open a linked RMS customer
   - verify balances/programs load
   - verify masking in UI
3. Financed purchase
   - complete one Standard RMS Charge sale
   - verify host-gated success
   - verify metadata, receipt wording, and host reference
4. Payment collection
   - complete one RMS payment collection
   - verify payment receipt/reference and RMS record
5. Refund/reversal
   - perform one supported correction scenario
   - verify stored host linkage and RMS workspace state
6. Webhook
   - confirm a webhook lands
   - if supported, replay once and confirm idempotent handling
7. Reconciliation
   - run/view reconciliation
   - confirm financing/payment clearing support looks sane

## QBO-specific validation notes

Confirm these during sandbox/live validation:

- financed purchase still preserves the underlying sale behavior for revenue, tax, and COGS handling
- RMS financing support surfaces show `RMS_CHARGE_FINANCING_CLEARING`
- RMS payment collection support surfaces show `RMS_R2S_PAYMENT_CLEARING`
- refund/reversal support appears consistent with the original host-linked action

What Riverside can verify directly:

- RMS workspace reconciliation/support summaries
- stored posting metadata
- RMS record kind and posting status
- receipt wording
- visible clearing-path support markers

What still requires external accounting confirmation later:

- actual QBO journal sync output in the accounting system
- downstream accounting signoff by finance
- any tenant-specific posting/settlement nuances outside Riverside

## Safety and rollback

Stop validation immediately when:

- token/auth behavior is inconsistent
- unmasked account data appears anywhere
- checkout/payment collection succeeds without a confirmed host post
- webhook verification appears misconfigured
- duplicate live financial effects are suspected
- reconciliation exposes unexplained high-severity mismatches

How to disable webhook processing safely:

- remove or change the webhook route configuration on the CoreCard side first
- then unset or rotate `RIVERSIDE_CORECARD_WEBHOOK_SECRET`
- keep `RIVERSIDE_CORECARD_WEBHOOK_ALLOW_UNSIGNED=false`

How to revert env changes:

- stop the server
- restore the prior `server/.env`
- remove temporary sandbox/live values
- restart the server in normal local or fake-host mode

How to switch back to fake-host/local mode:

- unset sandbox/live CoreCard credentials from `server/.env`
- run `npm run dev:e2e`
- use the fake-host Playwright suite again

How to identify and isolate partial/failed validation records:

- review Customers → RMS Charge:
  - Exceptions
  - Transactions
  - Reconciliation
  - Sync health
- capture the RMS record id, host reference, posting status, and exception id
- do not reuse the same account/test case blindly until the failed record is understood

## Post-validation checklist

- remove or disable temporary linked test data if it should not remain in production
- confirm no active exceptions remain unintentionally open
- confirm no RMS records are stuck in failed/pending status without an owner
- confirm webhook verification is healthy
- confirm sync-health and repair polling timestamps look sane
- confirm reconciliation no longer shows unexplained mismatches
- remove sandbox/live secrets from local machines where they are no longer needed
- rotate any temporary test credentials or webhook secrets
- capture screenshots, RMS record ids, host references, audit log references, and any relevant server log excerpts for signoff

## Recommended command summary

Local sandbox preflight:

```bash
npm run validate:corecard:sandbox
```

Local live preflight:

```bash
npm run validate:corecard:live
```

Fake-host regression safety net:

```bash
cd client
E2E_BASE_URL="http://localhost:43173" \
E2E_API_BASE="http://127.0.0.1:43300" \
E2E_CORECARD_BASE="http://127.0.0.1:43400" \
npm run test:e2e:rms
```
