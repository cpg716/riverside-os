import { expect, test } from "@playwright/test";
import { e2eBackofficeStaffCode, signInToBackOffice } from "./helpers/backofficeSignIn";

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
    canaryStaffOk =
      Array.isArray(j.permissions) &&
      j.permissions.includes("staff.view") &&
      j.permissions.includes("tasks.complete");
  } catch {
    canaryStaffOk = false;
  }
});

test.beforeEach(() => {
  test.skip(
    !canaryStaffOk,
    `API not reachable or staff code ${e2eBackofficeStaffCode()} lacks staff.view + tasks.complete`,
  );
});

test.describe("Staff tasks", () => {
  test("Tasks subsection shows My tasks panel", async ({ page }) => {
    test.setTimeout(90_000);
    await signInToBackOffice(page);

    const expandSidebar = page.getByRole("button", { name: /expand sidebar/i });
    if (await expandSidebar.isVisible().catch(() => false)) {
      await expandSidebar.click();
    }
    const mainNav = page.getByRole("navigation", { name: "Main Navigation" });
    await mainNav.getByRole("button", { name: /^staff(\s+bo)?$/i }).click({ force: true });
    await expect(
      page
        .getByRole("heading", { name: /staff workspace/i })
        .or(page.getByRole("button", { name: /lock workspace/i })),
    ).toBeVisible({ timeout: 60_000 });
    const lockWorkspace = page.getByRole("button", { name: /lock workspace/i });
    if (!(await lockWorkspace.isVisible().catch(() => false))) {
      const staffGateModal = page.locator(".ui-modal").filter({
        has: page.getByRole("heading", { name: /staff workspace/i }),
      });
      const code = e2eBackofficeStaffCode();
      for (const digit of code) {
        await staffGateModal.getByTestId(`pin-key-${digit}`).click({ force: true });
      }
      await staffGateModal.getByRole("button", { name: /^unlock$/i }).click({ force: true });
    }
    await expect(lockWorkspace).toBeVisible({
      timeout: 25_000,
    });
    if (await expandSidebar.isVisible().catch(() => false)) {
      await expandSidebar.click({ force: true });
    }
    await mainNav.getByRole("button", { name: /^tasks$/i }).click({ force: true });

    await expect(page.getByRole("heading", { name: /^tasks$/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/^My tasks$/i).first()).toBeVisible({ timeout: 10_000 });
  });
});
