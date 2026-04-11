import { expect, test } from "@playwright/test";

/**
 * Phase 2 release-grade regressions:
 * 1) Help manual policy lifecycle (create/update/revert semantics via admin APIs)
 * 2) Finance-sensitive endpoint contracts (tax + reporting + payments/session gate behavior)
 *
 * This suite is intentionally API-centric for determinism and speed.
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
  return {
    "x-riverside-staff-code": e2eNonAdminCode(),
  };
}

function utcIsoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

type AdminManualRow = {
  manual_id: string;
  hidden: boolean;
  title_override: string | null;
  summary_override: string | null;
  markdown_override: string | null;
  order_override: number | null;
  required_permissions: string[] | null;
  allow_register_session: boolean | null;
};

type AdminManualDetail = {
  manual_id: string;
  bundled_title: string;
  bundled_summary: string;
  bundled_markdown: string;
  bundled_order: number;
  hidden: boolean;
  title_override: string | null;
  summary_override: string | null;
  markdown_override: string | null;
  order_override: number | null;
  required_permissions: string[] | null;
  allow_register_session: boolean | null;
  default_visibility: {
    required_permissions: string[];
    allow_register_session: boolean;
  };
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
  test.skip(
    !serverReachable,
    `API not reachable at ${apiBase()} — start DB + server for phase2-finance-and-help-lifecycle`,
  );
});

test.describe("Phase 2: Help policy lifecycle", () => {
  test("help policy lifecycle persists and reverts cleanly for one manual", async ({
    request,
  }) => {
    const listRes = await request.get(`${apiBase()}/api/help/admin/manuals`, {
      headers: adminHeaders(),
      failOnStatusCode: false,
    });

    if (listRes.status() === 401 || listRes.status() === 403) {
      test.skip(
        true,
        `Admin staff ${e2eAdminCode()} missing/unauthorized for help.manage`,
      );
    }

    expect(listRes.status()).toBe(200);
    const listJson = (await listRes.json()) as {
      manuals?: AdminManualRow[];
      permission_catalog?: string[];
    };

    expect(Array.isArray(listJson.manuals)).toBeTruthy();
    expect(Array.isArray(listJson.permission_catalog)).toBeTruthy();

    const manuals = listJson.manuals ?? [];
    test.skip(manuals.length === 0, "No help manuals returned by admin list");

    const permissionCatalog = listJson.permission_catalog ?? [];
    const manual = manuals[0];
    const manualId = manual.manual_id;

    const detailRes = await request.get(
      `${apiBase()}/api/help/admin/manuals/${encodeURIComponent(manualId)}`,
      {
        headers: adminHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(detailRes.status()).toBe(200);

    const before = (await detailRes.json()) as AdminManualDetail;

    const patchTitle = `E2E Title ${Date.now()}`;
    const patchSummary = `E2E Summary ${Date.now()}`;
    const patchMarkdown = `${before.bundled_markdown}\n\n<!-- e2e phase2 ${Date.now()} -->`;

    const chosenPerm =
      permissionCatalog.find((p) => typeof p === "string" && p.length > 0) ||
      "help.manage";

    const updatePayload = {
      hidden: !before.hidden,
      title_override: patchTitle,
      summary_override: patchSummary,
      markdown_override: patchMarkdown,
      order_override: (before.order_override ?? before.bundled_order) + 1,
      permissions_inherit: false,
      required_permissions: [chosenPerm],
      register_session_inherit: false,
      allow_register_session:
        before.allow_register_session ??
        before.default_visibility.allow_register_session,
    };

    const putRes = await request.put(
      `${apiBase()}/api/help/admin/manuals/${encodeURIComponent(manualId)}`,
      {
        headers: {
          ...adminHeaders(),
          "Content-Type": "application/json",
        },
        data: updatePayload,
        failOnStatusCode: false,
      },
    );
    const putBody = await putRes.text();
    expect(putRes.status(), `update body: ${putBody.slice(0, 400)}`).toBe(200);

    const afterUpdateRes = await request.get(
      `${apiBase()}/api/help/admin/manuals/${encodeURIComponent(manualId)}`,
      {
        headers: adminHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(afterUpdateRes.status()).toBe(200);
    const afterUpdate = (await afterUpdateRes.json()) as AdminManualDetail;

    expect(afterUpdate.hidden).toBe(updatePayload.hidden);
    expect(afterUpdate.title_override).toBe(updatePayload.title_override);
    expect(afterUpdate.summary_override).toBe(updatePayload.summary_override);
    expect(afterUpdate.markdown_override).toContain("e2e phase2");
    expect(afterUpdate.order_override).toBe(updatePayload.order_override);
    expect(afterUpdate.required_permissions).toEqual(
      updatePayload.required_permissions,
    );
    expect(afterUpdate.allow_register_session).toBe(
      updatePayload.allow_register_session,
    );

    // Revert: delete policy row and verify defaults/overrides reset.
    const delRes = await request.delete(
      `${apiBase()}/api/help/admin/manuals/${encodeURIComponent(manualId)}`,
      {
        headers: adminHeaders(),
        failOnStatusCode: false,
      },
    );
    const delBody = await delRes.text();
    expect(delRes.status(), `delete body: ${delBody.slice(0, 400)}`).toBe(200);

    const afterDeleteRes = await request.get(
      `${apiBase()}/api/help/admin/manuals/${encodeURIComponent(manualId)}`,
      {
        headers: adminHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(afterDeleteRes.status()).toBe(200);
    const afterDelete = (await afterDeleteRes.json()) as AdminManualDetail;

    expect(afterDelete.hidden).toBe(false);
    expect(afterDelete.title_override).toBeNull();
    expect(afterDelete.summary_override).toBeNull();
    expect(afterDelete.markdown_override).toBeNull();
    expect(afterDelete.order_override).toBeNull();
    expect(afterDelete.required_permissions).toBeNull();
    expect(afterDelete.allow_register_session).toBeNull();
  });

  test("help policy endpoints enforce RBAC boundaries", async ({ request }) => {
    const unknownManual = "this-manual-id-should-not-exist";
    const sampleBody = {
      hidden: false,
      title_override: "x",
      summary_override: "y",
      markdown_override: null,
      order_override: null,
      permissions_inherit: true,
      required_permissions: [],
      register_session_inherit: true,
      allow_register_session: false,
    };

    const anonGet = await request.get(
      `${apiBase()}/api/help/admin/manuals/${unknownManual}`,
      { failOnStatusCode: false },
    );
    expect(anonGet.status()).toBe(401);

    const anonPut = await request.put(
      `${apiBase()}/api/help/admin/manuals/${unknownManual}`,
      {
        data: sampleBody,
        failOnStatusCode: false,
      },
    );
    expect(anonPut.status()).toBe(401);

    const nonAdminGet = await request.get(
      `${apiBase()}/api/help/admin/manuals/${unknownManual}`,
      {
        headers: nonAdminHeaders(),
        failOnStatusCode: false,
      },
    );
    if (nonAdminGet.status() === 401) {
      test.skip(true, `Non-admin seed ${e2eNonAdminCode()} missing`);
    }
    expect([403, 404]).toContain(nonAdminGet.status());

    const nonAdminPut = await request.put(
      `${apiBase()}/api/help/admin/manuals/${unknownManual}`,
      {
        headers: {
          ...nonAdminHeaders(),
          "Content-Type": "application/json",
        },
        data: sampleBody,
        failOnStatusCode: false,
      },
    );
    if (nonAdminPut.status() === 401) {
      test.skip(true, `Non-admin seed ${e2eNonAdminCode()} missing`);
    }
    expect(nonAdminPut.status()).toBe(403);
  });
});

test.describe("Phase 2: Finance-sensitive endpoint contracts", () => {
  test("NYS tax audit + sales pivot contracts stay stable for admin", async ({
    request,
  }) => {
    const from = encodeURIComponent(utcIsoDaysAgo(30));
    const to = encodeURIComponent(new Date().toISOString());

    const taxRes = await request.get(
      `${apiBase()}/api/insights/nys-tax-audit?from=${from}&to=${to}`,
      {
        headers: adminHeaders(),
        failOnStatusCode: false,
      },
    );

    if (taxRes.status() === 401 || taxRes.status() === 403) {
      test.skip(
        true,
        `Admin staff ${e2eAdminCode()} missing/unauthorized for insights.view`,
      );
    }

    const taxText = await taxRes.text();
    expect(taxRes.status(), `nys-tax-audit: ${taxText.slice(0, 400)}`).toBe(200);
    const tax = JSON.parse(taxText) as {
      threshold_usd?: unknown;
      total_lines?: unknown;
      local_only_exempt_lines?: unknown;
      clothing_at_or_over_threshold_lines?: unknown;
      total_state_tax?: unknown;
      total_local_tax?: unknown;
    };
    expect(typeof tax.threshold_usd).toBe("string");
    expect(typeof tax.total_lines).toBe("number");
    expect(typeof tax.local_only_exempt_lines).toBe("number");
    expect(typeof tax.clothing_at_or_over_threshold_lines).toBe("number");
    expect(typeof tax.total_state_tax).toBe("string");
    expect(typeof tax.total_local_tax).toBe("string");

    const bases = ["booked", "sale", "completed", "pickup"];
    for (const basis of bases) {
      const pivotRes = await request.get(
        `${apiBase()}/api/insights/sales-pivot?group_by=customer&basis=${basis}&from=${from}&to=${to}`,
        {
          headers: adminHeaders(),
          failOnStatusCode: false,
        },
      );

      const pivotBody = await pivotRes.text();
      expect(
        pivotRes.status(),
        `sales-pivot basis=${basis}; body=${pivotBody.slice(0, 500)}`,
      ).toBe(200);

      const pivot = JSON.parse(pivotBody) as {
        rows?: unknown[];
        truncated?: unknown;
      };
      expect(Array.isArray(pivot.rows)).toBeTruthy();
      expect(typeof pivot.truncated).toBe("boolean");
    }
  });

  test("payments/session endpoints remain auth-gated and contract-safe", async ({
    request,
  }) => {
    const anonIntent = await request.post(`${apiBase()}/api/payments/intent`, {
      data: { amount_due: "1.00" },
      failOnStatusCode: false,
    });
    expect(anonIntent.status()).toBe(401);

    const anonCurrent = await request.get(`${apiBase()}/api/sessions/current`, {
      failOnStatusCode: false,
    });
    // Current may be 401 (no auth) or 404 (no open till in some gateways)
    expect([401, 404]).toContain(anonCurrent.status());

    const staffListOpen = await request.get(
      `${apiBase()}/api/sessions/list-open`,
      {
        headers: adminHeaders(),
        failOnStatusCode: false,
      },
    );
    if (staffListOpen.status() === 401 || staffListOpen.status() === 403) {
      test.skip(
        true,
        `Admin staff ${e2eAdminCode()} missing/unauthorized for sessions/list-open`,
      );
    }
    expect(staffListOpen.status()).toBe(200);
    const rows = (await staffListOpen.json()) as unknown[];
    expect(Array.isArray(rows)).toBeTruthy();
  });

  test("non-admin boundaries hold for margin + help admin operations", async ({
    request,
  }) => {
    const marginRes = await request.get(
      `${apiBase()}/api/insights/margin-pivot?group_by=brand&basis=sale`,
      {
        headers: nonAdminHeaders(),
        failOnStatusCode: false,
      },
    );
    if (marginRes.status() === 401) {
      test.skip(true, `Non-admin seed ${e2eNonAdminCode()} missing`);
    }
    expect(marginRes.status()).toBe(403);

    const helpStatusRes = await request.get(
      `${apiBase()}/api/help/admin/ops/status`,
      {
        headers: nonAdminHeaders(),
        failOnStatusCode: false,
      },
    );
    if (helpStatusRes.status() === 401) {
      test.skip(true, `Non-admin seed ${e2eNonAdminCode()} missing`);
    }
    expect(helpStatusRes.status()).toBe(403);
  });
});
