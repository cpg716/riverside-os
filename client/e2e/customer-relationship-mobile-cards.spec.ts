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
  profile_discount_percent: "12.50",
  tax_exempt: true,
  tax_exempt_id: "NY-EXEMPT-123",
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

const LINKED_COUPLE_ID = "99999999-9999-4999-8999-999999999999";

const PARTNER_ROW = {
  ...CUSTOMER_ROW,
  id: "f2f2f2f2-2222-4222-8222-222222222222",
  customer_code: "CUST-LINKED-E2E",
  first_name: "Jordan",
  last_name: "Harper",
  email: "jordan@example.com",
  phone: "555-333-4444",
};

const CUSTOMER_HUB_RESPONSE = {
  id: CUSTOMER_ROW.id,
  customer_code: CUSTOMER_ROW.customer_code,
  first_name: CUSTOMER_ROW.first_name,
  last_name: CUSTOMER_ROW.last_name,
  company_name: CUSTOMER_ROW.company_name,
  email: CUSTOMER_ROW.email,
  phone: CUSTOMER_ROW.phone,
  profile_discount_percent: CUSTOMER_ROW.profile_discount_percent,
  tax_exempt: CUSTOMER_ROW.tax_exempt,
  tax_exempt_id: CUSTOMER_ROW.tax_exempt_id,
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

function linkedHubResponse(
  customer: typeof CUSTOMER_ROW,
  partner: typeof CUSTOMER_ROW,
) {
  return {
    ...CUSTOMER_HUB_RESPONSE,
    ...customer,
    couple_id: LINKED_COUPLE_ID,
    couple_primary_id: CUSTOMER_ROW.id,
    couple_linked_at: "2026-04-12T12:00:00.000Z",
    partner: {
      id: partner.id,
      customer_code: partner.customer_code,
      first_name: partner.first_name,
      last_name: partner.last_name,
      email: partner.email,
      phone: partner.phone,
      couple_id: LINKED_COUPLE_ID,
      couple_primary_id: CUSTOMER_ROW.id,
    },
  };
}

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
      body: JSON.stringify({
        events: [
          {
            at: "2026-04-10T15:30:00.000Z",
            kind: "sale",
            summary: "Purchased 2 items",
            reference_id: "22222222-2222-4222-8222-222222222222",
            reference_type: "transaction",
            wedding_party_id: null,
          },
        ],
      }),
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

  await page.route("**/api/loyalty/ledger?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        entries: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            reason: "sale",
            delta_points: 40,
            balance_after: 40,
            transaction_id: "22222222-2222-4222-8222-222222222222",
            transaction_display_id: "TXN-9012",
            created_at: "2026-04-10T15:30:00.000Z",
            activity_label: "Purchase",
            activity_detail: "Earned points from purchase",
          },
        ],
      }),
    });
  });

  await page.route("**/api/loyalty/recent-issuances*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "55555555-5555-4555-8555-555555555555",
          customer_id: CUSTOMER_ROW.id,
          card_id: "66666666-6666-4666-8666-666666666666",
          card_code: "LOYALTY-E2E",
          first_name: CUSTOMER_ROW.first_name,
          last_name: CUSTOMER_ROW.last_name,
          reward_amount: "20.00",
          points_deducted: 200,
          applied_to_sale: "0.00",
          created_at: "2026-04-11T10:00:00.000Z",
        },
      ]),
    });
  });

  await page.route("**/api/gift-cards/code/LOYALTY-E2E/events", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "77777777-7777-4777-8777-777777777777",
          event_kind: "redeemed",
          amount: "5.00",
          balance_after: "15.00",
          transaction_id: "22222222-2222-4222-8222-222222222222",
          notes: "Used at register",
          created_at: "2026-04-12T12:00:00.000Z",
        },
      ]),
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

    await dialog.getByRole("button", { name: /^History$/i }).click();
    await expect(dialog.getByRole("button", { name: /open transaction/i })).toBeVisible({
      timeout: 20_000,
    });

    if (viewport.width <= 1279) {
      await expect(dialog.getByText(/channel:/i)).toBeVisible({ timeout: 10_000 });
      await expect(dialog.getByRole("table")).toHaveCount(0);
    } else {
      await expect(dialog.getByRole("table")).toBeVisible({ timeout: 10_000 });
    }

    await dialog.getByRole("button", { name: /^measurements$/i }).click();
    await expect(dialog.getByRole("heading", { name: /^archive$/i })).toBeVisible({
      timeout: 20_000,
    });

    if (viewport.width <= 1279) {
      await expect(dialog.getByText(/neck:/i)).toBeVisible({ timeout: 10_000 });
    } else {
      await expect(dialog.getByRole("table")).toBeVisible({ timeout: 10_000 });
    }
  });
}

