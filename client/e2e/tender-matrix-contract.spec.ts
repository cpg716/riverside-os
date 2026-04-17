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
});
