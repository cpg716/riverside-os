import { expect, test } from "@playwright/test";
import {
  ensurePosRegisterSessionOpen,
  ensurePosSaleCashierSignedIn,
} from "./helpers/openPosRegister";

function apiBase(): string {
  const raw =
    process.env.E2E_API_BASE?.trim() ||
    process.env.VITE_API_BASE?.trim() ||
    "http://127.0.0.1:43300";
  return raw.replace(/\/$/, "");
}

function e2eAdminCode(): string {
  return process.env.E2E_BO_STAFF_CODE?.trim() || "1234";
}

function adminHeaders(): Record<string, string> {
  const code = e2eAdminCode();
  return {
    "x-riverside-staff-code": code,
    "x-riverside-staff-pin": code,
  };
}

type SessionListRow = {
  session_id?: string;
  register_lane?: number;
};

type SessionOpenResponse = {
  session_id: string;
  pos_api_token?: string | null;
};

type VerifyCashierResponse = {
  staff_id: string;
};

type ProductCreateResponse = {
  id: string;
};

type ProductVariantRow = {
  id: string;
  sku: string;
};

type CheckoutResponse = {
  transaction_id: string;
};

type TransactionDetailResponse = {
  total_price: string;
  items: Array<{
    transaction_line_id: string;
    sku: string;
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

async function verifyAdminStaffId(
  request: Parameters<typeof test>[0]["request"],
): Promise<string> {
  const res = await request.post(`${apiBase()}/api/staff/verify-cashier-code`, {
    data: {
      cashier_code: e2eAdminCode(),
      pin: e2eAdminCode(),
    },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as VerifyCashierResponse;
  expect(body.staff_id).toBeTruthy();
  return body.staff_id;
}

async function primeBackofficeSession(
  page: Parameters<typeof test>[0]["page"],
  request: Parameters<typeof test>[0]["request"],
): Promise<string> {
  const staffId = await verifyAdminStaffId(request);
  const code = e2eAdminCode();
  await page.addInitScript(
    ({ seededCode, seededStaffId }) => {
      window.sessionStorage.setItem(
        "ros.backoffice.session.v1",
        JSON.stringify({
          staffCode: seededCode,
          staffPin: seededCode,
        }),
      );
      window.localStorage.setItem("ros_last_staff_id", seededStaffId);
    },
    {
      seededCode: code,
      seededStaffId: staffId,
    },
  );
  return staffId;
}

async function ensureSessionToken(
  request: Parameters<typeof test>[0]["request"],
): Promise<{ sessionId: string; sessionToken: string }> {
  const listRes = await request.get(`${apiBase()}/api/sessions/list-open`, {
    headers: adminHeaders(),
    failOnStatusCode: false,
  });
  expect(listRes.status()).toBe(200);
  const rows = (await listRes.json()) as SessionListRow[];

  if (rows.length === 0) {
    const openRes = await request.post(`${apiBase()}/api/sessions/open`, {
      data: {
        cashier_code: e2eAdminCode(),
        pin: e2eAdminCode(),
        opening_float: "200.00",
        register_lane: 1,
      },
      failOnStatusCode: false,
    });
    expect(openRes.status()).toBe(200);
    const opened = (await openRes.json()) as SessionOpenResponse;
    expect(opened.pos_api_token).toBeTruthy();
    return {
      sessionId: opened.session_id,
      sessionToken: opened.pos_api_token ?? "",
    };
  }

  const primary = rows.find((row) => row.register_lane === 1) ?? rows[0];
  expect(primary?.session_id).toBeTruthy();
  const sessionId = primary.session_id ?? "";
  const tokenRes = await request.post(
    `${apiBase()}/api/sessions/${sessionId}/pos-api-token`,
    {
      data: {
        cashier_code: e2eAdminCode(),
        pin: e2eAdminCode(),
      },
      failOnStatusCode: false,
    },
  );
  expect(tokenRes.status()).toBe(200);
  const tokenBody = (await tokenRes.json()) as { pos_api_token?: string };
  expect(tokenBody.pos_api_token).toBeTruthy();
  return {
    sessionId,
    sessionToken: tokenBody.pos_api_token ?? "",
  };
}

async function createDeterministicProduct(
  request: Parameters<typeof test>[0]["request"],
  actorStaffId: string,
): Promise<{ productId: string; variantId: string; sku: string }> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  const sku = `E2E-RET-${suffix}`;
  const categoryRes = await request.post(`${apiBase()}/api/categories`, {
    headers: {
      ...adminHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      name: `E2E Returns ${suffix}`,
      parent_id: null,
      is_clothing_footwear: false,
      changed_by_staff_id: actorStaffId,
      change_note: "Created for exchange/returns E2E coverage",
    },
    failOnStatusCode: false,
  });
  expect(categoryRes.status()).toBe(200);
  const category = (await categoryRes.json()) as { id: string };
  expect(category.id).toBeTruthy();

  const createRes = await request.post(`${apiBase()}/api/products`, {
    headers: {
      ...adminHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      category_id: category.id,
      name: `E2E Return Jacket ${suffix}`,
      brand: "Riverside E2E",
      description: "Deterministic return/exchange test product",
      base_retail_price: "100.00",
      base_cost: "40.00",
      variation_axes: [],
      variants: [
        {
          sku,
          variation_values: {},
          variation_label: "One Size",
          stock_on_hand: 12,
        },
      ],
    },
    failOnStatusCode: false,
  });
  expect(createRes.status()).toBe(200);
  const created = (await createRes.json()) as ProductCreateResponse;
  expect(created.id).toBeTruthy();

  const variantsRes = await request.get(
    `${apiBase()}/api/products/${created.id}/variants`,
    {
      headers: adminHeaders(),
      failOnStatusCode: false,
    },
  );
  expect(variantsRes.status()).toBe(200);
  const variants = (await variantsRes.json()) as ProductVariantRow[];
  expect(variants.length).toBeGreaterThan(0);

  return {
    productId: created.id,
    variantId: variants[0]?.id ?? "",
    sku,
  };
}

test.describe("POS exchange wizard", () => {
  test.describe.configure({ mode: "serial" });

  test("opens from cart when register is open", async ({ page, request }) => {
    test.setTimeout(60_000);
    await primeBackofficeSession(page, request);
    await page.goto("/pos", { waitUntil: "domcontentloaded" });
    const posNav = page.getByRole("navigation", { name: "POS Navigation" });
    await expect(posNav).toBeVisible({ timeout: 15_000 });
    await ensurePosRegisterSessionOpen(page);
    const registerTab = page.getByTestId("pos-sidebar-tab-register");
    const registerNavButton = posNav.getByRole("button", { name: /^register$/i });
    const goToRegisterButton = page.getByRole("button", {
      name: /go to register/i,
    });

    await expect
      .poll(
        async () =>
          (await goToRegisterButton.isVisible().catch(() => false)) ||
          (await registerTab.isVisible().catch(() => false)) ||
          (await registerNavButton.isVisible().catch(() => false)),
        { timeout: 15_000 },
      )
      .toBeTruthy();

    if (await goToRegisterButton.isVisible().catch(() => false)) {
      await goToRegisterButton.click();
    } else if (await registerTab.isVisible().catch(() => false)) {
      await expect(registerTab).toBeEnabled();
      await registerTab.click();
    } else if (await registerNavButton.isVisible().catch(() => false)) {
      await expect(registerNavButton).toBeEnabled();
      await registerNavButton.click();
    }
    await ensurePosSaleCashierSignedIn(page);
    await expect(page.getByTestId("pos-product-search")).toBeVisible({
      timeout: 20_000,
    });
    const trigger = page.getByTestId("pos-exchange-wizard-trigger");
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await trigger.focus();
    await trigger.press("Enter");
    const wizardDialog = page.getByTestId("pos-exchange-wizard-dialog");
    await expect(wizardDialog).toBeVisible({
      timeout: 15_000,
    });
    await expect(wizardDialog.getByText(/find original sale/i).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(wizardDialog.getByText(/record return items/i).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(wizardDialog.getByText(/sell replacements/i).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      wizardDialog.getByText(/next: record return items/i),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("returned quantity stays in sync across totals, refund queue, and receipt output", async ({
    request,
  }) => {
    test.setTimeout(90_000);

    const operatorStaffId = await verifyAdminStaffId(request);
    const { sessionId, sessionToken } = await ensureSessionToken(request);
    const { productId, variantId, sku } = await createDeterministicProduct(
      request,
      operatorStaffId,
    );

    const checkoutRes = await request.post(`${apiBase()}/api/transactions/checkout`, {
      headers: {
        "Content-Type": "application/json",
        "x-riverside-pos-session-id": sessionId,
        "x-riverside-pos-session-token": sessionToken,
      },
      data: {
        session_id: sessionId,
        operator_staff_id: operatorStaffId,
        primary_salesperson_id: operatorStaffId,
        customer_id: null,
        payment_method: "cash",
        total_price: "326.25",
        amount_paid: "326.25",
        items: [
          {
            product_id: productId,
            variant_id: variantId,
            fulfillment: "takeaway",
            quantity: 3,
            unit_price: "100.00",
            unit_cost: "40.00",
            state_tax: "4.00",
            local_tax: "4.75",
            salesperson_id: operatorStaffId,
          },
        ],
      },
      failOnStatusCode: false,
    });
    expect(checkoutRes.status()).toBe(200);
    const checkout = (await checkoutRes.json()) as CheckoutResponse;
    expect(checkout.transaction_id).toBeTruthy();

    const beforeRes = await request.get(
      `${apiBase()}/api/transactions/${checkout.transaction_id}?register_session_id=${encodeURIComponent(sessionId)}`,
      {
        headers: {
          "x-riverside-pos-session-id": sessionId,
          "x-riverside-pos-session-token": sessionToken,
        },
        failOnStatusCode: false,
      },
    );
    expect(beforeRes.status()).toBe(200);
    const before = (await beforeRes.json()) as TransactionDetailResponse;
    const line = before.items.find((item) => item.sku === sku);
    expect(line?.transaction_line_id).toBeTruthy();

    const returnRes = await request.post(
      `${apiBase()}/api/transactions/${checkout.transaction_id}/returns?register_session_id=${encodeURIComponent(sessionId)}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-riverside-pos-session-id": sessionId,
          "x-riverside-pos-session-token": sessionToken,
        },
        data: {
          lines: [
            {
              transaction_line_id: line?.transaction_line_id,
              quantity: 1,
              reason: "exchange",
            },
          ],
        },
        failOnStatusCode: false,
      },
    );
    expect(returnRes.status()).toBe(200);

    const detailRes = await request.get(
      `${apiBase()}/api/transactions/${checkout.transaction_id}?register_session_id=${encodeURIComponent(sessionId)}`,
      {
        headers: {
          "x-riverside-pos-session-id": sessionId,
          "x-riverside-pos-session-token": sessionToken,
        },
        failOnStatusCode: false,
      },
    );
    expect(detailRes.status()).toBe(200);
    const detail = (await detailRes.json()) as TransactionDetailResponse;
    const updatedLine = detail.items.find((item) => item.sku === sku);
    expect(updatedLine?.quantity).toBe(3);
    expect(updatedLine?.quantity_returned).toBe(1);
    expect(detail.total_price).toBe("217.50");

    const refundQueueRes = await request.get(`${apiBase()}/api/transactions/refunds/due`, {
      headers: adminHeaders(),
      failOnStatusCode: false,
    });
    expect(refundQueueRes.status()).toBe(200);
    const refunds = (await refundQueueRes.json()) as RefundQueueRow[];
    const refund = refunds.find((row) => row.transaction_id === checkout.transaction_id);
    expect(refund?.is_open).toBe(true);
    expect(refund?.amount_due).toBe("108.75");
    expect(refund?.amount_refunded).toBe("0");

    const receiptRes = await request.get(
      `${apiBase()}/api/transactions/${checkout.transaction_id}/receipt.zpl?register_session_id=${encodeURIComponent(sessionId)}`,
      {
        headers: {
          "x-riverside-pos-session-id": sessionId,
          "x-riverside-pos-session-token": sessionToken,
        },
        failOnStatusCode: false,
      },
    );
    expect(receiptRes.status()).toBe(200);
    const receipt = await receiptRes.text();
    expect(receipt).toContain(`2x E2E Return Jacket`);
    expect(receipt).toContain(`SKU ${sku}  @ 100.00`);
    expect(receipt).toContain("Total 217.50");
  });
});