test("Customer relationship drawer exposes profile defaults, history, and loyalty controls", async ({
  page,
}) => {
  test.setTimeout(120_000);
  let profilePatch: Record<string, unknown> | null = null;

  await page.setViewportSize({ width: 1440, height: 900 });
  await mockCustomersDrawerApis(page);
  await page.route(`**/api/customers/${CUSTOMER_ROW.id}`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    profilePatch = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...CUSTOMER_HUB_RESPONSE,
        ...profilePatch,
      }),
    });
  });

  await signInToBackOffice(page);
  await openBackofficeSidebarTab(page, "customers");
  await page.getByRole("button", { name: /riley harper/i }).first().click();

  const dialog = page.getByRole("dialog", { name: /riley harper/i });
  await expect(dialog).toBeVisible({ timeout: 20_000 });

  for (const label of [
    "Profile",
    "History",
    "Orders",
    "Layaways",
    "Alterations",
    "Loyalty",
    "Measurements",
    "Weddings",
  ]) {
    await expect(dialog.getByRole("button", { name: new RegExp(`^${label}$`, "i") })).toBeVisible();
  }
  await expect(dialog.getByRole("button", { name: /transaction records/i })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /wedding links/i })).toHaveCount(0);
  await expect(dialog.getByText(/lifecycle/i)).toHaveCount(0);

  await expect(dialog.getByText(/register defaults/i)).toBeVisible();
  await expect(dialog.getByLabel(/automatic discount/i)).toHaveValue("12.50");
  await expect(dialog.getByLabel(/^tax id$/i)).toHaveValue("NY-EXEMPT-123");

  await dialog.getByLabel(/automatic discount/i).fill("15");
  await dialog.getByLabel(/^tax id$/i).fill("NY-EXEMPT-999");
  await dialog.getByRole("button", { name: /save profile/i }).click();

  await expect.poll(() => profilePatch?.profile_discount_percent).toBe("15.00");
  expect(profilePatch).toMatchObject({
    tax_exempt: true,
    tax_exempt_id: "NY-EXEMPT-999",
  });

  await dialog.getByRole("button", { name: /^History$/i }).click();
    await expect(dialog.getByText(/customer notes, visits, and past purchases/i)).toBeVisible();
  await expect(dialog.getByText(/Purchased 2 items/i)).toBeVisible();
  await expect(dialog.getByText(/TXN-9012/i)).toBeVisible();

  await dialog.getByRole("button", { name: /^Loyalty$/i }).click();
  await expect(dialog.getByText(/historical earned/i)).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText(/LOYALTY-E2E/i)).toBeVisible();
  await expect(dialog.getByText(/Card used/i)).toBeVisible();
});

test("Customer relationship drawer opens linked profiles and keeps timeline language staff-facing", async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.setViewportSize({ width: 1440, height: 900 });
  await mockCustomersDrawerApis(page);

  await page.route("**/api/customers/browse*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          ...CUSTOMER_ROW,
          couple_id: LINKED_COUPLE_ID,
          couple_primary_id: CUSTOMER_ROW.id,
        },
      ]),
    });
  });

  const parentHub = linkedHubResponse(CUSTOMER_ROW, PARTNER_ROW);
  const partnerHub = linkedHubResponse(PARTNER_ROW, CUSTOMER_ROW);

  await page.route(`**/api/customers/${CUSTOMER_ROW.id}/hub`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(parentHub),
    });
  });

  await page.route(`**/api/customers/${PARTNER_ROW.id}/hub`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(partnerHub),
    });
  });

  for (const customer of [CUSTOMER_ROW, PARTNER_ROW]) {
    await page.route(`**/api/customers/${customer.id}/timeline`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          events: [
            {
              at: "2026-04-12T12:00:00.000Z",
              kind: "note",
              summary:
                customer.id === CUSTOMER_ROW.id
                  ? "Linked profile with Jordan Harper (CUST-LINKED-E2E)"
                  : "Linked profile with Riley Harper (CUST-HUB-E2E)",
              reference_id: null,
              reference_type: "note",
              wedding_party_id: null,
            },
            {
              at: "2026-04-10T15:30:00.000Z",
              kind: "sale",
              summary: "Purchased 2 items (TXN-9012)",
              reference_id: "22222222-2222-4222-8222-222222222222",
              reference_type: "transaction",
              wedding_party_id: null,
            },
          ],
        }),
      });
    });
    await page.route(`**/api/customers/${customer.id}/store-credit`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ balance: "0.00", ledger: [] }),
      });
    });
    await page.route(`**/api/customers/${customer.id}/open-deposit`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ balance: "0.00" }),
      });
    });
    await page.route(`**/api/customers/${customer.id}/transaction-history*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(TXN_HISTORY_RESPONSE),
      });
    });
    await page.route(`**/api/customers/${customer.id}/measurements*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ latest: null, history: [] }),
      });
    });
  }

  await signInToBackOffice(page);
  await openBackofficeSidebarTab(page, "customers");

  await expect(page.locator("tbody").getByText(/^Linked$/i).first()).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: /riley harper/i }).first().click();

  let dialog = page.getByRole("dialog", { name: /riley harper/i });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(
    dialog.getByText(/Parent profile\. Parent profile keeps loyalty points/i),
  ).toBeVisible();
  await dialog.getByRole("button", { name: /open jordan harper/i }).click();

  dialog = page.getByRole("dialog", { name: /jordan harper/i });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText(/linked with CUST-HUB-E2E/i)).toBeVisible();

  await dialog.getByRole("button", { name: /^History$/i }).click();
  await expect(dialog.getByText(/Linked profile with Riley Harper/i)).toBeVisible();
  await expect(dialog.getByText(/Purchased 2 items \(TXN-9012\)/i)).toBeVisible();
  await expect(dialog.getByText(/Order 22222222/i)).toHaveCount(0);
});
