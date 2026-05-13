import { expect, test } from "@playwright/test";
import { openBackofficeSidebarTab, signInToBackOffice } from "./helpers/backofficeSignIn";

async function openCatalogImporter(page: Parameters<typeof test>[0]["page"]) {
  await openBackofficeSidebarTab(page, "inventory");
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }).getByText(/^inventory$/i),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /^add\/edit catalog$/i }).first().click();
  await page.getByRole("button", { name: /^catalog import$/i }).click();
  await expect(page.getByRole("heading", { name: /catalog csv mapper/i })).toBeVisible({
    timeout: 20_000,
  });
}

test.describe("Inventory import operational confidence", () => {
  test("catalog import explains outcome, skipped rows, and stock safety", async ({ page }) => {
    test.setTimeout(60_000);
    await page.route("**/api/categories", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "cat-import-confidence", name: "Formalwear" }]),
      });
    });
    await page.route("**/api/products/import", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          products_created: 1,
          products_updated: 2,
          variants_synced: 3,
          rows_skipped: 1,
        }),
      });
    });

    await signInToBackOffice(page);
    await openCatalogImporter(page);

    await page.getByRole("button", { name: /catalog csv/i }).first().click();
    await page.locator('input[type="file"]').setInputFiles({
      name: "catalog-confidence.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        [
          "Product ID,SKU,Name,Retail,Cost,Brand",
          "STYLE-1,SKU-1,Tux Jacket,199.99,80.00,Riverside",
        ].join("\n"),
      ),
    });

    const selects = page.locator("select");
    await selects.nth(0).selectOption("Product ID");
    await selects.nth(1).selectOption("SKU");
    await selects.nth(2).selectOption("Name");
    await selects.nth(3).selectOption("Retail");
    await selects.nth(4).selectOption("Cost");
    await selects.nth(5).selectOption("Brand");
    await selects.nth(10).selectOption("cat-import-confidence");

    await page.getByRole("button", { name: /review import/i }).click();
    await expect(page.getByText(/what happens next/i)).toBeVisible();
    await expect(page.getByText(/retrying is safe/i)).toBeVisible();
    await expect(page.getByText(/this import never changes live on-hand counts/i)).toBeVisible();

    await page.getByRole("button", { name: /import catalog changes/i }).click();

    await expect(page.getByText(/catalog import finished/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByText(/1 product created · 2 products updated · 3 variants matched or updated · 1 row skipped/i),
    ).toBeVisible();
    await expect(page.getByText(/live on-hand counts were not changed/i)).toBeVisible();
  });
});
