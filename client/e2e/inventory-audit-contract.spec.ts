import { expect, test, type APIRequestContext } from "@playwright/test";
import { centsToFixed2, parseMoneyToCents } from "../src/lib/money";
import { calculateNysErieTaxStringsForUnit } from "../src/lib/tax";
import {
  addPurchaseOrderLine,
  adminHeaders,
  apiBase,
  createDraftPurchaseOrder,
  createSingleVariantProduct,
  createVendor,
  getInventoryIntelligence,
  getPurchaseOrderDetail,
  receivePurchaseOrder,
  submitPurchaseOrder,
  uniqueSuffix,
} from "./helpers/inventoryReceiving";
import { ensureSessionAuth, staffHeaders, verifyStaffId } from "./helpers/rmsCharge";

type InventoryProduct = {
  productId: string;
  variantId: string;
  sku: string;
  unitPrice: string;
  unitCost: string;
};

type CheckoutResponse = {
  transaction_id: string;
};

type TransactionDetailResponse = {
  total_price: string;
  items: Array<{
    transaction_line_id: string;
    sku: string;
    quantity: number;
    quantity_returned: number;
    is_fulfilled: boolean;
  }>;
};

type RefundQueueRow = {
  transaction_id: string;
  amount_due: string;
  amount_refunded: string;
  is_open: boolean;
};

