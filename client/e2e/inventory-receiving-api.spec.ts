import { expect, test } from "@playwright/test";
import {
  adminHeaders,
  apiBase,
  createDirectInvoicePurchaseOrder,
  createDraftPurchaseOrder,
  createSingleVariantProduct,
  createVendor,
  ensureServerReachable,
  getInventoryIntelligence,
  getPurchaseOrderDetail,
  receivePurchaseOrder,
  requireOrSkip,
  submitPurchaseOrder,
  addPurchaseOrderLine,
  uniqueSuffix,
} from "./helpers/inventoryReceiving";

let serverReachable = false;

test.beforeAll(async ({ request }) => {
  serverReachable = await ensureServerReachable(request);
});

test.beforeEach(() => {
  requireOrSkip(
    serverReachable,
    `API not reachable at ${apiBase()} — start Postgres + server to run inventory receiving API regressions`,
  );
});

test.describe("Inventory receiving API regressions", () => {
  test("batch scan stages matches without mutating live stock", async ({ request }) => {
    const suffix = uniqueSuffix("batch");
    const vendor = await createVendor(request, suffix);
    const product = await createSingleVariantProduct(request, suffix);

    const before = await getInventoryIntelligence(request, product.variantId);

    const scanRes = await request.post(`${apiBase()}/api/inventory/batch-scan`, {
      headers: {
        ...adminHeaders(),
        "Content-Type": "application/json",
      },
      data: [
        {
          code: product.sku,
          vendor_id: vendor.id,
          quantity: 2,
          source: "laser",
        },
      ],
      failOnStatusCode: false,
    });

    expect(scanRes.status()).toBe(200);
    const scanJson = (await scanRes.json()) as {
      processed: number;
      matched: number;
      not_found: number;
      results: Array<{
        status: string;
        variant_id: string | null;
        sku: string | null;
        new_stock: number | null;
      }>;
    };
    expect(scanJson.processed).toBe(1);
    expect(scanJson.matched).toBe(1);
    expect(scanJson.not_found).toBe(0);
    expect(scanJson.results[0]?.status).toBe("matched");
    expect(scanJson.results[0]?.variant_id).toBe(product.variantId);
    expect(scanJson.results[0]?.sku).toBe(product.sku);
    expect(scanJson.results[0]?.new_stock).toBeNull();

    const after = await getInventoryIntelligence(request, product.variantId);
    expect(after.stock_on_hand).toBe(before.stock_on_hand);
    expect(after.available_stock).toBe(before.available_stock);
  });

  test("final PO receipt posts stock exactly once and duplicate retry does not double-post", async ({
    request,
  }) => {
    const suffix = uniqueSuffix("po");
    const vendor = await createVendor(request, suffix);
    const product = await createSingleVariantProduct(request, suffix);
    const po = await createDraftPurchaseOrder(request, vendor.id);
    await addPurchaseOrderLine(request, po.id, product.variantId, 2);
    await submitPurchaseOrder(request, po.id);

    const detail = await getPurchaseOrderDetail(request, po.id);
    const line = detail.lines[0];
    expect(line, "purchase order line missing").toBeTruthy();

    const before = await getInventoryIntelligence(request, product.variantId);
    const firstReceipt = await receivePurchaseOrder(request, po.id, {
      invoice_number: `INV-${suffix}`,
      lines: [{ po_line_id: line!.line_id, quantity_received_now: 1 }],
    });

    expect(firstReceipt.idempotent_replay).toBe(false);

    const afterFirst = await getInventoryIntelligence(request, product.variantId);
    expect(afterFirst.stock_on_hand).toBe(before.stock_on_hand + 1);

    const firstDetailAfter = await getPurchaseOrderDetail(request, po.id);
    expect(firstDetailAfter.status).toBe("partially_received");
    expect(firstDetailAfter.lines[0]?.qty_previously_received).toBe(1);

    const replayReceipt = await receivePurchaseOrder(request, po.id, {
      invoice_number: `INV-${suffix}`,
      receipt_request_id: firstReceipt.receipt_request_id,
      lines: [{ po_line_id: line!.line_id, quantity_received_now: 1 }],
    });

    expect(replayReceipt.idempotent_replay).toBe(true);
    expect(replayReceipt.receiving_event_id).toBe(firstReceipt.receiving_event_id);
    expect(replayReceipt.receipt_request_id).toBe(firstReceipt.receipt_request_id);

    const afterReplay = await getInventoryIntelligence(request, product.variantId);
    expect(afterReplay.stock_on_hand).toBe(afterFirst.stock_on_hand);

    const replayDetail = await getPurchaseOrderDetail(request, po.id);
    expect(replayDetail.lines[0]?.qty_previously_received).toBe(1);
  });

  test("direct invoice receiving uses the same final posting path and remains exact-once on replay", async ({
    request,
  }) => {
    const suffix = uniqueSuffix("direct");
    const vendor = await createVendor(request, suffix);
    const product = await createSingleVariantProduct(request, suffix);
    const directInvoice = await createDirectInvoicePurchaseOrder(request, vendor.id);
    await addPurchaseOrderLine(request, directInvoice.id, product.variantId, 1);

    const detail = await getPurchaseOrderDetail(request, directInvoice.id);
    const line = detail.lines[0];
    expect(line, "direct invoice line missing").toBeTruthy();
    expect(detail.po_kind).toBe("direct_invoice");
    expect(detail.status).toBe("draft");

    const before = await getInventoryIntelligence(request, product.variantId);
    const firstReceipt = await receivePurchaseOrder(request, directInvoice.id, {
      invoice_number: `DIR-${suffix}`,
      lines: [{ po_line_id: line!.line_id, quantity_received_now: 1 }],
    });

    expect(firstReceipt.idempotent_replay).toBe(false);

    const afterFirst = await getInventoryIntelligence(request, product.variantId);
    expect(afterFirst.stock_on_hand).toBe(before.stock_on_hand + 1);

    const detailAfterFirst = await getPurchaseOrderDetail(request, directInvoice.id);
    expect(detailAfterFirst.status).toBe("closed");
    expect(detailAfterFirst.lines[0]?.qty_previously_received).toBe(1);

    const replayReceipt = await receivePurchaseOrder(request, directInvoice.id, {
      invoice_number: `DIR-${suffix}`,
      receipt_request_id: firstReceipt.receipt_request_id,
      lines: [{ po_line_id: line!.line_id, quantity_received_now: 1 }],
    });

    expect(replayReceipt.idempotent_replay).toBe(true);
    expect(replayReceipt.receiving_event_id).toBe(firstReceipt.receiving_event_id);

    const afterReplay = await getInventoryIntelligence(request, product.variantId);
    expect(afterReplay.stock_on_hand).toBe(afterFirst.stock_on_hand);

    const detailAfterReplay = await getPurchaseOrderDetail(request, directInvoice.id);
    expect(detailAfterReplay.status).toBe("closed");
    expect(detailAfterReplay.lines[0]?.qty_previously_received).toBe(1);
  });
});
