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
    await page.route("**/api/loyalty/monthly-eligible**", async (route) => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get("limit")).toBe("100");
      expect(url.searchParams.get("offset")).toBe("0");
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
    await expect(page.getByText("1 × $25.00 reward ready")).toBeVisible();
    await expect(page.getByText("5,000 points per reward")).toBeVisible();
    await expect(page.getByRole("button", { name: "Redeem Reward" })).toBeVisible();
  });
}

test("Loyalty supports single and group fulfillment controls", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signInToBackOffice(page);
  let alexBalance = 15_000;
  const redemptionRequests: Array<{
    points_to_redeem: number;
    remainder_card_code: string;
  }> = [];

  await page.route("**/api/loyalty/pipeline-stats", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        total_points_liability: 20000,
        eligible_customers_count: 2,
        lifetime_rewards_issued: 2,
        active_30d_adjustments: 0,
      }),
    });
  });
  await page.route("**/api/loyalty/settings", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        points_per_dollar: 5,
        loyalty_point_threshold: 5000,
        loyalty_reward_amount: "50.00",
        loyalty_letter_template: "Hello {{first_name}}\n{{cards_table}}",
      }),
    });
  });
  await page.route("**/api/loyalty/monthly-eligible**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "cust-1",
          customer_code: "C-1001",
          first_name: "Alex",
          last_name: "Rivera",
          loyalty_points: alexBalance,
          address_line1: "1 Main St",
          city: "Buffalo",
          state: "NY",
          zip: "14202",
        },
        {
          id: "cust-2",
          customer_code: "C-1002",
          first_name: "Jordan",
          last_name: "Lee",
          loyalty_points: 5000,
          address_line1: "2 Main St",
          city: "Buffalo",
          state: "NY",
          zip: "14202",
        },
      ]),
    });
  });
  await page.route("**/api/loyalty/redeem-reward", async (route) => {
    const body = route.request().postDataJSON() as {
      points_to_redeem: number;
      remainder_card_code: string;
    };
    redemptionRequests.push({
      points_to_redeem: body.points_to_redeem,
      remainder_card_code: body.remainder_card_code,
    });
    alexBalance -= body.points_to_redeem;
    const rewardAmount = (body.points_to_redeem / 5_000) * 50;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        new_balance: alexBalance,
        points_deducted: body.points_to_redeem,
        remainder_loaded: rewardAmount.toFixed(2),
        reward_card_code: body.remainder_card_code,
        reward_card_issued_at: "2026-08-12T14:00:00Z",
        reward_card_expires_at: "2027-08-12T14:00:00Z",
        reward_card_kind: "loyalty_reward",
        reward_card_is_liability: false,
      }),
    });
  });
  await page.route("**/api/loyalty/recent-issuances", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "issuance-1",
          customer_id: "cust-1",
          first_name: "Alex",
          last_name: "Rivera",
          card_code: "LOY-1001",
          reward_amount: "50.00",
          points_deducted: 5000,
          created_at: "2026-08-09T14:00:00Z",
          expires_at: "2027-08-09T14:00:00Z",
        },
        {
          id: "issuance-2",
          customer_id: "cust-2",
          first_name: "Jordan",
          last_name: "Lee",
          card_code: "LOY-1002",
          reward_amount: "50.00",
          points_deducted: 5000,
          created_at: "2026-08-09T14:01:00Z",
          expires_at: "2027-08-09T14:01:00Z",
        },
        {
          id: "issuance-3",
          customer_id: "cust-1",
          first_name: "Alex",
          last_name: "Rivera",
          card_code: "LOY-1001B",
          reward_amount: "50.00",
          points_deducted: 5000,
          created_at: "2026-08-09T14:02:00Z",
          expires_at: "2027-08-09T14:02:00Z",
        },
      ]),
    });
  });

  await openBackofficeSidebarTab(page, "loyalty");
  await page.getByRole("checkbox", { name: /select alex rivera for loyalty batch/i }).check();
  await page.getByRole("checkbox", { name: /select jordan lee for loyalty batch/i }).check();
  await page.getByRole("button", { name: "Start Batch (2)" }).click();
  await expect(page.getByRole("dialog", { name: /issue cards, then print letters and labels/i })).toBeVisible();
  await expect(page.getByText("Alex Rivera", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Jordan Lee", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Close loyalty reward batch" }).click();

  await page.getByRole("button", { name: "Redeem Reward" }).first().click();
  await expect(page.getByText("Customer 1 of 1")).toBeVisible();
  const rewardBlocks = page.getByLabel("Reward blocks on this card");
  await rewardBlocks.fill("2");
  await page.getByPlaceholder("Scan card...").fill("LOY-SPLIT-100");
  await expect(page.getByRole("button", { name: "Issue $100.00 card" })).toBeVisible();
  await page.getByRole("button", { name: "Issue $100.00 card" }).click();
  await expect(page.getByText("5,000 pts remaining").first()).toBeVisible();
  await page.getByPlaceholder("Scan card...").fill("LOY-SPLIT-50");
  await page.getByRole("button", { name: "Issue $50.00 card" }).click();
  await expect(page.getByRole("heading", { name: "Batch complete" })).toBeVisible();
  expect(redemptionRequests).toEqual([
    { points_to_redeem: 10_000, remainder_card_code: "LOY-SPLIT-100" },
    { points_to_redeem: 5_000, remainder_card_code: "LOY-SPLIT-50" },
  ]);
  await page.getByRole("button", { name: "Close loyalty reward batch" }).click();

  const expandSidebar = page.getByRole("button", { name: "Expand sidebar" });
  if (await expandSidebar.isVisible()) await expandSidebar.click();
  await page.getByRole("button", { name: "Reward History" }).click();
  const singleLetterPopupPromise = page.waitForEvent("popup");
  await page.getByTitle("Print Award Letter").first().click();
  const singleLetterPopup = await singleLetterPopupPromise;
  await expect(singleLetterPopup.locator("section.letter")).toHaveCount(1);

  await page.getByRole("checkbox", { name: "Select reward card LOY-1001 for printing" }).check();
  await page.getByRole("checkbox", { name: "Select reward card LOY-1001B for printing" }).check();
  await page.getByRole("checkbox", { name: "Select reward card LOY-1002 for printing" }).check();
  const printLetters = page.getByRole("button", { name: "Print Letters (3)" });
  await expect(printLetters).toBeVisible();
  const groupLetterPopupPromise = page.waitForEvent("popup");
  await printLetters.click();
  const groupLetterPopup = await groupLetterPopupPromise;
  await expect(groupLetterPopup.locator("section.letter")).toHaveCount(2);
  await expect(groupLetterPopup.locator("body")).toContainText("LOY-1001");
  await expect(groupLetterPopup.locator("body")).toContainText("LOY-1001B");

  const printLabels = page.getByRole("button", { name: "Print Labels" });
  await expect(printLabels).toBeVisible();
  const groupLabelPopupPromise = page.waitForEvent("popup");
  await printLabels.click();
  const groupLabelPopup = await groupLabelPopupPromise;
  await expect(groupLabelPopup.locator(".label")).toHaveCount(2);
});
