import { expect, test, type APIRequestContext } from "@playwright/test";
import { parseMoneyToCents } from "../src/lib/money";
import { calculateNysErieTaxStringsForUnit } from "../src/lib/tax";
import { openBackofficeSidebarTab, signInToBackOffice } from "./helpers/backofficeSignIn";
import {
  apiBase,
  ensureSessionAuth,
  seedRmsFixture,
  staffHeaders,
  verifyStaffId,
} from "./helpers/rmsCharge";

type CheckoutResponse = {
  transaction_id: string;
};

type SeededOrder = {
  transactionId: string;
  displayId: string;
  customerName: string;
  productName: string;
  transactionLineId: string;
};

async function createSpecialOrder(
  request: APIRequestContext,
  label: string,
): Promise<SeededOrder> {
  const fixture = await seedRmsFixture(request, "standard_only", `Orders Detail ${label}`);
  const { sessionId, sessionToken } = await ensureSessionAuth(request);
  const operatorStaffId = await verifyStaffId(request);
  const priceCents = parseMoneyToCents(fixture.product.unit_price);
  const { stateTax, localTax } = calculateNysErieTaxStringsForUnit("clothing", priceCents);
  const total = (
    Number.parseFloat(fixture.product.unit_price) +
    Number.parseFloat(stateTax) +
    Number.parseFloat(localTax)
  ).toFixed(2);

  const checkoutRes = await request.post(`${apiBase()}/api/transactions/checkout`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
      "x-riverside-pos-session-id": sessionId,
      "x-riverside-pos-session-token": sessionToken,
    },
    data: {
      session_id: sessionId,
      operator_staff_id: operatorStaffId,
      primary_salesperson_id: null,
      customer_id: fixture.customer.id,
      wedding_member_id: null,
      payment_method: "cash",
      total_price: total,
      amount_paid: "0.00",
      checkout_client_id: crypto.randomUUID(),
      items: [
        {
          product_id: fixture.product.product_id,
          variant_id: fixture.product.variant_id,
          fulfillment: "special_order",
          quantity: 1,
          unit_price: fixture.product.unit_price,
          unit_cost: fixture.product.unit_cost,
          state_tax: stateTax,
          local_tax: localTax,
        },
      ],
      payment_splits: [],
    },
    failOnStatusCode: false,
  });

  expect(checkoutRes.status()).toBe(200);
  const checkout = (await checkoutRes.json()) as CheckoutResponse;

  const detailRes = await request.get(`${apiBase()}/api/transactions/${checkout.transaction_id}`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  expect(detailRes.status()).toBe(200);
  const detail = (await detailRes.json()) as {
    transaction_display_id?: string;
    items?: Array<{
      transaction_line_id?: string;
    }>;
  };

  return {
    transactionId: checkout.transaction_id,
    displayId: detail.transaction_display_id ?? checkout.transaction_id,
    customerName: fixture.customer.display_name,
    productName: fixture.product.name,
    transactionLineId: detail.items?.[0]?.transaction_line_id ?? "",
  };
}

