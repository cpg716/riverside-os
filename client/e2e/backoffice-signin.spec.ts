import { expect, test } from "@playwright/test";
import {
  clearBackofficeSession,
  e2eBackofficeStaffCode,
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
    await expect(
      page.getByText(/operations activity|morning dashboard/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("wrong code shows an error", async ({ page }) => {
    await clearBackofficeSession(page);
    await expect(
      page.getByRole("heading", {
        name: /sign in to (back office|riverside os)/i,
      }),
    ).toBeVisible({ timeout: 20_000 });

    for (const digit of "9999") {
      await page.getByRole("button", { name: digit, exact: true }).click();
    }
    await page.getByRole("button", { name: /^continue$/i }).click();

    await expect(
      page.getByText(
        /invalid|not authorized|credentials|forbidden|unauthorized/i,
      ).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("Switch staff returns to sign-in", async ({ page }) => {
    await signInToBackOffice(page);
    const switchBtn = page.getByRole("button", { name: /switch staff/i });
    if (!(await switchBtn.isVisible().catch(() => false))) {
      test.skip(
        true,
        "Switch staff is hidden while a register session is open (till open). Close the till for this test.",
      );
    }
    await switchBtn.click();
    await expect(
      page.getByRole("heading", {
        name: /sign in to (back office|riverside os)/i,
      }),
    ).toBeVisible({ timeout: 15_000 });
  });
});
