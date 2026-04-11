import { expect, test } from "@playwright/test";

import { signInToBackOffice } from "./helpers/backofficeSignIn";

test.describe("Reports workspace", () => {
  test("shows curated library for signed-in staff with insights.view", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await signInToBackOffice(page);

    await page.getByTestId("sidebar-nav-reports").click({ force: true });

    await expect(
      page.getByTestId("reports-catalog-card-sales_pivot"),
    ).toBeVisible({
      timeout: 20_000,
    });
  });

  test("seeded admin sees margin pivot tile", async ({ page }) => {
    test.setTimeout(60_000);
    await signInToBackOffice(page);

    await page.getByTestId("sidebar-nav-reports").click({ force: true });

    await expect(
      page.getByTestId("reports-catalog-card-margin_pivot"),
    ).toBeVisible({
      timeout: 15_000,
    });

    const marginPivotResp = page.waitForResponse(
      (r) =>
        r.url().includes("/api/insights/margin-pivot") &&
        r.request().method() === "GET",
      { timeout: 30_000 },
    );
    await page.getByTestId("reports-catalog-card-margin_pivot").click();
    const r = await marginPivotResp;
    if (r.status() === 200) {
      await expect(
        page
          .getByTestId("reports-detail-table")
          .or(page.getByText(/No rows in this window/i)),
      ).toBeVisible({ timeout: 15_000 });
    } else {
      await expect(page.getByTestId("reports-detail-error")).toBeVisible();
    }
  });
});
