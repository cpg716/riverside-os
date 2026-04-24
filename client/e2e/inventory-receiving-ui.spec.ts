import { expect, test } from "@playwright/test";
import { openBackofficeSidebarTab, signInToBackOffice } from "./helpers/backofficeSignIn";
import {
  addPurchaseOrderLine,
  apiBase,
  createDirectInvoicePurchaseOrder,
  createDraftPurchaseOrder,
  createSingleVariantProduct,
  createVendor,
  ensureServerReachable,
  getInventoryIntelligence,
  requireOrSkip,
  uniqueSuffix,
} from "./helpers/inventoryReceiving";

let serverReachable = false;

test.beforeAll(async ({ request }) => {
  serverReachable = await ensureServerReachable(request);
});

test.beforeEach(() => {
  requireOrSkip(
    serverReachable,
    `API not reachable at ${apiBase()} — start Postgres + server to run inventory receiving UI verification`,
  );
});

async function openInventoryPurchaseOrders(page: Parameters<typeof test>[0]["page"]) {
  await openBackofficeSidebarTab(page, "inventory");
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }).getByText(/^inventory$/i),
  ).toBeVisible({ timeout: 15_000 });
  const purchaseOrdersButton = page.getByRole("button", {
    name: /^purchase orders$/i,
  });
  await expect(purchaseOrdersButton).toBeVisible({ timeout: 15_000 });
  await purchaseOrdersButton.click({ force: true });
  await expect(page.getByText(/purchase orders & receiving/i).first()).toBeVisible({
    timeout: 20_000,
  });
}

async function openInventoryReceiveStock(page: Parameters<typeof test>[0]["page"]) {
  await openBackofficeSidebarTab(page, "inventory");
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }).getByText(/^inventory$/i),
  ).toBeVisible({ timeout: 15_000 });
  const receiveStockButton = page.getByRole("button", {
    name: /^receive stock$/i,
  });
  await expect(receiveStockButton).toBeVisible({ timeout: 15_000 });
  await receiveStockButton.click({ force: true });
  await expect(page.getByText(/start with the vendor paperwork in hand/i)).toBeVisible({
    timeout: 20_000,
  });
}

