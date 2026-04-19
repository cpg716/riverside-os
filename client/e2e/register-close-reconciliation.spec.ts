import { expect, test } from "@playwright/test";

function apiBase(): string {
  const raw =
    process.env.E2E_API_BASE?.trim() ||
    process.env.VITE_API_BASE?.trim() ||
    "http://127.0.0.1:3000";
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

const isCi = process.env.CI === "true" || process.env.CI === "1";

function requireOrSkip(condition: boolean, message: string): void {
  if (condition) return;
  if (isCi) {
    expect(condition, message).toBeTruthy();
    return;
  }
  test.skip(true, message);
}

type OpenSessionResponse = {
  session_id: string;
  pos_api_token?: string | null;
};

type OpenSessionRow = {
  session_id: string;
  register_lane: number;
  till_close_group_id: string;
};

type VerifyCashierResponse = {
  staff_id: string;
};

type ProductCreateResponse = {
  id: string;
};

type ProductVariantRow = {
  id: string;
};

type CheckoutResponse = {
  transaction_id: string;
};

type TransactionDetailResponse = {
  total_price: string;
};

type ReconciliationResponse = {
  expected_cash: string;
};

type RegisterSessionHistoryRow = {
  id: string;
  register_lane: number;
  total_sales: string;
};

let serverReachable = false;

test.beforeAll(async ({ request }) => {
  try {
    const res = await request.get(`${apiBase()}/api/staff/list-for-pos`, {
      timeout: 8000,
      failOnStatusCode: false,
    });
    serverReachable = res.status() > 0;
  } catch {
    serverReachable = false;
  }
});

test.beforeEach(() => {
  requireOrSkip(
    serverReachable,
    `API not reachable at ${apiBase()} — start Postgres + server to run register-close-reconciliation`,
  );
});

async function verifyAdminStaffId(
  request: Parameters<typeof test>[0]["request"],
): Promise<string> {
  const res = await request.post(`${apiBase()}/api/staff/verify-cashier-code`, {
    headers: { "Content-Type": "application/json" },
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

async function listOpenSessions(
  request: Parameters<typeof test>[0]["request"],
): Promise<OpenSessionRow[]> {
  const res = await request.get(`${apiBase()}/api/sessions/list-open`, {
    headers: adminHeaders(),
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as OpenSessionRow[];
}

async function issuePosToken(
  request: Parameters<typeof test>[0]["request"],
  sessionId: string,
): Promise<string> {
  const res = await request.post(`${apiBase()}/api/sessions/${sessionId}/pos-api-token`, {
    headers: {
      ...adminHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      cashier_code: e2eAdminCode(),
      pin: e2eAdminCode(),
    },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { pos_api_token?: string };
  expect(body.pos_api_token).toBeTruthy();
  return body.pos_api_token ?? "";
}

async function fetchReconciliation(
  request: Parameters<typeof test>[0]["request"],
  sessionId: string,
  sessionToken: string,
): Promise<ReconciliationResponse> {
  const res = await request.get(`${apiBase()}/api/sessions/${sessionId}/reconciliation`, {
    headers: {
      "x-riverside-pos-session-id": sessionId,
      "x-riverside-pos-session-token": sessionToken,
    },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as ReconciliationResponse;
}

async function closeRegisterGroup(
  request: Parameters<typeof test>[0]["request"],
  sessionId: string,
  sessionToken: string,
): Promise<void> {
  const recon = await fetchReconciliation(request, sessionId, sessionToken);
  const res = await request.post(`${apiBase()}/api/sessions/${sessionId}/close`, {
    headers: {
      "Content-Type": "application/json",
      "x-riverside-pos-session-id": sessionId,
      "x-riverside-pos-session-token": sessionToken,
    },
    data: {
      actual_cash: recon.expected_cash,
      closing_notes: null,
      closing_comments: null,
    },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
}

async function closeAnyExistingOpenGroup(
  request: Parameters<typeof test>[0]["request"],
): Promise<void> {
  const open = await listOpenSessions(request);
  const primary = open.find((row) => row.register_lane === 1);
  if (!primary) return;
  const token = await issuePosToken(request, primary.session_id);
  await closeRegisterGroup(request, primary.session_id, token);
}

async function openFreshPrimarySession(
  request: Parameters<typeof test>[0]["request"],
): Promise<OpenSessionResponse> {
  const res = await request.post(`${apiBase()}/api/sessions/open`, {
    headers: {
      ...adminHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      cashier_code: e2eAdminCode(),
      pin: e2eAdminCode(),
      opening_float: "200.00",
      register_lane: 1,
    },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as OpenSessionResponse;
  expect(body.session_id).toBeTruthy();
  expect(body.pos_api_token).toBeTruthy();
  return body;
}

async function createDeterministicProduct(
  request: Parameters<typeof test>[0]["request"],
  actorStaffId: string,
): Promise<{ productId: string; variantId: string }> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  const categoryRes = await request.post(`${apiBase()}/api/categories`, {
    headers: {
      ...adminHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      name: `E2E Register Close ${suffix}`,
      parent_id: null,
      is_clothing_footwear: false,
      changed_by_staff_id: actorStaffId,
      change_note: "Created for register close reconciliation coverage",
    },
    failOnStatusCode: false,
  });
  expect(categoryRes.status()).toBe(200);
  const category = (await categoryRes.json()) as { id: string };

  const createRes = await request.post(`${apiBase()}/api/products`, {
    headers: {
      ...adminHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      category_id: category.id,
      name: `E2E Register Close Item ${suffix}`,
      brand: "Riverside E2E",
      description: "Deterministic register close test product",
      base_retail_price: "100.00",
      base_cost: "40.00",
      variation_axes: [],
      variants: [
        {
          sku: `E2E-REG-CLOSE-${suffix}`,
          variation_values: {},
          variation_label: "One Size",
          stock_on_hand: 8,
        },
      ],
    },
    failOnStatusCode: false,
  });
  expect(createRes.status()).toBe(200);
  const created = (await createRes.json()) as ProductCreateResponse;

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
  };
}

test.describe("Register close / reconciliation", () => {
  test.describe.configure({ mode: "serial" });

  test("historical Z session list stays unified to Register #1 for a till-close group", async ({
    request,
  }) => {
    await closeAnyExistingOpenGroup(request);

    const operatorStaffId = await verifyAdminStaffId(request);
    const opened = await openFreshPrimarySession(request);
    const openRows = await listOpenSessions(request);
    const openGroup = openRows.filter(
      (row) => row.till_close_group_id === openRows[0]?.till_close_group_id,
    );
    expect(openGroup.map((row) => row.register_lane).sort()).toEqual([1, 2, 3]);

    const primary = openGroup.find((row) => row.register_lane === 1);
    const satellite = openGroup.find((row) => row.register_lane === 2);
    const tertiary = openGroup.find((row) => row.register_lane === 3);
    expect(primary?.session_id).toBe(opened.session_id);
    expect(satellite?.session_id).toBeTruthy();
    expect(tertiary?.session_id).toBeTruthy();

    const lane2Token = await issuePosToken(request, satellite?.session_id ?? "");
    const product = await createDeterministicProduct(request, operatorStaffId);

    const checkoutRes = await request.post(`${apiBase()}/api/transactions/checkout`, {
      headers: {
        "Content-Type": "application/json",
        "x-riverside-pos-session-id": satellite?.session_id ?? "",
        "x-riverside-pos-session-token": lane2Token,
      },
      data: {
        session_id: satellite?.session_id,
        operator_staff_id: operatorStaffId,
        primary_salesperson_id: operatorStaffId,
        customer_id: null,
        payment_method: "cash",
        total_price: "108.75",
        amount_paid: "108.75",
        items: [
          {
            product_id: product.productId,
            variant_id: product.variantId,
            fulfillment: "takeaway",
            quantity: 1,
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

    const detailRes = await request.get(
      `${apiBase()}/api/transactions/${checkout.transaction_id}?register_session_id=${encodeURIComponent(satellite?.session_id ?? "")}`,
      {
        headers: {
          "x-riverside-pos-session-id": satellite?.session_id ?? "",
          "x-riverside-pos-session-token": lane2Token,
        },
        failOnStatusCode: false,
      },
    );
    expect(detailRes.status()).toBe(200);
    const detail = (await detailRes.json()) as TransactionDetailResponse;

    await closeRegisterGroup(
      request,
      primary?.session_id ?? "",
      opened.pos_api_token ?? "",
    );

    const historyRes = await request.get(`${apiBase()}/api/insights/register-sessions?limit=10`, {
      headers: adminHeaders(),
      failOnStatusCode: false,
    });
    expect(historyRes.status()).toBe(200);
    const history = (await historyRes.json()) as RegisterSessionHistoryRow[];
    const primaryHistory = history.find((row) => row.id === primary?.session_id);
    expect(primaryHistory).toBeTruthy();
    expect(primaryHistory?.register_lane).toBe(1);
    expect(primaryHistory?.total_sales).toBe(detail.total_price);
    expect(history.some((row) => row.id === satellite?.session_id)).toBeFalsy();
    expect(history.some((row) => row.id === tertiary?.session_id)).toBeFalsy();
  });
});
