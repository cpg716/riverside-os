import { expect, test, type APIRequestContext } from "@playwright/test";
import { centsToFixed2, parseMoneyToCents } from "../src/lib/money";
import { calculateNysErieTaxStringsForUnit } from "../src/lib/tax";
import {
  apiBase,
  ensureSessionAuth,
  staffCode,
  staffHeaders,
  verifyStaffId,
} from "./helpers/rmsCharge";
import {
  createSingleVariantProduct,
  uniqueSuffix,
  type CreatedProduct,
} from "./helpers/inventoryReceiving";

type CheckoutResponse = {
  transaction_id: string;
};

type TransactionDetail = {
  status: string;
  balance_due: string;
  items: Array<{
    transaction_line_id: string;
    sku: string;
    product_name: string;
    order_lifecycle_status: string;
    is_fulfilled: boolean;
    shipped_at?: string | null;
  }>;
};

type TransactionAuditEvent = {
  event_kind: string;
  metadata?: {
    delivered_item_count?: number;
    shipped_item_count?: number;
    readiness_override?: boolean;
    override_reason?: string | null;
    payment_override?: boolean;
    payment_override_detail?: {
      payment_override_reason?: string;
      shortage?: string | number;
    } | null;
  };
};

const UNIT_PRICE = "49.99";
const UNIT_COST = "20.00";

function lineTax() {
  return calculateNysErieTaxStringsForUnit("clothing", parseMoneyToCents(UNIT_PRICE));
}

function transactionTotal(lineCount: number): string {
  const tax = lineTax();
  const lineTotal =
    parseMoneyToCents(UNIT_PRICE) +
    parseMoneyToCents(tax.stateTax) +
    parseMoneyToCents(tax.localTax);
  return centsToFixed2(lineTotal * lineCount);
}

