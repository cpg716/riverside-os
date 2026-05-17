import { expect, test, type APIRequestContext } from "@playwright/test";
import { apiBase, ensureSessionAuth, staffHeaders, verifyStaffId, seedRmsFixture, type SeedFixtureResponse } from "./helpers/rmsCharge";

function apiUrl(path: string) {
  return `${apiBase()}${path}`;
}

type CheckoutResponse = {
  transaction_id: string;
  transaction_display_id: string;
};

type RefundQueueRow = {
  id: string;
  transaction_id: string;
  amount_due: string;
  amount_refunded: string;
  is_open: boolean;
};

type TransactionArtifacts = {
  transaction_id: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  payment_rows: Array<{
    payment_method: string;
    metadata: Record<string, unknown>;
  }>;
  allocation_rows: Array<{
    payment_transaction_id: string;
    target_transaction_id: string;
    amount_allocated: string;
    payment_method: string;
    payment_amount: string;
  }>;
};

function moneyToCents(value: string | number | undefined | null): number {
  if (value == null) return 0;
  const str = String(value).trim();
  const sign = str.startsWith("-") ? -1 : 1;
  const abs = str.replace("-", "");
  const [dollars, cents = ""] = abs.split(".");
  return sign * (Number.parseInt(dollars || "0", 10) * 100 + Number.parseInt(cents.padEnd(2, "0").slice(0, 2), 10));
}

function getGrossTotal(fixture: SeedFixtureResponse): { grossStr: string; grossCents: number } {
  const stateTax = 900; // 9.00
  const localTax = 1069; // 10.69
  const unitPriceCents = moneyToCents(fixture.product.unit_price);
  const grossCents = unitPriceCents + stateTax + localTax;
  return { grossStr: (grossCents / 100).toFixed(2), grossCents };
}

async function doCheckout(
  request: APIRequestContext,
  options: {
    sessionId: string;
    sessionToken: string;
    operatorStaffId: string;
    fixture: SeedFixtureResponse;
    amountPaid?: string;
    paymentMethod?: string;
  },
): Promise<CheckoutResponse & { grossStr: string }> {
  const { grossStr } = getGrossTotal(options.fixture);
  const amountToPay = options.amountPaid ?? grossStr;

  const res = await request.post(apiUrl("/api/transactions/checkout"), {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
      "x-riverside-pos-session-id": options.sessionId,
      "x-riverside-pos-session-token": options.sessionToken,
    },
    data: {
      session_id: options.sessionId,
      operator_staff_id: options.operatorStaffId,
      primary_salesperson_id: options.operatorStaffId,
      customer_id: options.fixture.customer.id,
      payment_method: options.paymentMethod ?? "cash",
      total_price: grossStr,
      amount_paid: amountToPay,
      checkout_client_id: crypto.randomUUID(),
      items: [
        {
          product_id: options.fixture.product.product_id,
          variant_id: options.fixture.product.variant_id,
          fulfillment: "takeaway",
          quantity: 1,
          unit_price: options.fixture.product.unit_price,
          unit_cost: options.fixture.product.unit_cost,
          state_tax: "9.00",
          local_tax: "10.69",
          salesperson_id: options.operatorStaffId,
        },
      ],
      payment_splits: [{ payment_method: options.paymentMethod ?? "cash", amount: amountToPay }],
      order_payments: [],
      is_tax_exempt: false,
      tax_exempt_reason: null,
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), `checkout failed: ${bodyText.slice(0, 500)}`).toBe(200);
  return { ...JSON.parse(bodyText), grossStr };
}

async function doReturn(
  request: APIRequestContext,
  options: { transactionId: string; sessionId: string; sessionToken: string; lineId: string; qty: number },
): Promise<void> {
  const res = await request.post(
    apiUrl(`/api/transactions/${options.transactionId}/returns?register_session_id=${options.sessionId}`),
    {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
        "x-riverside-pos-session-id": options.sessionId,
        "x-riverside-pos-session-token": options.sessionToken,
      },
      data: { lines: [{ transaction_line_id: options.lineId, quantity: options.qty, reason: "e2e_split_tender_test" }] },
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), `return failed: ${bodyText.slice(0, 500)}`).toBe(200);
}

