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
  }>;
};

type TransactionAuditEvent = {
  event_kind: string;
  metadata?: {
    delivered_item_count?: number;
    readiness_override?: boolean;
    override_reason?: string | null;
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
      primary_salesperson_id: options.operatorStaffId,
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
        salesperson_id: options.operatorStaffId,
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
        manager_staff_code: staffCode(),
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

test.describe("pickup launch certification contract", () => {
  test("certifies unpaid, partial-ready, blocked, and override pickup paths", async ({
    request,
  }) => {
    test.setTimeout(120_000);

    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);

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
      amountPaid: "0.00",
    });
    const unpaidAttempt = await pickup(request, unpaidCheckout.transaction_id, sessionId, sessionToken, {
      delivered_item_ids: [],
      override_readiness: true,
      override_reason: "Certification confirms balance due remains a hard stop.",
    });
    expect(unpaidAttempt.status, unpaidAttempt.bodyText.slice(0, 1000)).toBe(400);
    expect(unpaidAttempt.bodyText).toContain("Balance Due");

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
    });

    let detail = await fetchTransactionDetail(request, mixedCheckout.transaction_id);
    const readyLine = detail.items.find((item) => item.sku === readyProduct.sku);
    const blockedLine = detail.items.find((item) => item.sku === blockedProduct.sku);
    expect(readyLine, "ready fixture line missing").toBeTruthy();
    expect(blockedLine, "blocked fixture line missing").toBeTruthy();

    await markLineReady(request, readyLine!.transaction_line_id);

    const mixedBulkAttempt = await pickup(request, mixedCheckout.transaction_id, sessionId, sessionToken, {
      delivered_item_ids: [],
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
});
