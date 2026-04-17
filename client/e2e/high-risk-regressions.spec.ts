import { expect, test } from "@playwright/test";

/**
 * High-risk API regressions:
 * - Tax audit (NYS §718-C surface)
 * - Revenue basis behavior (booked vs completed aliases)
 * - Help Center Manager admin ops RBAC + payload shape
 * - Session resilience endpoints
 * - Migration-smoke critical route availability
 *
 * This file intentionally focuses on API-level checks (fast + deterministic).
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

function e2eNonAdminCode(): string {
  return process.env.E2E_NON_ADMIN_CODE?.trim() || "5678";
}

function adminHeaders(): Record<string, string> {
  const code = e2eAdminCode();
  return {
    "x-riverside-staff-code": code,
    "x-riverside-staff-pin": code,
  };
}

function nonAdminHeaders(): Record<string, string> {
  return { "x-riverside-staff-code": e2eNonAdminCode() };
}

function utcIsoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split("T")[0];
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
    `API not reachable at ${apiBase()} — start Postgres + server to run high-risk-regressions`,
  );
});

test.describe("High-risk API regressions", () => {
  test("migration smoke: critical routes are mounted (not 404)", async ({
    request,
  }) => {
    const from = encodeURIComponent(utcIsoDaysAgo(30));
    const to = encodeURIComponent(new Date().toISOString().split("T")[0]);

    const checks: Array<{ path: string; method: "GET" | "POST"; body?: unknown }> = [
      { path: `/api/insights/sales-pivot?group_by=customer&basis=booked&from=${from}&to=${to}`, method: "GET" },
      { path: `/api/insights/nys-tax-audit?from=${from}&to=${to}`, method: "GET" },
      { path: `/api/help/admin/ops/status`, method: "GET" },
      { path: `/api/sessions/current`, method: "GET" },
      { path: `/api/sessions/list-open`, method: "GET" },
      {
        path: `/api/help/admin/ops/reindex-search`,
        method: "POST",
        body: { full_reindex_fallback: true },
      },
    ];

    for (const c of checks) {
      const res =
        c.method === "GET"
          ? await request.get(`${apiBase()}${c.path}`, { failOnStatusCode: false })
          : await request.post(`${apiBase()}${c.path}`, {
              data: c.body,
              failOnStatusCode: false,
            });
      expect(
        res.status(),
        `${c.method} ${c.path} returned 404 (route likely missing)`,
      ).not.toBe(404);
    }
  });

  test("tax audit endpoint requires auth and returns expected shape for admin", async ({
    request,
  }) => {
    const from = encodeURIComponent(utcIsoDaysAgo(30));
    const to = encodeURIComponent(new Date().toISOString().split("T")[0]);

    const unauth = await request.get(
      `${apiBase()}/api/insights/nys-tax-audit?from=${from}&to=${to}`,
      { failOnStatusCode: false },
    );
    expect([401, 403]).toContain(unauth.status());

    const admin = await request.get(
      `${apiBase()}/api/insights/nys-tax-audit?from=${from}&to=${to}`,
      { headers: adminHeaders(), failOnStatusCode: false },
    );

    requireOrSkip(
      admin.status() !== 401 && admin.status() !== 403,
      `Admin staff ${e2eAdminCode()} missing/unauthorized for insights.view`,
    );

    expect(admin.status()).toBe(200);
    const j = (await admin.json()) as {
      threshold_usd?: unknown;
      total_lines?: unknown;
      total_state_tax?: unknown;
      total_local_tax?: unknown;
      local_only_exempt_lines?: unknown;
      clothing_footwear_lines?: unknown;
    };

    expect(typeof j.threshold_usd).toBe("string");
    expect(typeof j.total_lines).toBe("number");
    expect(typeof j.total_state_tax).toBe("string");
    expect(typeof j.total_local_tax).toBe("string");
    expect(typeof j.local_only_exempt_lines).toBe("number");
    expect(typeof j.clothing_footwear_lines).toBe("number");
  });

  test("revenue basis aliases are accepted and shape remains stable", async ({
    request,
  }) => {
    const from = encodeURIComponent(utcIsoDaysAgo(30));
    const to = encodeURIComponent(new Date().toISOString().split("T")[0]);

    const bases = ["booked", "sale", "completed", "pickup"];

    for (const basis of bases) {
      const res = await request.get(
        `${apiBase()}/api/insights/sales-pivot?group_by=customer&basis=${basis}&from=${from}&to=${to}`,
        { headers: adminHeaders(), failOnStatusCode: false },
      );

      requireOrSkip(
        res.status() !== 401 && res.status() !== 403,
        `Admin staff ${e2eAdminCode()} missing/unauthorized for sales-pivot basis checks`,
      );

      const body = await res.text();
      expect(res.status(), `basis=${basis}; body=${body.slice(0, 500)}`).toBe(200);

      const j = JSON.parse(body) as { rows?: unknown[]; truncated?: unknown };
      expect(Array.isArray(j.rows)).toBeTruthy();
      expect(typeof j.truncated).toBe("boolean");
    }
  });

  test("help manager admin ops enforce RBAC and return stable payloads", async ({
    request,
  }) => {
    const anonStatus = await request.get(`${apiBase()}/api/help/admin/ops/status`, {
      failOnStatusCode: false,
    });
    expect(anonStatus.status()).toBe(401);

    const nonAdminStatus = await request.get(
      `${apiBase()}/api/help/admin/ops/status`,
      {
        headers: nonAdminHeaders(),
        failOnStatusCode: false,
      },
    );
    requireOrSkip(
      nonAdminStatus.status() !== 401,
      `Non-admin seed ${e2eNonAdminCode()} missing`,
    );
    expect(nonAdminStatus.status()).toBe(403);

    const adminStatus = await request.get(`${apiBase()}/api/help/admin/ops/status`, {
      headers: adminHeaders(),
      failOnStatusCode: false,
    });
    requireOrSkip(
      adminStatus.status() !== 401 && adminStatus.status() !== 403,
      `Admin staff ${e2eAdminCode()} missing/unauthorized for help.manage`,
    );
    expect(adminStatus.status()).toBe(200);
    const statusJson = (await adminStatus.json()) as {
      meilisearch_configured?: unknown;
      meilisearch_indexing?: unknown;
      node_available?: unknown;
      script_exists?: unknown;
      help_docs_dir_exists?: unknown;
    };
    expect(typeof statusJson.meilisearch_configured).toBe("boolean");
    expect(typeof statusJson.meilisearch_indexing).toBe("boolean");
    expect(typeof statusJson.node_available).toBe("boolean");
    expect(typeof statusJson.script_exists).toBe("boolean");
    expect(typeof statusJson.help_docs_dir_exists).toBe("boolean");

    const genAnon = await request.post(
      `${apiBase()}/api/help/admin/ops/generate-manifest`,
      {
        data: {
          dry_run: true,
          include_shadcn: false,
          rescan_components: false,
          cleanup_orphans: false,
        },
        failOnStatusCode: false,
      },
    );
    expect(genAnon.status()).toBe(401);

    const genAdmin = await request.post(
      `${apiBase()}/api/help/admin/ops/generate-manifest`,
      {
        headers: adminHeaders(),
        data: {
          dry_run: true,
          include_shadcn: false,
          rescan_components: false,
          cleanup_orphans: false,
        },
        failOnStatusCode: false,
      },
    );

    const genBody = await genAdmin.text();
    expect(genAdmin.status(), `generate-manifest body: ${genBody.slice(0, 700)}`).toBe(200);
    const genJson = JSON.parse(genBody) as {
      result?: {
        ok?: unknown;
        exit_code?: unknown;
        stdout?: unknown;
        stderr?: unknown;
      };
    };
    expect(genJson.result).toBeTruthy();
    expect(typeof genJson.result?.ok).toBe("boolean");
    expect(
      genJson.result?.exit_code == null || typeof genJson.result?.exit_code === "number",
    ).toBeTruthy();
    expect(
      genJson.result?.stdout == null || typeof genJson.result?.stdout === "string",
    ).toBeTruthy();
    expect(
      genJson.result?.stderr == null || typeof genJson.result?.stderr === "string",
    ).toBeTruthy();
  });

  test("session resilience: current/list-open routes are auth-gated and staff-accessible", async ({
    request,
  }) => {
    const currentAnon = await request.get(`${apiBase()}/api/sessions/current`, {
      failOnStatusCode: false,
    });
    expect([401, 404]).toContain(currentAnon.status());

    const listAnon = await request.get(`${apiBase()}/api/sessions/list-open`, {
      failOnStatusCode: false,
    });
    expect([401, 403]).toContain(listAnon.status());

    const listStaff = await request.get(`${apiBase()}/api/sessions/list-open`, {
      headers: adminHeaders(),
      failOnStatusCode: false,
    });

    requireOrSkip(
      listStaff.status() !== 401 && listStaff.status() !== 403,
      `Admin staff ${e2eAdminCode()} missing/unauthorized for session list-open`,
    );

    expect(listStaff.status()).toBe(200);
    const rows = (await listStaff.json()) as unknown[];
    expect(Array.isArray(rows)).toBeTruthy();
  });

  test("permission boundary: sensitive insights and help-admin endpoints reject non-admin staff", async ({
    request,
  }) => {
    const code = e2eNonAdminCode();

    const margin = await request.get(
      `${apiBase()}/api/insights/margin-pivot?group_by=brand&basis=sale`,
      {
        headers: { "x-riverside-staff-code": code },
        failOnStatusCode: false,
      },
    );

    requireOrSkip(margin.status() !== 401, `Non-admin seed ${code} missing`);
    expect(margin.status()).toBe(403);

    const helpReindex = await request.post(
      `${apiBase()}/api/help/admin/ops/reindex-search`,
      {
        headers: { "x-riverside-staff-code": code },
        data: { full_reindex_fallback: true },
        failOnStatusCode: false,
      },
    );

    requireOrSkip(
      helpReindex.status() !== 401,
      `Non-admin seed ${code} missing`,
    );
    expect(helpReindex.status()).toBe(403);
  });
});
