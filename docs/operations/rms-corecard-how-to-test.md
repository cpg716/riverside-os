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

## SECTION 2 — MANUAL UI TEST (LOCAL)

1. Open POS in the browser at `http://localhost:43173`.
2. Sign in as a POS user.
3. Attach a seeded test customer with a linked RMS account.
4. Click `RMS Charge`.
5. When the plan picker appears, select a program.
6. Complete the sale.

Expected:

- transaction succeeds
- plan selection is required before the RMS Charge payment can be added
- receipt shows `RMS Charge` + the selected program
- RMS workspace shows the transaction

Then:

7. Run RMS payment collection.

Expected:

- payment succeeds
- appears in RMS workspace

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

## SECTION 5 — SANDBOX TEST (OPTIONAL)

1. Set real CoreCard env vars.
2. Run:

```bash
npm run validate:corecard:sandbox
```

3. Follow:
   [`/Users/cpg/riverside-os/docs/CORECARD_SANDBOX_LIVE_VALIDATION_RUNBOOK.md`](../CORECARD_SANDBOX_LIVE_VALIDATION_RUNBOOK.md)

Important warnings:

- real transactions may occur
- start with one test customer only

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
- [ ] failure cases behave correctly
- [ ] RMS workspace reflects data
- [ ] E2E tests pass
