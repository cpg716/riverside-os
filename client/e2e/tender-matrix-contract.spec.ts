import { expect, test } from "@playwright/test";

/**
 * Deterministic tender-matrix contract suite.
 *
 * Goal:
 * - Validate payment-intent API contract behavior per tender mode without relying on flaky UI/external hardware.
 * - Keep assertions stable across environments while still protecting checkout-critical logic.
 *
 * Notes:
 * - This suite is API-centric by design.
 * - It complements UI smoke specs (POS shell / exchange / help) and high-risk finance suites.
 */

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

type SessionListRow = {
  session_id?: string;
  id?: string;
  register_lane?: number;
  lifecycle_status?: string;
};

type SessionOpenResponse = {
  session_id: string;
  pos_api_token?: string | null;
};

type VerifyCashierResponse = {
  staff_id: string;
};

type RmsPaymentLineMeta = {
  product_id: string;
  variant_id: string;
  sku: string;
  name: string;
};

type CustomerProfileRow = {
  id: string;
};

type CheckoutResponse = {
  transaction_id: string;
};

type TransactionDetailResponse = {
  items: Array<{
    product_name: string;
    is_internal: boolean;
  }>;
};

type IntentResponse = {
  intent_id?: string;
  client_secret?: string;
  status?: string;
  error?: string;
};

const isCi = process.env.CI === "true" || process.env.CI === "1";

function requireOrSkip(condition: boolean, message: string): void {
  if (condition) return;
  if (isCi) {
    expect(condition, message).toBeTruthy();
    return;
  }
  test.skip(true, message);
}

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
    `API not reachable at ${apiBase()} — start DB + server for tender-matrix-contract`,
  );
});

async function requireOpenSessionId(
  request: Parameters<typeof test>[0]["request"],
): Promise<string> {
  const listRes = await request.get(`${apiBase()}/api/sessions/list-open`, {
    headers: adminHeaders(),
    failOnStatusCode: false,
  });

  requireOrSkip(
    listRes.status() !== 401 && listRes.status() !== 403,
    `Admin staff ${e2eAdminCode()} missing/unauthorized for /api/sessions/list-open`,
  );

  expect(listRes.status()).toBe(200);
  const rows = (await listRes.json()) as SessionListRow[];
  requireOrSkip(Array.isArray(rows) && rows.length > 0, "No open register session");
  const first = rows[0] ?? {};
  const sid = (first.session_id || first.id || "").trim();
  requireOrSkip(Boolean(sid), "Open session row missing session id");
  return sid;
}

