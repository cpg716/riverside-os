import { expect, test } from "@playwright/test";
import { e2eBackofficeStaffCode, signInToBackOffice } from "./helpers/backofficeSignIn";

function apiBase(): string {
  const raw =
    process.env.E2E_API_BASE?.trim() ||
    process.env.VITE_API_BASE?.trim() ||
    "http://127.0.0.1:43300";
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

test("QBO staging shell: warning-aware staging and posting language", async ({ page }) => {
  test.setTimeout(90_000);
  await signInToBackOffice(page);
  const mainNav = page.getByRole("navigation", { name: "Main Navigation" });
  const qboNav = mainNav.getByRole("button", { name: /qbo bridge/i });
  const stagingNav = mainNav.getByRole("button", { name: /^staging$/i });
  await expect
    .poll(
      async () => {
        if (!(await qboNav.isVisible().catch(() => false))) return false;
        if (!(await qboNav.isEnabled().catch(() => false))) return false;
        await qboNav.click();
        if (await stagingNav.isVisible().catch(() => false)) {
          await stagingNav.click();
        }
        return await page
          .getByRole("heading", { name: /review & send/i })
          .isVisible()
          .catch(() => false);
      },
      { timeout: 60_000 },
    )
    .toBeTruthy();
  await expect(page.getByRole("heading", { name: /review & send/i })).toBeVisible();
  await expect(page.getByText(/needs attention/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/recent quickbooks activity/i)).toBeVisible();
  await expect(page.getByText(/dates, in plain english/i)).toBeVisible();
  await expect(page.getByText(/refunds, exchanges, deposits, and gift cards/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /copy support snapshot/i })).toBeVisible();
  await expect(page.getByText(/balanced means the debits and credits match/i)).toBeVisible();
});
