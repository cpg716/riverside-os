import { expect, test } from "@playwright/test";

/**
 * Verifies gated APIs reject anonymous callers (Appendix B.4 backend checklist).
 * Requires `riverside-server` listening on E2E_API_BASE (default http://127.0.0.1:43300).
 */
function apiBase(): string {
  const raw =
    process.env.E2E_API_BASE?.trim() ||
    process.env.VITE_API_BASE?.trim() ||
    "http://127.0.0.1:43300";
  return raw.replace(/\/$/, "");
}

/** Non-Admin staff for margin-pivot 403 gate; seed via `scripts/seed_e2e_non_admin_staff.sql`. */
function e2eNonAdminStaffCode(): string {
  return process.env.E2E_NON_ADMIN_CODE?.trim() || "5678";
}

function nonAdminHeaders(): Record<string, string> {
  const code = e2eNonAdminStaffCode();
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
    `API not reachable at ${apiBase()} — start Postgres + riverside-server to run api-gates`,
  );
});

test.describe("API auth gates", () => {
  test("GET /api/products without staff headers returns 401", async ({
    request,
  }) => {
    const res = await request.get(`${apiBase()}/api/products`);
    expect(res.status(), `body: ${(await res.text()).slice(0, 200)}`).toBe(401);
  });

  test("POST /api/payments/providers/helcim/purchase without auth returns 401", async ({
    request,
  }) => {
    /** Playwright `APIRequestContext` ignores `json`; use `data` so `Content-Type: application/json` is set. */
    const res = await request.post(`${apiBase()}/api/payments/providers/helcim/purchase`, {
      data: { amount_cents: 100, currency: "usd" },
    });
    expect(res.status()).toBe(401);
  });

  test("expanded Helcim provider endpoints reject anonymous callers", async ({
    request,
  }) => {
    const postCases: Array<{ path: string; data: unknown }> = [
      {
        path: "/api/payments/providers/helcim/terminal/refund",
        data: { amount_cents: 100, original_transaction_id: 123 },
      },
      {
        path: "/api/payments/providers/helcim/card-token/purchase",
        data: {
          amount_cents: 100,
          customer_id: "00000000-0000-0000-0000-000000000000",
          helcim_customer_id: "1",
          helcim_card_id: "1",
          currency: "usd",
        },
      },
      {
        path: "/api/payments/providers/helcim/card/refund",
        data: { amount_cents: 100, original_transaction_id: 123 },
      },
      {
        path: "/api/payments/providers/helcim/card/reverse",
        data: { original_transaction_id: 123 },
      },
      {
        path: "/api/payments/providers/helcim/helcim-pay/initialize",
        data: { amount_cents: 100, currency: "usd" },
      },
      {
        path: "/api/payments/providers/helcim/helcim-pay/confirm",
        data: {
          attempt_id: "00000000-0000-0000-0000-000000000000",
          checkout_token: "checkout",
          data: {},
          hash: "hash",
        },
      },
      {
        path: "/api/payments/providers/helcim/fees/sync",
        data: {},
      },
      {
        path: "/api/payments/providers/helcim/customers/1/cards/1/default",
        data: {},
      },
    ];

    for (const { path, data } of postCases) {
      const res = await request.post(`${apiBase()}${path}`, {
        data,
        failOnStatusCode: false,
      });
      expect(res.status(), `${path} should require auth`).toBe(401);
    }

    const getCases = [
      "/api/payments/providers/helcim/customers",
      "/api/payments/providers/helcim/customers/1/cards",
      "/api/payments/providers/helcim/fees/status",
    ];
    for (const path of getCases) {
      const res = await request.get(`${apiBase()}${path}`, {
        failOnStatusCode: false,
      });
      expect(res.status(), `${path} should require auth`).toBe(401);
    }

    const deleteRes = await request.delete(
      `${apiBase()}/api/payments/providers/helcim/customers/1/cards/1`,
      { failOnStatusCode: false },
    );
    expect(deleteRes.status()).toBe(401);
  });

  test("Helcim Payments Operations read endpoints reject anonymous callers", async ({
    request,
  }) => {
    const getCases = [
      "/api/payments/providers/helcim/operations/overview",
      "/api/payments/providers/helcim/batches",
      "/api/payments/providers/helcim/batches/00000000-0000-0000-0000-000000000000",
      "/api/payments/providers/helcim/batches/00000000-0000-0000-0000-000000000000/transactions",
      "/api/payments/providers/helcim/reconciliation/items",
      "/api/payments/providers/helcim/reconciliation/items/00000000-0000-0000-0000-000000000000/candidate-payments",
      "/api/payments/providers/helcim/transactions",
      "/api/payments/providers/helcim/transactions/00000000-0000-0000-0000-000000000000",
      "/api/payments/providers/helcim/sync/runs",
      "/api/payments/providers/helcim/events/health",
      "/api/payments/providers/helcim/deposits",
      "/api/payments/providers/helcim/deposits/00000000-0000-0000-0000-000000000000",
      "/api/payments/providers/helcim/deposits/unmatched-batches",
      "/api/payments/providers/helcim/deposits/unmatched-deposits",
    ];

    for (const path of getCases) {
      const res = await request.get(`${apiBase()}${path}`, {
        failOnStatusCode: false,
      });
      expect(res.status(), `${path} should require auth`).toBe(401);
    }
  });

  test("Helcim Payments Operations mutation endpoints reject anonymous callers", async ({
    request,
  }) => {
    const uuid = "00000000-0000-0000-0000-000000000000";
    const cases: Array<{
      method: "post" | "patch";
      path: string;
      data: Record<string, unknown>;
    }> = [
      {
        method: "post",
        path: "/api/payments/providers/helcim/settlements/sync",
        data: {},
      },
      {
        method: "post",
        path: "/api/payments/providers/helcim/fees/sync",
        data: {},
      },
      {
        method: "patch",
        path: `/api/payments/providers/helcim/reconciliation/items/${uuid}/status`,
        data: { action: "reviewed" },
      },
      {
        method: "post",
        path: `/api/payments/providers/helcim/reconciliation/items/${uuid}/notes`,
        data: { note: "E2E gate" },
      },
      {
        method: "post",
        path: `/api/payments/providers/helcim/reconciliation/items/${uuid}/link-payment`,
        data: { payment_transaction_id: uuid, note: "E2E gate" },
      },
      {
        method: "post",
        path: "/api/payments/providers/helcim/deposits",
        data: {
          posted_at: new Date().toISOString(),
          amount: "1.00",
          note: "E2E gate",
        },
      },
      {
        method: "post",
        path: `/api/payments/providers/helcim/deposits/${uuid}/link-batches`,
        data: { batch_ids: [uuid], note: "E2E gate" },
      },
      {
        method: "post",
        path: `/api/payments/providers/helcim/deposits/${uuid}/notes`,
        data: { note: "E2E gate" },
      },
      {
        method: "patch",
        path: `/api/payments/providers/helcim/deposits/${uuid}/review`,
        data: { note: "E2E gate" },
      },
      {
        method: "post",
        path: `/api/payments/providers/helcim/deposits/${uuid}/reopen`,
        data: {},
      },
      {
        method: "post",
        path: "/api/payments/providers/helcim/deposits/reconciliation/runs",
        data: {},
      },
    ];

    for (const testCase of cases) {
      const options = {
        data: testCase.data,
        failOnStatusCode: false,
      };
      const res =
        testCase.method === "post"
          ? await request.post(`${apiBase()}${testCase.path}`, options)
          : await request.patch(`${apiBase()}${testCase.path}`, options);
      expect(res.status(), `${testCase.path} should require auth`).toBe(401);
    }
  });

  test("Helcim manual sync endpoints require payments.sync beyond basic staff auth", async ({
    request,
  }) => {
    const code = e2eNonAdminStaffCode();
    const cases = [
      "/api/payments/providers/helcim/fees/sync",
      "/api/payments/providers/helcim/settlements/sync",
    ];

    for (const path of cases) {
      const res = await request.post(`${apiBase()}${path}`, {
        headers: nonAdminHeaders(),
        data: {},
        failOnStatusCode: false,
      });
      expect(res.status(), `Seeded non-admin staff ${code} must authenticate`).not.toBe(401);
      expect(res.status(), `${path} should require payments.sync`).toBe(403);
    }
  });

  test("Helcim reconciliation mutations require payments.reconcile beyond basic staff auth", async ({
    request,
  }) => {
    const code = e2eNonAdminStaffCode();
    const uuid = "00000000-0000-0000-0000-000000000000";
    const cases: Array<{
      method: "post" | "patch";
      path: string;
      data: Record<string, unknown>;
    }> = [
      {
        method: "patch",
        path: `/api/payments/providers/helcim/reconciliation/items/${uuid}/status`,
        data: { action: "reviewed" },
      },
      {
        method: "post",
        path: `/api/payments/providers/helcim/reconciliation/items/${uuid}/notes`,
        data: { note: "E2E gate" },
      },
      {
        method: "post",
        path: `/api/payments/providers/helcim/reconciliation/items/${uuid}/link-payment`,
        data: { payment_transaction_id: uuid, note: "E2E gate" },
      },
    ];

    for (const testCase of cases) {
      const options = {
        headers: nonAdminHeaders(),
        data: testCase.data,
        failOnStatusCode: false,
      };
      const res =
        testCase.method === "post"
          ? await request.post(`${apiBase()}${testCase.path}`, options)
          : await request.patch(`${apiBase()}${testCase.path}`, options);
      expect(res.status(), `Seeded non-admin staff ${code} must authenticate`).not.toBe(401);
      expect(res.status(), `${testCase.path} should require payments.reconcile`).toBe(403);
    }
  });

  test("Helcim deposit mutations require dedicated deposit permissions", async ({
    request,
  }) => {
    const code = e2eNonAdminStaffCode();
    const uuid = "00000000-0000-0000-0000-000000000000";
    const cases: Array<{
      method: "post" | "patch";
      path: string;
      data: Record<string, unknown>;
      permission: string;
    }> = [
      {
        method: "post",
        path: "/api/payments/providers/helcim/deposits",
        data: {
          posted_at: new Date().toISOString(),
          amount: "1.00",
          note: "E2E gate",
        },
        permission: "payments.deposit.adjust",
      },
      {
        method: "post",
        path: `/api/payments/providers/helcim/deposits/${uuid}/link-batches`,
        data: { batch_ids: [uuid], note: "E2E gate" },
        permission: "payments.deposit.link",
      },
      {
        method: "post",
        path: `/api/payments/providers/helcim/deposits/${uuid}/notes`,
        data: { note: "E2E gate" },
        permission: "payments.deposit.review",
      },
      {
        method: "patch",
        path: `/api/payments/providers/helcim/deposits/${uuid}/review`,
        data: { note: "E2E gate" },
        permission: "payments.deposit.review",
      },
      {
        method: "patch",
        path: `/api/payments/providers/helcim/deposits/${uuid}/review`,
        data: { accept_variance: true, note: "E2E gate" },
        permission: "payments.deposit.adjust",
      },
      {
        method: "post",
        path: `/api/payments/providers/helcim/deposits/${uuid}/reopen`,
        data: {},
        permission: "payments.deposit.review",
      },
      {
        method: "post",
        path: "/api/payments/providers/helcim/deposits/reconciliation/runs",
        data: {},
        permission: "payments.deposit.review",
      },
    ];

    for (const testCase of cases) {
      const options = {
        headers: nonAdminHeaders(),
        data: testCase.data,
        failOnStatusCode: false,
      };
      const res =
        testCase.method === "post"
          ? await request.post(`${apiBase()}${testCase.path}`, options)
          : await request.patch(`${apiBase()}${testCase.path}`, options);
      expect(res.status(), `Seeded non-admin staff ${code} must authenticate`).not.toBe(401);
      expect(res.status(), `${testCase.path} should require ${testCase.permission}`).toBe(403);
    }
  });

  test("GET /api/settings/receipt without staff returns 401 or 403", async ({
    request,
  }) => {
    const res = await request.get(`${apiBase()}/api/settings/receipt`);
    expect([401, 403]).toContain(res.status());
  });

  test("GET /api/customers/{id}/transaction-history without staff returns 401", async ({
    request,
  }) => {
    const res = await request.get(
      `${apiBase()}/api/customers/00000000-0000-0000-0000-000000000000/transaction-history`,
    );
    expect(res.status()).toBe(401);
  });

  test("GET /api/insights/sales-pivot?group_by=customer without staff returns 401", async ({
    request,
  }) => {
    const res = await request.get(
      `${apiBase()}/api/insights/sales-pivot?group_by=customer&basis=sale`,
    );
    expect(res.status()).toBe(401);
  });

  test("GET /api/insights/best-sellers without staff returns 401", async ({
    request,
  }) => {
    const res = await request.get(
      `${apiBase()}/api/insights/best-sellers?limit=5&basis=sale`,
    );
    expect(res.status()).toBe(401);
  });

  test("GET /api/insights/margin-pivot without staff returns 401", async ({
    request,
  }) => {
    const res = await request.get(
      `${apiBase()}/api/insights/margin-pivot?group_by=brand&basis=sale`,
    );
    expect(res.status()).toBe(401);
  });

  test("GET /api/insights/margin-pivot with non-Admin staff returns 403", async ({
    request,
  }) => {
    const code = e2eNonAdminStaffCode();
    const res = await request.get(
      `${apiBase()}/api/insights/margin-pivot?group_by=brand&basis=sale`,
      {
        headers: nonAdminHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(res.status(), `Seeded non-admin staff ${code} must authenticate`).not.toBe(401);
    expect(res.status()).toBe(403);
  });

  test("GET /api/staff/effective-permissions with seeded 1234+1234 returns 200 and permissions", async ({
    request,
  }) => {
    const code = process.env.E2E_BO_STAFF_CODE?.trim() || "1234";
    const res = await request.get(
      `${apiBase()}/api/staff/effective-permissions`,
      {
        headers: {
          "x-riverside-staff-code": code,
          "x-riverside-staff-pin": code,
        },
        failOnStatusCode: false,
      },
    );
    requireOrSkip(
      res.status() !== 401 && res.status() !== 403,
      `No valid staff for code ${code} — apply migration 53 and seed (scripts/seed_staff_register_test.sql)`,
    );
    expect(res.status()).toBe(200);
    const j = (await res.json()) as { permissions?: string[] };
    expect(Array.isArray(j.permissions)).toBeTruthy();
    expect(j.permissions!.length).toBeGreaterThan(0);
  });

  test("Staff Access session is opaque, connection-bound, usable, and revocable", async ({
    request,
  }) => {
    const code = process.env.E2E_BO_STAFF_CODE?.trim() || "1234";
    const legacy = await request.get(`${apiBase()}/api/staff/effective-permissions`, {
      headers: {
        "x-riverside-staff-code": code,
        "x-riverside-staff-pin": code,
      },
      failOnStatusCode: false,
    });
    requireOrSkip(legacy.ok(), `No valid seeded staff for code ${code}`);
    const staff = (await legacy.json()) as { staff_id?: string };
    expect(staff.staff_id).toBeTruthy();

    const stationKey = "station-e2e-staff-session";
    const connectionKey = "connection-e2e-staff-session";
    const created = await request.post(`${apiBase()}/api/staff/session`, {
      data: {
        staff_id: staff.staff_id,
        pin: code,
        station_key: stationKey,
        connection_key: connectionKey,
        runtime_surface: "browser_tab",
      },
      failOnStatusCode: false,
    });
    const createdBody = await created.text();
    expect(created.status(), createdBody).toBe(200);
    const issued = JSON.parse(createdBody) as { session_token?: string };
    expect(issued.session_token).toBeTruthy();
    expect(issued.session_token).not.toBe(code);

    const headers = {
      "x-riverside-staff-code": code,
      "x-riverside-staff-session": issued.session_token!,
      "x-riverside-station-key": stationKey,
      "x-riverside-connection-key": connectionKey,
    };
    const accepted = await request.get(
      `${apiBase()}/api/staff/effective-permissions`,
      { headers, failOnStatusCode: false },
    );
    expect(accepted.status()).toBe(200);

    const copied = await request.get(
      `${apiBase()}/api/staff/effective-permissions`,
      {
        headers: { ...headers, "x-riverside-connection-key": "connection-e2e-other" },
        failOnStatusCode: false,
      },
    );
    expect([401, 403]).toContain(copied.status());

    const revoked = await request.delete(`${apiBase()}/api/staff/session`, {
      headers,
      failOnStatusCode: false,
    });
    expect(revoked.status()).toBe(204);
    const afterRevoke = await request.get(
      `${apiBase()}/api/staff/effective-permissions`,
      { headers, failOnStatusCode: false },
    );
    expect([401, 403]).toContain(afterRevoke.status());
  });

  test("GET /api/sessions/list-open with staff headers returns 200 array (till / attach)", async ({
    request,
  }) => {
    const code = process.env.E2E_BO_STAFF_CODE?.trim() || "1234";
    const res = await request.get(`${apiBase()}/api/sessions/list-open`, {
      headers: {
        "x-riverside-staff-code": code,
        "x-riverside-staff-pin": code,
      },
      failOnStatusCode: false,
    });
    requireOrSkip(
      res.status() !== 401 && res.status() !== 403,
      "Staff headers not accepted for list-open",
    );
    expect(res.status()).toBe(200);
    const rows = (await res.json()) as unknown[];
    expect(Array.isArray(rows)).toBeTruthy();
  });

  test("GET /api/insights/margin-pivot with Admin staff returns 200 and margin payload shape", async ({
    request,
  }) => {
    const code = process.env.E2E_BO_STAFF_CODE?.trim() || "1234";
    const res = await request.get(
      `${apiBase()}/api/insights/margin-pivot?group_by=brand&basis=sale`,
      {
        headers: {
          "x-riverside-staff-code": code,
          "x-riverside-staff-pin": code,
        },
        failOnStatusCode: false,
      },
    );
    requireOrSkip(
      res.status() !== 401 && res.status() !== 403,
      `Margin pivot requires Admin staff for code ${code} — use default migration 53 admin or set E2E_BO_STAFF_CODE`,
    );
    const body = await res.text();
    expect(res.status(), `body: ${body.slice(0, 400)}`).toBe(200);
    const j = JSON.parse(body) as { rows?: unknown[]; truncated?: boolean };
    expect(Array.isArray(j.rows)).toBeTruthy();
    expect(typeof j.truncated).toBe("boolean");
  });

  test("GET /api/help/admin/ops/status without staff returns 401", async ({
    request,
  }) => {
    const res = await request.get(`${apiBase()}/api/help/admin/ops/status`);
    expect(res.status()).toBe(401);
  });

  test("POST /api/help/admin/ops/generate-manifest without staff returns 401", async ({
    request,
  }) => {
    const res = await request.post(
      `${apiBase()}/api/help/admin/ops/generate-manifest`,
      {
        data: {
          dry_run: true,
          include_shadcn: false,
          rescan_components: false,
          cleanup_orphans: false,
        },
      },
    );
    expect(res.status()).toBe(401);
  });

  test("POST /api/help/admin/ops/reindex-search without staff returns 401", async ({
    request,
  }) => {
    const res = await request.post(
      `${apiBase()}/api/help/admin/ops/reindex-search`,
      {
        data: { full_reindex_fallback: true },
      },
    );
    expect(res.status()).toBe(401);
  });

  test("GET /api/help/admin/ops/status with non-Admin staff returns 403", async ({
    request,
  }) => {
    const code = e2eNonAdminStaffCode();
    const res = await request.get(`${apiBase()}/api/help/admin/ops/status`, {
      headers: nonAdminHeaders(),
      failOnStatusCode: false,
    });
    expect(res.status(), `Seeded non-admin staff ${code} must authenticate`).not.toBe(401);
    expect(res.status()).toBe(403);
  });

  test("POST /api/help/admin/ops/generate-manifest with non-Admin staff returns 403", async ({
    request,
  }) => {
    const code = e2eNonAdminStaffCode();
    const res = await request.post(
      `${apiBase()}/api/help/admin/ops/generate-manifest`,
      {
        headers: nonAdminHeaders(),
        data: {
          dry_run: true,
          include_shadcn: false,
          rescan_components: false,
          cleanup_orphans: false,
        },
        failOnStatusCode: false,
      },
    );
    expect(res.status(), `Seeded non-admin staff ${code} must authenticate`).not.toBe(401);
    expect(res.status()).toBe(403);
  });

  test("POST /api/help/admin/ops/reindex-search with non-Admin staff returns 403", async ({
    request,
  }) => {
    const code = e2eNonAdminStaffCode();
    const res = await request.post(
      `${apiBase()}/api/help/admin/ops/reindex-search`,
      {
        headers: nonAdminHeaders(),
        data: { full_reindex_fallback: true },
        failOnStatusCode: false,
      },
    );
    expect(res.status(), `Seeded non-admin staff ${code} must authenticate`).not.toBe(401);
    expect(res.status()).toBe(403);
  });

  test("GET /api/help/admin/ops/status with Admin staff returns 200 and shape", async ({
    request,
  }) => {
    const code = process.env.E2E_BO_STAFF_CODE?.trim() || "1234";
    const res = await request.get(`${apiBase()}/api/help/admin/ops/status`, {
      headers: {
        "x-riverside-staff-code": code,
        "x-riverside-staff-pin": code,
      },
      failOnStatusCode: false,
    });
    requireOrSkip(
      res.status() !== 401 && res.status() !== 403,
      `Help admin ops status requires help.manage for code ${code} — use default admin or set E2E_BO_STAFF_CODE`,
    );
    expect(res.status()).toBe(200);
    const j = (await res.json()) as {
      meilisearch_configured?: unknown;
      meilisearch_indexing?: unknown;
      node_available?: unknown;
      script_exists?: unknown;
      help_docs_dir_exists?: unknown;
    };
    expect(typeof j.meilisearch_configured).toBe("boolean");
    expect(typeof j.meilisearch_indexing).toBe("boolean");
    expect(typeof j.node_available).toBe("boolean");
    expect(typeof j.script_exists).toBe("boolean");
    expect(typeof j.help_docs_dir_exists).toBe("boolean");
  });

  test("POST /api/help/admin/ops/generate-manifest with Admin staff returns terminal result shape", async ({
    request,
  }) => {
    const code = process.env.E2E_BO_STAFF_CODE?.trim() || "1234";
    const res = await request.post(
      `${apiBase()}/api/help/admin/ops/generate-manifest`,
      {
        headers: {
          "x-riverside-staff-code": code,
          "x-riverside-staff-pin": code,
        },
        data: {
          dry_run: true,
          include_shadcn: false,
          rescan_components: false,
          cleanup_orphans: false,
        },
        failOnStatusCode: false,
      },
    );
    requireOrSkip(
      res.status() !== 401 && res.status() !== 403,
      `Help admin manifest generation requires help.manage for code ${code} — use default admin or set E2E_BO_STAFF_CODE`,
    );
    const body = await res.text();
    expect(res.status(), `body: ${body.slice(0, 600)}`).toBe(200);
    const j = JSON.parse(body) as {
      result?: {
        ok?: unknown;
        exit_code?: unknown;
        stdout?: unknown;
        stderr?: unknown;
      };
      error?: unknown;
    };
    expect(j.result).toBeTruthy();
    expect(typeof j.result?.ok).toBe("boolean");
    expect(
      j.result?.exit_code == null || typeof j.result?.exit_code === "number",
    ).toBeTruthy();
    expect(
      j.result?.stdout == null || typeof j.result?.stdout === "string",
    ).toBeTruthy();
    expect(
      j.result?.stderr == null || typeof j.result?.stderr === "string",
    ).toBeTruthy();
  });

  test("POST /api/help/admin/ops/reindex-search with Admin staff returns status payload", async ({
    request,
  }) => {
    const code = process.env.E2E_BO_STAFF_CODE?.trim() || "1234";
    const res = await request.post(
      `${apiBase()}/api/help/admin/ops/reindex-search`,
      {
        headers: {
          "x-riverside-staff-code": code,
          "x-riverside-staff-pin": code,
        },
        data: { full_reindex_fallback: true },
        failOnStatusCode: false,
      },
    );
    requireOrSkip(
      res.status() !== 401 && res.status() !== 403,
      `Help search reindex requires help.manage for code ${code} — use default admin or set E2E_BO_STAFF_CODE`,
    );
    const body = await res.text();
    expect(
      res.status() === 200 ||
        (res.status() >= 400 && res.status() < 600 && res.status() !== 404),
      `body: ${body.slice(0, 600)}`,
    ).toBeTruthy();
    const j = JSON.parse(body) as {
      status?: unknown;
      mode?: unknown;
      error?: unknown;
    };
    if (res.status() === 200) {
      expect(typeof j.status).toBe("string");
      expect(j.mode == null || typeof j.mode === "string").toBeTruthy();
    } else {
      expect(typeof j.error).toBe("string");
    }
  });
});
