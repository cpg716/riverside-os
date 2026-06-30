import { expect, test } from "@playwright/test";
import { checkoutRmsPaymentCollection, seedRmsFixture } from "./helpers/rmsCharge";

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
  id?: string;
  register_lane?: number;
  lifecycle_status?: string;
};

type SessionOpenResponse = {
  session_id: string;
  pos_api_token?: string | null;
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
  const { sessionId } = await ensureSessionAuth(request);
  expect(sessionId).toBeTruthy();
  return sessionId;
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
      "x-riverside-station-key": "station-e2e",
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
    `${apiBase()}/api/sessions/${sessionId}/attach`,
    {
      headers: {
        ...adminHeaders(),
        "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
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

test.describe("Tender matrix payment-intent contract", () => {
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
    const fixture = await seedRmsFixture(request, "single_valid", "Tender Matrix");
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
      (beforePivot.rows ?? []).some((row) => row.customer_id === fixture.customer.id),
    ).toBeFalsy();

    const { response: checkoutRes } = await checkoutRmsPaymentCollection(
      request,
      fixture,
    );
    expect(checkoutRes.status()).toBe(200);
    const checkout = (await checkoutRes.json()) as CheckoutResponse;
    expect(checkout.transaction_id).toBeTruthy();

    const detailRes = await request.get(
      `${apiBase()}/api/transactions/${checkout.transaction_id}?register_session_id=${encodeURIComponent(sessionId)}`,
      {
        headers: {
          "x-riverside-pos-session-id": sessionId,
          "x-riverside-pos-session-token": sessionToken,
      "x-riverside-station-key": "station-e2e",
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
      `${apiBase()}/api/transactions/${checkout.transaction_id}/receipt.escpos?register_session_id=${encodeURIComponent(sessionId)}`,
      {
        headers: {
          "x-riverside-pos-session-id": sessionId,
          "x-riverside-pos-session-token": sessionToken,
      "x-riverside-station-key": "station-e2e",
        },
        failOnStatusCode: false,
      },
    );
    expect(receiptRes.status()).toBe(200);
    const receiptBody = await receiptRes.text();
    const receipt = (JSON.parse(receiptBody) as { receiptline_markdown?: string }).receiptline_markdown ?? "";
    expect(receipt).toContain("RMS CHARGE PAYMENT");
    expect(receipt).toMatch(/Total[\s\S]*50\.00/);
    expect(receipt).toContain("Cash");

    const rmsRecordsRes = await request.get(
      `${apiBase()}/api/customers/rms-charge/records?kind=payment&customer_id=${encodeURIComponent(fixture.customer.id)}&from=${today}&to=${today}`,
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
      (afterPivot.rows ?? []).some((row) => row.customer_id === fixture.customer.id),
    ).toBeFalsy();
  });
});
