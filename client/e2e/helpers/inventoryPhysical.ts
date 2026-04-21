import { expect, type APIRequestContext, type APIResponse } from "@playwright/test";
import {
  adminHeaders,
  apiBase,
  createSingleVariantProduct,
  type CreatedProduct,
} from "./inventoryReceiving";

export interface CreatedCategory {
  id: string;
  name: string;
}

export interface PhysicalInventorySession {
  id: string;
  session_number: string;
  status: "open" | "reviewing" | "published" | "cancelled";
  scope: "full" | "category";
  category_ids: string[];
  started_at: string;
  last_saved_at: string;
  published_at: string | null;
  notes: string | null;
}

async function expectJsonOk(response: APIResponse, label: string): Promise<unknown> {
  const body = await response.text();
  expect(response.ok(), `${label} failed (${response.status()}): ${body.slice(0, 1000)}`).toBeTruthy();
  return body ? (JSON.parse(body) as unknown) : null;
}

export async function createCategory(
  request: APIRequestContext,
  suffix: string,
): Promise<CreatedCategory> {
  const name = `E2E Physical Count ${suffix}`;
  const res = await request.post(`${apiBase()}/api/categories`, {
    headers: {
      ...adminHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      name,
      is_clothing_footwear: true,
      change_note: "E2E physical inventory verification category",
    },
    failOnStatusCode: false,
  });
  return (await expectJsonOk(res, "create category")) as CreatedCategory;
}

export async function createPhysicalInventorySkuPair(
  request: APIRequestContext,
  suffix: string,
): Promise<{
  category: CreatedCategory;
  countedProduct: CreatedProduct;
  missingProduct: CreatedProduct;
}> {
  const category = await createCategory(request, suffix);
  const countedProduct = await createSingleVariantProduct(request, `${suffix}-counted`, {
    categoryId: category.id,
    stockOnHand: 4,
    namePrefix: "Physical Count Counted",
    skuPrefix: "PICNT",
  });
  const missingProduct = await createSingleVariantProduct(request, `${suffix}-missing`, {
    categoryId: category.id,
    stockOnHand: 2,
    namePrefix: "Physical Count Missing",
    skuPrefix: "PIMIS",
  });
  return { category, countedProduct, missingProduct };
}

export async function getActivePhysicalInventorySession(
  request: APIRequestContext,
): Promise<PhysicalInventorySession | null> {
  const res = await request.get(`${apiBase()}/api/inventory/physical/sessions/active`, {
    headers: adminHeaders(),
    failOnStatusCode: false,
  });
  const json = await expectJsonOk(res, "fetch active physical inventory session");
  return (json as PhysicalInventorySession | null) ?? null;
}

export async function cancelActivePhysicalInventorySession(
  request: APIRequestContext,
): Promise<void> {
  const active = await getActivePhysicalInventorySession(request);
  if (!active) return;
  const res = await request.delete(`${apiBase()}/api/inventory/physical/sessions/${active.id}`, {
    headers: adminHeaders(),
    failOnStatusCode: false,
  });
  await expectJsonOk(res, "cancel active physical inventory session");
}

export async function createCategoryScopedPhysicalInventorySession(
  request: APIRequestContext,
  categoryId: string,
): Promise<PhysicalInventorySession> {
  const res = await request.post(`${apiBase()}/api/inventory/physical/sessions`, {
    headers: {
      ...adminHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      scope: "category",
      category_ids: [categoryId],
      notes: "E2E physical inventory review verification",
    },
    failOnStatusCode: false,
  });
  return (await expectJsonOk(res, "create physical inventory session")) as PhysicalInventorySession;
}

export async function addPhysicalInventoryCount(
  request: APIRequestContext,
  sessionId: string,
  variantId: string,
  quantity: number,
): Promise<number> {
  const res = await request.post(`${apiBase()}/api/inventory/physical/sessions/${sessionId}/counts`, {
    headers: {
      ...adminHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      variant_id: variantId,
      quantity,
      source: "manual",
    },
    failOnStatusCode: false,
  });
  const json = (await expectJsonOk(res, "add physical inventory count")) as { counted_qty: number };
  return json.counted_qty;
}

export async function movePhysicalInventorySessionToReview(
  request: APIRequestContext,
  sessionId: string,
): Promise<void> {
  const res = await request.post(`${apiBase()}/api/inventory/physical/sessions/${sessionId}/move-to-review`, {
    headers: adminHeaders(),
    failOnStatusCode: false,
  });
  await expectJsonOk(res, "move physical inventory session to review");
}
