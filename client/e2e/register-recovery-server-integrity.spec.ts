import { execFileSync } from "node:child_process";
import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  apiBase,
  ensureSessionAuth,
  seedRmsFixture,
  staffCode,
  staffHeaders,
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

function installAuditFailureTrigger(
  eventKind: string,
  clientJobKey: string,
): () => void {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const functionName = `e2e_fail_recovery_audit_${suffix}`;
  const triggerName = `e2e_fail_recovery_audit_${suffix}`;
  runSql(`
    CREATE FUNCTION public.${functionName}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.event_kind = ${sqlLiteral(eventKind)}
         AND NEW.metadata->>'client_job_key' = ${sqlLiteral(clientJobKey)} THEN
        RAISE EXCEPTION 'E2E forced recovery audit failure';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER ${triggerName}
    BEFORE INSERT ON public.staff_access_log
    FOR EACH ROW EXECUTE FUNCTION public.${functionName}();
  `);
  return () => {
    runSql(`
      DROP TRIGGER IF EXISTS ${triggerName} ON public.staff_access_log;
      DROP FUNCTION IF EXISTS public.${functionName}();
    `);
  };
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
  items: Array<Record<string, unknown>>;
};

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

async function ensureOpenPrimarySession(
  request: APIRequestContext,
): Promise<{ sessionId: string; sessionToken: string }> {
  const list = await request.get(`${apiBase()}/api/sessions/list-open`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  if (list.status() !== 200) return ensureSessionAuth(request);
  const rows = (await list.json()) as Array<{
    session_id?: string;
    id?: string;
    register_lane?: number;
  }>;
  const primary = rows.find((row) => row.register_lane === 1) ?? rows[0];
  const sessionId = (primary?.session_id ?? primary?.id ?? "").trim();
  if (!sessionId) return ensureSessionAuth(request);

  const reopen = await request.post(
    `${apiBase()}/api/sessions/${sessionId}/begin-reconcile`,
    {
      headers: { ...staffHeaders(), "Content-Type": "application/json" },
      data: { active: false },
      failOnStatusCode: false,
    },
  );
  const reopenText = await reopen.text();
  expect(reopen.status(), reopenText.slice(0, 1000)).toBe(200);
  const attach = await request.post(
    `${apiBase()}/api/sessions/${sessionId}/attach`,
    {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
        "x-riverside-station-key": "station-e2e",
      },
      failOnStatusCode: false,
    },
  );
  const attachText = await attach.text();
  expect(attach.status(), attachText.slice(0, 1000)).toBe(200);
  return {
    sessionId,
    sessionToken:
      (JSON.parse(attachText) as { pos_api_token?: string }).pos_api_token ??
      "",
  };
}

