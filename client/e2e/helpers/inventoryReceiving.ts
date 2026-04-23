import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

export interface CreatedVendor {
  id: string;
  name: string;
}

export interface CreatedProduct {
  productId: string;
  variantId: string;
  sku: string;
  brand: string;
  name: string;
}

export interface CreateSingleVariantProductOptions {
  categoryId?: string | null;
  stockOnHand?: number;
  namePrefix?: string;
  skuPrefix?: string;
}

export interface CreatedPurchaseOrder {
  id: string;
  po_number: string;
  status: string;
  vendor_name: string;
  po_kind: string;
}

export interface PurchaseOrderDetailLine {
  line_id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  qty_ordered: number;
  qty_previously_received: number;
  unit_cost: string;
}

export interface PurchaseOrderDetail {
  id: string;
  po_number: string;
  status: string;
  vendor_id: string;
  vendor_name: string;
  po_kind: string;
  lines: PurchaseOrderDetailLine[];
}

export interface ReceiveReceiptResult {
  status: string;
  receiving_event_id: string;
  freight_total_this_receipt: string;
  freight_ledger_key: string;
  backorder_created_for_short_lines: boolean;
  receipt_request_id: string;
  idempotent_replay: boolean;
}

export interface InventoryIntelligence {
  variant_id: string;
  product_id: string;
  sku: string;
  stock_on_hand: number;
  reserved_stock: number;
  available_stock: number;
  qty_on_order: number;
}

export interface ProductHubVariantInventoryRow {
  id: string;
  sku: string;
  stock_on_hand: number;
  reserved_stock: number;
  available_stock: number;
  qty_on_order?: number | null;
  last_physical_count_at?: string | null;
}

export interface ProductHubInventoryResponse {
  can_view_procurement?: boolean;
  stats: {
    total_units_on_hand: number;
    total_reserved_units: number;
    total_available_units: number;
    last_physical_count_at?: string | null;
  };
  variants: ProductHubVariantInventoryRow[];
}

export interface ProductTimelineEvent {
  at: string;
  kind: string;
  summary: string;
  reference_id: string | null;
}

export function apiBase(): string {
  const raw =
    process.env.E2E_API_BASE?.trim() ||
    process.env.VITE_API_BASE?.trim() ||
    "http://127.0.0.1:43300";
  return raw.replace(/\/$/, "");
}

export function e2eAdminCode(): string {
  return process.env.E2E_BO_STAFF_CODE?.trim() || "1234";
}

export function adminHeaders(): Record<string, string> {
  const code = e2eAdminCode();
  return {
    "x-riverside-staff-code": code,
    "x-riverside-staff-pin": code,
  };
}

const isCi = process.env.CI === "true" || process.env.CI === "1";

export function requireOrSkip(condition: boolean, message: string): void {
  if (condition) return;
  if (isCi) {
    expect(condition, message).toBeTruthy();
    return;
  }
  test.skip(true, message);
}