test.describe("Inventory receiving operator verification", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(90_000);

  test("Receive Stock sidebar entry shows the next action and can open a ready document", async ({
    page,
    request,
  }) => {
    const suffix = uniqueSuffix("ui-receive-tab");
    const vendor = await createVendor(request, suffix);
    const product = await createSingleVariantProduct(request, suffix);
    const directInvoice = await createDirectInvoicePurchaseOrder(request, vendor.id);
    await addPurchaseOrderLine(request, directInvoice.id, product.variantId, 1);

    await signInToBackOffice(page, { persistSession: true });
    await openInventoryReceiveStock(page);

    await expect(page.getByText(/choose an open purchase order/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/create a direct invoice/i).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/standalone|offline/i)).toHaveCount(0);

    const invoiceRow = page.locator("tr").filter({ hasText: directInvoice.po_number }).first();
    await expect(invoiceRow).toBeVisible({ timeout: 20_000 });
    await invoiceRow.getByRole("button", { name: /receive/i }).click();
    await expect(
      page.getByRole("heading", { name: /^receive stock$/i }).first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("standard PO can be submitted, staged without stock mutation, and then received", async ({
    page,
    request,
  }) => {
    const suffix = uniqueSuffix("ui-po");
    const vendor = await createVendor(request, suffix);
    const product = await createSingleVariantProduct(request, suffix);
    const draftPo = await createDraftPurchaseOrder(request, vendor.id);
    await addPurchaseOrderLine(request, draftPo.id, product.variantId, 1);

    const stockBefore = await getInventoryIntelligence(request, product.variantId);

    await signInToBackOffice(page, { persistSession: true });
    await openInventoryPurchaseOrders(page);

    const poRow = page.locator("tr").filter({ hasText: draftPo.po_number }).first();
    await expect(poRow).toBeVisible({ timeout: 20_000 });
    await poRow.click();

    const submitButton = page.getByRole("button", { name: /^submit po$/i });
    await expect(submitButton).toBeVisible({ timeout: 10_000 });
    await submitButton.click();

    await expect(poRow).toContainText(/ready to receive/i, { timeout: 20_000 });

    const receiveButton = poRow.getByRole("button", { name: /receive/i });
    await expect(receiveButton).toBeVisible({ timeout: 10_000 });
    await receiveButton.click();

    await expect(page.getByRole("heading", { name: /receive stock/i })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/^step 1$/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/^check paperwork$/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/^count & invoice$/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/^post inventory$/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/next: count & invoice/i)).toBeVisible({ timeout: 10_000 });

    const receivingRow = page.locator("tr").filter({ hasText: product.sku }).first();
    const receivingNowInput = receivingRow.getByRole("spinbutton");
    await expect(receivingNowInput).toBeVisible({ timeout: 10_000 });
    await receivingNowInput.fill("1");
    await expect(page.getByText(/next: post inventory/i)).toBeVisible({ timeout: 10_000 });

    const postInventoryButton = page.getByRole("button", { name: /^post inventory$/i });
    await expect(postInventoryButton).toBeEnabled({ timeout: 10_000 });
    const receiveResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/purchase-orders/${draftPo.id}/receive`) &&
        response.request().method() === "POST" &&
        response.status() === 200,
    );
    await postInventoryButton.click({ force: true });
    await page.getByRole("button", { name: /confirm & post/i }).click({ force: true });
    await receiveResponse;

    await expect(page.getByRole("heading", { name: /receive stock/i })).toBeHidden({
      timeout: 20_000,
    });
    await expect(poRow).toContainText(/closed/i, { timeout: 20_000 });

    await expect
      .poll(async () => (await getInventoryIntelligence(request, product.variantId)).stock_on_hand, {
        timeout: 15_000,
      })
      .toBe(stockBefore.stock_on_hand + 1);
  });

  test("direct invoice receiving opens without raw ID entry and completes through Receive Stock", async ({
    page,
    request,
  }) => {
    const suffix = uniqueSuffix("ui-direct");
    const vendor = await createVendor(request, suffix);
    const product = await createSingleVariantProduct(request, suffix);
    const directInvoice = await createDirectInvoicePurchaseOrder(request, vendor.id);
    await addPurchaseOrderLine(request, directInvoice.id, product.variantId, 1);

    const stockBefore = await getInventoryIntelligence(request, product.variantId);

    await signInToBackOffice(page, { persistSession: true });
    await openInventoryPurchaseOrders(page);

    const invoiceRow = page.locator("tr").filter({ hasText: directInvoice.po_number }).first();
    await expect(invoiceRow).toBeVisible({ timeout: 20_000 });
    await invoiceRow.click();

    await expect(page.getByText(/line pointer/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^submit po$/i })).toHaveCount(0);

    const openReceivingButton = page.getByRole("button", { name: /^open receive stock$/i });
    await expect(openReceivingButton).toBeVisible({ timeout: 10_000 });
    await expect(openReceivingButton).toBeEnabled();
    await openReceivingButton.click();

    await expect(page.getByRole("heading", { name: /receive stock/i })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/^check paperwork$/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/next: count & invoice/i)).toBeVisible({ timeout: 10_000 });

    const receivingRow = page.locator("tr").filter({ hasText: product.sku }).first();
    const receivingNowInput = receivingRow.getByRole("spinbutton");
    await expect(receivingNowInput).toBeVisible({ timeout: 10_000 });
    await receivingNowInput.fill("1");
    await expect(page.getByText(/next: post inventory/i)).toBeVisible({ timeout: 10_000 });

    const postInventoryButton = page.getByRole("button", { name: /^post inventory$/i });
    await expect(postInventoryButton).toBeEnabled({ timeout: 10_000 });
    const receiveResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/purchase-orders/${directInvoice.id}/receive`) &&
        response.request().method() === "POST" &&
        response.status() === 200,
    );
    await postInventoryButton.click({ force: true });
    await page.getByRole("button", { name: /confirm & post/i }).click({ force: true });
    await receiveResponse;

    await expect(page.getByRole("heading", { name: /receive stock/i })).toBeHidden({
      timeout: 20_000,
    });
    await expect(invoiceRow).toContainText(/closed/i, { timeout: 20_000 });

    await expect
      .poll(async () => (await getInventoryIntelligence(request, product.variantId)).stock_on_hand, {
        timeout: 15_000,
      })
      .toBe(stockBefore.stock_on_hand + 1);
  });
});
