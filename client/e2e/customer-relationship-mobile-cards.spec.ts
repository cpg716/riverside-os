import { expect, test, type Page } from "@playwright/test";
import {
  openBackofficeSidebarTab,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";

type DrawerViewport = {
  label: string;
  width: number;
  height: number;
};

const DRAWER_VIEWPORTS: DrawerViewport[] = [
  { label: "phone_390x844", width: 390, height: 844 },
  { label: "tablet_768x1024", width: 768, height: 1024 },
  { label: "ipad_1024x1366", width: 1024, height: 1366 },
  { label: "desktop_1440x900", width: 1440, height: 900 },
];

const CUSTOMER_ROW = {
  id: "f1f1f1f1-1111-4111-8111-111111111111",
  customer_code: "CUST-HUB-E2E",
  first_name: "Riley",
  last_name: "Harper",
  company_name: null,
  email: "riley@example.com",
  phone: "555-111-2222",
  is_vip: false,
  open_balance_due: "0.00",
  lifetime_sales: "1245.50",
  open_orders_count: 1,
  active_shipment_status: null,
  wedding_soon: false,
  wedding_active: false,
  wedding_party_name: null,
  wedding_party_id: null,
  lifecycle_state: "active",
};

const CUSTOMER_HUB_RESPONSE = {
  id: CUSTOMER_ROW.id,
  customer_code: CUSTOMER_ROW.customer_code,
  first_name: CUSTOMER_ROW.first_name,
  last_name: CUSTOMER_ROW.last_name,
  company_name: CUSTOMER_ROW.company_name,
  email: CUSTOMER_ROW.email,
  phone: CUSTOMER_ROW.phone,
  address_line1: null,
  address_line2: null,
  city: null,
  state: null,
  postal_code: null,
  date_of_birth: null,
  anniversary_date: null,
  custom_field_1: null,
  custom_field_2: null,
  custom_field_3: null,
  custom_field_4: null,
  marketing_email_opt_in: true,
  marketing_sms_opt_in: false,
  transactional_sms_opt_in: true,
  transactional_email_opt_in: true,
  podium_conversation_url: null,
  is_vip: false,
  loyalty_points: 40,
  customer_created_source: "store",
  couple_id: null,
  couple_primary_id: null,
  couple_linked_at: null,
  open_balance_due: "0.00",
  lifetime_sales: "1245.50",
  profile_complete: true,
  weddings: [],
  stats: {
    lifetime_spend_usd: "1245.50",
    balance_due_usd: "0.00",
    wedding_party_count: 0,
    last_activity_at: null,
    days_since_last_visit: 2,
    marketing_needs_attention: false,
    loyalty_points: 40,
    lifecycle_state: "active",
  },
  partner: null,
};

const TXN_HISTORY_RESPONSE = {
  items: [
    {
      transaction_id: "22222222-2222-4222-8222-222222222222",
      transaction_display_id: "TXN-9012",
      booked_at: "2026-04-10T15:30:00.000Z",
      status: "completed",
      sale_channel: "register",
      total_price: "199.99",
      amount_paid: "199.99",
      balance_due: "0.00",
      item_count: 2,
      primary_salesperson_name: "Chris G",
      is_fulfillment_order: false,
      is_counterpoint_import: false,
      counterpoint_customer_code: null,
    },
  ],
  total_count: 1,
};

const MEASUREMENTS_RESPONSE = {
  latest: null,
  history: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      neck: "15.5",
      sleeve: "34",
      chest: "40",
      waist: "34",
      seat: "40",
      inseam: "31",
      outseam: null,
      shoulder: null,
      retail_suit: null,
      retail_waist: null,
      retail_vest: null,
      retail_shirt: null,
      retail_shoe: null,
      measured_at: "2026-04-02T11:00:00.000Z",
      source: "archive",
    },
  ],
};

async function mockCustomersDrawerApis(page: Page): Promise<void> {
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
        total_customers: 1,
        vip_customers: 0,
        with_balance: 0,
        upcoming_weddings: 0,
      }),
    });
  });

  await page.route("**/api/customers/duplicate-candidates*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route("**/api/customers/browse*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([CUSTOMER_ROW]),
    });
  });

  await page.route(`**/api/customers/${CUSTOMER_ROW.id}/hub`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(CUSTOMER_HUB_RESPONSE),
    });
  });

  await page.route(`**/api/customers/${CUSTOMER_ROW.id}/timeline`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route(`**/api/customers/${CUSTOMER_ROW.id}/store-credit`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ balance: "0.00" }),
    });
  });

  await page.route(`**/api/customers/${CUSTOMER_ROW.id}/open-deposit`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ balance: "0.00" }),
    });
  });

  await page.route(`**/api/customers/${CUSTOMER_ROW.id}/transaction-history*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(TXN_HISTORY_RESPONSE),
    });
  });

  await page.route(`**/api/customers/${CUSTOMER_ROW.id}/measurements*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MEASUREMENTS_RESPONSE),
    });
  });
}

for (const viewport of DRAWER_VIEWPORTS) {
  test(`Customer relationship drawer responsive cards ${viewport.label}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });

    await mockCustomersDrawerApis(page);
    await signInToBackOffice(page);
    await openBackofficeSidebarTab(page, "customers");

    await expect(page.getByRole("button", { name: /riley harper/i }).first()).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: /riley harper/i }).first().click();

    const dialog = page.getByRole("dialog", { name: /riley harper/i });
    await expect(dialog).toBeVisible({ timeout: 20_000 });

    await dialog.getByRole("button", { name: /^transactions$/i }).click();
    await expect(dialog.getByRole("button", { name: /open transaction/i })).toBeVisible({
      timeout: 20_000,
    });

    if (viewport.width <= 1023) {
      await expect(dialog.getByText(/channel:/i)).toBeVisible({ timeout: 10_000 });
      await expect(dialog.getByRole("table")).toHaveCount(0);
    } else {
      await expect(dialog.getByRole("table")).toBeVisible({ timeout: 10_000 });
    }

    await dialog.getByRole("button", { name: /^measurements$/i }).click();
    await expect(dialog.getByRole("heading", { name: /^archive$/i })).toBeVisible({
      timeout: 20_000,
    });

    if (viewport.width <= 1023) {
      await expect(dialog.getByText(/neck:/i)).toBeVisible({ timeout: 10_000 });
    } else {
      await expect(dialog.getByRole("table")).toBeVisible({ timeout: 10_000 });
    }
  });
}