function checkoutPayload(
  fixture: SeedFixtureResponse,
  sessionId: string,
  staffId: string,
  checkoutClientId: string,
): CheckoutPayload {
  return {
    session_id: sessionId,
    operator_staff_id: staffId,
    primary_salesperson_id: staffId,
    customer_id: fixture.customer.id,
    payment_method: "cash",
    total_price: fixture.product.unit_price,
    amount_paid: fixture.product.unit_price,
    payment_splits: [
      { payment_method: "cash", amount: fixture.product.unit_price },
    ],
    checkout_client_id: checkoutClientId,
    is_tax_exempt: true,
    tax_exempt_reason: "Out of State",
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
  expect(response.status(), bodyText.slice(0, 1000)).toBe(200);
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
  expect(response.status(), bodyText.slice(0, 1000)).toBe(200);
  const detail = JSON.parse(bodyText) as {
    items: Array<{ transaction_line_id: string }>;
  };
  expect(detail.items[0]?.transaction_line_id).toBeTruthy();
  return detail.items[0].transaction_line_id;
}

async function upsertRecovery(
  request: APIRequestContext,
  sessionId: string,
  sessionToken: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await request.post(`${apiBase()}/api/recovery`, {
    headers: {
      ...posHeaders(sessionId, sessionToken),
      "Content-Type": "application/json",
    },
    data: body,
    failOnStatusCode: false,
  });
  const bodyText = await response.text();
  expect(response.status(), bodyText.slice(0, 1000)).toBe(200);
}

test.describe.configure({ mode: "serial" });

test("external checkout recovery requires exact final payment evidence and commits one audit", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const { sessionId, sessionToken } = await ensureOpenPrimarySession(request);
  const managerStaffId = await verifyStaffId(request);
  const fixture = await seedRmsFixture(
    request,
    "standard_only",
    `External Recovery ${Date.now()}`,
  );
  const wrongFixture = await seedRmsFixture(
    request,
    "standard_only",
    `External Recovery Wrong ${Date.now()}`,
  );
  const checkoutClientId = crypto.randomUUID();
  const providerTransactionId = `e2e-external-${crypto.randomUUID()}`;
  const providerPaymentId = `e2e-payment-${crypto.randomUUID()}`;
  const attemptId = crypto.randomUUID();
  const recoveryKey = `e2e-external-recovery-${crypto.randomUUID()}`;
  const reason = "E2E exact externally reconciled Helcim approval";
  const totalCents = Math.round(Number(fixture.product.unit_price) * 100);
  const paymentAmount = (Math.max(1, Math.floor(totalCents / 2)) / 100).toFixed(
    2,
  );
  const payload = checkoutPayload(
    fixture,
    sessionId,
    managerStaffId,
    checkoutClientId,
  );
  payload.payment_method = "card_terminal";
  payload.amount_paid = paymentAmount;
  payload.items[0] = { ...payload.items[0], fulfillment: "special_order" };
  payload.payment_splits = [
    {
      payment_method: "card_terminal",
      amount: paymentAmount,
      metadata: {
        payment_provider: "helcim",
        payment_provider_attempt_id: attemptId,
        provider_payment_id: providerPaymentId,
        provider_transaction_id: providerTransactionId,
        provider_status: "approved",
      },
    },
  ];
  runSql(`
    INSERT INTO payment_provider_attempts (
      id, provider, status, amount_cents, currency, register_session_id,
      staff_id, idempotency_key, provider_payment_id, provider_transaction_id,
      raw_audit_reference, completed_at, checkout_client_id
    ) VALUES (
      ${sqlLiteral(attemptId)}::uuid,
      'helcim',
      'approved',
      ROUND(${sqlLiteral(paymentAmount)}::numeric * 100)::bigint,
      'usd',
      ${sqlLiteral(sessionId)}::uuid,
      ${sqlLiteral(managerStaffId)}::uuid,
      ${sqlLiteral(`external-recovery:${attemptId}`)},
      ${sqlLiteral(providerPaymentId)},
      ${sqlLiteral(providerTransactionId)},
      ${sqlLiteral(`helcim:cardPurchase:${providerTransactionId}`)},
      now(),
      ${sqlLiteral(checkoutClientId)}::uuid
    );
  `);
  const transactionId = await recordCheckout(request, payload, sessionToken);
  const transactionDisplayId = runSql(`
    SELECT display_id FROM transactions WHERE id = ${sqlLiteral(transactionId)}::uuid;
  `);
  const wrongClientId = crypto.randomUUID();
  const wrongTransactionId = await recordCheckout(
    request,
    checkoutPayload(wrongFixture, sessionId, managerStaffId, wrongClientId),
    sessionToken,
  );
  const wrongTransactionDisplayId = runSql(`
    SELECT display_id FROM transactions WHERE id = ${sqlLiteral(wrongTransactionId)}::uuid;
  `);
  await upsertRecovery(request, sessionId, sessionToken, {
    client_job_key: recoveryKey,
    kind: "checkout_unconfirmed",
    status: "blocked",
    register_session_id: sessionId,
    checkout_client_id: checkoutClientId,
    label: "E2E exact external checkout recovery",
    payload: { payload },
  });

  const resolveExternal = (
    clientJobKey = recoveryKey,
    targetDisplayId = transactionDisplayId,
    managerReason = reason,
  ) =>
    request.post(
      `${apiBase()}/api/recovery/${encodeURIComponent(clientJobKey)}/resolve-external`,
      {
        headers: { ...staffHeaders(), "Content-Type": "application/json" },
        data: {
          manager_staff_id: managerStaffId,
          manager_pin: staffCode(),
          reason: managerReason,
          target_transaction_display_id: targetDisplayId,
          provider_transaction_id: providerTransactionId,
        },
        failOnStatusCode: false,
      },
    );

  const duplicatePaymentId = crypto.randomUUID();
  runSql(`
    INSERT INTO payment_transactions (
      id, session_id, payer_id, payment_method, amount, status,
      payment_provider, provider_payment_id, provider_status,
      provider_transaction_id
    ) VALUES (
      ${sqlLiteral(duplicatePaymentId)}::uuid,
      ${sqlLiteral(sessionId)}::uuid,
      ${sqlLiteral(wrongFixture.customer.id)}::uuid,
      'card_terminal',
      ${sqlLiteral(paymentAmount)}::numeric,
      'success',
      'HELCIM',
      ${sqlLiteral(providerPaymentId)},
      'approved',
      ${sqlLiteral(providerTransactionId)}
    );
  `);
  try {
    const duplicateProviderReference = await resolveExternal();
    const duplicateProviderReferenceText =
      await duplicateProviderReference.text();
    expect(
      duplicateProviderReference.status(),
      duplicateProviderReferenceText,
    ).toBe(400);
    expect(duplicateProviderReferenceText).toContain(
      "exactly one normalized Helcim payment ledger row",
    );
  } finally {
    runSql(`
      DELETE FROM payment_transactions
      WHERE id = ${sqlLiteral(duplicatePaymentId)}::uuid;
    `);
  }

  const wrongTarget = await resolveExternal(
    recoveryKey,
    wrongTransactionDisplayId,
  );
  const wrongTargetText = await wrongTarget.text();
  expect(wrongTarget.status(), wrongTargetText).toBe(400);
  expect(wrongTargetText).toContain("Checkout recovery remains blocked");

  const mismatchedRecoveryKey = `e2e-external-mismatch-${crypto.randomUUID()}`;
  await upsertRecovery(request, sessionId, sessionToken, {
    client_job_key: mismatchedRecoveryKey,
    kind: "checkout_unconfirmed",
    status: "blocked",
    register_session_id: sessionId,
    checkout_client_id: checkoutClientId,
    label: "E2E mismatched external checkout recovery",
    payload: { payload },
  });
  runSql(`
    UPDATE operational_recovery_job
    SET checkout_client_id = ${sqlLiteral(crypto.randomUUID())}::uuid
    WHERE client_job_key = ${sqlLiteral(mismatchedRecoveryKey)};
  `);
  const wrongJob = await resolveExternal(mismatchedRecoveryKey);
  const wrongJobText = await wrongJob.text();
  expect(wrongJob.status(), wrongJobText).toBe(400);
  expect(wrongJobText).toContain("identify different checkouts");
  runSql(`
    DELETE FROM operational_recovery_job
    WHERE client_job_key = ${sqlLiteral(mismatchedRecoveryKey)};
  `);

  const targetIdentityEvidence = selectJson<{
    register_session_id: string;
    checkout_client_id: string;
    checkout_request_fingerprint: string;
    checkout_payment_fingerprint: string;
  }>(`
    SELECT json_build_object(
      'register_session_id', register_session_id,
      'checkout_client_id', checkout_client_id,
      'checkout_request_fingerprint', checkout_request_fingerprint,
      'checkout_payment_fingerprint', checkout_payment_fingerprint
    )::text
    FROM transactions
    WHERE id = ${sqlLiteral(transactionId)}::uuid;
  `);
  expect(targetIdentityEvidence).toMatchObject({
    register_session_id: sessionId,
    checkout_client_id: checkoutClientId,
    checkout_request_fingerprint: expect.any(String),
    checkout_payment_fingerprint: expect.any(String),
  });
  runSql(`
    UPDATE transactions
    SET register_session_id = NULL,
        checkout_client_id = NULL,
        checkout_request_fingerprint = NULL,
        checkout_payment_fingerprint = NULL
    WHERE id = ${sqlLiteral(transactionId)}::uuid;
  `);
  try {
    const missingTargetEvidence = await resolveExternal();
    const missingTargetEvidenceText = await missingTargetEvidence.text();
    expect(
      missingTargetEvidence.status(),
      missingTargetEvidenceText,
    ).toBe(400);
    expect(missingTargetEvidenceText).toContain(
      "different or unknown Register session",
    );

    runSql(`
      UPDATE transactions
      SET register_session_id = ${sqlLiteral(sessionId)}::uuid
      WHERE id = ${sqlLiteral(transactionId)}::uuid;
    `);
    const missingCheckoutEvidence = await resolveExternal();
    const missingCheckoutEvidenceText = await missingCheckoutEvidence.text();
    expect(
      missingCheckoutEvidence.status(),
      missingCheckoutEvidenceText,
    ).toBe(400);
    expect(missingCheckoutEvidenceText).toContain(
      "different or unknown checkout",
    );
  } finally {
    runSql(`
      UPDATE transactions
      SET register_session_id = ${sqlLiteral(targetIdentityEvidence.register_session_id)}::uuid,
          checkout_client_id = ${sqlLiteral(targetIdentityEvidence.checkout_client_id)}::uuid,
          checkout_request_fingerprint = ${sqlLiteral(targetIdentityEvidence.checkout_request_fingerprint)},
          checkout_payment_fingerprint = ${sqlLiteral(targetIdentityEvidence.checkout_payment_fingerprint)}
      WHERE id = ${sqlLiteral(transactionId)}::uuid;
    `);
  }

  expect(
    selectJson<{ status: string; total_price: string; amount_paid: string }>(`
      SELECT json_build_object(
        'status', status::text,
        'total_price', total_price::text,
        'amount_paid', amount_paid::text
      )::text
      FROM transactions
      WHERE id = ${sqlLiteral(transactionId)}::uuid;
    `),
  ).toEqual({
    status: "open",
    total_price: fixture.product.unit_price,
    amount_paid: paymentAmount,
  });

  runSql(`
    UPDATE transactions
    SET status = 'processing'::order_status
    WHERE id = ${sqlLiteral(transactionId)}::uuid;
  `);
  try {
    const processing = await resolveExternal();
    const processingText = await processing.text();
    expect(processing.status(), processingText).toBe(400);
    expect(processingText).toContain("not the exact committed checkout");
  } finally {
    runSql(`
      UPDATE transactions
      SET status = 'open'::order_status
      WHERE id = ${sqlLiteral(transactionId)}::uuid;
    `);
  }

  runSql(`
    UPDATE payment_transactions
    SET status = 'pending', provider_status = 'pending'
    WHERE provider_transaction_id = ${sqlLiteral(providerTransactionId)};
  `);
  try {
    const nonFinal = await resolveExternal();
    const nonFinalText = await nonFinal.text();
    expect(nonFinal.status(), nonFinalText).toBe(400);
    expect(nonFinalText).toContain("not in a final successful provider state");
  } finally {
    runSql(`
      UPDATE payment_transactions
      SET status = 'success', provider_status = 'approved'
      WHERE provider_transaction_id = ${sqlLiteral(providerTransactionId)};
    `);
  }

  const removeAuditFailure = installAuditFailureTrigger(
    "register_checkout_recovery_external_resolved",
    recoveryKey,
  );
  try {
    const failedAudit = await resolveExternal();
    expect(failedAudit.status(), await failedAudit.text()).toBe(500);
    expect(
      selectJson<{
        status: string;
        transaction_id: string | null;
        audit_count: number;
      }>(`
        SELECT json_build_object(
          'status', job.status,
          'transaction_id', job.transaction_id,
          'audit_count', (
            SELECT COUNT(*) FROM staff_access_log
            WHERE idempotency_key = ${sqlLiteral(`register-checkout-recovery-external:${recoveryKey}:${transactionId}`)}
          )
        )::text
        FROM operational_recovery_job job
        WHERE client_job_key = ${sqlLiteral(recoveryKey)};
      `),
    ).toEqual({ status: "blocked", transaction_id: null, audit_count: 0 });
  } finally {
    removeAuditFailure();
  }

  const resolved = await resolveExternal();
  const resolvedText = await resolved.text();
  expect(resolved.status(), resolvedText).toBe(200);
  expect(JSON.parse(resolvedText)).toMatchObject({
    status: "resolved",
    transaction_id: transactionId,
    transaction_display_id: transactionDisplayId,
    register_session_id: sessionId,
    checkout_client_id: checkoutClientId,
    provider_transaction_id: providerTransactionId,
    idempotent_replay: false,
  });
  expect(
    selectJson<{
      status: string;
      transaction_id: string;
      audit_count: number;
      audit_register_session_id: string;
      audit_checkout_client_id: string;
    }>(`
      SELECT json_build_object(
        'status', job.status,
        'transaction_id', job.transaction_id,
        'audit_count', (
          SELECT COUNT(*) FROM staff_access_log
          WHERE idempotency_key = ${sqlLiteral(`register-checkout-recovery-external:${recoveryKey}:${transactionId}`)}
        ),
        'audit_register_session_id', (
          SELECT metadata->>'register_session_id' FROM staff_access_log
          WHERE idempotency_key = ${sqlLiteral(`register-checkout-recovery-external:${recoveryKey}:${transactionId}`)}
        ),
        'audit_checkout_client_id', (
          SELECT metadata->>'checkout_client_id' FROM staff_access_log
          WHERE idempotency_key = ${sqlLiteral(`register-checkout-recovery-external:${recoveryKey}:${transactionId}`)}
        )
      )::text
      FROM operational_recovery_job job
      WHERE client_job_key = ${sqlLiteral(recoveryKey)};
    `),
  ).toEqual({
    status: "resolved",
    transaction_id: transactionId,
    audit_count: 1,
    audit_register_session_id: sessionId,
    audit_checkout_client_id: checkoutClientId,
  });

  const retried = await resolveExternal(
    recoveryKey,
    transactionDisplayId,
    "E2E retry after the original response was lost",
  );
  const retriedText = await retried.text();
  expect(retried.status(), retriedText).toBe(200);
  expect(JSON.parse(retriedText)).toMatchObject({
    transaction_id: transactionId,
    register_session_id: sessionId,
    checkout_client_id: checkoutClientId,
    idempotent_replay: true,
  });
  expect(
    selectJson<{
      audit_count: number;
      audit_reason: string;
      job_reason: string;
    }>(`
      SELECT json_build_object(
        'audit_count', (
          SELECT COUNT(*) FROM staff_access_log
          WHERE idempotency_key = ${sqlLiteral(`register-checkout-recovery-external:${recoveryKey}:${transactionId}`)}
        ),
        'audit_reason', (
          SELECT metadata->>'reason' FROM staff_access_log
          WHERE idempotency_key = ${sqlLiteral(`register-checkout-recovery-external:${recoveryKey}:${transactionId}`)}
        ),
        'job_reason', resolution_note
      )::text
      FROM operational_recovery_job
      WHERE client_job_key = ${sqlLiteral(recoveryKey)};
    `),
  ).toEqual({ audit_count: 1, audit_reason: reason, job_reason: reason });
});

