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
  const purchaseOrdersButton = page.getByRole("navigation", { name: "Main Navigation" }).getByRole("button", {
    name: /^order stock$/i,
  });
  await expect(purchaseOrdersButton).toBeVisible({ timeout: 15_000 });
  await purchaseOrdersButton.click({ force: true });
  await expect(page.getByText(/build purchase orders and send to vendors/i)).toBeVisible({
    timeout: 20_000,
  });
}

async function openInventoryReceiveStock(page: Parameters<typeof test>[0]["page"]) {
  await openBackofficeSidebarTab(page, "inventory");
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }).getByText(/^inventory$/i),
  ).toBeVisible({ timeout: 15_000 });
  const receiveStockButton = page.getByRole("navigation", { name: "Main Navigation" }).getByRole("button", {
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

    await expect(page.getByText(/pick an existing purchase order/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/direct invoice/i).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/pick an existing purchase order/i)).toBeVisible();

    const invoiceRow = page.locator("tr").filter({ hasText: directInvoice.po_number }).first();
    await expect(invoiceRow).toBeVisible({ timeout: 20_000 });
    await invoiceRow.getByRole("button", { name: /receive/i }).click();
    await expect(
      page.getByRole("heading", { name: /^receive stock$/i }).first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("Batch Scan sidebar entry opens the batch resolution tool", async ({ page }) => {
    await signInToBackOffice(page, { persistSession: true });
    await openBackofficeSidebarTab(page, "inventory");

    const batchScanButton = page.getByRole("navigation", { name: "Main Navigation" }).getByRole("button", {
      name: /^batch scan$/i,
    });
    await expect(batchScanButton).toBeVisible({ timeout: 15_000 });
    await batchScanButton.click({ force: true });

    await expect(page.getByRole("heading", { name: /^batch scan$/i }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: /^resolve batch$/i })).toBeVisible();
    await expect(page.getByText(/no stock mutation/i)).toBeVisible();
  });

  test("New PO opens editable paperwork immediately", async ({ page, request }) => {
    const suffix = uniqueSuffix("ui-new-po");
    const vendor = await createVendor(request, suffix);
    const quickSku = `QPO-${suffix}`.toUpperCase();

    await signInToBackOffice(page, { persistSession: true });
    await openInventoryPurchaseOrders(page);

    await page.locator("select").first().selectOption({ label: vendor.name });
    await page.getByRole("button", { name: /^new po$/i }).click();

    await expect(page.getByText(/^open paperwork$/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(vendor.name).last()).toBeVisible();
    await expect(page.getByText(/no lines yet/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /^add line$/i })).toBeVisible();

    await page.getByRole("button", { name: /quick add item/i }).click();
    const dialog = page.getByRole("dialog", { name: /quick add item/i });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/item name/i).fill(`Quick PO Item ${suffix}`);
    await dialog.getByLabel(/^sku$/i).fill(quickSku);
    await dialog.getByLabel(/unit cost/i).fill("12.34");
    await dialog.getByLabel(/^retail$/i).fill("45.67");
    await dialog.getByRole("button", { name: /create & use item/i }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });

    await expect(page.getByText(quickSku)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /^add line$/i }).click();
    await expect(page.locator("table").filter({ hasText: quickSku }).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test("Direct Invoice opens receiving item entry immediately", async ({ page, request }) => {
    const suffix = uniqueSuffix("ui-direct-open");
    const vendor = await createVendor(request, suffix);
    const quickSku = `QDI-${suffix}`.toUpperCase();

    await signInToBackOffice(page, { persistSession: true });
    await openInventoryReceiveStock(page);

    await page.locator("select").first().selectOption({ label: vendor.name });
    await page.getByRole("button", { name: /^direct invoice$/i }).click();

    await expect(page.getByRole("heading", { name: /^receive stock$/i }).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/add invoice lines above/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/search or scan item/i).first()).toBeVisible();

    await page.locator("#drawer-root").getByRole("button", { name: /quick add item/i }).click();
    const dialog = page.getByRole("dialog", { name: /quick add item/i });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/item name/i).fill(`Quick Invoice Item ${suffix}`);
    await dialog.getByLabel(/^sku$/i).fill(quickSku);
    await dialog.getByLabel(/unit cost/i).fill("22.22");
    await dialog.getByLabel(/^retail$/i).fill("66.66");
    await dialog.getByRole("button", { name: /create & use item/i }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });

    await expect(page.getByText(quickSku)).toBeVisible({ timeout: 20_000 });
    await page.locator("#drawer-root").getByRole("button", { name: /^add line$/i }).click();
    await expect(
      page.locator("#drawer-root").getByText(quickSku, { exact: true }),
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
    const insightRequests: Record<string, unknown>[] = [];
    await page.route("**/api/help/rosie/v1/insight-summary", async (route) => {
      insightRequests.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "unavailable", bullets: [] }),
      });
    });

    const stockBefore = await getInventoryIntelligence(request, product.variantId);

    await signInToBackOffice(page, { persistSession: true });
    await openInventoryPurchaseOrders(page);

    const poRow = page.locator("tr").filter({ hasText: draftPo.po_number }).first();
    await expect(poRow).toBeVisible({ timeout: 20_000 });
    await poRow.click();

    const submitButton = poRow.getByRole("button", { name: /^mark sent$/i });
    await expect(submitButton).toBeVisible({ timeout: 10_000 });
    await submitButton.click();

    await expect(poRow).toContainText(/sent to vendor/i, { timeout: 20_000 });

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
    expect(insightRequests).toHaveLength(0);
    await page
      .getByTestId("rosie-insight-summary-receiving_review")
      .getByRole("button", { name: /rosie insight/i })
      .click();
    await expect(page.getByText("ROSIE thinking...")).toHaveCount(0);
    expect(insightRequests).toHaveLength(1);
    expect(insightRequests[0]).toMatchObject({
      surface: "receiving_review",
      mode: "explain",
      facts: {
        title: "Receiving Review",
        bullets: expect.arrayContaining([
          expect.objectContaining({ id: "receiving-context" }),
          expect.objectContaining({ id: "receiving-units" }),
        ]),
        disclaimers: expect.arrayContaining([
          "Explain visible receiving checks only. ROSIE cannot approve receiving, change quantities, or post inventory.",
        ]),
      },
    });
    expect(JSON.stringify(insightRequests[0])).not.toContain(product.sku);

    const drawerRoot = page.locator("#drawer-root");
    const receivingRow = drawerRoot.locator("tr").filter({ hasText: product.sku }).first();
    const receivingNowInput = receivingRow.getByRole("spinbutton", {
      name: new RegExp(`receiving quantity for ${product.sku}`, "i"),
    });
    await expect(receivingNowInput).toBeVisible({ timeout: 10_000 });
    await receivingNowInput.fill("1");
    await expect(page.getByText(/next: post inventory/i)).toBeVisible({ timeout: 10_000 });

    const postInventoryButton = drawerRoot
      .getByRole("button", { name: /post receipt/i })
      .last();
    await expect(postInventoryButton).toBeVisible({ timeout: 10_000 });
    await expect(postInventoryButton).toBeEnabled({ timeout: 10_000 });
    const receiveResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/purchase-orders/") &&
        response.url().includes("/receive") &&
        response.request().method() === "POST" &&
        response.status() === 200,
    );
    await postInventoryButton.evaluate((button) => (button as HTMLButtonElement).click());
    const confirmPostButton = drawerRoot
      .getByRole("button", { name: /confirm & post|post without invoice/i })
      .last();
    await expect(confirmPostButton).toBeVisible({ timeout: 10_000 });
    await confirmPostButton.click({ force: true });
    await receiveResponse;

    // Close receiving report modal
    await page.getByRole("button", { name: /^done$/i }).click();

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
    await expect(invoiceRow.getByRole("button", { name: /^mark sent$/i })).toHaveCount(0);
    const printBtn = page.getByRole("button", { name: /^print$/i });
    await expect(printBtn).toBeVisible({ timeout: 10_000 });
    await expect(printBtn.locator("..").getByRole("button", { name: /^mark sent$/i })).toHaveCount(0);

    const openReceivingButton = page.getByRole("button", {
      name: `Receive stock for ${directInvoice.po_number}`,
    });
    await expect(openReceivingButton).toBeVisible({ timeout: 10_000 });
    await expect(openReceivingButton).toBeEnabled();
    await openReceivingButton.click();

    await expect(page.getByRole("heading", { name: /receive stock/i })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/^check paperwork$/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/next: count & invoice/i)).toBeVisible({ timeout: 10_000 });

    const drawerRoot = page.locator("#drawer-root");
    const receivingRow = drawerRoot.locator("tr").filter({ hasText: product.sku }).first();
    const receivingNowInput = receivingRow.getByRole("spinbutton", {
      name: new RegExp(`receiving quantity for ${product.sku}`, "i"),
    });
    await expect(receivingNowInput).toBeVisible({ timeout: 10_000 });
    await receivingNowInput.fill("1");
    await expect(page.getByText(/next: post inventory/i)).toBeVisible({ timeout: 10_000 });

    const postInventoryButton = drawerRoot
      .getByRole("button", { name: /post receipt/i })
      .last();
    await expect(postInventoryButton).toBeEnabled({ timeout: 10_000 });
    const receiveResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/purchase-orders/${directInvoice.id}/receive`) &&
        response.request().method() === "POST" &&
        response.status() === 200,
    );
    await postInventoryButton.evaluate((button) => (button as HTMLButtonElement).click());
    await drawerRoot
      .getByRole("button", { name: /confirm & post|post without invoice/i })
      .click({ force: true });
    await receiveResponse;

    // Close receiving report modal
    await page.getByRole("button", { name: /^done$/i }).click();

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
