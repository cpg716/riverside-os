import { expect, test, type APIRequestContext } from "@playwright/test";
import { centsToFixed2, parseMoneyToCents } from "../src/lib/money";
import { calculateNysErieTaxStringsForUnit } from "../src/lib/tax";
import {
  apiBase,
  ensureSessionAuth,
  staffHeaders,
  verifyStaffId,
} from "./helpers/rmsCharge";

type CreatedQboProduct = {
  categoryId: string;
  productId: string;
  variantId: string;
  sku: string;
  unitCost: string;
};

type CheckoutResponse = {
  transaction_id: string;
  display_id?: string;
};

type CustomerResponse = {
  id: string;
};

type TransactionDetail = {
  transaction_display_id: string;
  total_price: string;
  balance_due: string;
};

type TransactionListResponse = {
  items: Array<{
    transaction_id: string;
    display_id: string;
    order_payment_display_id: string;
    order_kind: string;
    is_fulfillment_order: boolean;
  }>;
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
    business_timezone?: string;
    lines: QboJournalLine[];
    totals?: {
      debits?: string | number;
      credits?: string | number;
      balanced?: boolean;
    };
    warnings?: string[];
  };
};

function uniqueSuffix(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function futureUtcDate(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function moneyToCents(value: string | number | undefined): number {
  if (value === undefined) return 0;
  return parseMoneyToCents(String(value));
}

function totalFor(unitPrice: string, stateTax: string, localTax: string): string {
  return centsToFixed2(
    parseMoneyToCents(unitPrice) + parseMoneyToCents(stateTax) + parseMoneyToCents(localTax),
  );
}

async function createQboProduct(
  request: APIRequestContext,
  actorStaffId: string,
): Promise<CreatedQboProduct> {
  const suffix = uniqueSuffix("qbo");
  const categoryRes = await request.post(`${apiBase()}/api/categories`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      name: `E2E QBO ${suffix}`,
      parent_id: null,
      is_clothing_footwear: true,
      changed_by_staff_id: actorStaffId,
      change_note: "Created for QBO audit E2E coverage",
    },
    failOnStatusCode: false,
  });
  expect(categoryRes.status()).toBe(200);
  const category = (await categoryRes.json()) as { id: string };

  const sku = `QBO-${suffix}`.toUpperCase();
  const createRes = await request.post(`${apiBase()}/api/products`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      category_id: category.id,
      name: `E2E QBO Journal Item ${suffix}`,
      brand: "Riverside E2E",
      description: "Deterministic QBO audit SKU",
      base_retail_price: "110.00",
      base_cost: "40.00",
      variation_axes: [],
      images: [],
      track_low_stock: false,
      publish_variants_to_web: false,
      variants: [
        {
          sku,
          variation_values: {},
          variation_label: "Standard",
          stock_on_hand: 20,
          retail_price_override: null,
          cost_override: null,
          track_low_stock: false,
        },
      ],
    },
    failOnStatusCode: false,
  });
  expect(createRes.status()).toBe(200);
  const product = (await createRes.json()) as { id: string };

  const variantsRes = await request.get(`${apiBase()}/api/products/${product.id}/variants`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  expect(variantsRes.status()).toBe(200);
  const variants = (await variantsRes.json()) as Array<{ id: string; sku: string }>;
  expect(variants[0]?.id).toBeTruthy();

  return {
    categoryId: category.id,
    productId: product.id,
    variantId: variants[0]!.id,
    sku,
    unitCost: "40.00",
  };
}

