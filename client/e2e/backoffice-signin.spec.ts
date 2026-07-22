import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  clearBackofficeSession,
  e2eBackofficeStaffCode,
  selectBackofficeStaffMember,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";

function apiBase(): string {
  const raw =
    process.env.E2E_API_BASE?.trim() ||
    process.env.VITE_API_BASE?.trim() ||
    "http://127.0.0.1:3000";
  return raw.replace(/\/$/, "");
}

let canaryStaffOk = false;

async function closeOpenRegisterSessions(request: APIRequestContext) {
  const code = e2eBackofficeStaffCode();
  const headers = {
    "x-riverside-staff-code": code,
    "x-riverside-staff-pin": code,
  };
  const listRes = await request.get(`${apiBase()}/api/sessions/list-open`, {
    headers,
    failOnStatusCode: false,
  });
  expect(listRes.status()).toBe(200);
  const rows = (await listRes.json()) as Array<{
    session_id: string;
    register_lane: number;
  }>;
  const primary = rows.find((row) => row.register_lane === 1);
  if (!primary) {
    expect(rows).toHaveLength(0);
    return;
  }

  const issueToken = async (sessionId: string): Promise<string> => {
    const response = await request.post(
      `${apiBase()}/api/sessions/${sessionId}/pos-api-token`,
      {
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "x-riverside-station-key": "station-e2e",
        },
        data: { cashier_code: code, pin: code },
        failOnStatusCode: false,
      },
    );
    const responseText = await response.text();
    expect(response.status(), responseText.slice(0, 1000)).toBe(200);
    const body = JSON.parse(responseText) as { pos_api_token?: string };
    expect(body.pos_api_token).toBeTruthy();
    return body.pos_api_token ?? "";
  };

  const primaryToken = await issueToken(primary.session_id);
  const begin = await request.post(
    `${apiBase()}/api/sessions/${primary.session_id}/begin-reconcile`,
    {
      headers: {
        "Content-Type": "application/json",
        "x-riverside-pos-session-id": primary.session_id,
        "x-riverside-pos-session-token": primaryToken,
        "x-riverside-station-key": "station-e2e",
      },
      data: { active: true },
      failOnStatusCode: false,
    },
  );
  expect(begin.status()).toBe(200);

  for (const row of rows) {
    const token =
      row.session_id === primary.session_id
        ? primaryToken
        : await issueToken(row.session_id);
    const acknowledgement = await request.post(
      `${apiBase()}/api/recovery/station-close-status`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-riverside-pos-session-id": row.session_id,
          "x-riverside-pos-session-token": token,
          "x-riverside-station-key": "station-e2e",
        },
        data: {
          pending_checkout_count: 0,
          blocked_checkout_count: 0,
        },
        failOnStatusCode: false,
      },
    );
    expect(acknowledgement.status()).toBe(200);
  }

  const reconciliation = await request.get(
    `${apiBase()}/api/sessions/${primary.session_id}/reconciliation`,
    {
      headers: {
        "x-riverside-pos-session-id": primary.session_id,
        "x-riverside-pos-session-token": primaryToken,
        "x-riverside-station-key": "station-e2e",
      },
      failOnStatusCode: false,
    },
  );
  expect(reconciliation.status()).toBe(200);
  const expectedCash = ((await reconciliation.json()) as { expected_cash: string })
    .expected_cash;
  const close = await request.post(
    `${apiBase()}/api/sessions/${primary.session_id}/close`,
    {
      headers: {
        "Content-Type": "application/json",
        "x-riverside-pos-session-id": primary.session_id,
        "x-riverside-pos-session-token": primaryToken,
        "x-riverside-station-key": "station-e2e",
      },
      data: {
        actual_cash: expectedCash,
        closing_notes: "E2E sign-in reset",
        closing_comments: "E2E sign-in reset",
      },
      failOnStatusCode: false,
    },
  );
  const closeText = await close.text();
  expect(close.status(), closeText.slice(0, 1000)).toBe(200);
}

