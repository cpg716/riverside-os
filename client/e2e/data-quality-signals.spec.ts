import { expect, test, type Page, type Locator } from "@playwright/test";

import {
  openBackofficeSidebarTab,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";

async function openWorkspace(
  page: Page,
  tab: "customers" | "inventory",
  readyTarget: Locator,
) {
  await openBackofficeSidebarTab(page, tab);
  await expect(readyTarget).toBeVisible({
    timeout: 30_000,
  });
}

test("workspace quality summaries expose lightweight completeness signals", async ({
  page,
}) => {
  await page.route("**/api/categories", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { id: "cat-suits", name: "Suits", is_clothing_footwear: true },
      ]),
    });
  });

  await page.route("**/api/vendors", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: "vendor-1", name: "Formal House" }]),
    });
  });

  await page.route("**/api/inventory/control-board*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        rows: [
          {
            variant_id: "variant-1",
            product_id: "product-1",
            sku: "SKU-QUALITY-1",
            product_name: "Classic Navy Suit",
            brand: null,
            variation_label: "40R",
            category_id: "cat-suits",
            category_name: "Suits",
            is_clothing_footwear: true,
            stock_on_hand: 3,
            available_stock: 2,
            retail_price: "299.99",
            cost_price: "140.00",
            base_retail_price: "299.99",
            base_cost: "140.00",
            shelf_labeled_at: null,
            primary_vendor_id: null,
            primary_vendor_name: null,
            web_published: false,
            web_price_override: null,
          },
        ],
        stats: {
          total_asset_value: "420.00",
          skus_out_of_stock: 0,
          active_vendors: 1,
          need_label_skus: 1,
        },
      }),
    });
  });

  await page.route("**/api/customers/groups", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route("**/api/customers/pipeline-stats", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        total_customers: 2,
        vip_customers: 0,
        with_balance: 0,
        upcoming_weddings: 0,
      }),
    });
  });

  await page.route("**/api/customers/browse*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "customer-1",
          customer_code: "CUST-INCOMPLETE",
          first_name: "Casey",
          last_name: "Contactless",
          company_name: null,
          email: null,
          phone: "555-0110",
          is_vip: false,
          open_balance_due: "0.00",
          lifetime_sales: "50.00",
          open_orders_count: 0,
          active_shipment_status: null,
          wedding_soon: false,
          wedding_active: false,
          wedding_party_name: null,
          wedding_party_id: null,
          lifecycle_state: "new",
        },
        {
          id: "customer-2",
          customer_code: "CUST-COMPLETE",
          first_name: "Avery",
          last_name: "Active",
          company_name: null,
          email: "avery@example.com",
          phone: "555-0111",
          is_vip: false,
          open_balance_due: "0.00",
          lifetime_sales: "400.00",
          open_orders_count: 1,
          active_shipment_status: null,
          wedding_soon: false,
          wedding_active: false,
          wedding_party_name: null,
          wedding_party_id: null,
          lifecycle_state: "pending",
        },
      ]),
    });
  });

  await signInToBackOffice(page);

  await openWorkspace(
    page,
    "inventory",
    page.getByText("Item Readiness"),
  );
  await expect(page.getByText("Item Readiness")).toBeVisible();
  await expect(page.getByText("Optional brand blank")).toBeVisible();
  await expect(page.getByText("Vendor missing")).toBeVisible();

  await openWorkspace(
    page,
    "customers",
    page.getByText("Customer Completeness"),
  );
  await expect(page.getByText("Customer Completeness")).toBeVisible();
  await expect(page.getByText("Profiles incomplete")).toBeVisible();
  await expect(page.getByText("Profile incomplete")).toBeVisible();

});
