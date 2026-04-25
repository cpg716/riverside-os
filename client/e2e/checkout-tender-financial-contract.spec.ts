import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  apiBase,
  ensureSessionAuth,
  getTransactionArtifacts,
  seedRmsFixture,
  staffHeaders,
  verifyStaffId,
  type SeedFixtureResponse,
  type TransactionArtifacts,
} from "./helpers/rmsCharge";

const E2E_RMS_CATEGORY_ID = "90000000-0000-0000-0000-000000000001";
const E2E_FIXTURE_TOTAL = "244.69";

type CheckoutResponse = {
  transaction_id: string;
  transaction_display_id: string;
};

type TransactionDetail = {
  transaction_id: string;
  transaction_display_id: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  status: string;
};

type QboJournalLine = {
  qbo_account_id: string;
  qbo_account_name: string;
  debit: string | number;
  credit: string | number;
  memo: string;
  detail?: Array<Record<string, unknown>>;
};

type QboStagingRow = {
  id: string;
  sync_date: string;
  status: string;
  payload: {
    activity_date: string;
    lines: QboJournalLine[];
    totals?: {
      debits?: string | number;
      credits?: string | number;
      balanced?: boolean;
    };
  };
};

function futureUtcDate(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function moneyToCents(value: string | number | undefined | null): number {
  if (value == null) return 0;
  const [dollarsRaw, centsRaw = ""] = String(value).trim().split(".");
  const sign = dollarsRaw.startsWith("-") ? -1 : 1;
  const dollars = Math.abs(Number.parseInt(dollarsRaw || "0", 10));
  const cents = Number.parseInt(centsRaw.padEnd(2, "0").slice(0, 2) || "0", 10);
  return sign * (dollars * 100 + cents);
}

async function fetchTransactionDetail(
  request: APIRequestContext,
  transactionId: string,
): Promise<TransactionDetail> {
  const res = await request.get(`${apiBase()}/api/transactions/${transactionId}`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as TransactionDetail;
}

async function checkoutFixtureProduct(
  request: APIRequestContext,
  options: {
    fixture: SeedFixtureResponse;
    sessionId: string;
    sessionToken: string;
    operatorStaffId: string;
    customerId?: string | null;
    fulfillment?: "takeaway" | "special_order";
    amountPaid?: string;
    paymentSplits?: Array<Record<string, unknown>>;
    orderPayments?: Array<Record<string, unknown>>;
    roundingAdjustment?: string | null;
    finalCashDue?: string | null;
  },
) {
  const checkoutTotal = E2E_FIXTURE_TOTAL;
  const amountPaid = options.amountPaid ?? checkoutTotal;
  const res = await request.post(`${apiBase()}/api/transactions/checkout`, {
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
      customer_id: options.customerId ?? null,
      payment_method: "cash",
      total_price: checkoutTotal,
      amount_paid: amountPaid,
      checkout_client_id: crypto.randomUUID(),
      items: [
        {
          product_id: options.fixture.product.product_id,
          variant_id: options.fixture.product.variant_id,
          fulfillment: options.fulfillment ?? "takeaway",
          quantity: 1,
          unit_price: options.fixture.product.unit_price,
          unit_cost: options.fixture.product.unit_cost,
          state_tax: "9.00",
          local_tax: "10.69",
          salesperson_id: options.operatorStaffId,
        },
      ],
      payment_splits: options.paymentSplits ?? [
        {
          payment_method: "cash",
          amount: amountPaid,
        },
      ],
      order_payments: options.orderPayments ?? [],
      ...(options.roundingAdjustment ? { rounding_adjustment: options.roundingAdjustment } : {}),
      ...(options.finalCashDue ? { final_cash_due: options.finalCashDue } : {}),
      is_tax_exempt: false,
      tax_exempt_reason: null,
    },
    failOnStatusCode: false,
  });
  return res;
}

async function expectSuccessfulCheckout(
  res: Awaited<ReturnType<APIRequestContext["post"]>>,
): Promise<CheckoutResponse> {
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as CheckoutResponse;
}

async function seedQboMappings(request: APIRequestContext, activityDate: string): Promise<void> {
  const res = await request.post(`${apiBase()}/api/test-support/qbo/seed-tax-mapping`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      category_id: E2E_RMS_CATEGORY_ID,
      activity_date: activityDate,
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
}

async function assignQboDate(
  request: APIRequestContext,
  transactionId: string,
  activityDate: string,
): Promise<void> {
  const res = await request.post(`${apiBase()}/api/test-support/qbo/assign-transaction-date`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      transaction_id: transactionId,
      activity_date: activityDate,
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
}

async function proposeJournal(
  request: APIRequestContext,
  activityDate: string,
): Promise<QboStagingRow> {
  const res = await request.post(`${apiBase()}/api/qbo/staging/propose`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      activity_date: activityDate,
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as QboStagingRow;
}

test.describe("checkout tender financial contract", () => {
  test("check tender requires a check number before checkout can post", async ({ request }) => {
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const fixture = await seedRmsFixture(request, "single_valid", "Tender Check Number");

    const res = await checkoutFixtureProduct(request, {
      fixture,
      sessionId,
      sessionToken,
      operatorStaffId,
      customerId: fixture.customer.id,
      paymentSplits: [
        {
          payment_method: "check",
          amount: fixture.product.unit_price,
        },
      ],
    });

    const body = (await res.json()) as { error?: string };
    expect(res.status()).toBe(400);
    expect(body.error ?? "").toContain("check_number");
  });

  test("split tender allocates exactly across current sale and existing transaction balance", async ({
    request,
  }) => {
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const fixture = await seedRmsFixture(request, "single_valid", "Tender Split Allocation");

    const orderRes = await checkoutFixtureProduct(request, {
      fixture,
      sessionId,
      sessionToken,
      operatorStaffId,
      customerId: fixture.customer.id,
      fulfillment: "special_order",
      amountPaid: "50.00",
      paymentSplits: [{ payment_method: "cash", amount: "50.00" }],
    });
    const orderCheckout = await expectSuccessfulCheckout(orderRes);
    const orderBefore = await fetchTransactionDetail(request, orderCheckout.transaction_id);
    expect(orderBefore.balance_due).toBe("194.69");

    const currentRes = await checkoutFixtureProduct(request, {
      fixture,
      sessionId,
      sessionToken,
      operatorStaffId,
      customerId: fixture.customer.id,
      amountPaid: "439.38",
      paymentSplits: [
        { payment_method: "cash", amount: "100.00" },
        { payment_method: "check", amount: "339.38", check_number: "CHK-E2E-400" },
      ],
      orderPayments: [
        {
          client_line_id: "existing-order-balance",
          target_transaction_id: orderCheckout.transaction_id,
          target_display_id: orderBefore.transaction_display_id,
          customer_id: fixture.customer.id,
          amount: "194.69",
          balance_before: "194.69",
          projected_balance_after: "0.00",
        },
      ],
    });
    const currentCheckout = await expectSuccessfulCheckout(currentRes);
    const currentArtifacts = await getTransactionArtifacts(request, currentCheckout.transaction_id);
    const orderAfter = await fetchTransactionDetail(request, orderCheckout.transaction_id);

    expect(currentArtifacts.total_price).toBe("244.69");
    expect(currentArtifacts.amount_paid).toBe("244.69");
    expect(moneyToCents(currentArtifacts.balance_due)).toBe(0);
    expect(moneyToCents(orderAfter.balance_due)).toBe(0);

    const allocations = currentArtifacts.allocation_rows;
    expect(allocations).toHaveLength(3);
    expect(
      allocations.map((row) => ({
        method: row.payment_method,
        target: row.target_transaction_id,
        amount: row.amount_allocated,
        check: row.allocation_check_number,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          method: "cash",
          target: currentCheckout.transaction_id,
          amount: "100.00",
          check: null,
        },
        {
          method: "check",
          target: currentCheckout.transaction_id,
          amount: "144.69",
          check: "CHK-E2E-400",
        },
        {
          method: "check",
          target: orderCheckout.transaction_id,
          amount: "194.69",
          check: "CHK-E2E-400",
        },
      ]),
    );

    const orderAllocation = allocations.find(
      (row) => row.target_transaction_id === orderCheckout.transaction_id,
    );
    expect(orderAllocation?.allocation_metadata).toMatchObject({
      kind: "existing_order_payment",
      client_line_id: "existing-order-balance",
      target_transaction_id: orderCheckout.transaction_id,
      target_display_id: orderBefore.transaction_display_id,
      customer_id: fixture.customer.id,
      balance_before: "194.69",
      projected_balance_after: "0.00",
      applied_deposit_amount: "194.69",
    });
  });

  test("cash rounding records balanced transaction artifacts and QBO rounding impact", async ({
    request,
  }) => {
    const activityDate = futureUtcDate(90 + Math.floor(Math.random() * 300));
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const fixture = await seedRmsFixture(request, "single_valid", "Tender Cash Rounding");
    await seedQboMappings(request, activityDate);

    const checkoutRes = await checkoutFixtureProduct(request, {
      fixture,
      sessionId,
      sessionToken,
      operatorStaffId,
      customerId: fixture.customer.id,
      amountPaid: "244.70",
      paymentSplits: [{ payment_method: "cash", amount: "244.70" }],
      roundingAdjustment: "0.01",
      finalCashDue: "244.70",
    });
    const checkout = await expectSuccessfulCheckout(checkoutRes);
    await assignQboDate(request, checkout.transaction_id, activityDate);

    const artifacts: TransactionArtifacts = await getTransactionArtifacts(
      request,
      checkout.transaction_id,
    );
    expect(artifacts.total_price).toBe("244.69");
    expect(artifacts.amount_paid).toBe("244.70");
    expect(moneyToCents(artifacts.balance_due)).toBe(0);
    expect(artifacts.rounding_adjustment).toBe("0.01");
    expect(artifacts.allocation_rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_transaction_id: checkout.transaction_id,
          payment_method: "cash",
          amount_allocated: "244.70",
          payment_amount: "244.70",
        }),
      ]),
    );

    const proposed = await proposeJournal(request, activityDate);
    expect(proposed.payload.totals?.balanced).toBe(true);
    expect(moneyToCents(proposed.payload.totals?.debits)).toBe(
      moneyToCents(proposed.payload.totals?.credits),
    );

    const roundingLine = proposed.payload.lines.find(
      (line) => line.qbo_account_id === "E2E_CASH_ROUNDING",
    );
    expect(roundingLine).toBeTruthy();
    expect(roundingLine?.memo).toContain("Rounding");
    expect(moneyToCents(roundingLine?.debit)).toBe(0);
    expect(moneyToCents(roundingLine?.credit)).toBe(1);
    expect(roundingLine?.detail ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "cash_rounding",
          amount: "0.01",
        }),
      ]),
    );

    const cashLine = proposed.payload.lines.find(
      (line) => line.memo.startsWith("Tenders") && line.qbo_account_id === "E2E_CASH",
    );
    expect(cashLine).toBeTruthy();
    expect(moneyToCents(cashLine?.debit)).toBe(24470);
  });
});