async function doRefund(
  request: APIRequestContext,
  options: {
    transactionId: string;
    sessionId: string;
    amount: string;
    paymentMethod?: string;
    managerStaffId?: string;
    managerPin?: string;
    managerReason?: string;
  },
): Promise<{ status: number; body: unknown }> {
  const res = await request.post(apiUrl(`/api/transactions/${options.transactionId}/refunds/process`), {
    headers: { ...staffHeaders(), "Content-Type": "application/json" },
    data: {
      session_id: options.sessionId,
      payment_method: options.paymentMethod ?? "cash",
      amount: options.amount,
      manager_staff_id: options.managerStaffId,
      manager_pin: options.managerPin,
      manager_reason: options.managerReason,
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  let body = {};
  try {
    body = JSON.parse(bodyText);
  } catch (e) {
    body = { raw: bodyText };
  }
  return { status: res.status(), body };
}

async function getArtifacts(request: APIRequestContext, transactionId: string): Promise<TransactionArtifacts> {
  const res = await request.get(apiUrl(`/api/test-support/rms/transaction/${transactionId}`), {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 500)).toBe(200);
  return JSON.parse(bodyText) as TransactionArtifacts;
}

async function getRefundsDue(request: APIRequestContext): Promise<RefundQueueRow[]> {
  const res = await request.get(apiUrl("/api/transactions/refunds/due"), {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 500)).toBe(200);
  return JSON.parse(bodyText) as RefundQueueRow[];
}

async function getTransactionLines(request: APIRequestContext, transactionId: string) {
  const res = await request.get(apiUrl(`/api/transactions/${transactionId}`), {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 500)).toBe(200);
  const data = JSON.parse(bodyText) as { items: Array<{ transaction_line_id: string; sku: string }> };
  return data.items;
}

test.describe("refund split-tender capacity contract", () => {
  test("cash partial refunds accumulate correctly in the refund queue", async ({ request }) => {
    test.setTimeout(60_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const fixture = await seedRmsFixture(request, "single_valid", "Split Refund Accrual");

    const checkout = await doCheckout(request, {
      sessionId,
      sessionToken,
      operatorStaffId,
      fixture,
    });

    const lines = await getTransactionLines(request, checkout.transaction_id);
    const line = lines[0];
    expect(line?.transaction_line_id).toBeTruthy();

    await doReturn(request, {
      transactionId: checkout.transaction_id,
      sessionId,
      sessionToken,
      lineId: line!.transaction_line_id,
      qty: 1,
    });

    const queueBefore = (await getRefundsDue(request)).find(
      (r) => r.transaction_id === checkout.transaction_id,
    );
    expect(queueBefore?.is_open).toBe(true);
    expect(moneyToCents(queueBefore?.amount_due)).toBe(moneyToCents(checkout.grossStr));
    expect(moneyToCents(queueBefore?.amount_refunded)).toBe(0);

    // Partial refund 1: $10.00
    const r1 = await doRefund(request, { transactionId: checkout.transaction_id, sessionId, amount: "10.00" });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);

    const queueMid = (await getRefundsDue(request)).find(
      (r) => r.transaction_id === checkout.transaction_id,
    );
    expect(queueMid?.is_open).toBe(true);
    expect(moneyToCents(queueMid?.amount_refunded)).toBe(1000);

    // Partial refund 2: remainder
    const remaining = moneyToCents(checkout.grossStr) - 1000;
    const r2 = await doRefund(request, { 
      transactionId: checkout.transaction_id, 
      sessionId, 
      amount: (remaining / 100).toFixed(2) 
    });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);

    const queueAfter = (await getRefundsDue(request)).find(
      (r) => r.transaction_id === checkout.transaction_id,
    );
    // Queue should be closed (fully refunded)
    expect(queueAfter).toBeUndefined();

    // Two negative allocation rows should exist
    const artifacts = await getArtifacts(request, checkout.transaction_id);
    const negativeAllocations = artifacts.allocation_rows.filter(
      (r) => moneyToCents(r.amount_allocated) < 0,
    );
    expect(negativeAllocations).toHaveLength(2);
    const refundedTotal = negativeAllocations.reduce((s, r) => s + moneyToCents(r.amount_allocated), 0);
    expect(refundedTotal).toBe(-moneyToCents(checkout.grossStr));
  });

  test("refund exceeding amount_due is rejected at the queue level", async ({ request }) => {
    test.setTimeout(60_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const fixture = await seedRmsFixture(request, "single_valid", "Split Refund Queue Cap");

    const checkout = await doCheckout(request, {
      sessionId,
      sessionToken,
      operatorStaffId,
      fixture,
    });

    const lines = await getTransactionLines(request, checkout.transaction_id);
    await doReturn(request, {
      transactionId: checkout.transaction_id,
      sessionId,
      sessionToken,
      lineId: lines[0]!.transaction_line_id,
      qty: 1,
    });

    // Attempt to refund more than amount_due (gross)
    const excessiveAmount = (moneyToCents(checkout.grossStr) / 100 + 1).toFixed(2);
    const result = await doRefund(request, {
      transactionId: checkout.transaction_id,
      sessionId,
      amount: excessiveAmount,
    });
    expect(result.status).toBe(400);
    const body = result.body as { error?: string };
    expect(body.error ?? "").toContain("refund exceeds refundable paid credit");
  });

  test("refund against a closed queue returns a clear error", async ({ request }) => {
    test.setTimeout(60_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const fixture = await seedRmsFixture(request, "single_valid", "Split Refund Closed Queue");

    const checkout = await doCheckout(request, {
      sessionId,
      sessionToken,
      operatorStaffId,
      fixture,
    });

    const lines = await getTransactionLines(request, checkout.transaction_id);
    await doReturn(request, {
      transactionId: checkout.transaction_id,
      sessionId,
      sessionToken,
      lineId: lines[0]!.transaction_line_id,
      qty: 1,
    });

    // Fully refund using gross amount
    const r1 = await doRefund(request, { 
      transactionId: checkout.transaction_id, 
      sessionId, 
      amount: checkout.grossStr 
    });
    expect(r1.status).toBe(200);

    // Attempt a second refund — queue is now closed
    const r2 = await doRefund(request, { transactionId: checkout.transaction_id, sessionId, amount: "1.00" });
    expect(r2.status).toBe(400);
    const body = r2.body as { error?: string };
    expect(body.error ?? "").toContain("no open refund");
  });

  test("cash refund payment rows carry order_refund metadata", async ({ request }) => {
    test.setTimeout(60_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const fixture = await seedRmsFixture(request, "single_valid", "Split Refund Metadata");

    const checkout = await doCheckout(request, {
      sessionId,
      sessionToken,
      operatorStaffId,
      fixture,
    });

    const lines = await getTransactionLines(request, checkout.transaction_id);
    await doReturn(request, {
      transactionId: checkout.transaction_id,
      sessionId,
      sessionToken,
      lineId: lines[0]!.transaction_line_id,
      qty: 1,
    });

    const refundResult = await doRefund(request, {
      transactionId: checkout.transaction_id,
      sessionId,
      amount: checkout.grossStr,
    });
    expect(refundResult.status).toBe(200);

    const artifacts = await getArtifacts(request, checkout.transaction_id);
    const refundRow = artifacts.payment_rows.find(
      (r) => r.payment_method === "cash" && (r.metadata as Record<string, unknown>)["kind"] === "order_refund",
    );
    expect(refundRow).toBeTruthy();
    expect((refundRow!.metadata as Record<string, unknown>)["transaction_id"]).toBe(checkout.transaction_id);
  });

  test("legacy/manual card refund recording requires manager authorization", async ({ request }) => {
    test.setTimeout(60_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const fixture = await seedRmsFixture(request, "single_valid", "Legacy Manual Refund Auth");

    const checkout = await doCheckout(request, {
      sessionId,
      sessionToken,
      operatorStaffId,
      fixture,
      paymentMethod: "cash", // No Helcim card charge
    });

    const lines = await getTransactionLines(request, checkout.transaction_id);
    await doReturn(request, {
      transactionId: checkout.transaction_id,
      sessionId,
      sessionToken,
      lineId: lines[0]!.transaction_line_id,
      qty: 1,
    });

    // Attempt card refund without manager fields -> expect 400
    const r1 = await doRefund(request, {
      transactionId: checkout.transaction_id,
      sessionId,
      amount: checkout.grossStr,
      paymentMethod: "card",
    });
    expect(r1.status).toBe(400);
    expect((r1.body as any).error).toContain("No original Helcim card charge found");

    // Attempt with invalid PIN -> expect 400
    const r2 = await doRefund(request, {
      transactionId: checkout.transaction_id,
      sessionId,
      amount: checkout.grossStr,
      paymentMethod: "card",
      managerStaffId: operatorStaffId,
      managerPin: "0000", // Assuming 0000 is wrong
      managerReason: "migration fix",
    });
    expect(r2.status).toBe(400);
    expect((r2.body as any).error).toContain("Manager Access was not approved");
  });

  test("legacy/manual card refund recording succeeds with manager override", async ({ request }) => {
    test.setTimeout(60_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const fixture = await seedRmsFixture(request, "single_valid", "Legacy Manual Refund Success");

    const checkout = await doCheckout(request, {
      sessionId,
      sessionToken,
      operatorStaffId,
      fixture,
      paymentMethod: "cash",
    });

    const lines = await getTransactionLines(request, checkout.transaction_id);
    await doReturn(request, {
      transactionId: checkout.transaction_id,
      sessionId,
      sessionToken,
      lineId: lines[0]!.transaction_line_id,
      qty: 1,
    });

    // Valid override (using operator's own ID/PIN as "manager" for test simplicity if they have admin role)
    // In seedRmsFixture, the default staff usually has admin-level access.
    // We'll use "1234" which is the standard test PIN for the operator in these fixtures.
    const r3 = await doRefund(request, {
      transactionId: checkout.transaction_id,
      sessionId,
      amount: checkout.grossStr,
      paymentMethod: "card",
      managerStaffId: operatorStaffId,
      managerPin: "1234",
      managerReason: "migration migration",
    });
    expect(r3.status, JSON.stringify(r3.body)).toBe(200);

    const artifacts = await getArtifacts(request, checkout.transaction_id);
    const manualRow = artifacts.payment_rows.find(
      (r) => r.payment_method === "card_terminal_manual",
    );
    expect(manualRow).toBeTruthy();
    expect(manualRow!.metadata.kind).toBe("legacy_migration_refund");
    expect(manualRow!.metadata.original_provider_transaction_id).toBe("MANUAL_MIGRATION");
    expect(manualRow!.metadata.authorizing_manager_id).toBe(operatorStaffId);

    const queue = (await getRefundsDue(request)).find(
      (r) => r.transaction_id === checkout.transaction_id,
    );
    expect(queue).toBeUndefined(); // Should be closed
  });
});
