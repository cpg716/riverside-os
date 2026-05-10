import { expect, test, type Page } from "@playwright/test";

import {
  openBackofficeSidebarTab,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";

const PO_ID = "11111111-2222-4333-8444-555555555555";
const VENDOR_ID = "99999999-8888-4777-8666-555555555555";

const READY_PO = {
  id: PO_ID,
  po_number: "PO-PHASE3-READY",
  status: "submitted",
  vendor_name: "Phase 3 Vendor",
  po_kind: "purchase_order",
};

async function openOrdersWorkspace(page: Page) {
  await openBackofficeSidebarTab(page, "orders");
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }).getByText(/^orders$/i),
  ).toBeVisible({ timeout: 20_000 });
}

async function openInventoryReceiveStock(page: Page) {
  await openBackofficeSidebarTab(page, "inventory");
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }).getByText(/^inventory$/i),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /^receive stock$/i }).click({ force: true });
  await expect(page.getByText(/start with the vendor paperwork in hand/i)).toBeVisible({
    timeout: 20_000,
  });
}

async function mockInventoryPaperworkShell(page: Page) {
  await page.route("**/api/vendors", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: VENDOR_ID, name: "Phase 3 Vendor" }]),
    });
  });

  await page.route("**/api/weddings/non-inventory", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });
}

test.describe("Phase 3 failure-state coverage", () => {
  test("orders list load failure does not look like an empty result", async ({ page }) => {
    await page.route(/\/api\/transactions\?/, async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporarily unavailable" }),
      });
    });

    await signInToBackOffice(page);
    await openOrdersWorkspace(page);

    await expect(
      page.getByText("Transactions unavailable").filter({ visible: true }),
    ).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page
        .getByText("Transaction records could not load right now. Try again in a moment.")
        .filter({ visible: true }),
    ).toBeVisible();
    await expect(page.getByText("No matching records found")).toHaveCount(0);
  });

  test("purchase orders warn when a refresh fails after rows loaded", async ({ page }) => {
    let purchaseOrderListCalls = 0;
    await mockInventoryPaperworkShell(page);
    await page.route("**/api/purchase-orders", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      purchaseOrderListCalls += 1;
      if (purchaseOrderListCalls === 1) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([READY_PO]),
        });
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporarily unavailable" }),
      });
    });

    await signInToBackOffice(page, { persistSession: true });
    await openInventoryReceiveStock(page);

    await expect(page.getByRole("cell", { name: READY_PO.po_number })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("Vendor paperwork may not be current")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByText("Could not refresh the latest paperwork. Showing the last successfully loaded results."),
    ).toBeVisible();
    await expect(page.getByText("No vendor paperwork is ready to receive yet.")).toHaveCount(0);
  });

  test("receiving load failure offers retry and confirms nothing posted", async ({ page }) => {
    await mockInventoryPaperworkShell(page);
    await page.route("**/api/purchase-orders", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([READY_PO]),
      });
    });
    await page.route(`**/api/purchase-orders/${PO_ID}`, async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporarily unavailable" }),
      });
    });

    await signInToBackOffice(page, { persistSession: true });
    await openInventoryReceiveStock(page);

    const poRow = page.locator("tr").filter({ hasText: READY_PO.po_number }).first();
    await expect(poRow).toBeVisible({ timeout: 20_000 });
    await poRow.getByRole("button", { name: /receive/i }).click();

    await expect(page.getByRole("heading", { name: "Vendor paperwork could not open" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("Receiving has not posted any inventory from this window.")).toBeVisible();
    await expect(page.getByRole("button", { name: /^try again$/i })).toBeVisible();
  });

  test("operations home marks failed feeds instead of looking clear", async ({ page }) => {
    await page.route(/\/api\/insights\/register-day-activity\?/, async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporarily unavailable" }),
      });
    });

    await signInToBackOffice(page);

    await expect(
      page.getByText("Some operational feeds did not refresh. Review the marked sections before treating the dashboard as clear."),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Not loaded").first()).toBeVisible();
  });
});
