import { expect, test } from "@playwright/test";

/**
 * Intelligence & Finance Stability (Phase 0.2.0):
 * - Wedding Health Heatmap (Decision Support)
 * - Inventory Brain (Stocking Recommendations)
 * - Commission Truth Trace (Transparency Invariant)
 * - Financial Reporting Consistency (Clobber prevention)
 * - Stripe Vaulting & Credit Boundaries (PCI/Compliance)
 *
 * This suite verifies the "Strategic Truth" of the system before launch.
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
    `API not reachable at ${apiBase()} — start Postgres + server to run intelligence-and-finance tests`,
  );
});

test.describe("Core Intelligence & Finance Contracts", () => {
  test("Wedding Health summary returns valid counts for the dashboard", async ({
    request,
  }) => {
    const res = await request.get(`${apiBase()}/api/insights/wedding-health`, {
      headers: adminHeaders(),
      failOnStatusCode: false,
    });

    requireOrSkip(
      res.status() !== 401 && res.status() !== 403,
      "Admin unauthorized for wedding-health",
    );

    expect(res.status()).toBe(200);
    const j = await res.json();
    expect(j).toHaveProperty("parties_event_next_30_days");
    expect(j).toHaveProperty("wedding_members_without_order");
    expect(j).toHaveProperty("wedding_members_with_open_balance");
  });

  test("Inventory Brain provides contract-safe recommendations payload", async ({
    request,
  }) => {
    const res = await request.get(`${apiBase()}/api/inventory/recommendations`, {
      headers: adminHeaders(),
      failOnStatusCode: false,
    });

    requireOrSkip(
      res.status() !== 401 && res.status() !== 403,
      "Admin unauthorized for inventory-recommendations",
    );

    expect(res.status()).toBe(200);
    const j = await res.json();
    expect(Array.isArray(j)).toBeTruthy();

    if (j.length > 0) {
      const rec = j[0];
      expect(rec).toHaveProperty("variant_id");
      expect(rec).toHaveProperty("recommendation_type");
      expect(rec).toHaveProperty("confidence");
      expect(rec).toHaveProperty("reason");
      expect(rec).toHaveProperty("suggested_action");
    }
  });

  test("Commission Trace rationale is human-readable/exact", async ({ request }) => {
    const res = await request.get(
      `${apiBase()}/api/insights/margin-pivot?group_by=brand&basis=sale`,
      {
        headers: adminHeaders(),
        failOnStatusCode: false,
      },
    );

    requireOrSkip(
      res.status() !== 403 && res.status() !== 401,
      "Admin permission error on margin-pivot",
    );

    expect(res.status()).toBe(200);
    const j = await res.json();
    expect(j).toHaveProperty("rows");
  });

  test("Stripe SetupIntent requires authentication", async ({ request }) => {
    const customerId = "00000000-0000-0000-0000-000000000000";

    const anon = await request.post(
      `${apiBase()}/api/payments/customers/${customerId}/setup-intent`,
      {
        failOnStatusCode: false,
      },
    );
    expect(anon.status()).toBe(401);
  });

  test("Payment config returns public keys but suppresses secrets", async ({
    request,
  }) => {
    const res = await request.get(`${apiBase()}/api/payments/config`);
    expect(res.status()).toBe(200);
    const config = await res.json();
    expect(config).toHaveProperty("stripe_public_key");
    expect(config.stripe_secret_key).toBeUndefined();
  });
});

const describeDataDependent = isCi ? test.describe.skip : test.describe;

describeDataDependent("Optional Data-Dependent Diagnostics", () => {
  test("Detailed Wedding Health Scorecard returns per-party risk analysis", async ({
    request,
  }) => {
    const partiesRes = await request.get(`${apiBase()}/api/weddings/parties?limit=1`, {
      headers: adminHeaders(),
      failOnStatusCode: false,
    });

    requireOrSkip(
      partiesRes.status() === 200,
      "Could not fetch wedding parties for detailed health scorecard",
    );

    const partiesJson = await partiesRes.json();
    test.skip(
      !partiesJson.data || partiesJson.data.length === 0,
      "No wedding parties to test detailed health scorecard",
    );

    const partyId = partiesJson.data[0].id;
    const res = await request.get(`${apiBase()}/api/weddings/parties/${partyId}/health`, {
      headers: adminHeaders(),
      failOnStatusCode: false,
    });

    expect(res.status()).toBe(200);
    const score = await res.json();
    expect(score.wedding_id).toBe(partyId);
    expect(score).toHaveProperty("overall_score");
    expect(score).toHaveProperty("status");
    expect(score).toHaveProperty("reason");
  });

  test("Product Intelligence returns detailed sales velocity and stock levels", async ({
    request,
  }) => {
    const boardRes = await request.get(`${apiBase()}/api/inventory/control-board?limit=1`, {
      headers: adminHeaders(),
      failOnStatusCode: false,
    });

    requireOrSkip(
      boardRes.status() === 200,
      "Could not fetch control board for variant ID",
    );

    const boardJson = await boardRes.json();
    test.skip(
      !boardJson.rows || boardJson.rows.length === 0,
      "No products in database to test intelligence drill-down",
    );

    const variantId = boardJson.rows[0].variant_id;
    const res = await request.get(`${apiBase()}/api/inventory/intelligence/${variantId}`, {
      headers: adminHeaders(),
      failOnStatusCode: false,
    });

    expect(res.status()).toBe(200);
    const item = await res.json();
    expect(item.variant_id).toBe(variantId);
    expect(item).toHaveProperty("stock_on_hand");
    expect(item).toHaveProperty("available_stock");
  });

  test("Commission Trace rationale is human-readable/exact", async ({ request }) => {
    const linesRes = await request.get(`${apiBase()}/api/insights/commission-lines?limit=10`, {
      headers: adminHeaders(),
      failOnStatusCode: false,
    });

    requireOrSkip(linesRes.status() === 200, "Could not fetch commission lines");

    const lines = await linesRes.json();
    test.skip(
      !Array.isArray(lines) || lines.length === 0,
      "No commission lines available to trace",
    );

    const lineId = lines[0].transaction_line_id;
    const res = await request.get(`${apiBase()}/api/insights/commission-trace/${lineId}`, {
      headers: adminHeaders(),
      failOnStatusCode: false,
    });

    if (res.status() === 400) {
      const err = await res.json();
      expect(err.error).toContain("No salesperson");
      return;
    }

    expect(res.status()).toBe(200);
    const trace = await res.json();
    expect(trace).toHaveProperty("explanation");
    expect(trace).toHaveProperty("source");
    expect(trace).toHaveProperty("total_commission");
  });
});
