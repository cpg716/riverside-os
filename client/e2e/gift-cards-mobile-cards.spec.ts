import { expect, test } from "@playwright/test";
import { openBackofficeSidebarTab, signInToBackOffice } from "./helpers/backofficeSignIn";

type GiftCardsViewport = {
  label: string;
  width: number;
  height: number;
};

const GIFT_CARDS_VIEWPORTS: GiftCardsViewport[] = [
  { label: "phone_390x844", width: 390, height: 844 },
  { label: "tablet_768x1024", width: 768, height: 1024 },
  { label: "ipad_1024x1366", width: 1024, height: 1366 },
  { label: "desktop_1440x900", width: 1440, height: 900 },
];

for (const viewport of GIFT_CARDS_VIEWPORTS) {
  test(`Gift cards responsive list mode ${viewport.label}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await signInToBackOffice(page);

    await page.route("**/api/gift-cards/summary", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          open_cards_count: 2,
          active_liability_balance: "150.00",
          loyalty_cards_count: 1,
          donated_cards_count: 1,
        }),
      });
    });

    await page.route("**/api/gift-cards?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "gc-1",
            code: "RW-1001",
            card_kind: "purchased",
            card_status: "active",
            current_balance: "100.00",
            original_value: "100.00",
            is_liability: true,
            expires_at: "2027-01-01",
            customer_id: "cust-1",
            customer_name: "Alex Rivera",
            notes: "Primary card",
            created_at: "2026-04-26T12:00:00.000Z",
          },
          {
            id: "gc-2",
            code: "RW-1002",
            card_kind: "donated_giveaway",
            card_status: "active",
            current_balance: "50.00",
            original_value: "50.00",
            is_liability: false,
            expires_at: null,
            customer_id: null,
            customer_name: null,
            notes: null,
            created_at: "2026-04-26T12:02:00.000Z",
          },
        ]),
      });
    });

    await page.route("**/api/gift-cards/*/events", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "ev-1",
            event_kind: "issued",
            amount: "100.00",
            balance_after: "100.00",
            transaction_id: null,
            notes: "Issued",
            created_at: "2026-04-26T12:00:00.000Z",
          },
        ]),
      });
    });

    await openBackofficeSidebarTab(page, "gift-cards");
    await expect(page.getByRole("heading", { name: /^gift cards$/i })).toBeVisible({
      timeout: 20_000,
    });

    if (viewport.width <= 1023) {
      await expect(page.getByTestId("gift-cards-card-list")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("gift-cards-table")).toHaveCount(0);
    } else {
      await expect(page.getByTestId("gift-cards-table")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("gift-cards-card-list")).toHaveCount(0);
    }
  });
}
