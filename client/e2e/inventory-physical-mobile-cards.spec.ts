import { expect, test, type Page } from "@playwright/test";
import { openBackofficeSidebarTab, signInToBackOffice } from "./helpers/backofficeSignIn";

type PhysicalViewport = {
  label: string;
  width: number;
  height: number;
};

const PHYSICAL_VIEWPORTS: PhysicalViewport[] = [
  { label: "ipad_1024x1366", width: 1024, height: 1366 },
  { label: "desktop_1440x900", width: 1440, height: 900 },
];

const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const SESSION_NUMBER = "PI-2026-0426";

async function openInventoryPhysicalCount(page: Page): Promise<void> {
  await openBackofficeSidebarTab(page, "inventory");
  let physicalCountButton = page.getByRole("button", {
    name: /^physical counts$/i,
  });
  if (!(await physicalCountButton.isVisible().catch(() => false))) {
    const menuToggle = page.getByRole("button", { name: /toggle menu/i });
    if (await menuToggle.isVisible().catch(() => false)) {
      await menuToggle.click({ force: true }).catch(() => {});
    }
    const expandSidebar = page.getByRole("button", { name: /expand sidebar/i });
    if (await expandSidebar.isVisible().catch(() => false)) {
      await expandSidebar.click({ force: true }).catch(() => {});
    }
    await page
      .getByRole("navigation", { name: "Main Navigation" })
      .getByRole("button", { name: /^inventory(?:\\s+bo)?$/i })
      .click({ force: true })
      .catch(() => {});
    physicalCountButton = page
      .getByRole("navigation", { name: "Main Navigation" })
      .getByRole("button", { name: /^physical counts$/i });
  }
  await expect(physicalCountButton).toBeVisible({ timeout: 20_000 });
  await physicalCountButton.click({ force: true });
  await expect(page.getByRole("heading", { name: /physical inventory/i }).first()).toBeVisible({
    timeout: 20_000,
  });
}

async function mockPhysicalInventoryApis(page: Page): Promise<void> {
  await page.route("**/api/inventory/physical/sessions/active", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: SESSION_ID,
        session_number: SESSION_NUMBER,
        status: "open",
        scope: "full",
        category_ids: [],
        started_at: "2026-04-26T14:00:00.000Z",
        last_saved_at: "2026-04-26T14:15:00.000Z",
        published_at: null,
        notes: null,
        total_counted: 4,
      }),
    });
  });

  await page.route("**/api/inventory/physical/sessions", async (route) => {
    const method = route.request().method();
    if (method !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          {
            id: SESSION_ID,
            session_number: SESSION_NUMBER,
            status: "open",
            scope: "full",
            category_ids: [],
            started_at: "2026-04-26T14:00:00.000Z",
            last_saved_at: "2026-04-26T14:15:00.000Z",
            published_at: null,
            notes: null,
            total_counted: 4,
          },
          {
            id: "66666666-6666-4666-8666-666666666666",
            session_number: "PI-2026-0418",
            status: "published",
            scope: "category",
            category_ids: ["c1"],
            started_at: "2026-04-18T12:00:00.000Z",
            last_saved_at: "2026-04-18T12:25:00.000Z",
            published_at: "2026-04-18T13:00:00.000Z",
            notes: "completed",
            total_counted: 18,
          },
        ],
      }),
    });
  });

  await page.route("**/api/categories", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route(`**/api/inventory/physical/sessions/${SESSION_ID}/move-to-review`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route(`**/api/inventory/physical/sessions/${SESSION_ID}/review`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        rows: [
          {
            count_id: "77777777-7777-4777-8777-777777777777",
            variant_id: "88888888-8888-4888-8888-888888888888",
            sku: "E2E-PI-001",
            product_name: "Inventory Audit Jacket",
            variation_label: "42R",
            stock_at_start: 3,
            counted_qty: 2,
            adjusted_qty: null,
            effective_qty: 2,
            sales_since_start: 0,
            final_stock: 2,
            delta: -1,
            review_status: "pending",
            review_note: null,
          },
        ],
        summary: {
          total_counted: 1,
          total_variants_in_scope: 2,
          missing_variants: 1,
          total_shrinkage: 1,
          total_surplus: 0,
        },
      }),
    });
  });

  await page.route(`**/api/inventory/physical/sessions/${SESSION_ID}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        session: {
          id: SESSION_ID,
          session_number: SESSION_NUMBER,
          status: "open",
          scope: "full",
          category_ids: [],
          started_at: "2026-04-26T14:00:00.000Z",
          last_saved_at: "2026-04-26T14:15:00.000Z",
          published_at: null,
          notes: null,
          total_counted: 4,
        },
        counts: [
          {
            id: "99999999-9999-4999-8999-999999999999",
            session_id: SESSION_ID,
            variant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            sku: "E2E-COUNT-01",
            product_name: "Counted Blazer",
            variation_label: "40L",
            counted_qty: 4,
            adjusted_qty: null,
            review_status: "pending",
            review_note: null,
            last_scanned_at: "2026-04-26T14:14:00.000Z",
            scan_source: "laser",
          },
        ],
      }),
    });
  });
}

for (const viewport of PHYSICAL_VIEWPORTS) {
  test(`Physical inventory responsive cards ${viewport.label}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await mockPhysicalInventoryApis(page);
    await signInToBackOffice(page);
    await openInventoryPhysicalCount(page);

    await expect(page.getByRole("heading", { name: /session manager/i })).toBeVisible({ timeout: 20_000 });

    if (viewport.width <= 1023) {
      await expect(page.getByTestId("physical-session-cards")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("physical-session-table")).toHaveCount(0);
    } else {
      await expect(page.getByTestId("physical-session-table")).toBeVisible({ timeout: 20_000 });
    }

    await page.getByRole("button", { name: /resume scanners/i }).click();
    await expect(page.getByRole("heading", { name: /counting phase/i })).toBeVisible({ timeout: 20_000 });

    if (viewport.width <= 1023) {
      await expect(page.getByTestId("physical-count-cards")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("physical-count-table")).toHaveCount(0);
    } else {
      await expect(page.getByTestId("physical-count-table")).toBeVisible({ timeout: 20_000 });
    }

    await page.getByRole("button", { name: /finish & audit/i }).click();
    await page.getByRole("button", { name: /procede to audit|proceed to audit/i }).click();

    await expect(page.getByRole("heading", { name: /review phase/i })).toBeVisible({ timeout: 20_000 });
    if (viewport.width <= 1023) {
      await expect(page.getByTestId("physical-review-cards")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("physical-review-table")).toHaveCount(0);
    } else {
      await expect(page.getByTestId("physical-review-table")).toBeVisible({ timeout: 20_000 });
    }
  });
}
