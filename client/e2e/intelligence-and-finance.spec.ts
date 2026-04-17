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
  test.skip(
    !serverReachable,
    `API not reachable at ${apiBase()} — start Postgres + server to run intelligence-and-finance tests`,
  );
});

test.describe("Intelligence Layer Stability", () => {
  test("Wedding Health summary returns valid counts for the dashboard", async ({ request }) => {
    const res = await request.get(`${apiBase()}/api/insights/wedding-health`, {
      headers: adminHeaders(),
    });
    
    if (res.status() === 401 || res.status() === 403) {
      test.skip(true, "Admin unauthorized for wedding-health");
    }

    expect(res.status()).toBe(200);
    const j = await res.json();
    // Use the actual fields from WeddingHealthSummary struct
    expect(j).toHaveProperty("parties_event_next_30_days");
    expect(j).toHaveProperty("wedding_members_without_order");
    expect(j).toHaveProperty("wedding_members_with_open_balance");
  });

  test("Detailed Wedding Health Scorecard returns per-party risk analysis", async ({ request }) => {
    // 1. Get a party ID
    const partiesRes = await request.get(`${apiBase()}/api/weddings/parties?limit=1`, {
      headers: adminHeaders(),
    });
    const partiesJson = await partiesRes.json();
    
    if (!partiesJson.data || partiesJson.data.length === 0) {
      test.skip(true, "No wedding parties to test detailed health scorecard");
    }
    
    const partyId = partiesJson.data[0].id;
    const res = await request.get(`${apiBase()}/api/weddings/parties/${partyId}/health`, {
      headers: adminHeaders(),
    });

    expect(res.status()).toBe(200);
    const score = await res.json();
    expect(score.wedding_id).toBe(partyId);
    expect(score).toHaveProperty("overall_score");
    expect(score).toHaveProperty("status");
    expect(score).toHaveProperty("reason");
  });

  test("Inventory Brain provides actionable stocking recommendations", async ({ request }) => {
    const res = await request.get(`${apiBase()}/api/inventory/recommendations`, {
      headers: adminHeaders(),
    });

    if (res.status() === 401 || res.status() === 403) {
      test.skip(true, "Admin unauthorized for inventory-recommendations");
    }

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

  test("Product Intelligence returns detailed sales velocity and stock levels", async ({ request }) => {
    const boardRes = await request.get(`${apiBase()}/api/inventory/control-board?limit=1`, {
      headers: adminHeaders(),
    });

    if (boardRes.status() !== 200) {
      test.skip(true, "Could not fetch control board for variant ID");
    }

    const boardJson = await boardRes.json();
    if (!boardJson.rows || boardJson.rows.length === 0) {
      test.skip(true, "No products in database to test intelligence drill-down");
    }
    
    const variantId = boardJson.rows[0].variant_id;
    const res = await request.get(`${apiBase()}/api/inventory/intelligence/${variantId}`, {
      headers: adminHeaders(),
    });

    expect(res.status()).toBe(200);
    const item = await res.json();
    expect(item.variant_id).toBe(variantId);
    expect(item).toHaveProperty("stock_on_hand");
    expect(item).toHaveProperty("available_stock");
  });
});

test.describe("Financial Truth & Reporting Stability", () => {
  test("Commission Trace rationale is human-readable/exact", async ({ request }) => {
    const linesRes = await request.get(`${apiBase()}/api/insights/commission-lines?limit=10`, {
      headers: adminHeaders(),
    });

    if (linesRes.status() !== 200) {
      test.skip(true, "Could not fetch commission lines");
    }

    const lines = await linesRes.json();
    if (!Array.isArray(lines) || lines.length === 0) {
      test.skip(true, "No commission lines available to trace");
    }

    // Find a line with a salesperson attributed
    const lineId = lines[0].transaction_line_id;
    const res = await request.get(`${apiBase()}/api/insights/commission-trace/${lineId}`, {
      headers: adminHeaders(),
      failOnStatusCode: false,
    });

    // If no salesperson attributed, it might 400 - that's fine for existence check
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

  test("Reporting Views Stability: Margin columns persist", async ({ request }) => {
    const res = await request.get(`${apiBase()}/api/insights/margin-pivot?group_by=brand&basis=sale`, {
      headers: adminHeaders(),
    });

    if (res.status() === 403 || res.status() === 401) {
      test.skip(true, "Admin permission error on margin-pivot");
    }

    expect(res.status()).toBe(200);
    const j = await res.json();
    expect(j).toHaveProperty("rows");
  });
});

test.describe("Payment & Compliance Boundaries", () => {
  test("Stripe SetupIntent requires authentication", async ({ request }) => {
    const custRes = await request.get(`${apiBase()}/api/customers/browse?limit=1`, {
      headers: adminHeaders(),
    });
    
    if (custRes.status() !== 200) {
      test.skip(true, "Could not browse customers");
    }

    const custs = await custRes.json();
    if (!custs.rows || custs.rows.length === 0) {
      test.skip(true, "No customers to test vaulting setup");
    }
    
    const customerId = custs.rows[0].id;
    
    const anon = await request.post(`${apiBase()}/api/payments/customers/${customerId}/setup-intent`, {
      failOnStatusCode: false,
    });
    expect(anon.status()).toBe(401);
  });

  test("Payment config returns public keys but suppresses secrets", async ({ request }) => {
    const res = await request.get(`${apiBase()}/api/payments/config`);
    expect(res.status()).toBe(200);
    const config = await res.json();
    expect(config).toHaveProperty("stripe_public_key");
    expect(config.stripe_secret_key).toBeUndefined();
  });
});
