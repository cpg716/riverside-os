import { expect, test, type APIRequestContext } from "@playwright/test";
import { centsToFixed2, parseMoneyToCents } from "../src/lib/money";
import { calculateNysErieTaxStringsForUnit } from "../src/lib/tax";
import {
  apiBase,
  ensureSessionAuth,
  getTransactionArtifacts,
  staffHeaders,
  verifyStaffId,
} from "./helpers/rmsCharge";
import { createVendor } from "./helpers/inventoryReceiving";

type CreatedQboProduct = {
  categoryId: string;
  productId: string;
  variantId: string;
  sku: string;
  unitCost: string;
};

type GiftCardLoadLineMeta = {
  product_id: string;
  variant_id: string;
  sku: string;
};

type GiftCardSubtype =
  | "paid_liability"
  | "loyalty_giveaway"
  | "donated_giveaway"
  | "promo_gift_card";

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
  amount_paid: string;
  balance_due: string;
  items: Array<{
    transaction_line_id: string;
    sku: string;
    quantity: number;
    quantity_returned: number;
  }>;
};

type RefundQueueRow = {
  transaction_id: string;
  amount_due: string;
  amount_refunded: string;
  is_open: boolean;
};

type QboDrilldown = {
  contributors?: Array<{
    transaction_id: string;
    amount: string | number;
  }>;
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
    qbo_stage?: {
      entry_type?: string;
      business_date?: string;
      revision_of?: Array<{
        staging_id?: string;
        status?: string;
        journal_entry_id?: string | null;
      }>;
      note?: string;
    };
    lines: QboJournalLine[];
    totals?: {
      debits?: string | number;
      credits?: string | number;
      balanced?: boolean;
    };
    warnings?: string[];
  };
};