async function checkoutSpecialOrder(
  request: APIRequestContext,
  options: {
    products: CreatedProduct[];
    sessionId: string;
    sessionToken: string;
    operatorStaffId: string;
    salespersonId: string;
    amountPaid?: string;
  },
): Promise<CheckoutResponse> {
  const tax = lineTax();
  const total = transactionTotal(options.products.length);
  const amountPaid = options.amountPaid ?? total;
  const res = await request.post(`${apiBase()}/api/transactions/checkout`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
      "x-riverside-pos-session-id": options.sessionId,
      "x-riverside-pos-session-token": options.sessionToken,
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      session_id: options.sessionId,
      operator_staff_id: options.operatorStaffId,
      primary_salesperson_id: options.salespersonId,
      customer_id: null,
      payment_method: "cash",
      total_price: total,
      amount_paid: amountPaid,
      checkout_client_id: crypto.randomUUID(),
      items: options.products.map((product) => ({
        product_id: product.productId,
        variant_id: product.variantId,
        fulfillment: "special_order",
        quantity: 1,
        unit_price: UNIT_PRICE,
        unit_cost: UNIT_COST,
        state_tax: tax.stateTax,
        local_tax: tax.localTax,
        salesperson_id: options.salespersonId,
      })),
      payment_splits:
        parseMoneyToCents(amountPaid) > 0
          ? [
              {
                payment_method: "cash",
                amount: amountPaid,
              },
            ]
          : [],
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as CheckoutResponse;
}

async function createSalespersonStaff(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${apiBase()}/api/staff/admin`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      full_name: `E2E Pickup Salesperson ${uniqueSuffix("staff")}`,
      role: "salesperson",
      is_active: true,
      base_commission_rate: "0.0500",
      max_discount_percent: "30",
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  const body = JSON.parse(bodyText) as { id: string };
  return body.id;
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

async function fetchTransactionAudit(
  request: APIRequestContext,
  transactionId: string,
): Promise<TransactionAuditEvent[]> {
  const res = await request.get(`${apiBase()}/api/transactions/${transactionId}/audit`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as TransactionAuditEvent[];
}

async function markLineReady(
  request: APIRequestContext,
  transactionLineId: string,
): Promise<void> {
  const managerStaffId = await verifyStaffId(request);
  const res = await request.post(
    `${apiBase()}/api/order-lifecycle/items/${transactionLineId}/transition`,
    {
      headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
        "x-riverside-station-key": "station-e2e",
      },
      data: {
        next_status: "ready_for_pickup",
        override_checks: true,
        manager_staff_id: managerStaffId,
        manager_pin: staffCode(),
        reason: "Pickup certification readiness simulation",
        metadata: {
          source: "pickup-certification-contract",
        },
      },
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
}

async function pickup(
  request: APIRequestContext,
  transactionId: string,
  sessionId: string,
  sessionToken: string,
  data: Record<string, unknown>,
): Promise<{ status: number; bodyText: string }> {
  const res = await request.post(`${apiBase()}/api/transactions/${transactionId}/pickup`, {
    headers: {
      ...staffHeaders(),
      "x-riverside-pos-session-id": sessionId,
      "x-riverside-pos-session-token": sessionToken,
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      actor: "Pickup Certification",
      register_session_id: sessionId,
      ...data,
    },
    failOnStatusCode: false,
  });
  return {
    status: res.status(),
    bodyText: await res.text(),
  };
}

async function ship(
  request: APIRequestContext,
  transactionId: string,
  sessionId: string,
  sessionToken: string,
  data: Record<string, unknown>,
): Promise<{ status: number; bodyText: string }> {
  const res = await request.post(`${apiBase()}/api/transactions/${transactionId}/ship`, {
    headers: {
      ...staffHeaders(),
      "x-riverside-pos-session-id": sessionId,
      "x-riverside-pos-session-token": sessionToken,
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      actor: "Shipping Certification",
      register_session_id: sessionId,
      ...data,
    },
    failOnStatusCode: false,
  });
  return {
    status: res.status(),
    bodyText: await res.text(),
  };
}

test.describe("pickup launch certification contract", () => {
  test("certifies unpaid, partial-ready, blocked, and override pickup paths", async ({
    request,
  }) => {
    test.setTimeout(120_000);

    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const salespersonId = await createSalespersonStaff(request);

    const unpaidProduct = await createSingleVariantProduct(request, uniqueSuffix("pickup-unpaid"), {
      stockOnHand: 1,
      namePrefix: "Pickup Unpaid Guard",
      skuPrefix: "PKU",
    });
    const unpaidCheckout = await checkoutSpecialOrder(request, {
      products: [unpaidProduct],
      sessionId,
      sessionToken,
      operatorStaffId,
      salespersonId,
      amountPaid: "0.00",
    });
    const unpaidDetail = await fetchTransactionDetail(
      request,
      unpaidCheckout.transaction_id,
    );
    const unpaidLine = unpaidDetail.items.find(
      (item) => item.sku === unpaidProduct.sku,
    );
    expect(unpaidLine, "unpaid pickup fixture line missing").toBeTruthy();
    const unpaidAttempt = await pickup(request, unpaidCheckout.transaction_id, sessionId, sessionToken, {
      delivered_item_ids: [unpaidLine!.transaction_line_id],
      override_readiness: true,
      override_reason: "Certification confirms balance due remains a hard stop.",
      readiness_override_manager_staff_id: operatorStaffId,
      readiness_override_manager_pin: staffCode(),
    });
    expect(unpaidAttempt.status, unpaidAttempt.bodyText.slice(0, 1000)).toBe(400);
    expect(unpaidAttempt.bodyText).toContain("Balance Due");

    const depositReadyProduct = await createSingleVariantProduct(request, uniqueSuffix("pickup-deposit-ready"), {
      stockOnHand: 1,
      namePrefix: "Pickup Deposit Ready",
      skuPrefix: "PKD",
    });
    const depositRemainingProduct = await createSingleVariantProduct(request, uniqueSuffix("pickup-deposit-open"), {
      stockOnHand: 1,
      namePrefix: "Pickup Deposit Open",
      skuPrefix: "PKO",
    });
    const depositCheckout = await checkoutSpecialOrder(request, {
      products: [depositReadyProduct, depositRemainingProduct],
      sessionId,
      sessionToken,
      operatorStaffId,
      salespersonId,
      amountPaid: "60.00",
    });
    let depositDetail = await fetchTransactionDetail(request, depositCheckout.transaction_id);
    const depositReadyLine = depositDetail.items.find((item) => item.sku === depositReadyProduct.sku);
    expect(depositReadyLine, "deposit override fixture line missing").toBeTruthy();
    await markLineReady(request, depositReadyLine!.transaction_line_id);

    const depositApproved = await pickup(request, depositCheckout.transaction_id, sessionId, sessionToken, {
      delivered_item_ids: [depositReadyLine!.transaction_line_id],
    });
    expect(depositApproved.status, depositApproved.bodyText.slice(0, 1000)).toBe(200);

    depositDetail = await fetchTransactionDetail(request, depositCheckout.transaction_id);
    expect(depositDetail.status.toLowerCase()).toBe("open");
    expect(depositDetail.items.find((item) => item.sku === depositReadyProduct.sku)?.is_fulfilled).toBe(true);
    expect(depositDetail.items.find((item) => item.sku === depositRemainingProduct.sku)?.is_fulfilled).toBe(false);

    const depositAudit = await fetchTransactionAudit(request, depositCheckout.transaction_id);
    const depositPickupAudit = depositAudit.find(
      (event) => event.event_kind === "pickup",
    );
    expect(depositPickupAudit, "pickup audit event missing").toBeTruthy();
    expect(depositPickupAudit?.metadata?.payment_override).toBe(false);

    const readyProduct = await createSingleVariantProduct(request, uniqueSuffix("pickup-ready"), {
      stockOnHand: 1,
      namePrefix: "Pickup Ready Guard",
      skuPrefix: "PKR",
    });
    const blockedProduct = await createSingleVariantProduct(request, uniqueSuffix("pickup-blocked"), {
      stockOnHand: 1,
      namePrefix: "Pickup Blocked Guard",
      skuPrefix: "PKB",
    });
    const mixedCheckout = await checkoutSpecialOrder(request, {
      products: [readyProduct, blockedProduct],
      sessionId,
      sessionToken,
      operatorStaffId,
      salespersonId,
    });

    let detail = await fetchTransactionDetail(request, mixedCheckout.transaction_id);
    const readyLine = detail.items.find((item) => item.sku === readyProduct.sku);
    const blockedLine = detail.items.find((item) => item.sku === blockedProduct.sku);
    expect(readyLine, "ready fixture line missing").toBeTruthy();
    expect(blockedLine, "blocked fixture line missing").toBeTruthy();

    await markLineReady(request, readyLine!.transaction_line_id);

    const mixedBulkAttempt = await pickup(request, mixedCheckout.transaction_id, sessionId, sessionToken, {
      delivered_item_ids: [
        readyLine!.transaction_line_id,
        blockedLine!.transaction_line_id,
      ],
    });
    expect(mixedBulkAttempt.status, mixedBulkAttempt.bodyText.slice(0, 1000)).toBe(400);
    expect(mixedBulkAttempt.bodyText).toContain("not Ready for Pickup");

    const partialRelease = await pickup(request, mixedCheckout.transaction_id, sessionId, sessionToken, {
      delivered_item_ids: [readyLine!.transaction_line_id],
    });
    expect(partialRelease.status, partialRelease.bodyText.slice(0, 1000)).toBe(200);

    detail = await fetchTransactionDetail(request, mixedCheckout.transaction_id);
    expect(detail.status.toLowerCase()).toBe("open");
    expect(detail.items.find((item) => item.sku === readyProduct.sku)?.is_fulfilled).toBe(true);
    expect(detail.items.find((item) => item.sku === blockedProduct.sku)?.is_fulfilled).toBe(false);

    const blockedRelease = await pickup(request, mixedCheckout.transaction_id, sessionId, sessionToken, {
      delivered_item_ids: [blockedLine!.transaction_line_id],
    });
    expect(blockedRelease.status, blockedRelease.bodyText.slice(0, 1000)).toBe(400);
    expect(blockedRelease.bodyText).toContain("not Ready for Pickup");

    const overrideReason =
      "Customer present with manager-approved garment release during certification.";
    const overrideRelease = await pickup(request, mixedCheckout.transaction_id, sessionId, sessionToken, {
      delivered_item_ids: [blockedLine!.transaction_line_id],
      override_readiness: true,
      override_reason: overrideReason,
      readiness_override_manager_staff_id: operatorStaffId,
      readiness_override_manager_pin: staffCode(),
    });
    expect(overrideRelease.status, overrideRelease.bodyText.slice(0, 1000)).toBe(200);

    detail = await fetchTransactionDetail(request, mixedCheckout.transaction_id);
    expect(detail.status.toLowerCase()).toBe("fulfilled");
    expect(detail.items.every((item) => item.is_fulfilled)).toBe(true);

    const audit = await fetchTransactionAudit(request, mixedCheckout.transaction_id);
    const overrideAudit = audit.find(
      (event) => event.event_kind === "pickup" && event.metadata?.readiness_override === true,
    );
    expect(overrideAudit, "pickup override audit event missing").toBeTruthy();
    expect(overrideAudit?.metadata?.override_reason).toBe(overrideReason);
    expect(overrideAudit?.metadata?.delivered_item_count).toBe(1);
  });

  test("certifies selected-line shipping release and audit path", async ({ request }) => {
    test.setTimeout(120_000);

    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const salespersonId = await createSalespersonStaff(request);

    const readyProduct = await createSingleVariantProduct(request, uniqueSuffix("ship-ready"), {
      stockOnHand: 1,
      namePrefix: "Ship Ready Guard",
      skuPrefix: "SHR",
    });
    const blockedProduct = await createSingleVariantProduct(request, uniqueSuffix("ship-blocked"), {
      stockOnHand: 1,
      namePrefix: "Ship Blocked Guard",
      skuPrefix: "SHB",
    });
    const checkout = await checkoutSpecialOrder(request, {
      products: [readyProduct, blockedProduct],
      sessionId,
      sessionToken,
      operatorStaffId,
      salespersonId,
    });

    let detail = await fetchTransactionDetail(request, checkout.transaction_id);
    const readyLine = detail.items.find((item) => item.sku === readyProduct.sku);
    const blockedLine = detail.items.find((item) => item.sku === blockedProduct.sku);
    expect(readyLine, "ready shipping fixture line missing").toBeTruthy();
    expect(blockedLine, "blocked shipping fixture line missing").toBeTruthy();

    await markLineReady(request, readyLine!.transaction_line_id);

    const bulkBlocked = await ship(request, checkout.transaction_id, sessionId, sessionToken, {
      shipped_item_ids: [
        readyLine!.transaction_line_id,
        blockedLine!.transaction_line_id,
      ],
    });
    expect(bulkBlocked.status, bulkBlocked.bodyText.slice(0, 1000)).toBe(400);
    expect(bulkBlocked.bodyText).toContain("not Ready for Pickup/Shipping");

    const partialRelease = await ship(request, checkout.transaction_id, sessionId, sessionToken, {
      shipped_item_ids: [readyLine!.transaction_line_id],
    });
    expect(partialRelease.status, partialRelease.bodyText.slice(0, 1000)).toBe(200);

    detail = await fetchTransactionDetail(request, checkout.transaction_id);
    const shippedReadyLine = detail.items.find((item) => item.sku === readyProduct.sku);
    const unshippedBlockedLine = detail.items.find((item) => item.sku === blockedProduct.sku);
    expect(detail.status.toLowerCase()).toBe("open");
    expect(shippedReadyLine?.is_fulfilled).toBe(true);
    expect(shippedReadyLine?.shipped_at).toBeTruthy();
    expect(unshippedBlockedLine?.is_fulfilled).toBe(false);
    expect(unshippedBlockedLine?.shipped_at ?? null).toBeNull();

    const overrideReason =
      "Customer requested shipment and staff confirmed release during certification.";
    const overrideRelease = await ship(request, checkout.transaction_id, sessionId, sessionToken, {
      shipped_item_ids: [blockedLine!.transaction_line_id],
      override_readiness: true,
      override_reason: overrideReason,
      readiness_override_manager_staff_id: operatorStaffId,
      readiness_override_manager_pin: staffCode(),
    });
    expect(overrideRelease.status, overrideRelease.bodyText.slice(0, 1000)).toBe(200);

    detail = await fetchTransactionDetail(request, checkout.transaction_id);
    expect(detail.status.toLowerCase()).toBe("fulfilled");
    expect(detail.items.every((item) => item.is_fulfilled)).toBe(true);
    expect(detail.items.every((item) => Boolean(item.shipped_at))).toBe(true);

    const audit = await fetchTransactionAudit(request, checkout.transaction_id);
    const overrideAudit = audit.find(
      (event) => event.event_kind === "shipping" && event.metadata?.readiness_override === true,
    );
    expect(overrideAudit, "shipping override audit event missing").toBeTruthy();
    expect(overrideAudit?.metadata?.override_reason).toBe(overrideReason);
    expect(overrideAudit?.metadata?.shipped_item_count).toBe(1);
  });
});
