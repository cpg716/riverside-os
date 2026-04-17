import { expect, test } from "@playwright/test";
import { e2eBackofficeStaffCode, signInToBackOffice } from "./helpers/backofficeSignIn";

function apiBase(): string {
  const raw =
    process.env.E2E_API_BASE?.trim() ||
    process.env.VITE_API_BASE?.trim() ||
    "http://127.0.0.1:3000";
  return raw.replace(/\/$/, "");
}

let canaryQboView = false;

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
    canaryQboView = Array.isArray(j.permissions) && j.permissions.includes("qbo.view");
  } catch {
    canaryQboView = false;
  }
});

test.beforeEach(() => {
  test.skip(
    !canaryQboView,
    `Staff ${e2eBackofficeStaffCode()} needs qbo.view for QBO workspace`,
  );
});

test("QBO staging shell: map to propose approve sync", async ({ page }) => {
  test.setTimeout(90_000);
  await signInToBackOffice(page);
  const mainNav = page.getByRole("navigation", { name: "Main Navigation" });
  const qboNav = mainNav.getByRole("button", { name: /qbo bridge/i });
  await expect
    .poll(
      async () => {
        if (!(await qboNav.isVisible().catch(() => false))) return false;
        if (!(await qboNav.isEnabled().catch(() => false))) return false;
        await qboNav.click();
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        return await page.getByText(/financial bridge panel/i).isVisible().catch(() => false);
      },
      { timeout: 60_000 },
    )
    .toBeTruthy();
  await expect(page.getByText(/financial bridge panel/i)).toBeVisible();
  await expect(
    page.getByText(/workflow:\s*connection\s*→\s*mappings\s*→\s*staging/i),
  ).toBeVisible({ timeout: 15_000 });
  const stagingButton = page.getByRole("button", { name: /3 .*staging/i });
  await expect(stagingButton).toBeVisible({ timeout: 15_000 });
  await expect(stagingButton).toBeEnabled();
  await stagingButton.click();
  await expect(page.getByRole("button", { name: /propose journal/i })).toBeVisible();
});
