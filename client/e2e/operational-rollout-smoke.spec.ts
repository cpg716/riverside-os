import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  openBackofficeSidebarTab,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";
import {
  ensurePosRegisterSessionOpen,
  ensurePosSaleCashierSignedIn,
} from "./helpers/openPosRegister";
import {
  apiBase,
  ensureSessionAuth,
  getTransactionArtifacts,
  seedRmsFixture,
  staffHeaders,
  verifyStaffId,
} from "./helpers/rmsCharge";

const CUSTOMER = {
  id: "11111111-1111-4111-8111-111111111111",
  customer_code: "ROLLOUT-E2E",
  first_name: "Riley",
  last_name: "Rollout",
  company_name: null,
  email: "riley.rollout@example.com",
  phone: "716-555-0140",
};

const OPEN_ORDER = {
  id: "99999999-9999-4999-8999-999999999997",
  customer_id: CUSTOMER.id,
  display_id: "TXN-ROLLOUT-PAY",
  booked_at: new Date().toISOString(),
  status: "open",
  total_price: "150.00",
  amount_paid: "25.00",
  balance_due: "125.00",
  order_kind: "special_order",
  is_rush: false,
  need_by_date: null,
  wedding_member_id: null,
  party_name: null,
};

type CheckoutResponse = {
  transaction_id: string;
  transaction_display_id?: string;
};

type TransactionDetail = {
  transaction_id: string;
  transaction_display_id?: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  items: Array<{
    transaction_line_id: string;
    sku: string;
    product_name: string;
    quantity: number;
    quantity_returned: number;
  }>;
};

type RefundQueueRow = {
  transaction_id: string;
  amount_due: string;
  amount_refunded: string;
  is_open: boolean;
};

function moneyToCents(value: string | number | undefined | null): number {
  if (value == null) return 0;
  const [dollarsRaw, centsRaw = ""] = String(value).trim().split(".");
  const sign = dollarsRaw.startsWith("-") ? -1 : 1;
  const dollars = Math.abs(Number.parseInt(dollarsRaw || "0", 10));
  const cents = Number.parseInt(centsRaw.padEnd(2, "0").slice(0, 2) || "0", 10);
  return sign * (dollars * 100 + cents);
}

function centsToFixed2(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function mockPosCashierAuth(page: Page): Promise<void> {
  await page.route("**/api/staff/list-for-pos", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "55555555-5555-4555-8555-555555555555",
          full_name: "Avery Staff",
        },
      ]),
    });
  });
  await page.route("**/api/staff/verify-pin", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        staff_id: "55555555-5555-4555-8555-555555555555",
        full_name: "Avery Staff",
      }),
    });
  });
}

async function mockCustomerSearch(page: Page): Promise<void> {
  await page.route("**/api/customers/search?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([CUSTOMER]),
    });
  });
}

async function openPosRegisterSurface(page: Page): Promise<void> {
  await signInToBackOffice(page);
  await page
    .getByRole("navigation", { name: "Main Navigation" })
    .getByRole("button", { name: "POS", exact: true })
    .click();

  const posNav = page.getByRole("navigation", { name: "POS Navigation" });
  await expect(posNav).toBeVisible({ timeout: 20_000 });

  await ensurePosRegisterSessionOpen(page);
  await ensurePosSaleCashierSignedIn(page);
  const registerTab = page.getByTestId("pos-sidebar-tab-register");
  if (await registerTab.isVisible().catch(() => false)) {
    await registerTab.click();
  }
  await expect(page.getByTestId("pos-product-search")).toBeVisible({
    timeout: 25_000,
  });
}

async function selectCustomer(page: Page): Promise<void> {
  await page.getByTestId("pos-customer-search").fill("Riley");
  await page.getByRole("button", { name: /Riley Rollout/i }).click();
  await expect(page.getByText(/ROLLOUT-E2E/i)).toBeVisible({ timeout: 10_000 });
}