type CustomerLiabilityLedgers = {
  store_credit: Array<{
    amount: string | number;
    balance_after: string | number;
    reason: string;
    transaction_id: string | null;
  }>;
  open_deposit: Array<{
    amount: string | number;
    balance_after: string | number;
    reason: string;
    transaction_id: string | null;
  }>;
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
  const vendor = await createVendor(request, suffix);
  const createRes = await request.post(`${apiBase()}/api/products`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      category_id: category.id,
      primary_vendor_id: vendor.id,
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
    fulfillment?: "takeaway" | "layaway" | "special_order";
    quantity?: number;
    amountPaid?: string;
    appliedDepositAmount?: string;
    paymentMethod?: string;
    giftCardCode?: string;
    giftCardSubType?: GiftCardSubtype;
  },
): Promise<CheckoutResponse> {
  const tax = calculateNysErieTaxStringsForUnit("clothing", parseMoneyToCents("110.00"));
  const quantity = options.quantity ?? 1;
  const total = centsToFixed2(
    parseMoneyToCents(totalFor("110.00", tax.stateTax, tax.localTax)) * quantity,
  );
  const amountPaid = options.amountPaid ?? total;
  const paymentMethod = options.paymentMethod ?? "cash";
  const paymentSplit: Record<string, string> = {
    payment_method: paymentMethod,
    amount: amountPaid,
  };
  if (options.appliedDepositAmount) {
    paymentSplit.applied_deposit_amount = options.appliedDepositAmount;
  }
  if (options.giftCardCode) {
    paymentSplit.gift_card_code = options.giftCardCode;
  }
  if (options.giftCardSubType) {
    paymentSplit.sub_type = options.giftCardSubType;
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
      payment_method: paymentMethod,
      total_price: total,
      amount_paid: amountPaid,
      checkout_client_id: crypto.randomUUID(),
      items: [
        {
          product_id: options.product.productId,
          variant_id: options.product.variantId,
          fulfillment: options.fulfillment ?? "takeaway",
          quantity,
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

async function fetchGiftCardLoadLineMeta(request: APIRequestContext): Promise<GiftCardLoadLineMeta> {
  const res = await request.get(`${apiBase()}/api/pos/gift-card-load-line-meta`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  const body = JSON.parse(bodyText) as GiftCardLoadLineMeta | null;
  expect(body).toBeTruthy();
  return body as GiftCardLoadLineMeta;
}

async function checkoutPurchasedGiftCardLoad(
  request: APIRequestContext,
  options: {
    sessionId: string;
    sessionToken: string;
    operatorStaffId: string;
    code: string;
    amount: string;
  },
): Promise<CheckoutResponse> {
  const meta = await fetchGiftCardLoadLineMeta(request);
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
      customer_id: null,
      payment_method: "cash",
      total_price: options.amount,
      amount_paid: options.amount,
      checkout_client_id: crypto.randomUUID(),
      items: [
        {
          product_id: meta.product_id,
          variant_id: meta.variant_id,
          fulfillment: "takeaway",
          quantity: 1,
          unit_price: options.amount,
          unit_cost: "0.00",
          state_tax: "0.00",
          local_tax: "0.00",
          salesperson_id: options.operatorStaffId,
          price_override_reason: "pos_gift_card_load",
          original_unit_price: "0.00",
          gift_card_load_code: options.code,
        },
      ],
      payment_splits: [{ payment_method: "cash", amount: options.amount }],
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as CheckoutResponse;
}

async function issueGiftCardForQbo(
  request: APIRequestContext,
  options: {
    code: string;
    amount: string;
    kind: Exclude<GiftCardSubtype, "paid_liability">;
  },
) {
  const endpoint =
    options.kind === "loyalty_giveaway"
      ? "issue-loyalty-load"
      : options.kind === "donated_giveaway"
        ? "issue-donated"
        : "issue-promo";
  const res = await request.post(`${apiBase()}/api/gift-cards/${endpoint}`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      code: options.code,
      amount: options.amount,
      event_name: "E2E QBO promo event",
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
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

async function seedCustomerLiability(
  request: APIRequestContext,
  options: {
    customerId: string;
    storeCreditBalance?: string;
    openDepositBalance?: string;
  },
) {
  const res = await request.post(`${apiBase()}/api/test-support/qbo/seed-customer-liability`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      customer_id: options.customerId,
      store_credit_balance: options.storeCreditBalance,
      open_deposit_balance: options.openDepositBalance,
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
}

async function fetchCustomerLiabilityLedgers(
  request: APIRequestContext,
  customerId: string,
): Promise<CustomerLiabilityLedgers> {
  const res = await request.get(
    `${apiBase()}/api/test-support/qbo/customer-liability-ledgers/${customerId}`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as CustomerLiabilityLedgers;
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

async function assignQboReturnDate(
  request: APIRequestContext,
  transactionId: string,
  activityDate: string,
) {
  const res = await request.post(`${apiBase()}/api/test-support/qbo/assign-transaction-return-date`, {
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

async function assignQboRefundPaymentDate(
  request: APIRequestContext,
  transactionId: string,
  activityDate: string,
) {
  const res = await request.post(`${apiBase()}/api/test-support/qbo/assign-transaction-refund-payment-date`, {
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

async function returnFirstQboLine(
  request: APIRequestContext,
  options: {
    transactionId: string;
    sessionId: string;
    sessionToken: string;
    productSku: string;
  },
): Promise<TransactionDetail> {
  const before = await fetchTransactionDetail(request, options.transactionId);
  const line = before.items.find((item) => item.sku === options.productSku);
  expect(line?.transaction_line_id).toBeTruthy();

  const res = await request.post(
    `${apiBase()}/api/transactions/${options.transactionId}/returns?register_session_id=${encodeURIComponent(options.sessionId)}`,
    {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
        "x-riverside-pos-session-id": options.sessionId,
        "x-riverside-pos-session-token": options.sessionToken,
      },
      data: {
        lines: [
          {
            transaction_line_id: line?.transaction_line_id,
            quantity: 1,
            reason: "qbo_audit_return",
          },
        ],
      },
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as TransactionDetail;
}

async function fetchRefundsDue(request: APIRequestContext): Promise<RefundQueueRow[]> {
  const res = await request.get(`${apiBase()}/api/transactions/refunds/due`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as RefundQueueRow[];
}

async function processCashRefund(
  request: APIRequestContext,
  options: {
    transactionId: string;
    sessionId: string;
    amount: string;
  },
): Promise<void> {
  const res = await request.post(
    `${apiBase()}/api/transactions/${options.transactionId}/refunds/process`,
    {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
      },
      data: {
        session_id: options.sessionId,
        payment_method: "cash",
        amount: options.amount,
      },
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
}

async function fetchQboDrilldown(
  request: APIRequestContext,
  stagingId: string,
  lineIndex: number,
): Promise<QboDrilldown> {
  const res = await request.get(
    `${apiBase()}/api/qbo/staging/${stagingId}/drilldown?line_index=${lineIndex}`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as QboDrilldown;
}

test.describe("QBO audit contract", () => {
  test("processed refunds post negative tender evidence and returned-line drilldown uses effective quantity", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const dateOffset = 180 + Math.floor(Math.random() * 4000);
    const refundOriginalDate = futureUtcDate(dateOffset);
    const refundDate = futureUtcDate(dateOffset + 1);
    const recognitionDate = futureUtcDate(dateOffset + 2);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createQboProduct(request, operatorStaffId);
    const unitTax = calculateNysErieTaxStringsForUnit("clothing", parseMoneyToCents("110.00"));
    const returnedUnitTotal = totalFor("110.00", unitTax.stateTax, unitTax.localTax);

    const refundCheckout = await checkoutQboProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
      quantity: 2,
    });
    await assignQboDate(request, refundCheckout.transaction_id, refundOriginalDate);

    const returnedDetail = await returnFirstQboLine(request, {
      transactionId: refundCheckout.transaction_id,
      sessionId,
      sessionToken,
      productSku: product.sku,
    });
    const returnedLine = returnedDetail.items.find((item) => item.sku === product.sku);
    expect(returnedLine?.quantity).toBe(2);
    expect(returnedLine?.quantity_returned).toBe(1);
    expect(returnedDetail.total_price).toBe(returnedUnitTotal);

    const refundBefore = (await fetchRefundsDue(request)).find(
      (row) => row.transaction_id === refundCheckout.transaction_id,
    );
    expect(refundBefore?.is_open).toBe(true);
    expect(refundBefore?.amount_due).toBe(returnedUnitTotal);
    expect(moneyToCents(refundBefore?.amount_refunded)).toBe(0);

    await processCashRefund(request, {
      transactionId: refundCheckout.transaction_id,
      sessionId,
      amount: returnedUnitTotal,
    });
    await assignQboReturnDate(request, refundCheckout.transaction_id, refundDate);

    const refundArtifacts = await getTransactionArtifacts(
      request,
      refundCheckout.transaction_id,
    );
    expect(refundArtifacts.allocation_rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_transaction_id: refundCheckout.transaction_id,
          payment_method: "cash",
          amount_allocated: `-${returnedUnitTotal}`,
          payment_amount: `-${returnedUnitTotal}`,
        }),
      ]),
    );
    expect(
      (await fetchRefundsDue(request)).some(
        (row) => row.transaction_id === refundCheckout.transaction_id,
      ),
    ).toBe(false);

    await seedQboMappings(request, product.categoryId, refundDate);
    const refundProposal = await proposeJournal(request, refundDate);
    expect(refundProposal.payload.totals?.balanced).toBe(true);
    const refundTenderIndex = refundProposal.payload.lines.findIndex(
      (line) =>
        line.memo === "Tenders (refund/outflow) — cash" &&
        line.qbo_account_id === "E2E_CASH",
    );
    expect(refundTenderIndex).toBeGreaterThanOrEqual(0);
    const refundTender = refundProposal.payload.lines[refundTenderIndex];
    expect(moneyToCents(refundTender?.credit)).toBe(parseMoneyToCents(returnedUnitTotal));
    const refundTenderDrilldown = await fetchQboDrilldown(
      request,
      refundProposal.id,
      refundTenderIndex,
    );
    const refundContributor = refundTenderDrilldown.contributors?.find(
      (row) => row.transaction_id === refundCheckout.transaction_id,
    );
    expect(refundContributor).toBeTruthy();
    expect(moneyToCents(refundContributor?.amount)).toBe(-parseMoneyToCents(returnedUnitTotal));

    const drilldownCheckout = await checkoutQboProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
      quantity: 2,
    });
    await returnFirstQboLine(request, {
      transactionId: drilldownCheckout.transaction_id,
      sessionId,
      sessionToken,
      productSku: product.sku,
    });
    await processCashRefund(request, {
      transactionId: drilldownCheckout.transaction_id,
      sessionId,
      amount: returnedUnitTotal,
    });
    await assignQboDate(request, drilldownCheckout.transaction_id, recognitionDate);
    await seedQboMappings(request, product.categoryId, recognitionDate);

    const recognitionProposal = await proposeJournal(request, recognitionDate);
    expect(recognitionProposal.payload.totals?.balanced).toBe(true);
    const revenueLineIndex = recognitionProposal.payload.lines.findIndex(
      (line) =>
        line.memo.startsWith("Revenue") &&
        line.qbo_account_id === "E2E_REVENUE" &&
        line.detail?.some((detail) => detail.category_id === product.categoryId),
    );
    expect(revenueLineIndex).toBeGreaterThanOrEqual(0);
    expect(moneyToCents(recognitionProposal.payload.lines[revenueLineIndex]?.credit)).toBe(
      parseMoneyToCents("110.00"),
    );
    const revenueDrilldown = await fetchQboDrilldown(
      request,
      recognitionProposal.id,
      revenueLineIndex,
    );
    const revenueContributor = revenueDrilldown.contributors?.find(
      (row) => row.transaction_id === drilldownCheckout.transaction_id,
    );
    expect(revenueContributor).toBeTruthy();
    expect(moneyToCents(revenueContributor?.amount)).toBe(parseMoneyToCents("110.00"));
  });

  test("asynchronous returns and refunds balance independently via liability clearing", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const dateOffset = 900 + Math.floor(Math.random() * 4000);
    const checkoutDate = futureUtcDate(dateOffset);
    const returnDate = futureUtcDate(dateOffset + 1);
    const refundDate = futureUtcDate(dateOffset + 2);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createQboProduct(request, operatorStaffId);
    const unitTax = calculateNysErieTaxStringsForUnit("clothing", parseMoneyToCents("110.00"));
    const returnedUnitTotal = totalFor("110.00", unitTax.stateTax, unitTax.localTax);

    const checkout = await checkoutQboProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
      quantity: 1,
    });
    await assignQboDate(request, checkout.transaction_id, checkoutDate);

    // 1. A return on Day 1 creates refund queue activity
    await returnFirstQboLine(request, {
      transactionId: checkout.transaction_id,
      sessionId,
      sessionToken,
      productSku: product.sku,
    });
    await assignQboReturnDate(request, checkout.transaction_id, returnDate);
    
    const refundBefore = (await fetchRefundsDue(request)).find(
      (row) => row.transaction_id === checkout.transaction_id,
    );
    expect(refundBefore?.is_open).toBe(true);
    expect(refundBefore?.amount_due).toBe(returnedUnitTotal);
    expect(moneyToCents(refundBefore?.amount_refunded)).toBe(0);

    // 2. Day 1 QBO proposal is balanced & 3. Day 1 includes refund liability clearing evidence
    await seedQboMappings(request, product.categoryId, returnDate);
    const returnProposal = await proposeJournal(request, returnDate);
    expect(returnProposal.payload.totals?.balanced).toBe(true);
    const liabilityCreatedIndex = returnProposal.payload.lines.findIndex(
      (line) =>
        line.memo === "Refund liability queued (from returns)" &&
        line.qbo_account_id === "E2E_REFUND_LIABILITY_CLEARING",
    );
    expect(liabilityCreatedIndex).toBeGreaterThanOrEqual(0);
    expect(moneyToCents(returnProposal.payload.lines[liabilityCreatedIndex]?.credit)).toBe(
      parseMoneyToCents(returnedUnitTotal),
    );

    // 4. A refund payout on Day 2 closes/reduces the queue
    await processCashRefund(request, {
      transactionId: checkout.transaction_id,
      sessionId,
      amount: returnedUnitTotal,
    });
    // Only update the refund payment to refundDate! The original checkout payment stays on checkoutDate.
    await assignQboRefundPaymentDate(request, checkout.transaction_id, refundDate);

    // 5. Day 2 QBO proposal is balanced & 6. Day 2 includes tender outflow and refund liability relief evidence
    await seedQboMappings(request, product.categoryId, refundDate);
    const refundProposal = await proposeJournal(request, refundDate);
    expect(refundProposal.payload.totals?.balanced).toBe(true);
    const liabilityRelievedIndex = refundProposal.payload.lines.findIndex(
      (line) =>
        line.memo === "Refund liability relieved (payouts)" &&
        line.qbo_account_id === "E2E_REFUND_LIABILITY_CLEARING",
    );
    expect(liabilityRelievedIndex).toBeGreaterThanOrEqual(0);
    expect(moneyToCents(refundProposal.payload.lines[liabilityRelievedIndex]?.debit)).toBe(
      parseMoneyToCents(returnedUnitTotal),
    );
    const refundTenderIndex = refundProposal.payload.lines.findIndex(
      (line) => line.memo === "Tenders (refund/outflow) — cash" && line.qbo_account_id === "E2E_CASH",
    );
    expect(refundTenderIndex).toBeGreaterThanOrEqual(0);
    expect(moneyToCents(refundProposal.payload.lines[refundTenderIndex]?.credit)).toBe(
      parseMoneyToCents(returnedUnitTotal),
    );
  });

  test("store credit and open deposit redemptions post liability relief in QBO", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const dateOffset = 240 + Math.floor(Math.random() * 4000);
    const activityDate = futureUtcDate(dateOffset);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createQboProduct(request, operatorStaffId);
    const customer = await createQboCustomer(request);
    const unitTax = calculateNysErieTaxStringsForUnit("clothing", parseMoneyToCents("110.00"));
    const transactionTotal = totalFor("110.00", unitTax.stateTax, unitTax.localTax);

    await seedQboMappings(request, product.categoryId, activityDate);
    await seedCustomerLiability(request, {
      customerId: customer.id,
      storeCreditBalance: transactionTotal,
      openDepositBalance: transactionTotal,
    });

    const storeCreditCheckout = await checkoutQboProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
      customerId: customer.id,
      paymentMethod: "store_credit",
    });
    await assignQboDate(request, storeCreditCheckout.transaction_id, activityDate);

    const openDepositCheckout = await checkoutQboProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
      customerId: customer.id,
      fulfillment: "special_order",
      paymentMethod: "open_deposit",
    });
    await assignQboDate(request, openDepositCheckout.transaction_id, activityDate);
    await markPickup(request, openDepositCheckout.transaction_id);
    await assignQboFulfillmentTimestamp(
      request,
      openDepositCheckout.transaction_id,
      `${activityDate}T15:00:00Z`,
    );

    const storeCreditArtifacts = await getTransactionArtifacts(
      request,
      storeCreditCheckout.transaction_id,
    );
    expect(storeCreditArtifacts.allocation_rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_transaction_id: storeCreditCheckout.transaction_id,
          payment_method: "store_credit",
          amount_allocated: transactionTotal,
          payment_amount: transactionTotal,
        }),
      ]),
    );
    const openDepositArtifacts = await getTransactionArtifacts(
      request,
      openDepositCheckout.transaction_id,
    );
    expect(openDepositArtifacts.allocation_rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_transaction_id: openDepositCheckout.transaction_id,
          payment_method: "open_deposit",
          amount_allocated: transactionTotal,
          payment_amount: transactionTotal,
        }),
      ]),
    );

    const ledgers = await fetchCustomerLiabilityLedgers(request, customer.id);
    const storeCreditLedger = ledgers.store_credit.find(
      (row) =>
        row.reason === "checkout_redemption" &&
        row.transaction_id === storeCreditCheckout.transaction_id,
    );
    expect(moneyToCents(storeCreditLedger?.amount)).toBe(-parseMoneyToCents(transactionTotal));
    expect(moneyToCents(storeCreditLedger?.balance_after)).toBe(0);
    const openDepositLedger = ledgers.open_deposit.find(
      (row) =>
        row.reason === "checkout_redemption" &&
        row.transaction_id === openDepositCheckout.transaction_id,
    );
    expect(moneyToCents(openDepositLedger?.amount)).toBe(-parseMoneyToCents(transactionTotal));
    expect(moneyToCents(openDepositLedger?.balance_after)).toBe(0);

    const proposal = await proposeJournal(request, activityDate);
    expect(proposal.payload.totals?.balanced).toBe(true);
    const storeCreditLineIndex = proposal.payload.lines.findIndex(
      (line) =>
        line.memo === "Store credit redemption (liability)" &&
        line.qbo_account_id === "E2E_STORE_CREDIT_LIABILITY",
    );
    expect(storeCreditLineIndex).toBeGreaterThanOrEqual(0);
    expect(moneyToCents(proposal.payload.lines[storeCreditLineIndex]?.debit)).toBe(
      parseMoneyToCents(transactionTotal),
    );
    const openDepositLineIndex = proposal.payload.lines.findIndex(
      (line) =>
        line.memo === "Open deposit redemption (liability)" &&
        line.qbo_account_id === "E2E_DEPOSIT_LIABILITY",
    );
    expect(openDepositLineIndex).toBeGreaterThanOrEqual(0);
    expect(moneyToCents(proposal.payload.lines[openDepositLineIndex]?.debit)).toBe(
      parseMoneyToCents(transactionTotal),
    );
    expect(
      proposal.payload.lines.some(
        (line) =>
          line.memo === "Tenders — store_credit" || line.memo === "Tenders — open_deposit",
      ),
    ).toBe(false);

    const storeCreditDrilldown = await fetchQboDrilldown(
      request,
      proposal.id,
      storeCreditLineIndex,
    );
    const storeCreditContributor = storeCreditDrilldown.contributors?.find(
      (row) => row.transaction_id === storeCreditCheckout.transaction_id,
    );
    expect(moneyToCents(storeCreditContributor?.amount)).toBe(parseMoneyToCents(transactionTotal));
    const openDepositDrilldown = await fetchQboDrilldown(
      request,
      proposal.id,
      openDepositLineIndex,
    );
    const openDepositContributor = openDepositDrilldown.contributors?.find(
      (row) => row.transaction_id === openDepositCheckout.transaction_id,
    );
    expect(moneyToCents(openDepositContributor?.amount)).toBe(parseMoneyToCents(transactionTotal));
  });

  test("gift card subtypes post to their intended QBO accounts", async ({ request }) => {
    test.setTimeout(120_000);
    const dateOffset = 300 + Math.floor(Math.random() * 4000);
    const activityDate = futureUtcDate(dateOffset);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createQboProduct(request, operatorStaffId);
    const unitTax = calculateNysErieTaxStringsForUnit("clothing", parseMoneyToCents("110.00"));
    const transactionTotal = totalFor("110.00", unitTax.stateTax, unitTax.localTax);
    const purchasedLoadAmount = "500.00";
    const suffix = uniqueSuffix("gc-qbo");
    const cards: Array<{
      code: string;
      subType: GiftCardSubtype;
      expectedAccount: string;
      expectedMemo: string;
      transactionId?: string;
    }> = [
      {
        code: `GC-PAID-${suffix}`,
        subType: "paid_liability",
        expectedAccount: "E2E_GIFT_CARD_LIABILITY",
        expectedMemo: "Gift card redemption (liability)",
      },
      {
        code: `GC-LOYALTY-${suffix}`,
        subType: "loyalty_giveaway",
        expectedAccount: "E2E_LOYALTY_EXPENSE",
        expectedMemo: "Gift card redemption (loyalty/promo expense)",
      },
      {
        code: `GC-DONATED-${suffix}`,
        subType: "donated_giveaway",
        expectedAccount: "E2E_LOYALTY_EXPENSE",
        expectedMemo: "Gift card redemption (loyalty/promo expense)",
      },
      {
        code: `GC-PROMO-${suffix}`,
        subType: "promo_gift_card",
        expectedAccount: "E2E_LOYALTY_EXPENSE",
        expectedMemo: "Gift card redemption (loyalty/promo expense)",
      },
    ];

    await seedQboMappings(request, product.categoryId, activityDate);
    const purchasedLoad = await checkoutPurchasedGiftCardLoad(request, {
      sessionId,
      sessionToken,
      operatorStaffId,
      code: cards[0]!.code,
      amount: purchasedLoadAmount,
    });
    await assignQboDate(request, purchasedLoad.transaction_id, activityDate);
    for (const card of cards.slice(1)) {
      await issueGiftCardForQbo(request, {
        code: card.code,
        amount: transactionTotal,
        kind: card.subType as Exclude<GiftCardSubtype, "paid_liability">,
      });
    }

    for (const card of cards) {
      const checkout = await checkoutQboProduct(request, {
        product,
        sessionId,
        sessionToken,
        operatorStaffId,
        paymentMethod: "gift_card",
        giftCardCode: card.code,
        giftCardSubType: card.subType,
      });
      card.transactionId = checkout.transaction_id;
      await assignQboDate(request, checkout.transaction_id, activityDate);

      const artifacts = await getTransactionArtifacts(request, checkout.transaction_id);
      expect(artifacts.allocation_rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target_transaction_id: checkout.transaction_id,
            payment_method: "gift_card",
            amount_allocated: transactionTotal,
            payment_amount: transactionTotal,
          }),
        ]),
      );
      expect(artifacts.payment_rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            payment_method: "gift_card",
            metadata: expect.objectContaining({
              sub_type: card.subType,
              gift_card_code: card.code.toUpperCase(),
            }),
          }),
        ]),
      );
    }

    const proposal = await proposeJournal(request, activityDate);
    expect(proposal.payload.totals?.balanced).toBe(true);
    const loadLine = proposal.payload.lines.find(
      (line) =>
        line.memo === "Purchased gift card liability issued" &&
        line.qbo_account_id === "E2E_GIFT_CARD_LIABILITY",
    );
    expect(moneyToCents(loadLine?.credit)).toBe(parseMoneyToCents(purchasedLoadAmount));

    for (const card of cards) {
      const lineIndex = proposal.payload.lines.findIndex(
        (line) =>
          line.memo === card.expectedMemo &&
          line.qbo_account_id === card.expectedAccount &&
          line.detail?.some(
            (detail) =>
              detail.payment_method === "gift_card" && detail.sub_type === card.subType,
          ),
      );
      expect(lineIndex).toBeGreaterThanOrEqual(0);
      expect(moneyToCents(proposal.payload.lines[lineIndex]?.debit)).toBe(
        parseMoneyToCents(transactionTotal),
      );

      const drilldown = await fetchQboDrilldown(request, proposal.id, lineIndex);
      const contributor = drilldown.contributors?.find(
        (row) => row.transaction_id === card.transactionId,
      );
      expect(moneyToCents(contributor?.amount)).toBe(parseMoneyToCents(transactionTotal));
    }

    expect(proposal.payload.lines.some((line) => line.memo === "Tenders — gift_card")).toBe(false);
  });

  test("layaways stay transaction-scoped and post deposit, pickup, and forfeiture journals", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const uniqueDateOffset = Math.floor(Math.random() * 5000);
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
    const activityDate = futureUtcDate(720 + Math.floor(Math.random() * 2000));
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
    expect(proposed.payload.qbo_stage).toMatchObject({
      entry_type: "daily_general_journal",
      business_date: activityDate,
    });
    expect(proposed.payload.qbo_stage?.revision_of ?? []).toHaveLength(0);
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

    const secondCheckout = await checkoutQboProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
    });
    const assignSecondDateRes = await request.post(
      `${apiBase()}/api/test-support/qbo/assign-transaction-date`,
      {
        headers: {
          ...staffHeaders(),
          "Content-Type": "application/json",
        },
        data: {
          transaction_id: secondCheckout.transaction_id,
          activity_date: activityDate,
        },
        failOnStatusCode: false,
      },
    );
    const assignSecondDateText = await assignSecondDateRes.text();
    expect(assignSecondDateRes.status(), assignSecondDateText.slice(0, 1000)).toBe(200);

    const refreshed = await proposeJournal(request, activityDate);
    expect(refreshed.id).toBe(proposed.id);
    expect(refreshed.status).toBe("pending");
    const refreshedTenderLine = refreshed.payload.lines.find(
      (line) => line.memo.startsWith("Tenders") && line.qbo_account_id === "E2E_CASH",
    );
    expect(moneyToCents(refreshedTenderLine?.debit)).toBe(parseMoneyToCents("239.26"));

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

    const tenderLineIndex = refreshed.payload.lines.findIndex(
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

    const revision = await proposeJournal(request, activityDate);
    expect(revision.id).not.toBe(proposed.id);
    expect(revision.status).toBe("pending");
    expect(revision.payload.qbo_stage).toMatchObject({
      entry_type: "daily_general_journal_revision",
      business_date: activityDate,
    });
    expect(revision.payload.qbo_stage?.revision_of ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          staging_id: proposed.id,
          status: "approved",
        }),
      ]),
    );
  });

  test("financial date correction and existing order edits stay on the intended QBO day", async ({
    request,
  }) => {
    test.setTimeout(90_000);
    const dateOffset = 9_000 + Math.floor(Math.random() * 100_000);
    const originalDate = futureUtcDate(dateOffset);
    const businessDate = futureUtcDate(dateOffset + 1);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createQboProduct(request, operatorStaffId);
    await seedQboMappings(request, product.categoryId, businessDate);
    const checkout = await checkoutQboProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
      fulfillment: "special_order",
    });
    await assignQboDate(request, checkout.transaction_id, originalDate);

    const correctionRes = await request.patch(
      `${apiBase()}/api/transactions/${checkout.transaction_id}/financial-date`,
      {
        headers: {
          ...staffHeaders(),
          "Content-Type": "application/json",
        },
        data: {
          business_date: businessDate,
          payment_effective_date: businessDate,
          reason: "Customer order was booked for the corrected business day.",
        },
        failOnStatusCode: false,
      },
    );
    const correctionText = await correctionRes.text();
    expect(correctionRes.status(), correctionText.slice(0, 1000)).toBe(200);
    expect(JSON.parse(correctionText)).toMatchObject({
      business_date: businessDate,
      payment_effective_date: businessDate,
    });

    const beforeEdit = await fetchTransactionDetail(request, checkout.transaction_id);
    const originalLineIds = new Set(beforeEdit.items.map((item) => item.transaction_line_id));
    const tax = calculateNysErieTaxStringsForUnit("clothing", parseMoneyToCents("110.00"));
    const addLineRes = await request.post(
      `${apiBase()}/api/transactions/${checkout.transaction_id}/items`,
      {
        headers: {
          ...staffHeaders(),
          "Content-Type": "application/json",
        },
        data: {
          product_id: product.productId,
          variant_id: product.variantId,
          fulfillment: "special_order",
          quantity: 1,
          unit_price: "110.00",
          unit_cost: product.unitCost,
          state_tax: tax.stateTax,
          local_tax: tax.localTax,
        },
        failOnStatusCode: false,
      },
    );
    const addLineText = await addLineRes.text();
    expect(addLineRes.status(), addLineText.slice(0, 1000)).toBe(200);
    let editedDetail = JSON.parse(addLineText) as TransactionDetail;
    expect(moneyToCents(editedDetail.total_price)).toBe(parseMoneyToCents("239.26"));
    expect(moneyToCents(editedDetail.balance_due)).toBe(parseMoneyToCents("119.63"));

    const addedLine = editedDetail.items.find(
      (item) => !originalLineIds.has(item.transaction_line_id),
    );
    expect(addedLine?.transaction_line_id).toBeTruthy();
    const updateLineRes = await request.patch(
      `${apiBase()}/api/transactions/${checkout.transaction_id}/items/${addedLine!.transaction_line_id}`,
      {
        headers: {
          ...staffHeaders(),
          "Content-Type": "application/json",
        },
        data: {
          quantity: 2,
        },
        failOnStatusCode: false,
      },
    );
    const updateLineText = await updateLineRes.text();
    expect(updateLineRes.status(), updateLineText.slice(0, 1000)).toBe(200);
    editedDetail = JSON.parse(updateLineText) as TransactionDetail;
    expect(moneyToCents(editedDetail.total_price)).toBe(parseMoneyToCents("358.89"));
    expect(moneyToCents(editedDetail.balance_due)).toBe(parseMoneyToCents("239.26"));

    const proposal = await proposeJournal(request, businessDate);
    expect(proposal.sync_date).toBe(businessDate);
    const tenderLineIndex = proposal.payload.lines.findIndex(
      (line) => line.memo.startsWith("Tenders") && line.qbo_account_id === "E2E_CASH",
    );
    expect(tenderLineIndex).toBeGreaterThanOrEqual(0);
    const tenderLine = proposal.payload.lines[tenderLineIndex];
    expect(moneyToCents(tenderLine?.debit)).toBe(parseMoneyToCents("119.63"));
    const drilldown = await fetchQboDrilldown(request, proposal.id, tenderLineIndex);
    const contributor = drilldown.contributors?.find(
      (row) => row.transaction_id === checkout.transaction_id,
    );
    expect(contributor).toBeTruthy();
    expect(moneyToCents(contributor?.amount)).toBe(parseMoneyToCents("119.63"));
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
    const activityDate = futureUtcDate(900 + Math.floor(Math.random() * 2000));
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