test.beforeAll(async ({ request }) => {
  const code = e2eBackofficeStaffCode();
  try {
    const res = await request.get(`${apiBase()}/api/staff/effective-permissions`, {
      headers: {
        "x-riverside-staff-code": code,
        "x-riverside-staff-pin": code,
      },
      timeout: 8000,
      failOnStatusCode: false,
    });
    if (!res.ok()) return;
    const j = (await res.json()) as { permissions?: string[] };
    canaryStaffOk = Array.isArray(j.permissions) && j.permissions.length > 0;
  } catch {
    canaryStaffOk = false;
  }
});

test.beforeEach(() => {
  test.skip(
    !canaryStaffOk,
    `API not reachable or staff code ${e2eBackofficeStaffCode()} has no permissions — start server + DB and run seed/migration 53 (see docs/STAFF_PERMISSIONS.md)`,
  );
});

test.describe.configure({ mode: "serial" });

test.describe("Back Office sign-in gate", () => {
  test("4-digit code reaches Operations shell", async ({ page }) => {
    await signInToBackOffice(page);

    const operationsButton = page
      .getByRole("navigation", { name: "Main Navigation" })
      .getByRole("button", { name: /^operations(\s+bo)?$/i });
    await expect(operationsButton).toBeVisible({ timeout: 15_000 });
    await operationsButton.click();
    await expect
      .poll(
        async () =>
          (await page
            .getByRole("heading", { name: /operations overview/i })
            .isVisible()
            .catch(() => false)) ||
          (await page
            .getByRole("heading", { name: /what changed today/i })
            .isVisible()
            .catch(() => false)) ||
          (await page
            .getByRole("heading", { name: /what needs attention/i })
            .isVisible()
            .catch(() => false)) ||
          (await page
            .getByRole("heading", { name: /top issues/i })
            .isVisible()
            .catch(() => false)) ||
          (await page
            .getByRole("heading", { name: /action board/i })
            .isVisible()
            .catch(() => false)) ||
          (await page.getByText(/live dashboard active/i).isVisible().catch(() => false)),
        { timeout: 20_000 },
      )
      .toBeTruthy();
  });

  test("opaque Staff Access survives reload without retaining the PIN", async ({ page }) => {
    test.setTimeout(90_000);
    const accessPin = e2eBackofficeStaffCode();
    await signInToBackOffice(page, { persistSession: true });
    const persisted = await page.evaluate(() => {
      const raw = sessionStorage.getItem("ros.backoffice.session.v2");
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    });
    expect(persisted).toBeTruthy();
    expect(persisted?.staffCode).not.toBe(accessPin);
    expect(persisted?.staffPin).toBeUndefined();
    expect(String(persisted?.sessionToken ?? "").length).toBeGreaterThan(32);
    expect(Date.parse(String(persisted?.sessionExpiresAt ?? ""))).toBeGreaterThan(Date.now());
  });

  test("wrong code shows an error", async ({ page }) => {
    await clearBackofficeSession(page);
    await expect(
      page.getByRole("heading", { name: /^sign in$/i }),
    ).toBeVisible({ timeout: 20_000 });
    await selectBackofficeStaffMember(page);

    for (const digit of "9999") {
      await page.getByRole("button", { name: digit, exact: true }).click();
    }

    await expect(
      page.getByText(
        /invalid|not authorized|credentials|forbidden|unauthorized/i,
      ).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("Switch staff returns to sign-in", async ({ page, request }) => {
    await closeOpenRegisterSessions(request);
    await signInToBackOffice(page);
    const userMenuButton = page.getByRole("button", {
      name: /open staff profile menu/i,
    });
    await expect(userMenuButton).toBeVisible({ timeout: 15_000 });
    await userMenuButton.click();
    await page.getByRole("button", { name: /change staff member/i }).click();
    await expect(
      page.getByRole("heading", {
        name: /^sign in$|sign in to (back office|riverside os)/i,
      }),
    ).toBeVisible({ timeout: 15_000 });
  });
});
