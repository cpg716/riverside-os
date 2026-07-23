import { execFileSync } from "node:child_process";
import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  apiBase,
  ensureSessionAuth,
  seedRmsFixture,
  staffCode,
  staffHeaders,
  resetOpenRegisterSessions,
  verifyStaffId,
  type SeedFixtureResponse,
} from "./helpers/rmsCharge";

function databaseUrl(): string {
  const dbName =
    process.env.RIVERSIDE_DB_NAME?.trim() ||
    process.env.E2E_DB_NAME?.trim() ||
    "riverside_os_e2e";
  return (
    process.env.E2E_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    `postgres://postgres:password@127.0.0.1:5433/${dbName}`
  );
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runSql(sql: string): string {
  return execFileSync(
    "psql",
    ["-v", "ON_ERROR_STOP=1", "-q", "-At", "-f", "-", databaseUrl()],
    {
      encoding: "utf8",
      input: sql,
      stdio: ["pipe", "pipe", "pipe"],
    },
  ).trim();
}

function selectJson<T>(sql: string): T {
  return JSON.parse(runSql(sql)) as T;
}

function posHeaders(
  sessionId: string,
  sessionToken: string,
): Record<string, string> {
  return {
    "x-riverside-pos-session-id": sessionId,
    "x-riverside-pos-session-token": sessionToken,
    "x-riverside-station-key": "station-e2e",
  };
}

function moneyToCents(value: string): number {
  return Math.round(Number.parseFloat(value) * 100);
}

function centsToMoney(value: number): string {
  return (value / 100).toFixed(2);
}

type CheckoutPayload = {
  session_id: string;
  operator_staff_id: string;
  primary_salesperson_id: string;
  customer_id: string;
  payment_method: string;
  total_price: string;
  amount_paid: string;
  payment_splits: Array<{
    payment_method: string;
    amount: string;
    metadata?: Record<string, unknown>;
  }>;
  checkout_client_id: string;
  is_tax_exempt: boolean;
  tax_exempt_reason: string;
  exchange_settlement?: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
};

function checkoutPayload(
  fixture: SeedFixtureResponse,
  sessionId: string,
  staffId: string,
  checkoutClientId: string,
  paymentSplits: CheckoutPayload["payment_splits"],
  exchangeSettlement?: Record<string, unknown>,
): CheckoutPayload {
  return {
    session_id: sessionId,
    operator_staff_id: staffId,
    primary_salesperson_id: staffId,
    customer_id: fixture.customer.id,
    payment_method: "cash",
    total_price: fixture.product.unit_price,
    amount_paid: fixture.product.unit_price,
    payment_splits: paymentSplits,
    checkout_client_id: checkoutClientId,
    is_tax_exempt: true,
    tax_exempt_reason: "Out of State",
    exchange_settlement: exchangeSettlement,
    items: [
      {
        product_id: fixture.product.product_id,
        variant_id: fixture.product.variant_id,
        fulfillment: "takeaway",
        quantity: 1,
        unit_price: fixture.product.unit_price,
        unit_cost: fixture.product.unit_cost,
        state_tax: "0.00",
        local_tax: "0.00",
        salesperson_id: staffId,
      },
    ],
  };
}

async function recordCheckout(
  request: APIRequestContext,
  payload: CheckoutPayload,
  sessionToken: string,
): Promise<string> {
  const response = await request.post(
    `${apiBase()}/api/transactions/checkout`,
    {
      headers: {
        ...posHeaders(payload.session_id, sessionToken),
        "Content-Type": "application/json",
      },
      data: payload,
      failOnStatusCode: false,
    },
  );
  const bodyText = await response.text();
  expect(response.status(), bodyText.slice(0, 1200)).toBe(200);
  return (JSON.parse(bodyText) as { transaction_id: string }).transaction_id;
}

async function firstTransactionLineId(
  request: APIRequestContext,
  transactionId: string,
): Promise<string> {
  const response = await request.get(
    `${apiBase()}/api/transactions/${transactionId}`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  const bodyText = await response.text();
  expect(response.status(), bodyText.slice(0, 1200)).toBe(200);
  const body = JSON.parse(bodyText) as {
    items: Array<{ transaction_line_id: string }>;
  };
  expect(body.items[0]?.transaction_line_id).toBeTruthy();
  return body.items[0].transaction_line_id;
}

async function beginReconciliation(
  request: APIRequestContext,
  sessionId: string,
  sessionToken: string,
): Promise<void> {
  const headers = {
    ...posHeaders(sessionId, sessionToken),
    "Content-Type": "application/json",
  };
  const begin = await request.post(
    `${apiBase()}/api/sessions/${sessionId}/begin-reconcile`,
    { headers, data: { active: true }, failOnStatusCode: false },
  );
  expect(begin.status(), await begin.text()).toBe(200);
  const acknowledgement = await request.post(
    `${apiBase()}/api/recovery/station-close-status`,
    {
      headers,
      data: { pending_checkout_count: 0, blocked_checkout_count: 0 },
      failOnStatusCode: false,
    },
  );
  expect(acknowledgement.status(), await acknowledgement.text()).toBe(200);
}

async function closeWithRecoveryWarning(
  request: APIRequestContext,
  sessionId: string,
  sessionToken: string,
): Promise<{ recovery_job_keys?: string[] }> {
  const headers = posHeaders(sessionId, sessionToken);
  const reconciliation = await request.get(
    `${apiBase()}/api/sessions/${sessionId}/reconciliation`,
    { headers, failOnStatusCode: false },
  );
  const reconciliationText = await reconciliation.text();
  expect(reconciliation.status(), reconciliationText.slice(0, 1200)).toBe(200);
  const expectedCash = (
    JSON.parse(reconciliationText) as { expected_cash: string }
  ).expected_cash;
  const close = await request.post(
    `${apiBase()}/api/sessions/${sessionId}/close`,
    {
      headers: { ...headers, "Content-Type": "application/json" },
      data: {
        actual_cash: expectedCash,
        closing_notes: "E2E preserves unfinished exchange settlement",
        closing_comments: "Historical exchange recovery integrity test",
      },
      failOnStatusCode: false,
    },
  );
  const closeText = await close.text();
  expect(close.status(), closeText.slice(0, 1200)).toBe(200);
  const closeBody = JSON.parse(closeText) as {
    till_group_closed: boolean;
    unresolved_close_issues?: { recovery_job_keys?: string[] } | null;
  };
  expect(closeBody.till_group_closed).toBe(true);
  return closeBody.unresolved_close_issues ?? {};
}

test.describe.configure({ mode: "serial" });

test.afterEach(async ({ request }) => {
  await resetOpenRegisterSessions(request);
});

test("historical exchange recovery posts exact ledgers to the current Register and is retry-safe", async ({
  request,
}) => {
  test.setTimeout(180_000);
  const managerStaffId = await verifyStaffId(request);
  const fixture = await seedRmsFixture(
    request,
    "standard_only",
    `Exchange Recovery ${Date.now()}`,
  );
  const origin = await ensureSessionAuth(request);
  const originalClientId = crypto.randomUUID();
  const originalTransactionId = await recordCheckout(
    request,
    checkoutPayload(
      fixture,
      origin.sessionId,
      managerStaffId,
      originalClientId,
      [{ payment_method: "cash", amount: fixture.product.unit_price }],
    ),
    origin.sessionToken,
  );
  const originalLineId = await firstTransactionLineId(
    request,
    originalTransactionId,
  );

  const totalCents = moneyToCents(fixture.product.unit_price);
  expect(totalCents).toBeGreaterThan(1);
  const exchangeCreditCents = Math.floor(totalCents / 2);
  const cashRefundCents = totalCents - exchangeCreditCents;
  const exchangeCredit = centsToMoney(exchangeCreditCents);
  const cashRefund = centsToMoney(cashRefundCents);
  const replacementClientId = crypto.randomUUID();
  const recoveryKey = `exchange:${replacementClientId}`;
  const settlementRequest = {
    original_transaction_id: originalTransactionId,
    exchange_credit_amount: exchangeCredit,
    return_lines: [
      {
        transaction_line_id: originalLineId,
        quantity: 1,
        reason: "E2E historical exchange recovery",
        restock: true,
        refund_subtotal: fixture.product.unit_price,
        refund_state_tax: "0.00",
        refund_local_tax: "0.00",
        refund_total: fixture.product.unit_price,
      },
    ],
    refund_remainder: {
      payment_method: "cash",
      amount: cashRefund,
      tender_amount: cashRefund,
      rounding_adjustment: "0.00",
      final_cash_due: cashRefund,
    },
  };
  const replacementTransactionId = await recordCheckout(
    request,
    checkoutPayload(
      fixture,
      origin.sessionId,
      managerStaffId,
      replacementClientId,
      [
        {
          payment_method: "exchange_credit",
          amount: exchangeCredit,
          metadata: { original_transaction_id: originalTransactionId },
        },
        { payment_method: "cash", amount: cashRefund },
      ],
      settlementRequest,
    ),
    origin.sessionToken,
  );

  expect(
    runSql(
      `SELECT status FROM operational_recovery_job WHERE client_job_key = ${sqlLiteral(recoveryKey)};`,
    ),
  ).toBe("blocked");
  await beginReconciliation(request, origin.sessionId, origin.sessionToken);
  const closeIssues = await closeWithRecoveryWarning(
    request,
    origin.sessionId,
    origin.sessionToken,
  );
  expect(closeIssues.recovery_job_keys).toContain(recoveryKey);
  const archivedCloseIssues = selectJson<{
    recovery_job_keys?: string[];
  }>(`
    SELECT z_report_json->'unresolved_close_issues'
    FROM register_business_day_z_reports
    WHERE primary_register_session_id = ${sqlLiteral(origin.sessionId)}::uuid
    ORDER BY closed_at DESC
    LIMIT 1;
  `);
  expect(archivedCloseIssues.recovery_job_keys).toContain(recoveryKey);
  expect(
    runSql(
      `SELECT (NOT is_open)::text || '|' || lifecycle_status FROM register_sessions WHERE id = ${sqlLiteral(origin.sessionId)}::uuid;`,
    ),
  ).toBe("true|closed");

  const posting = await ensureSessionAuth(request);
  expect(posting.sessionId).not.toBe(origin.sessionId);
  await beginReconciliation(request, posting.sessionId, posting.sessionToken);
  expect(
    runSql(
      `SELECT is_open::text || '|' || lifecycle_status FROM register_sessions WHERE id = ${sqlLiteral(posting.sessionId)}::uuid;`,
    ),
  ).toBe("true|reconciling");

  const originalFingerprint = runSql(
    `SELECT checkout_request_fingerprint FROM transactions WHERE id = ${sqlLiteral(replacementTransactionId)}::uuid;`,
  );
  expect(originalFingerprint).toMatch(/^[0-9a-f]{64}$/);
  runSql(
    `UPDATE transactions SET checkout_request_fingerprint = NULL WHERE id = ${sqlLiteral(replacementTransactionId)}::uuid;`,
  );
  try {
    const rejected = await request.post(
      `${apiBase()}/api/transactions/exchange-settlement-recovery/${encodeURIComponent(recoveryKey)}`,
      {
        headers: {
          ...posHeaders(posting.sessionId, posting.sessionToken),
          "Content-Type": "application/json",
        },
        data: {
          posting_session_id: posting.sessionId,
          manager_staff_id: managerStaffId,
          manager_pin: staffCode(),
          reason:
            "E2E rejects an exchange without immutable checkout provenance",
        },
        failOnStatusCode: false,
      },
    );
    const rejectedText = await rejected.text();
    expect(rejected.status(), rejectedText).toBe(400);
    expect(rejectedText).toContain("provable server checkout provenance");
    const rejectedState = selectJson<{
      status: string;
      relief_count: number;
      audit_count: number;
    }>(`
      SELECT json_build_object(
        'status', status,
        'relief_count', (
          SELECT COUNT(*) FROM payment_transactions
          WHERE metadata->>'kind' IN ('exchange_credit_relief', 'exchange_refund_remainder')
            AND metadata->>'replacement_transaction_id' = ${sqlLiteral(replacementTransactionId)}
        ),
        'audit_count', (
          SELECT COUNT(*) FROM staff_access_log
          WHERE idempotency_key = ${sqlLiteral(`register-exchange-settlement-recovery:${recoveryKey}`)}
        )
      )::text
      FROM operational_recovery_job
      WHERE client_job_key = ${sqlLiteral(recoveryKey)};
    `);
    expect(rejectedState).toEqual({
      status: "blocked",
      relief_count: 0,
      audit_count: 0,
    });
  } finally {
    runSql(
      `UPDATE transactions SET checkout_request_fingerprint = ${sqlLiteral(originalFingerprint)} WHERE id = ${sqlLiteral(replacementTransactionId)}::uuid;`,
    );
  }

  const recover = () =>
    request.post(
      `${apiBase()}/api/transactions/exchange-settlement-recovery/${encodeURIComponent(recoveryKey)}`,
      {
        headers: {
          ...posHeaders(posting.sessionId, posting.sessionToken),
          "Content-Type": "application/json",
        },
        data: {
          posting_session_id: posting.sessionId,
          manager_staff_id: managerStaffId,
          manager_pin: staffCode(),
          reason: "E2E completes the locked historical exchange settlement",
        },
        failOnStatusCode: false,
      },
    );
  const recovered = await recover();
  const recoveredText = await recovered.text();
  expect(recovered.status(), recoveredText.slice(0, 1200)).toBe(200);
  expect(JSON.parse(recoveredText)).toMatchObject({
    status: "ok",
    exchange_credit_amount: exchangeCredit,
    refund_remainder_amount: cashRefund,
  });

  const ledgerState = selectJson<{
    job_status: string;
    resolved_by_staff_id: string;
    resolution_note: string;
    audit_count: number;
    audit_origin_session_id: string;
    audit_posting_session_id: string;
    return_count: number;
    return_session_id: string;
    return_total: string;
    relief_count: number;
    relief_session_id: string;
    relief_payment_amount: string;
    relief_allocation_amount: string;
    refund_count: number;
    refund_session_id: string;
    refund_payment_amount: string;
    refund_allocation_amount: string;
  }>(`
    SELECT json_build_object(
      'job_status', job.status,
      'resolved_by_staff_id', job.resolved_by_staff_id,
      'resolution_note', job.resolution_note,
      'audit_count', (
        SELECT COUNT(*) FROM staff_access_log
        WHERE idempotency_key = ${sqlLiteral(`register-exchange-settlement-recovery:${recoveryKey}`)}
      ),
      'audit_origin_session_id', (
        SELECT metadata->>'origin_session_id' FROM staff_access_log
        WHERE idempotency_key = ${sqlLiteral(`register-exchange-settlement-recovery:${recoveryKey}`)}
      ),
      'audit_posting_session_id', (
        SELECT metadata->>'posting_session_id' FROM staff_access_log
        WHERE idempotency_key = ${sqlLiteral(`register-exchange-settlement-recovery:${recoveryKey}`)}
      ),
      'return_count', (
        SELECT COUNT(*) FROM transaction_return_lines
        WHERE transaction_id = ${sqlLiteral(originalTransactionId)}::uuid
          AND reason = 'E2E historical exchange recovery'
      ),
      'return_session_id', (
        SELECT register_session_id FROM transaction_return_lines
        WHERE transaction_id = ${sqlLiteral(originalTransactionId)}::uuid
          AND reason = 'E2E historical exchange recovery'
        LIMIT 1
      ),
      'return_total', (
        SELECT refund_total::text FROM transaction_return_lines
        WHERE transaction_id = ${sqlLiteral(originalTransactionId)}::uuid
          AND reason = 'E2E historical exchange recovery'
        LIMIT 1
      ),
      'relief_count', (
        SELECT COUNT(*)
        FROM payment_transactions pt
        JOIN payment_allocations pa ON pa.transaction_id = pt.id
        WHERE pa.target_transaction_id = ${sqlLiteral(originalTransactionId)}::uuid
          AND pt.metadata->>'kind' = 'exchange_credit_relief'
          AND pt.metadata->>'replacement_transaction_id' = ${sqlLiteral(replacementTransactionId)}
      ),
      'relief_session_id', (
        SELECT pt.session_id
        FROM payment_transactions pt
        JOIN payment_allocations pa ON pa.transaction_id = pt.id
        WHERE pa.target_transaction_id = ${sqlLiteral(originalTransactionId)}::uuid
          AND pt.metadata->>'kind' = 'exchange_credit_relief'
          AND pt.metadata->>'replacement_transaction_id' = ${sqlLiteral(replacementTransactionId)}
        LIMIT 1
      ),
      'relief_payment_amount', (
        SELECT pt.amount::text
        FROM payment_transactions pt
        JOIN payment_allocations pa ON pa.transaction_id = pt.id
        WHERE pa.target_transaction_id = ${sqlLiteral(originalTransactionId)}::uuid
          AND pt.metadata->>'kind' = 'exchange_credit_relief'
          AND pt.metadata->>'replacement_transaction_id' = ${sqlLiteral(replacementTransactionId)}
        LIMIT 1
      ),
      'relief_allocation_amount', (
        SELECT pa.amount_allocated::text
        FROM payment_transactions pt
        JOIN payment_allocations pa ON pa.transaction_id = pt.id
        WHERE pa.target_transaction_id = ${sqlLiteral(originalTransactionId)}::uuid
          AND pt.metadata->>'kind' = 'exchange_credit_relief'
          AND pt.metadata->>'replacement_transaction_id' = ${sqlLiteral(replacementTransactionId)}
        LIMIT 1
      ),
      'refund_count', (
        SELECT COUNT(*)
        FROM payment_transactions pt
        JOIN payment_allocations pa ON pa.transaction_id = pt.id
        WHERE pa.target_transaction_id = ${sqlLiteral(originalTransactionId)}::uuid
          AND pt.metadata->>'kind' = 'exchange_refund_remainder'
          AND pt.metadata->>'replacement_transaction_id' = ${sqlLiteral(replacementTransactionId)}
      ),
      'refund_session_id', (
        SELECT pt.session_id
        FROM payment_transactions pt
        JOIN payment_allocations pa ON pa.transaction_id = pt.id
        WHERE pa.target_transaction_id = ${sqlLiteral(originalTransactionId)}::uuid
          AND pt.metadata->>'kind' = 'exchange_refund_remainder'
          AND pt.metadata->>'replacement_transaction_id' = ${sqlLiteral(replacementTransactionId)}
        LIMIT 1
      ),
      'refund_payment_amount', (
        SELECT pt.amount::text
        FROM payment_transactions pt
        JOIN payment_allocations pa ON pa.transaction_id = pt.id
        WHERE pa.target_transaction_id = ${sqlLiteral(originalTransactionId)}::uuid
          AND pt.metadata->>'kind' = 'exchange_refund_remainder'
          AND pt.metadata->>'replacement_transaction_id' = ${sqlLiteral(replacementTransactionId)}
        LIMIT 1
      ),
      'refund_allocation_amount', (
        SELECT pa.amount_allocated::text
        FROM payment_transactions pt
        JOIN payment_allocations pa ON pa.transaction_id = pt.id
        WHERE pa.target_transaction_id = ${sqlLiteral(originalTransactionId)}::uuid
          AND pt.metadata->>'kind' = 'exchange_refund_remainder'
          AND pt.metadata->>'replacement_transaction_id' = ${sqlLiteral(replacementTransactionId)}
        LIMIT 1
      )
    )::text
    FROM operational_recovery_job job
    WHERE job.client_job_key = ${sqlLiteral(recoveryKey)};
  `);
  expect(ledgerState).toMatchObject({
    job_status: "resolved",
    resolved_by_staff_id: managerStaffId,
    resolution_note: expect.stringContaining(
      "E2E completes the locked historical exchange settlement",
    ),
    audit_count: 1,
    audit_origin_session_id: origin.sessionId,
    audit_posting_session_id: posting.sessionId,
    return_count: 1,
    return_session_id: posting.sessionId,
    return_total: fixture.product.unit_price,
    relief_count: 1,
    relief_session_id: posting.sessionId,
    relief_payment_amount: `-${exchangeCredit}`,
    relief_allocation_amount: `-${exchangeCredit}`,
    refund_count: 1,
    refund_session_id: posting.sessionId,
    refund_payment_amount: `-${cashRefund}`,
    refund_allocation_amount: `-${cashRefund}`,
  });

  const retried = await recover();
  const retriedText = await retried.text();
  expect(retried.status(), retriedText.slice(0, 1200)).toBe(200);
  expect(JSON.parse(retriedText)).toMatchObject({
    status: "ok",
    idempotent_replay: true,
  });
  const retryCounts = selectJson<{
    audit_count: number;
    return_count: number;
    relief_count: number;
    refund_count: number;
  }>(`
    SELECT json_build_object(
      'audit_count', (
        SELECT COUNT(*) FROM staff_access_log
        WHERE idempotency_key = ${sqlLiteral(`register-exchange-settlement-recovery:${recoveryKey}`)}
      ),
      'return_count', (
        SELECT COUNT(*) FROM transaction_return_lines
        WHERE transaction_id = ${sqlLiteral(originalTransactionId)}::uuid
          AND reason = 'E2E historical exchange recovery'
      ),
      'relief_count', (
        SELECT COUNT(*) FROM payment_transactions
        WHERE metadata->>'kind' = 'exchange_credit_relief'
          AND metadata->>'replacement_transaction_id' = ${sqlLiteral(replacementTransactionId)}
      ),
      'refund_count', (
        SELECT COUNT(*) FROM payment_transactions
        WHERE metadata->>'kind' = 'exchange_refund_remainder'
          AND metadata->>'replacement_transaction_id' = ${sqlLiteral(replacementTransactionId)}
      )
    )::text;
  `);
  expect(retryCounts).toEqual({
    audit_count: 1,
    return_count: 1,
    relief_count: 1,
    refund_count: 1,
  });
});
