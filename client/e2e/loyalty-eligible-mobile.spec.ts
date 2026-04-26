import { expect, test } from "@playwright/test";
import { openBackofficeSidebarTab, signInToBackOffice } from "./helpers/backofficeSignIn";

type LoyaltyViewport = {
  label: string;
  width: number;
  height: number;
};

const LOYALTY_VIEWPORTS: LoyaltyViewport[] = [
  { label: "phone_390x844", width: 390, height: 844 },
  { label: "tablet_768x1024", width: 768, height: 1024 },
  { label: "ipad_1024x1366", width: 1024, height: 1366 },
  { label: "desktop_1440x900", width: 1440, height: 900 },
];

for (const viewport of LOYALTY_VIEWPORTS) {
  test(`Loyalty eligible mobile actions ${viewport.label}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await signInToBackOffice(page);

    await page.route("**/api/loyalty/pipeline-stats", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          total_points_liability: 12345,
          eligible_customers_count: 1,
          lifetime_rewards_issued: 42,
          active_30d_adjustments: 3,
        }),
      });
    });
    await page.route("**/api/loyalty/settings", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          points_per_dollar: 1,
          loyalty_point_threshold: 5000,
          loyalty_reward_amount: "25.00",
          loyalty_letter_template: "Hello {{first_name}}",
        }),
      });
    });
    await page.route("**/api/loyalty/monthly-eligible", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "cust-1",
            first_name: "Alex",
            last_name: "Rivera",
            loyalty_points: 6200,
            customer_code: "C-1001",
            email: "alex@example.com",
            city: "Buffalo",
            state: "NY",
          },
        ]),
      });
    });

    await openBackofficeSidebarTab(page, "loyalty");
    await expect(
      page.getByRole("heading", { name: /^customers ready for reward$/i }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("loyalty-eligible-row").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("loyalty-eligible-actions").first()).toBeVisible({
      timeout: 15_000,
    });
  });
}