async function checkoutQboProduct(
  request: APIRequestContext,
  options: {
    product: CreatedQboProduct;
    sessionId: string;
    sessionToken: string;
    operatorStaffId: string;
    customerId?: string | null;
    fulfillment?: "takeaway" | "layaway";
    amountPaid?: string;
    appliedDepositAmount?: string;
  },
): Promise<CheckoutResponse> {
  const tax = calculateNysErieTaxStringsForUnit("clothing", parseMoneyToCents("110.00"));
  const total = totalFor("110.00", tax.stateTax, tax.localTax);
  const amountPaid = options.amountPaid ?? total;
  const paymentSplit: Record<string, string> = {
    payment_method: "cash",
    amount: amountPaid,
  };
  if (options.appliedDepositAmount) {
    paymentSplit.applied_deposit_amount = options.appliedDepositAmount;
  }
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
      total_price: total,
      amount_paid: amountPaid,
      checkout_client_id: crypto.randomUUID(),
      items: [
        {
          product_id: options.product.productId,
          variant_id: options.product.variantId,
          fulfillment: options.fulfillment ?? "takeaway",
          quantity: 1,
          unit_price: "110.00",
          unit_cost: options.product.unitCost,
          state_tax: tax.stateTax,
          local_tax: tax.localTax,
          salesperson_id: options.operatorStaffId,
        },
      ],
      payment_splits: [paymentSplit],
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as CheckoutResponse;
}