async function ensureSessionAuth(
  request: Parameters<typeof test>[0]["request"],
): Promise<{ sessionId: string; sessionToken: string }> {
  const listRes = await request.get(`${apiBase()}/api/sessions/list-open`, {
    headers: adminHeaders(),
    failOnStatusCode: false,
  });

  requireOrSkip(
    listRes.status() !== 401 && listRes.status() !== 403,
    `Admin staff ${e2eAdminCode()} missing/unauthorized for /api/sessions/list-open`,
  );

  expect(listRes.status()).toBe(200);
  const rows = (await listRes.json()) as SessionListRow[];
  let sessionId = (rows[0]?.session_id || rows[0]?.id || "").trim();

  if (!sessionId) {
    const openRes = await request.post(`${apiBase()}/api/sessions/open`, {
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
    expect(openRes.status()).toBe(200);
    const opened = (await openRes.json()) as SessionOpenResponse;
    sessionId = opened.session_id;
    expect(opened.pos_api_token).toBeTruthy();
    return {
      sessionId,
      sessionToken: opened.pos_api_token ?? "",
    };
  }

  const tokenRes = await request.post(
    `${apiBase()}/api/sessions/${sessionId}/pos-api-token`,
    {
      headers: {
        ...adminHeaders(),
        "Content-Type": "application/json",
      },
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

async function fetchRmsPaymentMeta(
  request: Parameters<typeof test>[0]["request"],
): Promise<RmsPaymentLineMeta> {
  const res = await request.get(`${apiBase()}/api/pos/rms-payment-line-meta`, {
    headers: adminHeaders(),
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as RmsPaymentLineMeta | null;
  expect(body?.product_id).toBeTruthy();
  expect(body?.variant_id).toBeTruthy();
  return body as RmsPaymentLineMeta;
}

async function createDeterministicCustomer(
  request: Parameters<typeof test>[0]["request"],
): Promise<CustomerProfileRow> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  const res = await request.post(`${apiBase()}/api/customers`, {
    headers: {
      ...adminHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      first_name: "E2E RMS",
      last_name: `Customer ${suffix}`,
      email: null,
      phone: null,
      company_name: null,
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
      marketing_email_opt_in: false,
      marketing_sms_opt_in: false,
      transactional_sms_opt_in: false,
      transactional_email_opt_in: false,
    },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as CustomerProfileRow;
}

test.describe("Tender matrix payment-intent contract", () => {
  test("anonymous caller cannot create payment intent (auth gate)", async ({
    request,
  }) => {
    const res = await request.post(`${apiBase()}/api/payments/intent`, {
      data: { amount_due: "1.00" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(401);
  });

  test("manual card (MOTO) intent request returns contract-safe payload", async ({
    request,
  }) => {
    const sid = await requireOpenSessionId(request);

    const res = await request.post(`${apiBase()}/api/payments/intent`, {
      headers: {
        ...adminHeaders(),
        "Content-Type": "application/json",
        "x-riverside-pos-session-id": sid,
      },
      data: {
        amount_due: "12.34",
        moto: true,
        customer_id: null,
      },
      failOnStatusCode: false,
    });

    // Contract-safe expectation: endpoint should not 404; auth/session policy should be enforced.
    expect(res.status()).not.toBe(404);

    const text = await res.text();
    if (res.status() === 200) {
      const j = JSON.parse(text) as IntentResponse;
      expect(typeof j.intent_id).toBe("string");
      expect((j.intent_id ?? "").length).toBeGreaterThan(2);
    } else {
      // Accept explicit policy/validation statuses while ensuring structured JSON.
      expect(res.status()).toBeGreaterThanOrEqual(400);
      expect(res.status()).not.toBe(404);
      expect(res.status()).toBeLessThan(600);
      const j = JSON.parse(text) as { error?: unknown };
      expect(typeof j.error).toBe("string");
    }
  });

  test("card-reader mode intent request returns contract-safe payload", async ({
    request,
  }) => {
    const sid = await requireOpenSessionId(request);

    const res = await request.post(`${apiBase()}/api/payments/intent`, {
      headers: {
        ...adminHeaders(),
        "Content-Type": "application/json",
        "x-riverside-pos-session-id": sid,
      },
      data: {
        amount_due: "9.99",
        moto: false,
        customer_id: null,
      },
      failOnStatusCode: false,
    });

    expect(res.status()).not.toBe(404);

    const text = await res.text();
    if (res.status() === 200) {
      const j = JSON.parse(text) as IntentResponse;
      expect(typeof j.intent_id).toBe("string");
      expect((j.intent_id ?? "").length).toBeGreaterThan(2);
    } else {
      expect(res.status()).toBeGreaterThanOrEqual(400);
      expect(res.status()).not.toBe(404);
      expect(res.status()).toBeLessThan(600);
      const j = JSON.parse(text) as { error?: unknown };
      expect(typeof j.error).toBe("string");
    }
  });

  test("saved-card contract: invalid payment_method_id fails predictably", async ({
    request,
  }) => {
    const sid = await requireOpenSessionId(request);

    const res = await request.post(`${apiBase()}/api/payments/intent`, {
      headers: {
        ...adminHeaders(),
        "Content-Type": "application/json",
        "x-riverside-pos-session-id": sid,
      },
      data: {
        amount_due: "7.50",
        moto: false,
        customer_id: null,
        payment_method_id: "pm_not_a_real_id_for_e2e_contract",
      },
      failOnStatusCode: false,
    });

    // Should never be silent success with an invalid PM id in deterministic test data.
    expect(res.status()).not.toBe(404);
    expect(res.status()).not.toBe(200);

    const j = (await res.json().catch(() => ({}))) as { error?: unknown };
    expect(typeof j.error).toBe("string");
  });

  test("stripe-credit style contract: negative amount is rejected", async ({
    request,
  }) => {
    const sid = await requireOpenSessionId(request);

    const res = await request.post(`${apiBase()}/api/payments/intent`, {
      headers: {
        ...adminHeaders(),
        "Content-Type": "application/json",
        "x-riverside-pos-session-id": sid,
      },
      data: {
        amount_due: "-5.00",
        moto: false,
        customer_id: null,
        is_credit: true,
      },
      failOnStatusCode: false,
    });

    // Negative amount should not create a charge intent.
    expect(res.status()).not.toBe(404);
    expect(res.status()).not.toBe(200);

    const j = (await res.json().catch(() => ({}))) as { error?: unknown };
    expect(typeof j.error).toBe("string");
  });

  test("intent cancel endpoint rejects invalid IDs with structured error", async ({
    request,
  }) => {
    const sid = await requireOpenSessionId(request);

    const res = await request.post(`${apiBase()}/api/payments/intent/cancel`, {
      headers: {
        ...adminHeaders(),
        "Content-Type": "application/json",
        "x-riverside-pos-session-id": sid,
      },
      data: { intent_id: "pi_not_real_e2e_contract" },
      failOnStatusCode: false,
    });

    expect(res.status()).not.toBe(404);
    expect([400, 401, 403, 404, 409, 422, 429, 500]).toContain(res.status());

    const j = (await res.json().catch(() => ({}))) as { error?: unknown };
    expect(typeof j.error).toBe("string");
  });

  test("non-card tender contract remains session-safe (list-open + current)", async ({
    request,
  }) => {
    const sid = await requireOpenSessionId(request);

    const currentRes = await request.get(`${apiBase()}/api/sessions/current`, {
      headers: {
        ...adminHeaders(),
        "x-riverside-pos-session-id": sid,
      },
      failOnStatusCode: false,
    });

    expect(currentRes.status()).not.toBe(404);
    expect([200, 401, 403]).toContain(currentRes.status());

    if (currentRes.status() === 200) {
      const j = (await currentRes.json()) as {
        session_id?: string;
        register_lane?: number;
      };
      expect(typeof j.session_id).toBe("string");
      expect(typeof j.register_lane).toBe("number");
    }
  });

  test("RMS payment collection stays internal to receipts and sales pivot revenue", async ({
    request,
  }) => {
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const staffId = await verifyAdminStaffId(request);
    const customer = await createDeterministicCustomer(request);
    const rmsMeta = await fetchRmsPaymentMeta(request);
    const today = new Date().toISOString().split("T")[0];

    const beforePivotRes = await request.get(
      `${apiBase()}/api/insights/sales-pivot?group_by=customer&basis=sale&from=${today}&to=${today}`,
      {
        headers: adminHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(beforePivotRes.status()).toBe(200);
    const beforePivot = (await beforePivotRes.json()) as {
      rows?: Array<{ customer_id?: string | null }>;
    };
    expect(
      (beforePivot.rows ?? []).some((row) => row.customer_id === customer.id),
    ).toBeFalsy();

    const checkoutRes = await request.post(`${apiBase()}/api/transactions/checkout`, {
      headers: {
        "Content-Type": "application/json",
        "x-riverside-pos-session-id": sessionId,
        "x-riverside-pos-session-token": sessionToken,
      },
      data: {
        session_id: sessionId,
        operator_staff_id: staffId,
        primary_salesperson_id: staffId,
        customer_id: customer.id,
        payment_method: "cash",
        total_price: "50.00",
        amount_paid: "50.00",
        items: [
          {
            product_id: rmsMeta.product_id,
            variant_id: rmsMeta.variant_id,
            fulfillment: "takeaway",
            quantity: 1,
            unit_price: "50.00",
            unit_cost: "0.00",
            state_tax: "0.00",
            local_tax: "0.00",
            salesperson_id: staffId,
          },
        ],
      },
      failOnStatusCode: false,
    });
    expect(checkoutRes.status()).toBe(200);
    const checkout = (await checkoutRes.json()) as CheckoutResponse;
    expect(checkout.transaction_id).toBeTruthy();

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
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]?.product_name).toBe("RMS CHARGE PAYMENT");
    expect(detail.items[0]?.is_internal).toBe(true);

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
    expect(receipt).not.toContain("RMS CHARGE PAYMENT");
    expect(receipt).toContain("Total 50.00");
    expect(receipt).toContain("Cash");

    const rmsRecordsRes = await request.get(
      `${apiBase()}/api/customers/rms-charge/records?kind=payment&customer_id=${encodeURIComponent(customer.id)}&from=${today}&to=${today}`,
      {
        headers: adminHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(rmsRecordsRes.status()).toBe(200);
    const rmsRecords = (await rmsRecordsRes.json()) as Array<{
      transaction_id?: string;
      amount?: string;
      payment_method?: string;
      record_kind?: string;
    }>;
    const rmsRecord = rmsRecords.find(
      (row) => row.transaction_id === checkout.transaction_id,
    );
    expect(rmsRecord?.record_kind).toBe("payment");
    expect(rmsRecord?.payment_method).toBe("cash");
    expect(rmsRecord?.amount).toBe("50.00");

    const afterPivotRes = await request.get(
      `${apiBase()}/api/insights/sales-pivot?group_by=customer&basis=sale&from=${today}&to=${today}`,
      {
        headers: adminHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(afterPivotRes.status()).toBe(200);
    const afterPivot = (await afterPivotRes.json()) as {
      rows?: Array<{ customer_id?: string | null }>;
    };
    expect(
      (afterPivot.rows ?? []).some((row) => row.customer_id === customer.id),
    ).toBeFalsy();
  });
});