async function createNonClothingCategory(
  request: APIRequestContext,
  actorStaffId: string,
  label: string,
): Promise<string> {
  const res = await request.post(`${apiBase()}/api/categories`, {
    headers: {
      ...adminHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      name: `E2E Inventory ${label}`,
      parent_id: null,
      is_clothing_footwear: false,
      changed_by_staff_id: actorStaffId,
      change_note: "Created for inventory audit E2E coverage",
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return (JSON.parse(bodyText) as { id: string }).id;
}

async function createInventoryProduct(
  request: APIRequestContext,
  actorStaffId: string,
  label: string,
  stockOnHand: number,
): Promise<InventoryProduct> {
  const categoryId = await createNonClothingCategory(request, actorStaffId, uniqueSuffix(label));
  const product = await createSingleVariantProduct(request, uniqueSuffix(label), {
    categoryId,
    stockOnHand,
    namePrefix: "Inventory Audit",
    skuPrefix: "INV-AUD",
  });
  return {
    productId: product.productId,
    variantId: product.variantId,
    sku: product.sku,
    unitPrice: "49.99",
    unitCost: "20.00",
  };
}

function taxesFor(product: InventoryProduct) {
  return calculateNysErieTaxStringsForUnit("other", parseMoneyToCents(product.unitPrice));
}

function totalFor(product: InventoryProduct, quantity = 1): string {
  const tax = taxesFor(product);
  return centsToFixed2(
    (parseMoneyToCents(product.unitPrice) +
      parseMoneyToCents(tax.stateTax) +
      parseMoneyToCents(tax.localTax)) *
      quantity,
  );
}

async function checkoutInventoryProduct(
  request: APIRequestContext,
  options: {
    product: InventoryProduct;
    sessionId: string;
    sessionToken: string;
    operatorStaffId: string;
    fulfillment: "takeaway" | "special_order" | "custom" | "wedding_order" | "layaway";
    quantity?: number;
  },
): Promise<CheckoutResponse> {
  const quantity = options.quantity ?? 1;
  const tax = taxesFor(options.product);
  const total = totalFor(options.product, quantity);
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
      total_price: total,
      amount_paid: total,
      checkout_client_id: crypto.randomUUID(),
      items: [
        {
          product_id: options.product.productId,
          variant_id: options.product.variantId,
          fulfillment: options.fulfillment,
          quantity,
          unit_price: options.product.unitPrice,
          unit_cost: options.product.unitCost,
          state_tax: tax.stateTax,
          local_tax: tax.localTax,
          salesperson_id: options.operatorStaffId,
        },
      ],
      payment_splits: [
        {
          payment_method: "cash",
          amount: total,
        },
      ],
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
): Promise<TransactionDetailResponse> {
  const res = await request.get(`${apiBase()}/api/transactions/${transactionId}`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as TransactionDetailResponse;
}

test.describe("inventory audit contract", () => {
  test("fulfillment-order checkout does not decrement stock until pickup", async ({ request }) => {
    test.setTimeout(90_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createInventoryProduct(request, operatorStaffId, "fulfillment", 5);

    const before = await getInventoryIntelligence(request, product.variantId);
    expect(before.stock_on_hand).toBe(5);
    expect(before.available_stock).toBe(5);

    const checkout = await checkoutInventoryProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
      fulfillment: "special_order",
    });

    const afterCheckout = await getInventoryIntelligence(request, product.variantId);
    expect(afterCheckout.stock_on_hand).toBe(before.stock_on_hand);
    expect(afterCheckout.available_stock).toBe(before.available_stock);

    const detailBeforePickup = await fetchTransactionDetail(request, checkout.transaction_id);
    const lineBeforePickup = detailBeforePickup.items.find((item) => item.sku === product.sku);
    expect(lineBeforePickup?.is_fulfilled).toBe(false);

    const pickupRes = await request.post(`${apiBase()}/api/transactions/${checkout.transaction_id}/pickup`, {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
      },
      data: {
        actor: "E2E Inventory Audit",
      },
      failOnStatusCode: false,
    });
    const pickupText = await pickupRes.text();
    expect(pickupRes.status(), pickupText.slice(0, 1000)).toBe(200);

    const afterPickup = await getInventoryIntelligence(request, product.variantId);
    expect(afterPickup.stock_on_hand).toBe(before.stock_on_hand - 1);
    expect(afterPickup.available_stock).toBe(before.available_stock - 1);

    const detailAfterPickup = await fetchTransactionDetail(request, checkout.transaction_id);
    const lineAfterPickup = detailAfterPickup.items.find((item) => item.sku === product.sku);
    expect(lineAfterPickup?.is_fulfilled).toBe(true);
  });

  test("PO receipt duplicate retry does not double-increment stock", async ({ request }) => {
    test.setTimeout(90_000);
    const suffix = uniqueSuffix("po-audit");
    const vendor = await createVendor(request, suffix);
    const product = await createSingleVariantProduct(request, suffix, {
      stockOnHand: 3,
      vendorId: vendor.id,
    });
    const po = await createDraftPurchaseOrder(request, vendor.id);
    await addPurchaseOrderLine(request, po.id, product.variantId, 2);
    await submitPurchaseOrder(request, po.id);

    const detail = await getPurchaseOrderDetail(request, po.id);
    const line = detail.lines[0];
    expect(line, "purchase order line missing").toBeTruthy();

    const before = await getInventoryIntelligence(request, product.variantId);
    const firstReceipt = await receivePurchaseOrder(request, po.id, {
      invoice_number: `AUD-${suffix}`,
      lines: [{ po_line_id: line!.line_id, quantity_received_now: 2 }],
    });
    expect(firstReceipt.idempotent_replay).toBe(false);

    const afterFirst = await getInventoryIntelligence(request, product.variantId);
    expect(afterFirst.stock_on_hand).toBe(before.stock_on_hand + 2);

    const replayReceipt = await receivePurchaseOrder(request, po.id, {
      invoice_number: `AUD-${suffix}`,
      receipt_request_id: firstReceipt.receipt_request_id,
      lines: [{ po_line_id: line!.line_id, quantity_received_now: 2 }],
    });
    expect(replayReceipt.idempotent_replay).toBe(true);
    expect(replayReceipt.receiving_event_id).toBe(firstReceipt.receiving_event_id);

    const afterReplay = await getInventoryIntelligence(request, product.variantId);
    expect(afterReplay.stock_on_hand).toBe(afterFirst.stock_on_hand);

    const replayDetail = await getPurchaseOrderDetail(request, po.id);
    expect(replayDetail.lines[0]?.qty_previously_received).toBe(2);
  });

  test("takeaway return with restock restores stock and records refund truth", async ({
    request,
  }) => {
    test.setTimeout(90_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createInventoryProduct(request, operatorStaffId, "return-restock", 5);

    const before = await getInventoryIntelligence(request, product.variantId);
    const checkout = await checkoutInventoryProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
      fulfillment: "takeaway",
    });

    const afterCheckout = await getInventoryIntelligence(request, product.variantId);
    expect(afterCheckout.stock_on_hand).toBe(before.stock_on_hand - 1);

    const detailBeforeReturn = await fetchTransactionDetail(request, checkout.transaction_id);
    const line = detailBeforeReturn.items.find((item) => item.sku === product.sku);
    expect(line?.transaction_line_id).toBeTruthy();
    expect(line?.is_fulfilled).toBe(true);

    const returnRes = await request.post(`${apiBase()}/api/transactions/${checkout.transaction_id}/returns`, {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
      },
      data: {
        lines: [
          {
            transaction_line_id: line?.transaction_line_id,
            quantity: 1,
            reason: "inventory_audit_restock",
            restock: true,
          },
        ],
      },
      failOnStatusCode: false,
    });
    const returnText = await returnRes.text();
    expect(returnRes.status(), returnText.slice(0, 1000)).toBe(200);
    const detailAfterReturn = JSON.parse(returnText) as TransactionDetailResponse;
    const returnedLine = detailAfterReturn.items.find((item) => item.sku === product.sku);
    expect(returnedLine?.quantity_returned).toBe(1);
    expect(detailAfterReturn.total_price).toBe("0");

    const afterReturn = await getInventoryIntelligence(request, product.variantId);
    expect(afterReturn.stock_on_hand).toBe(before.stock_on_hand);

    const refundQueueRes = await request.get(`${apiBase()}/api/transactions/refunds/due`, {
      headers: staffHeaders(),
      failOnStatusCode: false,
    });
    expect(refundQueueRes.status()).toBe(200);
    const refunds = (await refundQueueRes.json()) as RefundQueueRow[];
    const refund = refunds.find((row) => row.transaction_id === checkout.transaction_id);
    expect(refund?.is_open).toBe(true);
    expect(refund?.amount_due).toBe(totalFor(product));
    expect(refund?.amount_refunded).toBe("0");
  });
});