test.describe("Orders detail drawer and POS handoff", () => {
  test("Back Office orders open the detail drawer and load the selected order into Register", async ({
    page,
    request,
  }) => {
    const order = await createSpecialOrder(request, "BO");

    await signInToBackOffice(page, { persistSession: true });
    await openBackofficeSidebarTab(page, "orders");

    const orderRow = page.locator("tr", { hasText: order.displayId }).first();
    await expect(orderRow).toBeVisible({ timeout: 20_000 });
    await orderRow.click();

    const drawer = page.getByRole("dialog", { name: "Order Detail" });
    await expect(drawer).toBeVisible({ timeout: 20_000 });
    await expect(drawer).toContainText(order.displayId);
    await expect(drawer).toContainText(order.productName);
    await expect(drawer).toContainText("Pickup Order");
    await expect(drawer).toContainText("Balance Due Before Release");
    await expect(drawer).toContainText("Still Open");

    await drawer.getByRole("button", { name: "Open in Register" }).first().click();

    const cashierDialog = page.getByRole("dialog", { name: /sign-in for this sale/i });
    await expect(cashierDialog).toBeVisible({ timeout: 20_000 });
    await cashierDialog.getByRole("button", { name: /select staff member/i }).first().click();
    await cashierDialog.getByRole("button", { name: /Chris Garcia/i }).click();
    for (const digit of "1234") {
      await cashierDialog.getByTestId(`pin-key-${digit}`).click();
    }
    await cashierDialog.getByRole("button", { name: /^continue$/i }).click();
    await expect(cashierDialog).toBeHidden({ timeout: 20_000 });
    await expect(page.getByText(order.productName).first()).toBeVisible({ timeout: 20_000 });
  });

  test("POS orders open the same detail drawer contract", async ({ page, request }) => {
    const order = await createSpecialOrder(request, "POS");

    await signInToBackOffice(page, { persistSession: true });
    await openBackofficeSidebarTab(page, "register");

    const posNav = page.getByRole("navigation", { name: "POS Navigation" });
    await expect(posNav).toBeVisible({ timeout: 20_000 });
    await posNav.getByRole("button", { name: "Orders", exact: true }).click();

    const orderRow = page.locator("tr", { hasText: order.displayId }).first();
    await expect(orderRow).toBeVisible({ timeout: 20_000 });
    await orderRow.click();

    const drawer = page.getByRole("dialog", { name: "Order Detail" });
    await expect(drawer).toBeVisible({ timeout: 20_000 });
    await expect(drawer).toContainText(order.displayId);
    await expect(drawer).toContainText(order.productName);
    await expect(drawer).toContainText("Pickup Order");
    await expect(drawer).toContainText("Still Open");
    await expect(drawer.getByRole("button", { name: "Edit" }).first()).toBeVisible();
  });

  test("Back Office drawer edits a line and rerenders the saved values", async ({
    page,
    request,
  }) => {
    const order = await createSpecialOrder(request, "BO Edit");

    await signInToBackOffice(page, { persistSession: true });
    await openBackofficeSidebarTab(page, "orders");

    const orderRow = page.locator("tr", { hasText: order.displayId }).first();
    await expect(orderRow).toBeVisible({ timeout: 20_000 });
    await orderRow.click();

    const drawer = page.getByRole("dialog", { name: "Order Detail" });
    await expect(drawer).toBeVisible({ timeout: 20_000 });
    await drawer.getByRole("button", { name: "Edit" }).first().click();

    const quantityInput = drawer.getByLabel("Quantity").first();
    await quantityInput.fill("2");
    await drawer.getByRole("button", { name: "Save Line" }).click();

    await expect(drawer.getByText("Qty 2").first()).toBeVisible({ timeout: 20_000 });
    await expect(drawer.getByText(order.productName).first()).toBeVisible();
  });

  test("POS orders hand off the selected order back into Register", async ({
    page,
    request,
  }) => {
    const order = await createSpecialOrder(request, "POS Handoff");

    await signInToBackOffice(page, { persistSession: true });
    await openBackofficeSidebarTab(page, "register");

    const posNav = page.getByRole("navigation", { name: "POS Navigation" });
    await expect(posNav).toBeVisible({ timeout: 20_000 });
    await posNav.getByRole("button", { name: "Orders", exact: true }).click();

    const orderRow = page.locator("tr", { hasText: order.displayId }).first();
    await expect(orderRow).toBeVisible({ timeout: 20_000 });
    await orderRow.click();

    const drawer = page.getByRole("dialog", { name: "Order Detail" });
    await expect(drawer).toBeVisible({ timeout: 20_000 });
    await drawer.getByRole("button", { name: "Open in Register" }).first().click();

    const cashierDialog = page.getByRole("dialog", { name: /sign-in for this sale/i });
    await expect(cashierDialog).toBeVisible({ timeout: 20_000 });
    await cashierDialog.getByRole("button", { name: /select staff member/i }).first().click();
    await cashierDialog.getByRole("button", { name: /Chris Garcia/i }).click();
    for (const digit of "1234") {
      await cashierDialog.getByTestId(`pin-key-${digit}`).click();
    }
    await cashierDialog.getByRole("button", { name: /^continue$/i }).click();
    await expect(cashierDialog).toBeHidden({ timeout: 20_000 });
    await expect(page.getByText(order.productName).first()).toBeVisible({ timeout: 20_000 });
  });

  test("POS order round-trip reopens with authoritative detail after register activity", async ({
    page,
    request,
  }) => {
    const order = await createSpecialOrder(request, "POS Roundtrip");

    await signInToBackOffice(page, { persistSession: true });
    await openBackofficeSidebarTab(page, "register");

    const posNav = page.getByRole("navigation", { name: "POS Navigation" });
    await expect(posNav).toBeVisible({ timeout: 20_000 });
    await posNav.getByRole("button", { name: "Orders", exact: true }).click();

    let orderRow = page.locator("tr", { hasText: order.displayId }).first();
    await expect(orderRow).toBeVisible({ timeout: 20_000 });
    await orderRow.click();

    let drawer = page.getByRole("dialog", { name: "Order Detail" });
    await expect(drawer).toBeVisible({ timeout: 20_000 });
    await drawer.getByRole("button", { name: "Open in Register" }).first().click();

    const cashierDialog = page.getByRole("dialog", { name: /sign-in for this sale/i });
    await expect(cashierDialog).toBeVisible({ timeout: 20_000 });
    await cashierDialog.getByRole("button", { name: /select staff member/i }).first().click();
    await cashierDialog.getByRole("button", { name: /Chris Garcia/i }).click();
    for (const digit of "1234") {
      await cashierDialog.getByTestId(`pin-key-${digit}`).click();
    }
    await cashierDialog.getByRole("button", { name: /^continue$/i }).click();
    await expect(cashierDialog).toBeHidden({ timeout: 20_000 });
    await expect(page.getByText(order.productName).first()).toBeVisible({ timeout: 20_000 });

    const patchRes = await request.patch(
      `${apiBase()}/api/transactions/${order.transactionId}/items/${order.transactionLineId}`,
      {
        headers: {
          ...staffHeaders(),
          "Content-Type": "application/json",
        },
        data: {
          quantity: 2,
        },
        failOnStatusCode: false,
      },
    );
    expect(patchRes.status()).toBe(200);

    await posNav.getByRole("button", { name: "Orders", exact: true }).click();
    orderRow = page.locator("tr", { hasText: order.displayId }).first();
    await expect(orderRow).toBeVisible({ timeout: 20_000 });
    await orderRow.click();

    drawer = page.getByRole("dialog", { name: "Order Detail" });
    await expect(drawer).toBeVisible({ timeout: 20_000 });
    await expect(drawer.getByText("Qty 2").first()).toBeVisible({ timeout: 20_000 });
  });
});