async function openSettingsSubItem(page: Page, label: RegExp): Promise<void> {
  const subButton = page.getByRole("button", { name: label }).first();
  if (!(await subButton.isVisible().catch(() => false))) {
    const menuToggle = page.getByRole("button", { name: /toggle menu/i });
    if (await menuToggle.isVisible().catch(() => false)) {
      await menuToggle.click().catch(() => {});
    }
  }
  await expect(subButton).toBeVisible({ timeout: 20_000 });
  await subButton.click({ force: true });
}

async function checkoutSeededProduct(
  request: APIRequestContext,
  options?: {
    quantity?: number;
    amountPaid?: string;
    fulfillment?: "takeaway" | "special_order";
  },
): Promise<{
  checkout: CheckoutResponse;
  detail: TransactionDetail;
  sessionId: string;
  sessionToken: string;
  customerName: string;
}> {
  const fixture = await seedRmsFixture(
    request,
    "standard_only",
    `Rollout Smoke ${Date.now()}`,
  );
  const { sessionId, sessionToken } = await ensureSessionAuth(request);
  const operatorStaffId = await verifyStaffId(request);
  const quantity = options?.quantity ?? 1;
  const unitCents = moneyToCents(fixture.product.unit_price);
  const total = centsToFixed2(unitCents * quantity);
  const amountPaid = options?.amountPaid ?? total;

  const checkoutRes = await request.post(`${apiBase()}/api/transactions/checkout`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
      "x-riverside-pos-session-id": sessionId,
      "x-riverside-pos-session-token": sessionToken,
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      session_id: sessionId,
      operator_staff_id: operatorStaffId,
      primary_salesperson_id: operatorStaffId,
      customer_id: fixture.customer.id,
      payment_method: "cash",
      total_price: total,
      amount_paid: amountPaid,
      checkout_client_id: crypto.randomUUID(),
      is_tax_exempt: true,
      tax_exempt_reason: "Out of State",
      items: [
        {
          product_id: fixture.product.product_id,
          variant_id: fixture.product.variant_id,
          fulfillment: options?.fulfillment ?? "takeaway",
          quantity,
          unit_price: fixture.product.unit_price,
          unit_cost: fixture.product.unit_cost,
          state_tax: "0.00",
          local_tax: "0.00",
          salesperson_id: operatorStaffId,
        },
      ],
      payment_splits: amountPaid === "0.00" ? [] : [{ payment_method: "cash", amount: amountPaid }],
    },
    failOnStatusCode: false,
  });
  const checkoutBodyText = await checkoutRes.text();
  expect(checkoutRes.status(), checkoutBodyText.slice(0, 1000)).toBe(200);
  const checkout = JSON.parse(checkoutBodyText) as CheckoutResponse;
  const detail = await fetchTransactionDetail(request, checkout.transaction_id);
  return { checkout, detail, sessionId, sessionToken, customerName: fixture.customer.display_name };
}

async function fetchTransactionDetail(
  request: APIRequestContext,
  transactionId: string,
): Promise<TransactionDetail> {
  const detailRes = await request.get(`${apiBase()}/api/transactions/${transactionId}`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const detailText = await detailRes.text();
  expect(detailRes.status(), detailText.slice(0, 1000)).toBe(200);
  return JSON.parse(detailText) as TransactionDetail;
}

async function returnFirstLine(
  request: APIRequestContext,
  options: {
    transactionId: string;
    sessionId: string;
    sessionToken: string;
  },
): Promise<TransactionDetail> {
  const before = await fetchTransactionDetail(request, options.transactionId);
  const line = before.items[0];
  expect(line?.transaction_line_id).toBeTruthy();

  const returnRes = await request.post(
    `${apiBase()}/api/transactions/${options.transactionId}/returns?register_session_id=${encodeURIComponent(options.sessionId)}`,
    {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
        "x-riverside-pos-session-id": options.sessionId,
        "x-riverside-pos-session-token": options.sessionToken,
      "x-riverside-station-key": "station-e2e",
      },
      data: {
        lines: [
          {
            transaction_line_id: line.transaction_line_id,
            quantity: 1,
            reason: "rollout_smoke_return",
          },
        ],
      },
      failOnStatusCode: false,
    },
  );
  const returnText = await returnRes.text();
  expect(returnRes.status(), returnText.slice(0, 1000)).toBe(200);
  return JSON.parse(returnText) as TransactionDetail;
}

