import { expect, test, type Page } from "@playwright/test";

import { signInToBackOffice } from "./helpers/backofficeSignIn";

const pendingCustomer = {
  id: "11111111-1111-4111-8111-111111111111",
  customer_code: "CUST-PENDING",
  first_name: "Paige",
  last_name: "Pending",
  company_name: null,
  email: "paige@example.com",
  phone: "555-0101",
  is_vip: false,
  open_balance_due: "0.00",
  lifetime_sales: "1250.00",
  open_orders_count: 1,
  active_shipment_status: null,
  wedding_soon: false,
  wedding_active: false,
  wedding_party_name: null,
  wedding_party_id: null,
  lifecycle_state: "pending",
};

const issueCustomer = {
  id: "22222222-2222-4222-8222-222222222222",
  customer_code: "CUST-ISSUE",
  first_name: "Iris",
  last_name: "Issue",
  company_name: null,
  email: "iris@example.com",
  phone: "555-0102",
  is_vip: true,
  open_balance_due: "25.00",
  lifetime_sales: "840.00",
  open_orders_count: 0,
  active_shipment_status: "exception",
  wedding_soon: false,
  wedding_active: false,
  wedding_party_name: null,
  wedding_party_id: null,
  lifecycle_state: "issue",
};

const issueHubResponse = {
  id: issueCustomer.id,
  customer_code: issueCustomer.customer_code,
  first_name: issueCustomer.first_name,
  last_name: issueCustomer.last_name,
  company_name: issueCustomer.company_name,
  email: issueCustomer.email,
  phone: issueCustomer.phone,
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
  is_vip: true,
  loyalty_points: 120,
  customer_created_source: "store",
  couple_id: null,
  couple_primary_id: null,
  couple_linked_at: null,
  open_balance_due: "25.00",
  lifetime_sales: "840.00",
  profile_complete: true,
  weddings: [],
  stats: {
    lifetime_spend_usd: "840.00",
    balance_due_usd: "25.00",
    wedding_party_count: 0,
    last_activity_at: null,
    days_since_last_visit: null,
    marketing_needs_attention: false,
    loyalty_points: 120,
    lifecycle_state: "issue",
  },
  partner: null,
};

async function openCustomersWorkspace(page: Page) {
  const customersButton = page
    .getByRole("navigation", { name: "Main Navigation" })
    .getByRole("button", { name: /customers/i });
  await expect(customersButton).toBeVisible({ timeout: 15_000 });
  await customersButton.click();
  await expect(
    page.getByText("Customer Completeness"),
  ).toBeVisible({ timeout: 25_000 });
}

test("customer lifecycle filter and hub badge use the same explicit state", async ({
  page,
}) => {
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
        vip_customers: 1,
        with_balance: 1,
        upcoming_weddings: 0,
      }),
    });
  });

  await page.route("**/api/customers/browse*", async (route) => {
    const url = new URL(route.request().url());
    const lifecycle = url.searchParams.get("lifecycle");
    const body =
      lifecycle === "issue" ? [issueCustomer] : [pendingCustomer, issueCustomer];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.route(`**/api/customers/${issueCustomer.id}/hub`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(issueHubResponse),
    });
  });

  await page.route(`**/api/customers/${issueCustomer.id}/timeline`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ events: [] }),
    });
  });

  await page.route(`**/api/customers/${issueCustomer.id}/store-credit`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ balance: "0.00" }),
    });
  });

  await page.route(`**/api/customers/${issueCustomer.id}/open-deposit`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ balance: "0.00" }),
    });
  });

  await signInToBackOffice(page);
  await openCustomersWorkspace(page);

  await expect(
    page.getByRole("button", {
      name: new RegExp(`${pendingCustomer.first_name}.*Pending`, "i"),
    }),
  ).toBeVisible();
  await page.getByLabel(/lifecycle/i).selectOption("issue");

  await expect(
    page.getByRole("button", {
      name: new RegExp(`${issueCustomer.first_name}.*Issue`, "i"),
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: new RegExp(pendingCustomer.first_name, "i"),
    }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: new RegExp(issueCustomer.first_name, "i") }).click();

  await expect(page.getByText(/lifecycle: issue/i)).toBeVisible();
  await expect(page.getByText(/customer work needs attention/i)).toBeVisible();
});
