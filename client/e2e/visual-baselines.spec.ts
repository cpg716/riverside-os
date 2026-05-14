import { expect, test } from "@playwright/test";
import {
  e2eBackofficeStaffCode,
  openBackofficeSidebarTab,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";

function apiBase(): string {
  const raw =
    process.env.E2E_API_BASE?.trim() ||
    process.env.VITE_API_BASE?.trim() ||
    "http://127.0.0.1:3000";
  return raw.replace(/\/$/, "");
}

/** Pixel snapshots differ on Linux CI fonts/layout; run locally or with E2E_RUN_VISUAL=1 if forcing. */
const describeVisual =
  process.env.E2E_RUN_VISUAL === "1" ? test.describe : test.describe.skip;

describeVisual("visual baselines (local screenshots)", () => {
  let visualHasSettingsAdmin = false;

  test.beforeAll(async ({ request }) => {
    const code = e2eBackofficeStaffCode();
    try {
      const res = await request.get(
        `${apiBase()}/api/staff/effective-permissions`,
        {
          headers: {
            "x-riverside-staff-code": code,
            "x-riverside-staff-pin": code,
          },
          timeout: 8000,
          failOnStatusCode: false,
        },
      );
      if (!res.ok()) return;
      const j = (await res.json()) as { permissions?: string[] };
      visualHasSettingsAdmin =
        Array.isArray(j.permissions) &&
        j.permissions.includes("settings.admin");
    } catch {
      visualHasSettingsAdmin = false;
    }
  });

  test("visual baseline: register closed overlay", async ({ page }) => {
    await signInToBackOffice(page);
    await openBackofficeSidebarTab(page, "register");
    await expect(
      page.getByRole("dialog", { name: /cash drawer|register|terminal/i }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveScreenshot("register-closed.png");
  });

  test("visual baseline: qbo workspace", async ({ page }) => {
    await signInToBackOffice(page);
    await openBackofficeSidebarTab(page, "qbo");
    await expect(page.getByText(/loading workspace/i)).toBeHidden({
      timeout: 60_000,
    });
    await expect(page).toHaveScreenshot("qbo-workspace.png", {
      maxDiffPixelRatio: 0.02,
    });
  });

  test("visual baseline: dark mode inventory", async ({ page }) => {
    test.setTimeout(90_000);
    test.skip(
      !visualHasSettingsAdmin,
      `Staff ${e2eBackofficeStaffCode()} needs settings.admin for Settings workspace`,
    );
    await signInToBackOffice(page);
    const darkModeButton = page.getByRole("button", {
      name: /switch to dark mode/i,
    });
    if (await darkModeButton.isVisible().catch(() => false)) {
      await darkModeButton.click();
    }
    await openBackofficeSidebarTab(page, "inventory");
    await expect(page.getByText(/loading workspace/i)).toBeHidden({
      timeout: 60_000,
    });
    await expect(
      page.getByRole("heading", { level: 2, name: /inventory/i }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveScreenshot("inventory-dark.png", {
      maxDiffPixelRatio: 0.03,
    });
  });

  test("visual baseline: customers workspace", async ({ page }) => {
    await signInToBackOffice(page);
    await openBackofficeSidebarTab(page, "customers");
    await expect(page.getByText(/profile completeness/i)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveScreenshot("customers-workspace.png", {
      maxDiffPixelRatio: 0.02,
    });
  });

  test("visual baseline: operations command center", async ({ page }) => {
    await signInToBackOffice(page);
    await openBackofficeSidebarTab(page, "home");
    await expect(
      page.getByRole("heading", { name: /operations overview/i }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveScreenshot("operations-command-center.png", {
      maxDiffPixelRatio: 0.03,
    });
  });
});