async function fetchRefundDue(
  request: APIRequestContext,
  transactionId: string,
): Promise<RefundQueueRow> {
  const res = await request.get(`${apiBase()}/api/transactions/refunds/due`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  const rows = JSON.parse(bodyText) as RefundQueueRow[];
  const row = rows.find((candidate) => candidate.transaction_id === transactionId);
  expect(row, `refund queue row missing for ${transactionId}`).toBeTruthy();
  return row!;
}

test.describe("operational rollout smoke", () => {
  test("existing balance due payment shows amount, remaining balance, and checkout evidence", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await mockPosCashierAuth(page);
    await mockCustomerSearch(page);
    await openPosRegisterSurface(page);
    await selectCustomer(page);

    await page.route("**/api/transactions?customer_id=*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [OPEN_ORDER] }),
      });
    });

    await page.getByTitle("View customer open orders").click();
    await page.getByTestId(`pos-order-make-payment-${OPEN_ORDER.display_id}`).click();

    const paymentModal = page.getByTestId("pos-order-payment-entry-modal");
    await expect(paymentModal).toBeVisible();
    await expect(paymentModal).toContainText("Balance due");
    await expect(paymentModal).toContainText("$125.00");
    await expect(paymentModal.getByTestId("pos-order-payment-amount")).toHaveValue("125.00");
    await paymentModal.getByTestId("pos-order-payment-add-to-cart").click();

    const orderPaymentLine = page.getByTestId("pos-order-payment-cart-line");
    await expect(orderPaymentLine).toContainText(OPEN_ORDER.display_id);
    await expect(orderPaymentLine).toContainText("$125.00");
    await expect(orderPaymentLine).toContainText("Remaining after payment: $0.00");

    let checkoutBody: Record<string, unknown> | null = null;
    await page.route("**/api/transactions/checkout", async (route) => {
      checkoutBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          transaction_id: "66666666-6666-4666-8666-666666666667",
          transaction_display_id: "TXN-ROLLOUT-PAYOFF",
          status: "paid",
        }),
      });
    });

    await page.getByTestId("pos-pay-button").click();
    const checkoutDrawer = page.getByRole("dialog", { name: /checkout/i });
    await expect(checkoutDrawer).toBeVisible({ timeout: 20_000 });
    await expect(checkoutDrawer).toContainText("$125.00");
    await expect(checkoutDrawer).toContainText("Balance Due");
    await checkoutDrawer.getByRole("button", { name: /^Cash$/i }).click();
    await checkoutDrawer.getByRole("button", { name: /full balance/i }).click();
    await checkoutDrawer.getByRole("button", { name: /add payment/i }).click();
    await checkoutDrawer.getByTestId("pos-finalize-checkout").click();
    await expect(page.getByText(/sale complete/i)).toBeVisible({ timeout: 20_000 });

    expect(checkoutBody).toMatchObject({
      customer_id: CUSTOMER.id,
      order_payments: [
        {
          target_transaction_id: OPEN_ORDER.id,
          target_display_id: OPEN_ORDER.display_id,
          customer_id: CUSTOMER.id,
          amount: "125.00",
          balance_before: "125.00",
          projected_balance_after: "0.00",
        },
      ],
    });
  });

  test("exchange return wizard records a visible return and leaves refund queue evidence", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const seeded = await checkoutSeededProduct(request, { quantity: 1 });
    const customerNamePattern = new RegExp(escapeRegExp(seeded.customerName), "i");

    await signInToBackOffice(page, { persistSession: true });
    await openBackofficeSidebarTab(page, "register");
    await ensurePosRegisterSessionOpen(page);
    await ensurePosSaleCashierSignedIn(page);

    await page.getByTestId("pos-exchange-wizard-trigger").click();
    const wizard = page.getByTestId("pos-exchange-wizard-dialog");
    await expect(wizard).toBeVisible({ timeout: 15_000 });
    await expect(wizard.getByText(/find original sale/i).first()).toBeVisible();
    await expect(wizard.getByText(/record return items/i).first()).toBeVisible();

    await page.route("**/api/transactions?search=*&limit=10", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              transaction_id: seeded.checkout.transaction_id,
              booked_at: new Date().toISOString(),
              status: "paid",
              total_price: seeded.detail.total_price,
              amount_paid: seeded.detail.amount_paid,
              balance_due: seeded.detail.balance_due,
              customer_name: seeded.customerName,
              party_name: null,
              transaction_kind: "takeaway",
            },
          ],
          total_count: 1,
        }),
      });
    });
    const search = wizard.getByRole("textbox").first();
    await search.fill(seeded.customerName);
    await expect(wizard.getByRole("button", { name: customerNamePattern })).toBeVisible({
      timeout: 20_000,
    });
    await wizard.getByRole("button", { name: customerNamePattern }).first().click();

    await expect(wizard.getByText("Eligible Return Items")).toBeVisible({ timeout: 20_000 });
    await expect(wizard.getByText(seeded.detail.items[0]!.product_name).first()).toBeVisible();
    await expect(wizard.getByText(/max return: 1/i)).toBeVisible();
    await wizard.locator("input[placeholder='0']").first().fill("1");
    await wizard.getByRole("button", { name: /continue exchange|exchange for new items/i }).click();
    await expect(page.getByText(/exchange credit/i).first()).toBeVisible({ timeout: 20_000 });

    const returned = await expect
      .poll(
        async () => {
          const detail = await fetchTransactionDetail(request, seeded.checkout.transaction_id);
          return detail.items[0]?.quantity_returned === 1 ? detail : null;
        },
        { timeout: 20_000, message: "return quantity was not recorded" },
      )
      .not.toBeNull()
      .then(async () => fetchTransactionDetail(request, seeded.checkout.transaction_id));
    expect(returned.items[0]?.quantity_returned).toBe(1);
    const refund = await fetchRefundDue(request, seeded.checkout.transaction_id);
    expect(refund.is_open).toBe(true);
    expect(moneyToCents(refund.amount_due)).toBeGreaterThan(0);
    expect(moneyToCents(refund.amount_refunded)).toBe(0);
  });

  test("orders workspace cash refund modal completes a refund from transaction detail", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const seeded = await checkoutSeededProduct(request, {
      quantity: 1,
      fulfillment: "special_order",
    });
    const returnedDetail = await returnFirstLine(request, {
      transactionId: seeded.checkout.transaction_id,
      sessionId: seeded.sessionId,
      sessionToken: seeded.sessionToken,
    });
    const refundBefore = await fetchRefundDue(request, seeded.checkout.transaction_id);
    const displayId = seeded.detail.transaction_display_id ?? seeded.checkout.transaction_id;

    await page.route("**/api/transactions?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              transaction_id: seeded.checkout.transaction_id,
              display_id: displayId,
              booked_at: new Date().toISOString(),
              status: "paid",
              total_price: returnedDetail.total_price,
              amount_paid: returnedDetail.amount_paid,
              balance_due: returnedDetail.balance_due,
              customer_id: null,
              customer_name: seeded.customerName,
              wedding_member_id: null,
              wedding_party_id: null,
              party_name: null,
              primary_salesperson_name: null,
              item_count: returnedDetail.items.length,
              order_kind: "special_order",
              counterpoint_customer_code: null,
            },
          ],
          total_count: 1,
        }),
      });
    });

    await signInToBackOffice(page, { persistSession: true });
    await openBackofficeSidebarTab(page, "orders");
    await page
      .getByRole("textbox", {
        name: /Search by customer, phone, order item, Transaction Record #, or fulfillment order #/i,
      })
      .fill(displayId);
    const orderRow = page.locator("tr", { hasText: displayId }).first();
    await expect(orderRow).toBeVisible({ timeout: 30_000 });
    const desktopOrderId = page.locator("tbody").getByText(displayId, { exact: true }).first();
    if (await desktopOrderId.isVisible().catch(() => false)) {
      await desktopOrderId.click();
    } else {
      await page.locator("button", { hasText: displayId }).first().click();
    }

    const drawer = page.getByRole("dialog", { name: /Transaction Record|Order Detail/i });
    await expect(drawer).toBeVisible({ timeout: 20_000 });
    await expect(drawer).toContainText(displayId);
    await expect(drawer.getByRole("button", { name: /Process Refund/i })).toBeVisible();
    await drawer.getByRole("button", { name: /Process Refund/i }).click();

    const refundModal = page.getByRole("dialog", { name: /process refund/i });
    await expect(refundModal).toBeVisible({ timeout: 10_000 });
    await expect(refundModal.getByLabel(/Amount \(USD\)/i)).toBeVisible();
    await refundModal.getByLabel(/Amount \(USD\)/i).fill(refundBefore.amount_due);
    await refundModal.getByLabel(/Payment method/i).selectOption("cash");
    await refundModal.getByRole("button", { name: /submit refund/i }).click();
    await expect(page.getByText(/Refund completed/i)).toBeVisible({ timeout: 20_000 });
    await expect(refundModal).toBeHidden({ timeout: 20_000 });

    const artifacts = await getTransactionArtifacts(request, seeded.checkout.transaction_id);
    expect(artifacts.allocation_rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_transaction_id: seeded.checkout.transaction_id,
          payment_method: "cash",
          amount_allocated: `-${refundBefore.amount_due}`,
          payment_amount: `-${refundBefore.amount_due}`,
        }),
      ]),
    );
  });

  test("transaction detail opens reprint receipt delivery choices", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const seeded = await checkoutSeededProduct(request, { quantity: 1 });
    const displayId = seeded.detail.transaction_display_id ?? seeded.checkout.transaction_id;

    await page.route("**/api/transactions?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              transaction_id: seeded.checkout.transaction_id,
              display_id: displayId,
              booked_at: new Date().toISOString(),
              status: "paid",
              total_price: seeded.detail.total_price,
              amount_paid: seeded.detail.amount_paid,
              balance_due: seeded.detail.balance_due,
              customer_id: null,
              customer_name: seeded.customerName,
              wedding_member_id: null,
              wedding_party_id: null,
              party_name: null,
              primary_salesperson_name: null,
              item_count: seeded.detail.items.length,
              order_kind: "special_order",
              counterpoint_customer_code: null,
            },
          ],
          total_count: 1,
        }),
      });
    });

    await signInToBackOffice(page, { persistSession: true });
    await openBackofficeSidebarTab(page, "orders");
    await page
      .getByRole("textbox", {
        name: /Search by customer, phone, order item, Transaction Record #, or fulfillment order #/i,
      })
      .fill(displayId);

    const orderRow = page.locator("tr", { hasText: displayId }).first();
    await expect(orderRow).toBeVisible({ timeout: 30_000 });
    const desktopOrderId = page.locator("tbody").getByText(displayId, { exact: true }).first();
    if (await desktopOrderId.isVisible().catch(() => false)) {
      await desktopOrderId.click();
    } else {
      await page.locator("button", { hasText: displayId }).first().click();
    }

    const drawer = page.getByRole("dialog", { name: /Transaction Record|Order Detail/i });
    await expect(drawer).toBeVisible({ timeout: 20_000 });
    await expect(drawer).toContainText(displayId);
    await expect(drawer.getByRole("button", { name: /Reprint Receipt/i })).toBeVisible();
    await drawer.getByRole("button", { name: /Reprint Receipt/i }).click();

    await expect(page.getByText(/Sale complete/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(new RegExp(`Transaction #${escapeRegExp(displayId)}`, "i"))).toBeVisible();
    await expect(page.getByRole("button", { name: "Print receipt", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /View receipt/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Text receipt/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Email receipt/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Gift receipt/i })).toBeVisible();
  });

  test("bug report flow exposes downloadable diagnostics evidence", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    let submittedBody: unknown = null;

    await page.route("**/api/bug-reports", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      submittedBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "rollout-report-1",
          correlation_id: "33333333-4444-4555-8666-777777777777",
        }),
      });
    });
    await page.route(/\/api\/settings\/bug-reports$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "rollout-report-1",
            correlation_id: "33333333-4444-4555-8666-777777777777",
            created_at: "2026-05-12T12:00:00Z",
            status: "pending",
            summary: "Rollout diagnostics smoke",
            staff_id: "staff-1",
            staff_name: "Chris G",
          },
        ]),
      });
    });
    await page.route(/\/api\/settings\/bug-reports\/error-events$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
    await page.route("**/api/settings/bug-reports/rollout-report-1", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "rollout-report-1",
          correlation_id: "33333333-4444-4555-8666-777777777777",
          created_at: "2026-05-12T12:00:00Z",
          updated_at: "2026-05-12T12:00:00Z",
          status: "pending",
          summary: "Rollout diagnostics smoke",
          steps_context: "Opened checkout and needed support evidence.",
          client_console_log: "INFO rollout diagnostics smoke",
          client_meta: {
            href: "/",
            event_capture: {
              capture_type: "manual_bug_report",
              route: "/",
            },
            runtime_surface: "browser",
          },
          screenshot_png_base64:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          server_log_snapshot: "rollout support log snapshot",
          resolver_notes: "",
          external_url: "",
          staff_id: "staff-1",
          staff_name: "Chris G",
          resolved_at: null,
          resolver_name: null,
        }),
      });
    });

    await signInToBackOffice(page, { persistSession: true });
    await page.getByTestId("bug-report-trigger").click();
    await expect(page.getByLabel(/what went wrong/i)).toBeVisible({
      timeout: 20_000,
    });
    await page.getByLabel(/what went wrong/i).fill("Rollout diagnostics smoke");
    await page
      .getByLabel(/what were you doing/i)
      .fill("Opened checkout and needed support evidence.");
    await page.getByRole("button", { name: /^submit report$/i }).click();
    await expect
      .poll(() => submittedBody, {
        timeout: 20_000,
        message: "bug report payload was not submitted",
      })
      .not.toBeNull();
    expect(submittedBody).toEqual(
      expect.objectContaining({
        summary: "Rollout diagnostics smoke",
        client_meta: expect.objectContaining({
          event_capture: expect.objectContaining({
            capture_type: "manual_bug_report",
          }),
        }),
      }),
    );

    await openBackofficeSidebarTab(page, "settings");
    await openSettingsSubItem(page, /^ros operations & support center$/i);
    await page.getByRole("button", { name: /^bug manager$/i }).first().click();
    await page.getByRole("button", { name: /^view$/i }).first().click();

    const detail = page.getByRole("dialog", { name: /bug report detail/i });
    await expect(detail).toBeVisible({ timeout: 20_000 });
    await expect(detail.getByRole("button", { name: /ai diagnostic json/i })).toBeVisible();
    await expect(detail.getByRole("button", { name: /screenshot png/i })).toBeVisible();
    await expect(detail.getByRole("button", { name: /support log/i })).toBeVisible();
    await expect(detail.getByRole("button", { name: /browser log/i })).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await detail.getByRole("button", { name: /ai diagnostic json/i }).click();
    const download = await downloadPromise;
    expect(await download.path()).toBeTruthy();
  });
});
