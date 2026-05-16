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

  test("pickup and Podium workspaces distinguish refresh failures from empty queues", async ({ page }) => {
    await page.route("**/api/transactions/fulfillment-queue", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporarily unavailable" }),
      });
    });
    await page.route("**/api/customers/podium/messaging-inbox?*", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporarily unavailable" }),
      });
    });

    await signInToBackOffice(page);
    await page.getByRole("button", { name: /^pickup queue$/i }).first().click();
    await expect(page.getByText("Pickup queue could not refresh.").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByText("Do not treat the queue as clear until refresh succeeds.").first(),
    ).toBeVisible();
    await expect(page.getByText("No pickup records match this priority level.")).toHaveCount(0);

    await page.getByRole("button", { name: /^podium inbox$/i }).first().click();
    await expect(page.getByText("Could not refresh Podium inbox.")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByText("Do not treat the inbox as empty until refresh succeeds."),
    ).toBeVisible();
    await expect(page.getByText("No Podium conversations yet")).toHaveCount(0);
  });

  test("pickup queue surfaces rush-condition release guidance", async ({ page }) => {
    await page.route("**/api/transactions/fulfillment-queue", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            order_id: "txn-phase3-blocked",
            order_short_id: "PH3-BLOCKED",
            booked_at: "2026-05-13T12:00:00Z",
            status: "open",
            customer_name: "Phase Three Blocked",
            item_count: 2,
            fulfilled_item_count: 0,
            urgency: "blocked",
            next_deadline: "2026-05-13",
            balance_due: 25,
            wedding_party_name: "Phase Three Wedding",
          },
          {
            order_id: "txn-phase3-ready",
            order_short_id: "PH3-READY",
            booked_at: "2026-05-13T12:05:00Z",
            status: "open",
            customer_name: "Phase Three Ready",
            item_count: 1,
            fulfilled_item_count: 1,
            urgency: "ready",
            next_deadline: null,
            balance_due: 0,
            wedding_party_name: null,
          },
        ]),
      });
    });

    await signInToBackOffice(page);
    await page.getByRole("button", { name: /^pickup queue$/i }).first().click();

    await expect(page.getByText("Rush-condition pickup guidance")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByText("Blocked pickups first: do not release garments until balance, readiness, or lifecycle blockers are cleared."),
    ).toBeVisible();
    await expect(page.getByText("Next: Pickup blocked until balance is cleared.")).toBeVisible();
    await expect(
      page.getByText("Escalation: Requires payment collection before release."),
    ).toBeVisible();
  });

  test("inventory control board shows outage guidance instead of empty filters", async ({ page }) => {
    await page.route("**/api/categories", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/api/vendors", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/api/inventory/control-board?*", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporarily unavailable" }),
      });
    });

    await signInToBackOffice(page);
    await openBackofficeSidebarTab(page, "inventory");
    await page.getByRole("button", { name: /^find item$/i }).first().click();

    await expect(page.getByText("Could not refresh inventory.")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByText("Do not treat these filters as empty until refresh succeeds."),
    ).toBeVisible();
    await expect(page.getByText("No matching inventory in current filters")).toHaveCount(0);
  });

  test("duplicate review queue does not look clear when refresh fails", async ({ page }) => {
    await page.route("**/api/customers/duplicate-review-queue", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporarily unavailable" }),
      });
    });

    await signInToBackOffice(page);
    await openBackofficeSidebarTab(page, "customers");
    await page.getByRole("button", { name: /^duplicate review$/i }).click();

    await expect(page.getByText("Could not refresh duplicate review queue.")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByText("Do not treat the queue as clear until refresh succeeds."),
    ).toBeVisible();
    await expect(page.getByText("No pending pairs.")).toHaveCount(0);
  });

  test("notification partial cleanup failures stay visible", async ({ page }) => {
    const rows = [
      {
        staff_notification_id: "sn-phase3-read-ok",
        notification_id: "n-phase3-read-ok",
        created_at: "2026-05-13T12:00:00.000Z",
        kind: "morning_low_stock",
        title: "Low stock needs review",
        body: "Review stock before the floor opens.",
        deep_link: { type: "inventory" },
        source: "system",
        read_at: null,
        completed_at: null,
        archived_at: null,
      },
      {
        staff_notification_id: "sn-phase3-read-fail",
        notification_id: "n-phase3-read-fail",
        created_at: "2026-05-13T12:01:00.000Z",
        kind: "pickup_stale",
        title: "Pickup needs attention",
        body: "Review the pickup queue.",
        deep_link: { type: "order", transaction_id: "txn-phase3" },
        source: "system",
        read_at: null,
        completed_at: null,
        archived_at: null,
      },
    ];

    await page.route("**/api/notifications/unread-count", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ unread: 2, podium_inbox_unread: 0 }),
      });
    });
    await page.route("**/api/notifications?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(rows),
      });
    });
    await page.route("**/api/notifications/sn-phase3-read-ok/read", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.route("**/api/notifications/sn-phase3-read-fail/read", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporarily unavailable" }),
      });
    });

    await signInToBackOffice(page);
    await page.getByRole("button", { name: /^Notifications(?:, \d+ unread)?$/ }).click();
    await expect(page.getByRole("button", { name: "Low stock needs review — Open" })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: /mark read/i }).click();

    await expect(page.getByText("Some alerts were not marked read")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByText("The completed updates were kept; retry is safe for the remaining alerts."),
    ).toBeVisible();
  });
});