export function uniqueSuffix(label: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${label}-${Date.now()}-${random}`;
}

async function expectJsonOk(response: APIResponse, label: string): Promise<unknown> {
  const body = await response.text();
  expect(response.ok(), `${label} failed (${response.status()}): ${body.slice(0, 1000)}`).toBeTruthy();
  return body ? (JSON.parse(body) as unknown) : null;
}

export async function ensureServerReachable(request: APIRequestContext): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    try {
      const res = await request.get(`${apiBase()}/api/staff/list-for-pos`, {
        timeout: 8000,
        failOnStatusCode: false,
      });
      if (res.status() > 0) {
        return true;
      }
    } catch {
      // Retry until the local stack is actually listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export async function fetchFirstCategoryId(request: APIRequestContext): Promise<string | null> {
  const res = await request.get(`${apiBase()}/api/categories`, {
    headers: adminHeaders(),
    failOnStatusCode: false,
  });
  const json = (await expectJsonOk(res, "list categories")) as Array<{ id: string }>;
  return json[0]?.id ?? null;
}

export async function createVendor(
  request: APIRequestContext,
  suffix: string,
): Promise<CreatedVendor> {
  const existingRes = await request.get(`${apiBase()}/api/vendors`, {
    headers: adminHeaders(),
    failOnStatusCode: false,
  });
  const existingJson = (await expectJsonOk(existingRes, "list vendors")) as Array<{
    id: string;
    name: string;
  }>;
  if (existingJson.length > 0) {
    return {
      id: existingJson[0]!.id,
      name: existingJson[0]!.name,
    };
  }

  const name = `E2E Receiving Vendor ${suffix}`;
  const res = await request.post(`${apiBase()}/api/vendors`, {
    headers: adminHeaders(),
    data: {
      name,
      vendor_code: `RCV-${suffix}`,
    },
    failOnStatusCode: false,
  });
  const json = (await expectJsonOk(res, "create vendor")) as { id: string; name: string };
  return {
    id: json.id,
    name: json.name,
  };
}

export async function createSingleVariantProduct(
  request: APIRequestContext,
  suffix: string,
  options: CreateSingleVariantProductOptions = {},
): Promise<CreatedProduct> {
  const categoryId = options.categoryId ?? (await fetchFirstCategoryId(request));
  requireOrSkip(Boolean(categoryId), "No categories available for inventory receiving E2E setup");

  const brand = `E2E Receiving ${suffix}`;
  const name = `${options.namePrefix?.trim() || "Receiving Proof"} ${suffix}`;
  const sku = `${options.skuPrefix?.trim() || "RCV"}-${suffix}`.toUpperCase();

  const createRes = await request.post(`${apiBase()}/api/products`, {
    headers: {
      ...adminHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      category_id: categoryId,
      name,
      brand,
      description: "Receiving hardening verification SKU",
      base_retail_price: "49.99",
      base_cost: "20.00",
      variation_axes: [],
      images: [],
      track_low_stock: false,
      publish_variants_to_web: false,
      variants: [
        {
          sku,
          variation_values: {},
          variation_label: "Standard",
          stock_on_hand: Math.max(0, options.stockOnHand ?? 0),
          retail_price_override: null,
          cost_override: null,
          track_low_stock: false,
        },
      ],
    },
    failOnStatusCode: false,
  });
  const productJson = (await expectJsonOk(createRes, "create product")) as { id: string };

  const boardRes = await request.get(
    `${apiBase()}/api/products/control-board?product_id=${encodeURIComponent(productJson.id)}&limit=10`,
    {
      headers: adminHeaders(),
      failOnStatusCode: false,
    },
  );
  const boardJson = (await expectJsonOk(boardRes, "fetch control board row")) as {
    rows?: Array<{ variant_id: string; sku: string }>;
  };

  const variantRow = boardJson.rows?.[0];
  expect(variantRow, "newly created product variant was not returned by control board").toBeTruthy();

  return {
    productId: productJson.id,
    variantId: variantRow!.variant_id,
    sku: variantRow!.sku,
    brand,
    name,
  };
}

export async function getInventoryIntelligence(
  request: APIRequestContext,
  variantId: string,
): Promise<InventoryIntelligence> {
  const res = await request.get(`${apiBase()}/api/inventory/intelligence/${variantId}`, {
    headers: adminHeaders(),
    failOnStatusCode: false,
  });
  return (await expectJsonOk(res, "fetch inventory intelligence")) as InventoryIntelligence;
}

export async function getProductHubInventory(
  request: APIRequestContext,
  productId: string,
): Promise<ProductHubInventoryResponse> {
  const res = await request.get(`${apiBase()}/api/products/${productId}/hub`, {
    headers: adminHeaders(),
    failOnStatusCode: false,
  });
  return (await expectJsonOk(res, "fetch product hub")) as ProductHubInventoryResponse;
}

export async function getProductTimeline(
  request: APIRequestContext,
  productId: string,
): Promise<ProductTimelineEvent[]> {
  const res = await request.get(`${apiBase()}/api/products/${productId}/timeline`, {
    headers: adminHeaders(),
    failOnStatusCode: false,
  });
  const json = (await expectJsonOk(res, "fetch product timeline")) as {
    events?: ProductTimelineEvent[];
  };
  return json.events ?? [];
}

export async function createDraftPurchaseOrder(
  request: APIRequestContext,
  vendorId: string,
): Promise<CreatedPurchaseOrder> {
  const res = await request.post(`${apiBase()}/api/purchase-orders`, {
    headers: adminHeaders(),
    data: { vendor_id: vendorId },
    failOnStatusCode: false,
  });
  return (await expectJsonOk(res, "create draft purchase order")) as CreatedPurchaseOrder;
}

export async function createDirectInvoicePurchaseOrder(
  request: APIRequestContext,
  vendorId: string,
): Promise<CreatedPurchaseOrder> {
  const res = await request.post(`${apiBase()}/api/purchase-orders/direct-invoice`, {
    headers: adminHeaders(),
    data: { vendor_id: vendorId },
    failOnStatusCode: false,
  });
  return (await expectJsonOk(res, "create direct invoice purchase order")) as CreatedPurchaseOrder;
}

export async function addPurchaseOrderLine(
  request: APIRequestContext,
  purchaseOrderId: string,
  variantId: string,
  quantityOrdered: number,
  unitCost = "20.00",
): Promise<void> {
  const res = await request.post(`${apiBase()}/api/purchase-orders/${purchaseOrderId}/lines`, {
    headers: adminHeaders(),
    data: {
      variant_id: variantId,
      quantity_ordered: quantityOrdered,
      unit_cost: unitCost,
    },
    failOnStatusCode: false,
  });
  await expectJsonOk(res, "add purchase order line");
}

export async function submitPurchaseOrder(
  request: APIRequestContext,
  purchaseOrderId: string,
): Promise<void> {
  const res = await request.post(`${apiBase()}/api/purchase-orders/${purchaseOrderId}/submit`, {
    headers: adminHeaders(),
    failOnStatusCode: false,
  });
  await expectJsonOk(res, "submit purchase order");
}

export async function getPurchaseOrderDetail(
  request: APIRequestContext,
  purchaseOrderId: string,
): Promise<PurchaseOrderDetail> {
  const res = await request.get(`${apiBase()}/api/purchase-orders/${purchaseOrderId}`, {
    headers: adminHeaders(),
    failOnStatusCode: false,
  });
  return (await expectJsonOk(res, "fetch purchase order detail")) as PurchaseOrderDetail;
}

export async function receivePurchaseOrder(
  request: APIRequestContext,
  purchaseOrderId: string,
  payload: {
    invoice_number?: string | null;
    freight_total?: string;
    receipt_request_id?: string;
    lines: Array<{ po_line_id: string; quantity_received_now: number }>;
  },
): Promise<ReceiveReceiptResult> {
  const res = await request.post(`${apiBase()}/api/purchase-orders/${purchaseOrderId}/receive`, {
    headers: adminHeaders(),
    data: {
      invoice_number: payload.invoice_number ?? null,
      freight_total: payload.freight_total ?? "0.00",
      receipt_request_id: payload.receipt_request_id,
      lines: payload.lines,
    },
    failOnStatusCode: false,
  });
  return (await expectJsonOk(res, "receive purchase order")) as ReceiveReceiptResult;
}