test("Register recovery remains session-scoped, identity-exact, verifiable, and recoverable after force-close", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const { sessionId, sessionToken } = await ensureOpenPrimarySession(request);
  const managerStaffId = await verifyStaffId(request);
  const firstFixture = await seedRmsFixture(
    request,
    "standard_only",
    `Recovery A ${Date.now()}`,
  );
  const secondFixture = await seedRmsFixture(
    request,
    "standard_only",
    `Recovery B ${Date.now()}`,
  );
  const replayFixture = await seedRmsFixture(
    request,
    "standard_only",
    `Recovery Replay ${Date.now()}`,
  );

  const firstClientId = crypto.randomUUID();
  const secondClientId = crypto.randomUUID();
  const firstPayload = checkoutPayload(
    firstFixture,
    sessionId,
    managerStaffId,
    firstClientId,
  );
  const secondPayload = checkoutPayload(
    secondFixture,
    sessionId,
    managerStaffId,
    secondClientId,
  );
  const firstTransactionId = await recordCheckout(
    request,
    firstPayload,
    sessionToken,
  );
  const secondTransactionId = await recordCheckout(
    request,
    secondPayload,
    sessionToken,
  );
  const firstLineId = await firstTransactionLineId(request, firstTransactionId);

  const publicExchange = await request.post(`${apiBase()}/api/recovery`, {
    headers: {
      ...posHeaders(sessionId, sessionToken),
      "Content-Type": "application/json",
    },
    data: {
      client_job_key: `exchange:${crypto.randomUUID()}`,
      kind: "exchange_settlement",
      status: "blocked",
      register_session_id: sessionId,
      transaction_id: firstTransactionId,
      checkout_client_id: firstClientId,
      payload: {},
    },
    failOnStatusCode: false,
  });
  expect(publicExchange.status()).toBe(400);
  await expect(publicExchange.json()).resolves.toMatchObject({
    error: expect.stringContaining("server-owned"),
  });

  const collisionKey = `e2e-recovery-collision-${crypto.randomUUID()}`;
  await upsertRecovery(request, sessionId, sessionToken, {
    client_job_key: collisionKey,
    kind: "receipt_print",
    status: "blocked",
    register_session_id: sessionId,
    label: "E2E immutable receipt recovery",
    last_error: "E2E original blocked reason",
    payload: { receipt: "immutable" },
  });
  const stalePendingMirror = await request.post(`${apiBase()}/api/recovery`, {
    headers: {
      ...posHeaders(sessionId, sessionToken),
      "Content-Type": "application/json",
    },
    data: {
      client_job_key: collisionKey,
      kind: "receipt_print",
      status: "pending",
      register_session_id: sessionId,
      label: "E2E stale pending mirror",
      last_error: null,
      payload: { receipt: "immutable" },
    },
    failOnStatusCode: false,
  });
  expect(stalePendingMirror.status()).toBe(200);
  await expect(stalePendingMirror.json()).resolves.toMatchObject({
    status: "blocked",
    label: "E2E immutable receipt recovery",
    last_error: "E2E original blocked reason",
  });
  const collision = await request.post(`${apiBase()}/api/recovery`, {
    headers: {
      ...posHeaders(sessionId, sessionToken),
      "Content-Type": "application/json",
    },
    data: {
      client_job_key: collisionKey,
      kind: "checkout_unconfirmed",
      status: "blocked",
      register_session_id: sessionId,
      transaction_id: firstTransactionId,
      checkout_client_id: firstClientId,
      label: "E2E collision must fail",
      payload: { payload: firstPayload },
    },
    failOnStatusCode: false,
  });
  expect(collision.status()).toBe(403);
  await expect(collision.json()).resolves.toMatchObject({
    error: expect.stringContaining("collides"),
  });

  const mismatchKey = `e2e-mismatched-identities-${crypto.randomUUID()}`;
  await upsertRecovery(request, sessionId, sessionToken, {
    client_job_key: mismatchKey,
    kind: "checkout_unconfirmed",
    status: "blocked",
    register_session_id: sessionId,
    transaction_id: secondTransactionId,
    checkout_client_id: firstClientId,
    label: "E2E mismatched identity",
    payload: { payload: firstPayload },
  });
  const mismatchedResolve = await request.patch(
    `${apiBase()}/api/recovery/${encodeURIComponent(mismatchKey)}`,
    {
      headers: { ...staffHeaders(), "Content-Type": "application/json" },
      data: {
        status: "resolved",
        resolution_note: "E2E identity verification",
      },
      failOnStatusCode: false,
    },
  );
  expect(mismatchedResolve.status()).toBe(403);
  await expect(mismatchedResolve.json()).resolves.toMatchObject({
    error: expect.stringContaining("exact active Register"),
  });

  const automaticKeys = [
    `e2e-automatic-resolution-a-${crypto.randomUUID()}`,
    `e2e-automatic-resolution-b-${crypto.randomUUID()}`,
  ];
  for (const automaticKey of automaticKeys) {
    await upsertRecovery(request, sessionId, sessionToken, {
      client_job_key: automaticKey,
      kind: "checkout_unconfirmed",
      status: "blocked",
      register_session_id: sessionId,
      transaction_id: firstTransactionId,
      checkout_client_id: firstClientId,
      label: "E2E exact automatic checkout resolution",
      payload: { payload: firstPayload },
    });
    const resolveAutomatically = () =>
      request.patch(
        `${apiBase()}/api/recovery/${encodeURIComponent(automaticKey)}`,
        {
          headers: {
            ...posHeaders(sessionId, sessionToken),
            "Content-Type": "application/json",
          },
          data: {
            status: "resolved",
            resolution_note: "Checkout synchronized",
          },
          failOnStatusCode: false,
        },
      );
    if (automaticKey === automaticKeys[0]) {
      const removeAutomaticAuditFailure = installAuditFailureTrigger(
        "register_checkout_recovery_auto_resolved",
        automaticKey,
      );
      try {
        const failedAutomaticResolution = await resolveAutomatically();
        expect(
          failedAutomaticResolution.status(),
          await failedAutomaticResolution.text(),
        ).toBe(500);
        expect(
          selectJson<{ status: string; audit_count: number }>(`
            SELECT json_build_object(
              'status', status,
              'audit_count', (
                SELECT COUNT(*) FROM staff_access_log
                WHERE idempotency_key = ${sqlLiteral(`register-checkout-auto-resolution:${automaticKey}:${firstTransactionId}`)}
              )
            )::text
            FROM operational_recovery_job
            WHERE client_job_key = ${sqlLiteral(automaticKey)};
          `),
        ).toEqual({ status: "blocked", audit_count: 0 });
      } finally {
        removeAutomaticAuditFailure();
      }
    }
    const firstResolution = await resolveAutomatically();
    expect(firstResolution.status(), await firstResolution.text()).toBe(204);
    const retriedResolution = await resolveAutomatically();
    expect(retriedResolution.status(), await retriedResolution.text()).toBe(
      204,
    );
    expect(
      selectJson<{
        status: string;
        transaction_id: string;
        audit_count: number;
      }>(`
        SELECT json_build_object(
          'status', job.status,
          'transaction_id', job.transaction_id,
          'audit_count', (
            SELECT COUNT(*) FROM staff_access_log
            WHERE idempotency_key = ${sqlLiteral(`register-checkout-auto-resolution:${automaticKey}:${firstTransactionId}`)}
          )
        )::text
        FROM operational_recovery_job job
        WHERE client_job_key = ${sqlLiteral(automaticKey)};
      `),
    ).toEqual({
      status: "resolved",
      transaction_id: firstTransactionId,
      audit_count: 1,
    });
  }

  const payloadMismatchKey = `e2e-payload-mismatch-${crypto.randomUUID()}`;
  await upsertRecovery(request, sessionId, sessionToken, {
    client_job_key: payloadMismatchKey,
    kind: "checkout_unconfirmed",
    status: "blocked",
    register_session_id: sessionId,
    transaction_id: firstTransactionId,
    checkout_client_id: firstClientId,
    label: "E2E mismatched payload remains blocked",
    payload: {
      payload: {
        ...firstPayload,
        tax_exempt_reason: "Resale",
      },
    },
  });
  const payloadMismatchResolution = await request.patch(
    `${apiBase()}/api/recovery/${encodeURIComponent(payloadMismatchKey)}`,
    {
      headers: {
        ...posHeaders(sessionId, sessionToken),
        "Content-Type": "application/json",
      },
      data: {
        status: "resolved",
        resolution_note: "Checkout synchronized",
      },
      failOnStatusCode: false,
    },
  );
  const payloadMismatchText = await payloadMismatchResolution.text();
  expect(payloadMismatchResolution.status(), payloadMismatchText).toBe(403);
  expect(payloadMismatchText).toContain("exact committed Transaction Record");
  expect(
    selectJson<{ status: string; audit_count: number }>(`
      SELECT json_build_object(
        'status', status,
        'audit_count', (
          SELECT COUNT(*) FROM staff_access_log
          WHERE idempotency_key = ${sqlLiteral(`register-checkout-auto-resolution:${payloadMismatchKey}:${firstTransactionId}`)}
        )
      )::text
      FROM operational_recovery_job
      WHERE client_job_key = ${sqlLiteral(payloadMismatchKey)};
    `),
  ).toEqual({ status: "blocked", audit_count: 0 });

  const followUpKey = `e2e-paid-follow-up-${crypto.randomUUID()}`;
  await upsertRecovery(request, sessionId, sessionToken, {
    client_job_key: followUpKey,
    kind: "pickup_after_payment",
    status: "blocked",
    register_session_id: sessionId,
    transaction_id: firstTransactionId,
    checkout_client_id: firstClientId,
    label: "E2E paid pickup follow-up",
    payload: {
      recovery_steps: [
        {
          kind: "pickup_transaction",
          transaction_id: firstTransactionId,
          transaction_line_ids: [firstLineId],
        },
      ],
    },
  });
  const falseGenericResolve = await request.patch(
    `${apiBase()}/api/recovery/${encodeURIComponent(followUpKey)}`,
    {
      headers: { ...staffHeaders(), "Content-Type": "application/json" },
      data: {
        status: "resolved",
        resolution_note: "E2E false generic resolution",
      },
      failOnStatusCode: false,
    },
  );
  expect(falseGenericResolve.status()).toBe(403);

  const verifyFollowUp = () =>
    request.post(
      `${apiBase()}/api/recovery/${encodeURIComponent(followUpKey)}/verify-follow-up`,
      {
        headers: { ...staffHeaders(), "Content-Type": "application/json" },
        data: {
          manager_staff_id: managerStaffId,
          manager_pin: staffCode(),
          reason: "E2E confirms the exact fulfilled pickup line",
        },
        failOnStatusCode: false,
      },
    );
  const removeFollowUpAuditFailure = installAuditFailureTrigger(
    "register_pickup_followup_recovery",
    followUpKey,
  );
  try {
    const failedFollowUp = await verifyFollowUp();
    expect(failedFollowUp.status(), await failedFollowUp.text()).toBe(500);
    const failedFollowUpState = selectJson<{
      status: string;
      audit_count: number;
    }>(`
      SELECT json_build_object(
        'status', status,
        'audit_count', (
          SELECT COUNT(*) FROM staff_access_log
          WHERE idempotency_key = ${sqlLiteral(`register-pickup-followup-recovery:${followUpKey}`)}
        )
      )::text
      FROM operational_recovery_job
      WHERE client_job_key = ${sqlLiteral(followUpKey)};
    `);
    expect(failedFollowUpState).toEqual({ status: "blocked", audit_count: 0 });
  } finally {
    removeFollowUpAuditFailure();
  }
  const verifiedFollowUp = await verifyFollowUp();
  const verifiedBodyText = await verifiedFollowUp.text();
  expect(verifiedFollowUp.status(), verifiedBodyText.slice(0, 1000)).toBe(200);
  expect(
    selectJson<{ status: string; audit_count: number }>(`
      SELECT json_build_object(
        'status', status,
        'audit_count', (
          SELECT COUNT(*) FROM staff_access_log
          WHERE idempotency_key = ${sqlLiteral(`register-pickup-followup-recovery:${followUpKey}`)}
        )
      )::text
      FROM operational_recovery_job
      WHERE client_job_key = ${sqlLiteral(followUpKey)};
    `),
  ).toEqual({ status: "resolved", audit_count: 1 });
  const retriedFollowUp = await verifyFollowUp();
  const retriedFollowUpText = await retriedFollowUp.text();
  expect(retriedFollowUp.status(), retriedFollowUpText.slice(0, 1000)).toBe(
    200,
  );
  expect(JSON.parse(retriedFollowUpText)).toMatchObject({
    status: "resolved",
    idempotent_replay: true,
  });
  expect(
    runSql(`
      SELECT COUNT(*) FROM staff_access_log
      WHERE idempotency_key = ${sqlLiteral(`register-pickup-followup-recovery:${followUpKey}`)};
    `),
  ).toBe("1");

  const replayCheckoutRequestFor = (jobKey: string, managerReason: string) =>
    request.post(
      `${apiBase()}/api/recovery/${encodeURIComponent(jobKey)}/replay-checkout`,
      {
        headers: { ...staffHeaders(), "Content-Type": "application/json" },
        data: {
          manager_staff_id: managerStaffId,
          manager_pin: staffCode(),
          reason: managerReason,
        },
        failOnStatusCode: false,
      },
    );
  const preCloseReplayKey = `e2e-pre-close-replay-${crypto.randomUUID()}`;
  const preCloseReplayReason =
    "E2E exact idempotent recovery while the Register remains open";
  await upsertRecovery(request, sessionId, sessionToken, {
    client_job_key: preCloseReplayKey,
    kind: "checkout_unconfirmed",
    status: "blocked",
    register_session_id: sessionId,
    transaction_id: firstTransactionId,
    checkout_client_id: firstClientId,
    label: "E2E pre-close replay retains its original audit facts",
    payload: { payload: firstPayload },
  });
  const preCloseResolution = await replayCheckoutRequestFor(
    preCloseReplayKey,
    preCloseReplayReason,
  );
  const preCloseResolutionText = await preCloseResolution.text();
  expect(
    preCloseResolution.status(),
    preCloseResolutionText.slice(0, 1000),
  ).toBe(200);
  expect(JSON.parse(preCloseResolutionText)).toMatchObject({
    transaction_id: firstTransactionId,
    post_close_recovery: false,
    idempotent_replay: false,
  });

  const replayClientId = crypto.randomUUID();
  const replayPayload = checkoutPayload(
    replayFixture,
    sessionId,
    managerStaffId,
    replayClientId,
  );
  const replayKey = `e2e-post-close-replay-${crypto.randomUUID()}`;
  await upsertRecovery(request, sessionId, sessionToken, {
    client_job_key: replayKey,
    kind: "checkout_offline",
    status: "blocked",
    register_session_id: sessionId,
    checkout_client_id: replayClientId,
    label: "E2E post-close exact replay",
    payload: { payload: replayPayload },
  });
  const duplicateReplayKey = `e2e-post-close-replay-duplicate-${crypto.randomUUID()}`;
  await upsertRecovery(request, sessionId, sessionToken, {
    client_job_key: duplicateReplayKey,
    kind: "checkout_offline",
    status: "blocked",
    register_session_id: sessionId,
    checkout_client_id: replayClientId,
    label: "E2E duplicate identity replay remains independently auditable",
    payload: { payload: replayPayload },
  });

  const beginReconcile = await request.post(
    `${apiBase()}/api/sessions/${sessionId}/begin-reconcile`,
    {
      headers: {
        ...posHeaders(sessionId, sessionToken),
        "Content-Type": "application/json",
      },
      data: { active: true },
      failOnStatusCode: false,
    },
  );
  expect(beginReconcile.status()).toBe(200);
  const stationAck = await request.post(
    `${apiBase()}/api/recovery/station-close-status`,
    {
      headers: {
        ...posHeaders(sessionId, sessionToken),
        "Content-Type": "application/json",
      },
      data: { pending_checkout_count: 0, blocked_checkout_count: 0 },
      failOnStatusCode: false,
    },
  );
  const stationAckText = await stationAck.text();
  expect(stationAck.status(), stationAckText.slice(0, 1000)).toBe(200);

  const reconciliation = await request.get(
    `${apiBase()}/api/sessions/${sessionId}/reconciliation`,
    {
      headers: posHeaders(sessionId, sessionToken),
      failOnStatusCode: false,
    },
  );
  const reconciliationText = await reconciliation.text();
  expect(reconciliation.status(), reconciliationText.slice(0, 1000)).toBe(200);
  const expectedCash = (
    JSON.parse(reconciliationText) as { expected_cash: string }
  ).expected_cash;
  const forcedClose = await request.post(
    `${apiBase()}/api/sessions/${sessionId}/close`,
    {
      headers: {
        ...posHeaders(sessionId, sessionToken),
        "Content-Type": "application/json",
      },
      data: {
        actual_cash: expectedCash,
        closing_notes: "E2E audited recovery force-close",
        closing_comments: "Recovery remains globally visible",
        force_unresolved_recovery: true,
        manager_staff_id: managerStaffId,
        manager_pin: staffCode(),
        manager_reason:
          "E2E preserves the exact checkout for post-close replay",
      },
      failOnStatusCode: false,
    },
  );
  const closeBodyText = await forcedClose.text();
  expect(forcedClose.status(), closeBodyText.slice(0, 1000)).toBe(200);
  expect(JSON.parse(closeBodyText)).toMatchObject({ till_group_closed: true });

  const globalList = await request.get(`${apiBase()}/api/recovery`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const globalListText = await globalList.text();
  expect(globalList.status(), globalListText.slice(0, 1000)).toBe(200);
  const globalJobs = JSON.parse(globalListText) as Array<{
    client_job_key: string;
  }>;
  expect(globalJobs.some((job) => job.client_job_key === replayKey)).toBe(true);

  const replayReason =
    "E2E exact concurrent recovery after audited force-close";
  const replayRequestFor = (jobKey: string, managerReason = replayReason) =>
    replayCheckoutRequestFor(jobKey, managerReason);
  const replayRequest = () => replayRequestFor(replayKey);

  const preCloseAuditKey = `register-checkout-recovery:${preCloseReplayKey}:${firstTransactionId}`;
  runSql(`
    UPDATE staff_access_log
    SET metadata = jsonb_set(
      metadata,
      '{legacy_committed_without_replay}',
      'true'::jsonb
    )
    WHERE idempotency_key = ${sqlLiteral(preCloseAuditKey)};
  `);
  const contradictoryLegacyRetry = await replayRequestFor(
    preCloseReplayKey,
    "E2E retry rejects a contradictory legacy checkout audit flag",
  );
  const contradictoryLegacyRetryText = await contradictoryLegacyRetry.text();
  expect(contradictoryLegacyRetry.status(), contradictoryLegacyRetryText).toBe(
    400,
  );
  expect(contradictoryLegacyRetryText).toContain(
    "conflicts with its durable checkout evidence",
  );
  runSql(`
    UPDATE staff_access_log
    SET metadata = jsonb_set(
      metadata,
      '{legacy_committed_without_replay}',
      'false'::jsonb
    )
    WHERE idempotency_key = ${sqlLiteral(preCloseAuditKey)};
    INSERT INTO register_post_close_checkout_recovery (
      recovery_client_job_key, register_session_id, transaction_id,
      recovered_by_staff_id, manager_reason, metadata
    ) VALUES (
      ${sqlLiteral(preCloseReplayKey)},
      ${sqlLiteral(sessionId)}::uuid,
      ${sqlLiteral(firstTransactionId)}::uuid,
      ${sqlLiteral(managerStaffId)}::uuid,
      'E2E deliberately contradictory post-close evidence',
      '{}'::jsonb
    );
  `);
  try {
    const contradictoryPostCloseRetry = await replayRequestFor(
      preCloseReplayKey,
      "E2E retry rejects contradictory post-close recovery evidence",
    );
    const contradictoryPostCloseRetryText =
      await contradictoryPostCloseRetry.text();
    expect(
      contradictoryPostCloseRetry.status(),
      contradictoryPostCloseRetryText,
    ).toBe(400);
    expect(contradictoryPostCloseRetryText).toContain(
      "conflicts with its durable checkout evidence",
    );
  } finally {
    runSql(`
      DELETE FROM register_post_close_checkout_recovery
      WHERE recovery_client_job_key = ${sqlLiteral(preCloseReplayKey)};
    `);
  }

  const preCloseLostResponseRetry = await replayRequestFor(
    preCloseReplayKey,
    "E2E retry after the original pre-close recovery response was lost",
  );
  const preCloseLostResponseRetryText = await preCloseLostResponseRetry.text();
  expect(
    preCloseLostResponseRetry.status(),
    preCloseLostResponseRetryText.slice(0, 1000),
  ).toBe(200);
  expect(JSON.parse(preCloseLostResponseRetryText)).toMatchObject({
    transaction_id: firstTransactionId,
    post_close_recovery: false,
    idempotent_replay: true,
  });
  expect(
    selectJson<{ post_close_count: number; audit_count: number }>(`
      SELECT json_build_object(
        'post_close_count', (
          SELECT COUNT(*) FROM register_post_close_checkout_recovery
          WHERE recovery_client_job_key = ${sqlLiteral(preCloseReplayKey)}
        ),
        'audit_count', (
          SELECT COUNT(*) FROM staff_access_log
          WHERE idempotency_key = ${sqlLiteral(`register-checkout-recovery:${preCloseReplayKey}:${firstTransactionId}`)}
        )
      )::text;
    `),
  ).toEqual({ post_close_count: 0, audit_count: 1 });

  const removeCheckoutAuditFailure = installAuditFailureTrigger(
    "register_checkout_recovery",
    replayKey,
  );
  let committedReplayTransactionId = "";
  try {
    const failedReplay = await replayRequest();
    expect(failedReplay.status(), await failedReplay.text()).toBe(500);
    const failedReplayState = selectJson<{
      status: string;
      committed_transaction_id: string;
      recovery_transaction_id: string | null;
      post_close_count: number;
      audit_count: number;
    }>(`
      SELECT json_build_object(
        'status', job.status,
        'committed_transaction_id', (
          SELECT id FROM transactions
          WHERE checkout_client_id = ${sqlLiteral(replayClientId)}::uuid
        ),
        'recovery_transaction_id', job.transaction_id,
        'post_close_count', (
          SELECT COUNT(*) FROM register_post_close_checkout_recovery
          WHERE recovery_client_job_key = ${sqlLiteral(replayKey)}
        ),
        'audit_count', (
          SELECT COUNT(*) FROM staff_access_log
          WHERE idempotency_key LIKE 'register-checkout-recovery:%'
            AND metadata->>'client_job_key' = ${sqlLiteral(replayKey)}
        )
      )::text
      FROM operational_recovery_job job
      WHERE job.client_job_key = ${sqlLiteral(replayKey)};
    `);
    expect(failedReplayState).toMatchObject({
      status: "blocked",
      recovery_transaction_id: null,
      post_close_count: 0,
      audit_count: 0,
    });
    expect(failedReplayState.committed_transaction_id).toBeTruthy();
    committedReplayTransactionId = failedReplayState.committed_transaction_id;
  } finally {
    removeCheckoutAuditFailure();
  }

  runSql(`
    UPDATE operational_recovery_job
    SET status = 'resolved',
        resolved_at = now(),
        resolved_by_staff_id = ${sqlLiteral(managerStaffId)}::uuid,
        resolution_note = ${sqlLiteral(replayReason)},
        transaction_id = ${sqlLiteral(committedReplayTransactionId)}::uuid
    WHERE client_job_key = ${sqlLiteral(replayKey)};
  `);
  const unauditedResolvedRetry = await replayRequest();
  const unauditedResolvedText = await unauditedResolvedRetry.text();
  expect(unauditedResolvedRetry.status(), unauditedResolvedText).toBe(400);
  expect(unauditedResolvedText).toContain("required exact Manager audit");
  runSql(`
    UPDATE operational_recovery_job
    SET status = 'blocked',
        resolved_at = NULL,
        resolved_by_staff_id = NULL,
        resolution_note = NULL,
        transaction_id = NULL
    WHERE client_job_key = ${sqlLiteral(replayKey)};
  `);

  const replayResponses = await Promise.all([replayRequest(), replayRequest()]);
  const replayResults = await Promise.all(
    replayResponses.map(async (response) => ({
      status: response.status(),
      body: (await response.json().catch(() => ({}))) as {
        transaction_id?: string;
        post_close_recovery?: boolean;
      },
    })),
  );
  const successfulReplays = replayResults.filter(
    (result) => result.status === 200,
  );
  expect(successfulReplays).toHaveLength(2);
  expect(
    successfulReplays.every(
      (result) => result.body.post_close_recovery === true,
    ),
  ).toBe(true);
  expect(
    new Set(successfulReplays.map((result) => result.body.transaction_id)).size,
  ).toBe(1);
  expect(
    selectJson<{
      status: string;
      post_close_count: number;
      audit_count: number;
    }>(`
      SELECT json_build_object(
        'status', job.status,
        'post_close_count', (
          SELECT COUNT(*) FROM register_post_close_checkout_recovery
          WHERE recovery_client_job_key = ${sqlLiteral(replayKey)}
        ),
        'audit_count', (
          SELECT COUNT(*) FROM staff_access_log
          WHERE idempotency_key = ${sqlLiteral(`register-checkout-recovery:${replayKey}:${committedReplayTransactionId}`)}
            AND metadata->>'client_job_key' = ${sqlLiteral(replayKey)}
        )
      )::text
      FROM operational_recovery_job job
      WHERE job.client_job_key = ${sqlLiteral(replayKey)};
    `),
  ).toEqual({ status: "resolved", post_close_count: 1, audit_count: 1 });

  const lostResponseRetry = await replayRequestFor(
    replayKey,
    "E2E retry after the replay response was lost",
  );
  const lostResponseRetryText = await lostResponseRetry.text();
  expect(lostResponseRetry.status(), lostResponseRetryText.slice(0, 1000)).toBe(
    200,
  );
  expect(JSON.parse(lostResponseRetryText)).toMatchObject({
    transaction_id: committedReplayTransactionId,
    post_close_recovery: true,
    idempotent_replay: true,
  });
  expect(
    runSql(`
      SELECT COUNT(*) FROM staff_access_log
      WHERE idempotency_key = ${sqlLiteral(`register-checkout-recovery:${replayKey}:${committedReplayTransactionId}`)};
    `),
  ).toBe("1");

  const duplicateReplay = await replayRequestFor(duplicateReplayKey);
  const duplicateReplayText = await duplicateReplay.text();
  expect(duplicateReplay.status(), duplicateReplayText.slice(0, 1000)).toBe(
    200,
  );
  expect(JSON.parse(duplicateReplayText)).toMatchObject({
    transaction_id: committedReplayTransactionId,
    post_close_recovery: true,
  });
  expect(
    selectJson<{ first_audit_count: number; second_audit_count: number }>(`
      SELECT json_build_object(
        'first_audit_count', (
          SELECT COUNT(*) FROM staff_access_log
          WHERE idempotency_key = ${sqlLiteral(`register-checkout-recovery:${replayKey}:${committedReplayTransactionId}`)}
        ),
        'second_audit_count', (
          SELECT COUNT(*) FROM staff_access_log
          WHERE idempotency_key = ${sqlLiteral(`register-checkout-recovery:${duplicateReplayKey}:${committedReplayTransactionId}`)}
        )
      )::text;
    `),
  ).toEqual({ first_audit_count: 1, second_audit_count: 1 });
});
