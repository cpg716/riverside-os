import { expect, test } from "@playwright/test";

import { signInToBackOffice } from "./helpers/backofficeSignIn";
import { adminHeaders, apiBase } from "./helpers/inventoryReceiving";

test.describe("Reports workspace", () => {
  test("shows curated library for signed-in staff with insights.view", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await signInToBackOffice(page);

    const reportsNav = page.getByTestId("sidebar-nav-reports");
    await expect(reportsNav).toBeVisible({ timeout: 15_000 });
    await expect(reportsNav).toBeEnabled();
    await reportsNav.click();

    await expect(
      page.getByTestId("reports-catalog-card-sales_pivot"),
    ).toBeVisible({
      timeout: 20_000,
    });
  });

  test("seeded admin sees margin pivot tile", async ({ page }) => {
    test.setTimeout(60_000);
    await signInToBackOffice(page);

    const reportsNav = page.getByTestId("sidebar-nav-reports");
    await expect(reportsNav).toBeVisible({ timeout: 15_000 });
    await expect(reportsNav).toBeEnabled();
    await reportsNav.click();

    await expect(
      page.getByTestId("reports-catalog-card-margin_pivot"),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByTestId("reports-catalog-card-wedding_program_profit"),
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

  test("best sellers supports product and variation report views", async ({ request }) => {
    const headers = adminHeaders();
    for (const view of ["product", "variation"]) {
      const response = await request.get(
        `${apiBase()}/api/insights/best-sellers?view=${view}&basis=booked&from=2026-01-01&to=2026-12-31&limit=5`,
        { headers, failOnStatusCode: false },
      );
      expect(response.status()).toBe(200);
      const body = (await response.json()) as {
        view?: string;
        rows?: Array<Record<string, unknown>>;
      };
      expect(body.view).toBe(view);
      expect(Array.isArray(body.rows)).toBeTruthy();
      if (view === "product" && (body.rows?.length ?? 0) > 0) {
        expect(body.rows?.[0]).toHaveProperty("variation_count");
        expect(body.rows?.[0]).toHaveProperty("top_sku");
      }
    }
  });

  test("negative transaction items report returns transaction-driven stock research rows", async ({ request }) => {
    const response = await request.get(
      `${apiBase()}/api/insights/negative-transaction-items?from=2026-01-01&to=2026-12-31`,
      { headers: adminHeaders(), failOnStatusCode: false },
    );
    expect(response.status()).toBe(200);
    const body = (await response.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBeTruthy();
    if (body.length > 0) {
      expect(body[0]).toHaveProperty("sku");
      expect(body[0]).toHaveProperty("product_name");
      expect(body[0]).toHaveProperty("quantity_sold");
      expect(body[0]).toHaveProperty("stock_after_transaction");
      expect(body[0]).toHaveProperty("transaction_id");
    }
  });

  test("wedding program profit exposes party-level margin fields", async ({ request }) => {
    const response = await request.get(
      `${apiBase()}/api/insights/wedding-program-profit?basis=booked&from=2026-01-01&to=2026-12-31`,
      { headers: adminHeaders(), failOnStatusCode: false },
    );
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      rows?: Array<Record<string, unknown>>;
    };
    expect(Array.isArray(body.rows)).toBeTruthy();
    const total = body.rows?.find((row) => row.wedding_party_name === "Period Total");
    expect(total).toBeTruthy();
    expect(total).toHaveProperty("paid_suits");
    expect(total).toHaveProperty("free_suits");
    expect(total).toHaveProperty("promo_discount");
    expect(total).toHaveProperty("cost_of_goods");
    expect(total).toHaveProperty("gross_profit");
    expect(total).toHaveProperty("profit_percent");
  });
});
