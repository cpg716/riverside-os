# How to Test RMS Charge / CoreCard Integration

## SECTION 1 — LOCAL (FAKE HOST) SETUP

Use the existing local E2E stack script:

```bash
bash scripts/e2e-local-stack.sh
```

Repo shortcut:

```bash
npm run dev:e2e
```

This should start:

- Riverside server
- client
- fake CoreCard server

After the stack is up, seed ready-to-use RMS-linked local test customers:

```bash
npm run seed:e2e:rms-fixtures
```

That prints customer names and search labels you can use in POS, including:

- `Local Single`
- `Local Standard`
- `Local RMS90`
- `Local Multi`
- `Local Restricted`

In the POS customer picker, search using phrases such as:

- `RMS90 Local`
- `Single Local`
- `Standard Local`
- `Multi Local`
- `Restricted Local`

Fake-host environment variables used by the script:

- `E2E_API_BASE=http://127.0.0.1:43300`
- `E2E_BASE_URL=http://localhost:43173`
- `E2E_CORECARD_BASE=http://127.0.0.1:43400`
- `RIVERSIDE_ENABLE_E2E_TEST_SUPPORT=1`
- `RIVERSIDE_CORECARD_BASE_URL=http://127.0.0.1:43400`
- `RIVERSIDE_CORECARD_CLIENT_ID=e2e-client`
- `RIVERSIDE_CORECARD_CLIENT_SECRET=e2e-secret`
- `RIVERSIDE_CORECARD_WEBHOOK_SECRET=e2e-corecard-webhook`

Expected local ports:

- client: `http://localhost:43173`
- Riverside server: `http://127.0.0.1:43300`
- fake CoreCard server: `http://127.0.0.1:43400`
- local Docker Postgres: `localhost:5433`

## SECTION 2 — MANUAL RMS CHARGE UI TEST

1. Open POS in the browser at `http://localhost:43173`.
2. Sign in as a POS user.
3. Attach a seeded test customer with a linked RMS account.
4. Click `RMS Charge`.
5. When the picker appears, select the account and program.
6. Complete the sale.

Expected:

- transaction succeeds
- program selection is required before the RMS Charge sale can be added
- receipt shows `RMS Charge` plus the selected program
- RMS workspace shows the transaction
- the RMS record is tracked as the manual RMS Charge workflow unless live
  CoreCard automation has been explicitly enabled

Then:

7. Run RMS payment collection.

Expected:

- payment succeeds
- appears in RMS workspace
- staff can preserve the Reference Number supplied by the R2S/CoreCard portal,
  approval documentation, or finance support notes

Manual RMS Charge is the launch/default workflow. It is not a temporary or
broken state. Staff should enter:

- customer and account
- program
- financed amount or payment amount
- Reference Number when available
- collection tender for RMS Charge payments

The Reference Number is the approval, authorization, merchant, or support
reference supplied by the approved RMS/CoreCard process. It is never a PAN, CVV,
card token, or full account number.

Then:

8. Try a failure scenario by setting the fake host to decline the next purchase for the test account:

```bash
curl -X POST http://127.0.0.1:43400/__admin/scenario \
  -H 'Content-Type: application/json' \
  -d '{"operation":"purchase","account_id":"CC-E2E-STANDARD","response":"insufficient_credit"}'
```

Expected:

- transaction is blocked
- clear error is shown

Reset the fake host when finished:

```bash
curl -X POST http://127.0.0.1:43400/__admin/reset
```

## SECTION 3 — BACK OFFICE TEST

1. Open `Customers → RMS Charge`.
2. View the account.
3. View transactions.
4. View exceptions (if any).
5. View reconciliation.

Expected:

- data matches POS actions
- statuses are correct
- no unexpected failures

## SECTION 4 — RUN E2E TESTS

Command:

```bash
npm run test:e2e:rms
```

What it runs:

- the RMS / CoreCard Playwright suite against the fake CoreCard host
- POS RMS Charge flows
- webhook coverage
- Back Office RMS workspace coverage
- reconciliation and permissions coverage

Expected output:

- all RMS tests pass

If tests fail:

- confirm the local stack is running
- confirm the client is on `http://localhost:43173`
- confirm the API is on `http://127.0.0.1:43300`
- confirm the fake CoreCard server is on `http://127.0.0.1:43400`
- rerun after resetting the fake host

## SECTION 5 — LIVE CORECARD API VALIDATION (OPTIONAL)

1. Save real CoreCard credentials in **Settings → Integrations → CoreCard**. Because live CoreCard runtime configuration is currently loaded at server startup, restart the server before running live/sandbox validation against newly saved values.
2. Run:

```bash
npm run validate:corecard:sandbox
```

3. Follow:
   [`/Users/cpg/riverside-os/docs/CORECARD_SANDBOX_LIVE_VALIDATION_RUNBOOK.md`](../CORECARD_SANDBOX_LIVE_VALIDATION_RUNBOOK.md)

4. Before running any real sandbox/live API action, open **Settings → CoreCard** and
   confirm the pre-live proof panel:

   - credentials saved
   - runtime config loaded
   - restart state current
   - Merchant Number `12115`
   - Merchant ID `11324`
   - unsigned webhooks disabled
   - **Run Probe** returns `source: corecard_live`

5. Optional CLI check for the same read-only probe:

```bash
curl -sS \
  -H "x-riverside-staff-code: <staff-code>" \
  -H "x-riverside-staff-pin: <access-pin>" \
  http://127.0.0.1:3000/api/settings/corecard/tenant-probe
```

6. The probe is go only when it returns:

   - `configured: true`
   - `runtime_loaded: true`
   - `merchant_number: "12115"`
   - `merchant_id: "11324"`
   - `source: "corecard_live"`
   - `api_host_reachable: true`
   - `read_call_succeeded: true`

7. In Customers → RMS Charge or POS RMS Charge, treat `source: corecard_live`
   as live-read proof. Treat `source: manual` as the normal launch workflow, not
   as live API proof. Keep live API posting disabled if any
   `corecard_*_missing/request_failed` warning appears during validation.

Important warnings:

- real transactions may occur
- start with one test customer only
- a visible account/program list is not proof of live CoreCard usage unless the
  source indicator says `corecard_live`
- the Payments workspace is Helcim-focused and is not proof of CoreCard tenant
  readiness
- manual RMS Charge remains operational even when live CoreCard validation is
  not complete

## SECTION 6 — COMMON ISSUES

- fake host not running
  Start `bash scripts/e2e-local-stack.sh` again and confirm port `43400` is in use.
- wrong API base URL
  Use `http://127.0.0.1:43300` for the server and `http://localhost:43173` for the client.
- missing env vars
  Let the local stack script set the fake-host values, or run the sandbox preflight before real-host testing.
- no linked customer
  RMS Charge will not work until the sale uses a customer with a linked RMS account.
- permissions missing
  Make sure the test user has both POS access and Back Office RMS access where needed.

## SECTION 7 — SUCCESS CRITERIA

- [ ] POS RMS Charge purchase works
- [ ] RMS payment collection works
- [ ] Reference Number, account, program, amount, staff actor, and timestamps are visible in RMS history/reporting
- [ ] failure cases behave correctly
- [ ] RMS workspace reflects data
- [ ] E2E tests pass
