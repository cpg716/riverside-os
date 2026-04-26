import { expect, test } from "@playwright/test";
import { openBackofficeSidebarTab, signInToBackOffice } from "./helpers/backofficeSignIn";

type ReportsViewport = {
  label: string;
  width: number;
  height: number;
};

const REPORTS_VIEWPORTS: ReportsViewport[] = [
  { label: "phone_390x844", width: 390, height: 844 },
  { label: "tablet_768x1024", width: 768, height: 1024 },
  { label: "ipad_1024x1366", width: 1024, height: 1366 },
  { label: "desktop_1440x900", width: 1440, height: 900 },
];

for (const viewport of REPORTS_VIEWPORTS) {
  test(`Reports responsive cards ${viewport.label}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await signInToBackOffice(page);

    await page.route("**/api/insights/margin-pivot**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          rows: [
            { brand: "Peak", gross_sales: "1200.00", margin_percent: "57.2" },
            { brand: "Harbor", gross_sales: "820.00", margin_percent: "49.1" },
          ],
          truncated: false,
        }),
      });
    });

    await page.route("**/api/insights/nys-tax-audit**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          taxable_sales: "2410.55",
          exempt_sales: "410.00",
          tax_collected: "192.04",
        }),
      });
    });

    await openBackofficeSidebarTab(page, "reports");
    await page.getByTestId("reports-catalog-card-margin_pivot").click();
    await expect(page.getByText(/download csv/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("reports-detail-filters")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel(/^from$/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel(/^to$/i)).toBeVisible({ timeout: 15_000 });

    if (viewport.width <= 1023) {
      if (viewport.width <= 639) {
      const refreshWidth = await page
        .getByRole("button", { name: /^refresh$/i })
        .first()
        .evaluate((el) => el.getBoundingClientRect().width);
      expect(refreshWidth).toBeGreaterThanOrEqual(Math.min(220, viewport.width * 0.55));
      }
      await expect(page.getByTestId("reports-detail-cards")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("reports-detail-table")).toHaveCount(0);
    } else {
      await expect(page.getByTestId("reports-detail-table")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("reports-detail-cards")).toHaveCount(0);
    }

    await page.getByRole("button", { name: /^library$/i }).click();
    await page.getByTestId("reports-catalog-card-nys_tax_audit").click();

    if (viewport.width <= 1023) {
      await expect(page.getByTestId("reports-detail-row-object-cards")).toBeVisible({
        timeout: 15_000,
      });
    } else {
      await expect(page.getByTestId("reports-detail-row-object-table")).toBeVisible({
        timeout: 15_000,
      });
    }
  });
}
