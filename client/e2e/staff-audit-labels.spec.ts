import { expect, test, type APIRequestContext } from "@playwright/test";
import { openBackofficeSidebarTab, signInToBackOffice } from "./helpers/backofficeSignIn";
import {
  apiBase,
  ensureSessionAuth,
  seedRmsFixture,
  staffHeaders,
  verifyStaffId,
} from "./helpers/rmsCharge";

async function getTransactionDisplayId(
  request: APIRequestContext,
  transactionId: string,
): Promise<string> {
  const res = await request.get(`${apiBase()}/api/transactions/${transactionId}`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText).toBe(200);
  const body = JSON.parse(bodyText) as { transaction_display_id?: string | null };
  return body.transaction_display_id ?? transactionId;
}

async function createTransactionForAuditSurface(
  request: APIRequestContext,
): Promise<{ transactionDisplayId: string }> {
  const fixture = await seedRmsFixture(request, "standard_only", "Staff Audit Labels");
  const { sessionId, sessionToken } = await ensureSessionAuth(request);
  const operatorStaffId = await verifyStaffId(request);

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
      primary_salesperson_id: operatorStaffId,
      customer_id: fixture.customer.id,
      payment_method: "cash",
      total_price: fixture.product.unit_price,
      amount_paid: fixture.product.unit_price,
      checkout_client_id: crypto.randomUUID(),
      is_tax_exempt: true,
      tax_exempt_reason: "Out of State",
      items: [
        {
          product_id: fixture.product.product_id,
          variant_id: fixture.product.variant_id,
          fulfillment: "special_order",
          quantity: 1,
          unit_price: fixture.product.unit_price,
          unit_cost: fixture.product.unit_cost,
          state_tax: "0.00",
          local_tax: "0.00",
        },
      ],
    },
    failOnStatusCode: false,
  });
  const checkoutBodyText = await checkoutRes.text();
  expect(checkoutRes.status(), checkoutBodyText).toBe(200);
  const checkoutBody = JSON.parse(checkoutBodyText) as { transaction_id: string };
  const transactionDisplayId = await getTransactionDisplayId(request, checkoutBody.transaction_id);
  return { transactionDisplayId };
}

function collectSurfaceLabels(surfaceText: string): string[] {
  return surfaceText
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 3 && line.length <= 64 && /[A-Za-z]/.test(line));
}

test.describe("staff-facing audit labels", () => {
  test("transaction detail drawer uses readable non-technical labels", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const seeded = await createTransactionForAuditSurface(request);

    await signInToBackOffice(page, { persistSession: true });
    await openBackofficeSidebarTab(page, "orders");

    const orderRow = page.locator("tr", { hasText: seeded.transactionDisplayId }).first();
    await expect(orderRow).toBeVisible({ timeout: 30_000 });
    await orderRow.click();

    const drawer = page.getByRole("dialog", { name: /Order Detail|Transaction Record/i });
    await expect(drawer).toBeVisible({ timeout: 20_000 });
    await expect(drawer).toContainText(/Transaction Record|Order Detail/i);
    await expect(
      drawer.getByRole("button", { name: /Open in Register|View Receipt|Reprint Receipt|Process Refund|Edit/i }).first(),
    ).toBeVisible();

    const drawerText = await drawer.innerText();
    const labels = collectSurfaceLabels(drawerText);
    expect(labels.length).toBeGreaterThan(0);

    const leakedSnakeCase = labels.filter((label) => /\b[a-z]+_[a-z0-9_]+\b/.test(label));
    const leakedCamelCase = labels.filter((label) => /\b[a-z]+[A-Z][A-Za-z0-9]*\b/.test(label));
    const leakedEnumStyle = labels.filter((label) => /\b[A-Z0-9]+(?:_[A-Z0-9]+)+\b/.test(label));
    expect(leakedSnakeCase, `snake_case labels leaked: ${leakedSnakeCase.join(", ")}`).toEqual([]);
    expect(leakedCamelCase, `camelCase labels leaked: ${leakedCamelCase.join(", ")}`).toEqual([]);
    expect(leakedEnumStyle, `enum-style labels leaked: ${leakedEnumStyle.join(", ")}`).toEqual([]);
    expect(drawerText).not.toMatch(
      /\b(register_close_event|transaction_display_id|lifecycle_status|till_close_group_id|pos_api_token|operator_staff_id)\b/i,
    );
  });
});
