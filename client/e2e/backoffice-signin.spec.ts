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
  if (listRes.status() !== 200) return;
  const rows = (await listRes.json()) as Array<{ id?: string; session_id?: string }>;
  for (const row of rows) {
    const sessionId = row.session_id || row.id;
    if (!sessionId) continue;
    await request.post(`${apiBase()}/api/sessions/${sessionId}/close`, {
      headers: {
        ...headers,
        "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
      },
      data: {
        actual_cash: "0.00",
        closing_notes: "E2E sign-in reset",
        closing_comments: "E2E sign-in reset",
      },
      failOnStatusCode: false,
    });
  }
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
    const userMenuButton = page.locator('button[aria-haspopup="true"]').last();
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
