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

async function mockCustomerWorkspaceBasics(page: Page) {
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
        total_customers: 0,
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
      body: JSON.stringify([]),
    });
  });

  await page.route("**/api/customers/duplicate-candidates*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });
}

async function openAddCustomerDrawer(page: Page) {
  await signInToBackOffice(page);
  await openCustomersWorkspace(page);
  await page.getByRole("button", { name: /add customer/i }).last().click();
  const drawer = page.getByRole("dialog", { name: /add customer/i });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function fillRequiredCustomerFields(page: Page) {
  const unique = Date.now().toString().slice(-6);
  await page.getByLabel(/first name/i).fill(`Address${unique}`);
  await page.getByLabel(/last name/i).fill("Autocomplete");
  await page.getByPlaceholder("(555) 000-0000").first().fill("(555) 111-2222");
  await page.getByRole("textbox", { name: /^email$/i }).fill(`address-${unique}@example.com`);
}

test("add customer accepts manual address entry without suggestions", async ({
  page,
}) => {
  await mockCustomerWorkspaceBasics(page);
  await page.route("**/api/customers/address-suggestions*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  let payload: Record<string, unknown> | null = null;
  await page.route("**/api/customers", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    payload = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "33333333-3333-4333-8333-333333333333",
        customer_code: "CUST-ADDR-MANUAL",
      }),
    });
  });

  await openAddCustomerDrawer(page);
  await fillRequiredCustomerFields(page);
  await page.getByLabel(/address line 1/i).fill("12 Manual Way");
  await page.getByLabel(/^city$/i).fill("Buffalo");
  await page.getByLabel(/^state$/i).fill("NY");
  await page.getByLabel(/postal code/i).fill("14202");
  await page.getByRole("button", { name: /create customer/i }).click();

  await expect
    .poll(() => payload?.address_line1)
    .toBe("12 Manual Way");
  expect(payload).toMatchObject({
    city: "Buffalo",
    state: "NY",
    postal_code: "14202",
  });
});

test("add customer address suggestion fills city state and ZIP", async ({
  page,
}) => {
  await mockCustomerWorkspaceBasics(page);
  await page.route("**/api/customers/address-suggestions*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "suggestion-1",
          label: "4600 Broadway, Buffalo, NY 14225",
          address_line1: "4600 Broadway",
          city: "Buffalo",
          state: "NEW YORK",
          postal_code: "14225",
        },
      ]),
    });
  });

  await openAddCustomerDrawer(page);
  await fillRequiredCustomerFields(page);
  await page.getByLabel(/address line 1/i).fill("4600 Broadway");
  await expect(page.getByText(/searching addresses near 14043/i)).toBeVisible();
  await page
    .getByRole("button", { name: /4600 broadway/i })
    .click();

  await expect(page.getByLabel(/address line 1/i)).toHaveValue(
    "4600 Broadway",
  );
  await expect(page.getByLabel(/^city$/i)).toHaveValue("Buffalo");
  await expect(page.getByLabel(/^state$/i)).toHaveValue("NY");
  await expect(page.getByLabel(/zip/i)).toHaveValue("14225");
});

test("failed address lookup keeps add customer form usable", async ({
  page,
}) => {
  await mockCustomerWorkspaceBasics(page);
  await page.route("**/api/customers/address-suggestions*", async (route) => {
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "lookup unavailable" }),
    });
  });

  let payload: Record<string, unknown> | null = null;
  await page.route("**/api/customers", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    payload = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "44444444-4444-4444-8444-444444444444",
        customer_code: "CUST-ADDR-FAIL",
      }),
    });
  });

  await openAddCustomerDrawer(page);
  await fillRequiredCustomerFields(page);
  await page.getByLabel(/address line 1/i).fill("99 Offline Lookup Ln");
  await expect(page.getByText(/manual entry is okay/i)).toBeVisible();
  await page.getByLabel(/^city$/i).fill("Buffalo");
  await page.getByLabel(/^state$/i).fill("NY");
  await page.getByLabel(/postal code/i).fill("14203");
  await page.getByRole("button", { name: /create customer/i }).click();

  await expect
    .poll(() => payload?.address_line1)
    .toBe("99 Offline Lookup Ln");
  expect(payload).toMatchObject({
    city: "Buffalo",
    state: "NY",
    postal_code: "14203",
  });
});

test("add customer waits for phone before showing same-name duplicate review", async ({
  page,
}) => {
  await mockCustomerWorkspaceBasics(page);
  await page.unroute("**/api/customers/duplicate-candidates*");
  await page.route("**/api/customers/duplicate-candidates*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "55555555-5555-4555-8555-555555555555",
          customer_code: "CUST-REVIEW",
          first_name: "Morgan",
          last_name: "Taylor",
          email: "old-morgan@example.com",
          phone: "(716) 555-0199",
          address_line1: "77 Review Rd",
          address_line2: null,
          city: "Buffalo",
          state: "NY",
          postal_code: "14202",
          match_reason: "same_name",
        },
      ]),
    });
  });

  await openAddCustomerDrawer(page);
  await page.getByLabel(/first name/i).fill("Morgan");
  await page.getByLabel(/last name/i).fill("Taylor");

  await expect(
    page.getByText(/enter a phone number first/i),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("77 Review Rd")).toBeHidden();

  await page.getByPlaceholder("(555) 000-0000").first().fill("(716) 555-0100");

  await expect(page.getByText("CUST-REVIEW")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("old-morgan@example.com")).toBeVisible();
  await expect(page.getByText(/77 Review Rd/)).toBeVisible();
});

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