async function createQboCustomer(request: APIRequestContext): Promise<CustomerResponse> {
  const suffix = uniqueSuffix("layaway-qbo");
  const res = await request.post(`${apiBase()}/api/customers`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      first_name: "QBO",
      last_name: suffix,
      email: `${suffix}@example.test`,
      phone: "555-0100",
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as CustomerResponse;
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

async function fetchCustomerLayaways(
  request: APIRequestContext,
  customerId: string,
): Promise<TransactionListResponse> {
  const res = await request.get(
    `${apiBase()}/api/transactions?customer_id=${encodeURIComponent(customerId)}&kind_filter=layaway&limit=25`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as TransactionListResponse;
}

async function payExistingTransaction(
  request: APIRequestContext,
  options: {
    sessionId: string;
    sessionToken: string;
    operatorStaffId: string;
    customerId: string;
    targetTransactionId: string;
    targetDisplayId: string;
    amount: string;
    balanceBefore: string;
  },
): Promise<CheckoutResponse> {
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
      customer_id: options.customerId,
      payment_method: "cash",
      total_price: "0.00",
      amount_paid: options.amount,
      checkout_client_id: crypto.randomUUID(),
      items: [],
      order_payments: [
        {
          client_line_id: "layaway-final-payment",
          target_transaction_id: options.targetTransactionId,
          target_display_id: options.targetDisplayId,
          customer_id: options.customerId,
          amount: options.amount,
          balance_before: options.balanceBefore,
          projected_balance_after: "0.00",
        },
      ],
      payment_splits: [
        {
          payment_method: "cash",
          amount: options.amount,
        },
      ],
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as CheckoutResponse;
}

async function seedQboMappings(
  request: APIRequestContext,
  categoryId: string,
  activityDate: string,
) {
  const res = await request.post(`${apiBase()}/api/test-support/qbo/seed-tax-mapping`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      category_id: categoryId,
      activity_date: activityDate,
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
}

async function assignQboTimestamp(
  request: APIRequestContext,
  transactionId: string,
  timestampUtc: string,
) {
  const res = await request.post(`${apiBase()}/api/test-support/qbo/assign-transaction-timestamp`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      transaction_id: transactionId,
      timestamp_utc: timestampUtc,
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
) {
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

async function assignQboFulfillmentTimestamp(
  request: APIRequestContext,
  transactionId: string,
  timestampUtc: string,
) {
  const res = await request.post(
    `${apiBase()}/api/test-support/qbo/assign-transaction-fulfillment-timestamp`,
    {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
      },
      data: {
        transaction_id: transactionId,
        timestamp_utc: timestampUtc,
      },
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
}

async function assignQboForfeitureTimestamp(
  request: APIRequestContext,
  transactionId: string,
  timestampUtc: string,
) {
  const res = await request.post(
    `${apiBase()}/api/test-support/qbo/assign-transaction-forfeiture-timestamp`,
    {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
      },
      data: {
        transaction_id: transactionId,
        timestamp_utc: timestampUtc,
      },
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
}

async function markPickup(request: APIRequestContext, transactionId: string) {
  const res = await request.post(`${apiBase()}/api/transactions/${transactionId}/pickup`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      delivered_item_ids: [],
      actor: "QBO layaway audit",
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
}

async function forfeitLayaway(request: APIRequestContext, transactionId: string) {
  const res = await request.patch(`${apiBase()}/api/transactions/${transactionId}`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      status: "Cancelled",
      forfeiture_reason: "E2E layaway QBO forfeiture contract",
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
}

async function assignQboShippingRecognition(
  request: APIRequestContext,
  transactionId: string,
  timestampUtc: string,
) {
  const res = await request.post(`${apiBase()}/api/test-support/qbo/assign-shipping-recognition`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      transaction_id: transactionId,
      label_purchased_at_utc: timestampUtc,
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

test.describe("QBO audit contract", () => {
  test("layaways stay transaction-scoped and post deposit, pickup, and forfeiture journals", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const uniqueDateOffset = Math.trunc(Date.now() % 5000);
    const depositDate = futureUtcDate(35 + uniqueDateOffset);
    const pickupDate = futureUtcDate(36 + uniqueDateOffset);
    const forfeitDepositDate = futureUtcDate(37 + uniqueDateOffset);
    const forfeitDate = futureUtcDate(38 + uniqueDateOffset);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createQboProduct(request, operatorStaffId);
    const customer = await createQboCustomer(request);

    for (const date of [depositDate, pickupDate, forfeitDepositDate, forfeitDate]) {
      await seedQboMappings(request, product.categoryId, date);
    }

    const layaway = await checkoutQboProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
      customerId: customer.id,
      fulfillment: "layaway",
      amountPaid: "30.00",
      appliedDepositAmount: "30.00",
    });
    await assignQboDate(request, layaway.transaction_id, depositDate);

    const layawayDetail = await fetchTransactionDetail(request, layaway.transaction_id);
    expect(layawayDetail.transaction_display_id).toMatch(/^TXN-/);
    expect(layawayDetail.balance_due).toBe("89.63");

    const layawayList = await fetchCustomerLayaways(request, customer.id);
    const layawayRow = layawayList.items.find(
      (row) => row.transaction_id === layaway.transaction_id,
    );
    expect(layawayRow).toBeTruthy();
    expect(layawayRow?.order_kind).toBe("layaway");
    expect(layawayRow?.display_id).toMatch(/^TXN-/);
    expect(layawayRow?.order_payment_display_id).toMatch(/^TXN-/);
    expect(layawayRow?.is_fulfillment_order).toBe(false);

    const depositProposal = await proposeJournal(request, depositDate);
    expect(depositProposal.payload.totals?.balanced).toBe(true);
    expect(
      depositProposal.payload.lines.some(
        (line) =>
          line.qbo_account_id === "E2E_DEPOSIT_LIABILITY" &&
          moneyToCents(line.credit) === parseMoneyToCents("30.00"),
      ),
    ).toBe(true);
    expect(
      depositProposal.payload.lines.some(
        (line) =>
          line.qbo_account_id === "E2E_REVENUE" &&
          line.detail?.some((detail) => detail.category_id === product.categoryId),
      ),
    ).toBe(false);

    const payoff = await payExistingTransaction(request, {
      sessionId,
      sessionToken,
      operatorStaffId,
      customerId: customer.id,
      targetTransactionId: layaway.transaction_id,
      targetDisplayId: layawayDetail.transaction_display_id,
      amount: layawayDetail.balance_due,
      balanceBefore: layawayDetail.balance_due,
    });
    await assignQboDate(request, payoff.transaction_id, pickupDate);
    await markPickup(request, layaway.transaction_id);
    await assignQboFulfillmentTimestamp(
      request,
      layaway.transaction_id,
      `${pickupDate}T15:00:00Z`,
    );

    const pickupProposal = await proposeJournal(request, pickupDate);
    expect(pickupProposal.payload.totals?.balanced).toBe(true);
    expect(
      pickupProposal.payload.lines.some(
        (line) =>
          line.qbo_account_id === "E2E_DEPOSIT_LIABILITY" &&
          moneyToCents(line.debit) === parseMoneyToCents("30.00"),
      ),
    ).toBe(true);
    const revenueCredits = pickupProposal.payload.lines
      .filter(
        (line) =>
          line.qbo_account_id === "E2E_REVENUE" &&
          line.detail?.some((detail) => detail.category_id === product.categoryId),
      )
      .reduce((sum, line) => sum + moneyToCents(line.credit), 0);
    expect(revenueCredits).toBe(parseMoneyToCents("110.00"));
    expect(
      pickupProposal.payload.lines.some(
        (line) =>
          line.qbo_account_id === "E2E_SALES_TAX" &&
          moneyToCents(line.credit) === parseMoneyToCents("9.63"),
      ),
    ).toBe(true);

    const forfeited = await checkoutQboProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
      customerId: customer.id,
      fulfillment: "layaway",
      amountPaid: "30.00",
      appliedDepositAmount: "30.00",
    });
    await assignQboDate(request, forfeited.transaction_id, forfeitDepositDate);
    await forfeitLayaway(request, forfeited.transaction_id);
    await assignQboForfeitureTimestamp(
      request,
      forfeited.transaction_id,
      `${forfeitDate}T15:00:00Z`,
    );

    const forfeitProposal = await proposeJournal(request, forfeitDate);
    expect(forfeitProposal.payload.totals?.balanced).toBe(true);
    expect(
      forfeitProposal.payload.lines.some(
        (line) =>
          line.qbo_account_id === "E2E_DEPOSIT_LIABILITY" &&
          moneyToCents(line.debit) === parseMoneyToCents("30.00"),
      ),
    ).toBe(true);
    expect(
      forfeitProposal.payload.lines.some(
        (line) =>
          line.qbo_account_id === "E2E_FORFEITED_DEPOSIT" &&
          moneyToCents(line.credit) === parseMoneyToCents("30.00"),
      ),
    ).toBe(true);

    const nonLayaway = await checkoutQboProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
    });
    const badForfeit = await request.patch(
      `${apiBase()}/api/transactions/${nonLayaway.transaction_id}`,
      {
        headers: {
          ...staffHeaders(),
          "Content-Type": "application/json",
        },
        data: {
          status: "Cancelled",
          forfeiture_reason: "should not be allowed for non-layaway",
        },
        failOnStatusCode: false,
      },
    );
    expect(badForfeit.status()).toBe(400);
    await expect(badForfeit.text()).resolves.toMatch(/only allowed for layaway/i);
  });

  test("proposed journal is balanced, deduped while pending, drillable, and approval-gated", async ({
    request,
  }) => {
    test.setTimeout(90_000);
    const activityDate = futureUtcDate(7);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createQboProduct(request, operatorStaffId);
    await seedQboMappings(request, product.categoryId, activityDate);
    const checkout = await checkoutQboProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
    });
    const assignDateRes = await request.post(
      `${apiBase()}/api/test-support/qbo/assign-transaction-date`,
      {
        headers: {
          ...staffHeaders(),
          "Content-Type": "application/json",
        },
        data: {
          transaction_id: checkout.transaction_id,
          activity_date: activityDate,
        },
        failOnStatusCode: false,
      },
    );
    const assignDateText = await assignDateRes.text();
    expect(assignDateRes.status(), assignDateText.slice(0, 1000)).toBe(200);

    const proposed = await proposeJournal(request, activityDate);
    expect(proposed.sync_date).toBe(activityDate);
    expect(proposed.status).toBe("pending");
    expect(proposed.payload.activity_date).toBe(activityDate);
    expect(proposed.payload.totals?.balanced).toBe(true);
    expect(moneyToCents(proposed.payload.totals?.debits)).toBe(
      moneyToCents(proposed.payload.totals?.credits),
    );

    const postableLines = proposed.payload.lines.filter(
      (line) => line.qbo_account_id && (moneyToCents(line.debit) > 0 || moneyToCents(line.credit) > 0),
    );
    expect(postableLines.length).toBeGreaterThanOrEqual(3);
    const lineDebits = postableLines.reduce((sum, line) => sum + moneyToCents(line.debit), 0);
    const lineCredits = postableLines.reduce((sum, line) => sum + moneyToCents(line.credit), 0);
    expect(lineDebits).toBe(lineCredits);

    expect(postableLines.some((line) => line.qbo_account_id === "E2E_CASH")).toBe(true);
    expect(postableLines.some((line) => line.qbo_account_id === "E2E_REVENUE")).toBe(true);
    expect(postableLines.some((line) => line.qbo_account_id === "E2E_SALES_TAX")).toBe(true);
    expect(proposed.payload.warnings ?? []).not.toContain(
      "Sales tax collected but no `tax` / SALES_TAX or MISC mapping; add qbo_mappings row.",
    );

    const duplicate = await proposeJournal(request, activityDate);
    expect(duplicate.id).toBe(proposed.id);
    expect(duplicate.status).toBe("pending");

    const listRes = await request.get(
      `${apiBase()}/api/qbo/staging?from=${activityDate}&to=${activityDate}`,
      {
        headers: staffHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(listRes.status()).toBe(200);
    const stagingRows = (await listRes.json()) as QboStagingRow[];
    const matchingPendingRows = stagingRows.filter(
      (row) => row.id === proposed.id && row.sync_date === activityDate && row.status === "pending",
    );
    expect(matchingPendingRows).toHaveLength(1);

    const tenderLineIndex = proposed.payload.lines.findIndex(
      (line) => line.memo.startsWith("Tenders") && line.qbo_account_id === "E2E_CASH",
    );
    expect(tenderLineIndex).toBeGreaterThanOrEqual(0);
    const drilldownRes = await request.get(
      `${apiBase()}/api/qbo/staging/${proposed.id}/drilldown?line_index=${tenderLineIndex}`,
      {
        headers: staffHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(drilldownRes.status()).toBe(200);
    const drilldown = (await drilldownRes.json()) as {
      contributors?: Array<{ transaction_id: string; amount: string | number }>;
    };
    const contributor = drilldown.contributors?.find(
      (row) => row.transaction_id === checkout.transaction_id,
    );
    expect(contributor).toBeTruthy();
    expect(moneyToCents(contributor?.amount)).toBe(parseMoneyToCents("119.63"));

    const approveRes = await request.post(`${apiBase()}/api/qbo/staging/${proposed.id}/approve`, {
      headers: staffHeaders(),
      failOnStatusCode: false,
    });
    const approveText = await approveRes.text();
    expect(approveRes.status(), approveText.slice(0, 1000)).toBe(200);
    expect(JSON.parse(approveText)).toMatchObject({ status: "approved" });

    const approveAgainRes = await request.post(`${apiBase()}/api/qbo/staging/${proposed.id}/approve`, {
      headers: staffHeaders(),
      failOnStatusCode: false,
    });
    expect(approveAgainRes.status()).toBe(409);
    await expect(approveAgainRes.text()).resolves.toMatch(/only pending entries can be approved/i);
  });

  test("store-local business date wins over UTC date near midnight", async ({ request }) => {
    test.setTimeout(90_000);
    const base = new Date();
    base.setUTCDate(base.getUTCDate() + 180 + Math.floor(Math.random() * 120));
    const localBusinessDate = base.toISOString().slice(0, 10);
    const utcNext = new Date(base);
    utcNext.setUTCDate(utcNext.getUTCDate() + 1);
    const utcCalendarDate = utcNext.toISOString().slice(0, 10);
    const timestampUtc = `${utcCalendarDate}T03:30:00Z`;

    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createQboProduct(request, operatorStaffId);
    await seedQboMappings(request, product.categoryId, localBusinessDate);
    await seedQboMappings(request, product.categoryId, utcCalendarDate);

    const checkout = await checkoutQboProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
    });
    await assignQboTimestamp(request, checkout.transaction_id, timestampUtc);

    const localProposal = await proposeJournal(request, localBusinessDate);
    expect(localProposal.payload.activity_date).toBe(localBusinessDate);
    expect(localProposal.payload.business_timezone).toBeTruthy();
    const localTenderLineIndex = localProposal.payload.lines.findIndex(
      (line) => line.memo.startsWith("Tenders") && line.qbo_account_id === "E2E_CASH",
    );
    expect(localTenderLineIndex).toBeGreaterThanOrEqual(0);
    const localDrilldownRes = await request.get(
      `${apiBase()}/api/qbo/staging/${localProposal.id}/drilldown?line_index=${localTenderLineIndex}`,
      {
        headers: staffHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(localDrilldownRes.status()).toBe(200);
    const localDrilldown = (await localDrilldownRes.json()) as {
      contributors?: Array<{ transaction_id: string; amount: string | number }>;
    };
    expect(
      localDrilldown.contributors?.some((row) => row.transaction_id === checkout.transaction_id),
    ).toBe(true);

    const utcProposal = await proposeJournal(request, utcCalendarDate);
    const utcTenderLineIndex = utcProposal.payload.lines.findIndex(
      (line) => line.memo.startsWith("Tenders") && line.qbo_account_id === "E2E_CASH",
    );
    if (utcTenderLineIndex >= 0) {
      const utcDrilldownRes = await request.get(
        `${apiBase()}/api/qbo/staging/${utcProposal.id}/drilldown?line_index=${utcTenderLineIndex}`,
        {
          headers: staffHeaders(),
          failOnStatusCode: false,
        },
      );
      expect(utcDrilldownRes.status()).toBe(200);
      const utcDrilldown = (await utcDrilldownRes.json()) as {
        contributors?: Array<{ transaction_id: string; amount: string | number }>;
      };
      expect(
        utcDrilldown.contributors?.some((row) => row.transaction_id === checkout.transaction_id),
      ).toBe(false);
    }
  });

  test("shipped orders recognize in QBO on shipment event date", async ({ request }) => {
    test.setTimeout(90_000);
    const activityDate = futureUtcDate(21);
    const recognitionTimestampUtc = `${activityDate}T16:00:00Z`;
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createQboProduct(request, operatorStaffId);
    await seedQboMappings(request, product.categoryId, activityDate);

    const checkout = await checkoutQboProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
    });
    await assignQboShippingRecognition(request, checkout.transaction_id, recognitionTimestampUtc);

    const proposed = await proposeJournal(request, activityDate);
    expect(proposed.payload.business_timezone).toBeTruthy();
    expect(proposed.payload.totals?.balanced).toBe(true);

    const revenueLineIndex = proposed.payload.lines.findIndex(
      (line) =>
        line.memo.startsWith("Revenue") &&
        line.qbo_account_id === "E2E_REVENUE" &&
        line.detail?.some((detail) => detail.category_id === product.categoryId),
    );
    expect(revenueLineIndex).toBeGreaterThanOrEqual(0);

    const drilldownRes = await request.get(
      `${apiBase()}/api/qbo/staging/${proposed.id}/drilldown?line_index=${revenueLineIndex}`,
      {
        headers: staffHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(drilldownRes.status()).toBe(200);
    const drilldown = (await drilldownRes.json()) as {
      contributors?: Array<{ transaction_id: string; amount: string | number }>;
    };
    expect(
      drilldown.contributors?.some((row) => row.transaction_id === checkout.transaction_id),
    ).toBe(true);
  });
});
