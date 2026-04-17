import { expect, test } from "@playwright/test";
import {
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
    await page
      .getByRole("navigation", { name: "Main Navigation" })
      .getByRole("button", { name: "POS", exact: true })
      .click();
    await expect(page).toHaveScreenshot("register-closed.png", {
      fullPage: true,
    });
  });

  test("visual baseline: qbo workspace", async ({ page }) => {
    await signInToBackOffice(page);
    await page.getByRole("button", { name: /qbo bridge/i }).click();
    await expect(page).toHaveScreenshot("qbo-workspace.png", {
      fullPage: true,
    });
  });

  test("visual baseline: dark mode inventory", async ({ page }) => {
    test.setTimeout(90_000);
    test.skip(
      !visualHasSettingsAdmin,
      `Staff ${e2eBackofficeStaffCode()} needs settings.admin for Settings workspace`,
    );
    await signInToBackOffice(page);
    const mainNav = page.getByRole("navigation", { name: "Main Navigation" });
    const systemControlHeading = page.getByRole("heading", {
      level: 1,
      name: /system control/i,
    });
    const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect
      .poll(
        async () => {
          const settingsButton = mainNav.getByRole("button", {
            name: /^settings(\s+bo)?$/i,
          });
          if (!(await settingsButton.isVisible().catch(() => false))) return false;
          if (!(await settingsButton.isEnabled().catch(() => false))) return false;
          await settingsButton.click();
          const asideOk = await systemControlHeading
            .isVisible()
            .catch(() => false);
          const crumbOk = await breadcrumb
            .getByText(/settings/i)
            .first()
            .isVisible()
            .catch(() => false);
          return asideOk && crumbOk;
        },
        { timeout: 45_000 },
      )
      .toBeTruthy();
    const settingsAside = page
      .locator("aside")
      .filter({
        has: page.getByRole("heading", { level: 1, name: /system control/i }),
      });
    const generalButton = settingsAside.getByRole("button", { name: /general/i });
    await expect(generalButton).toBeVisible({ timeout: 15_000 });
    await expect(generalButton).toBeEnabled();
    await generalButton.click();
    await expect(
      page.getByRole("heading", { name: /system settings/i }),
    ).toBeVisible({
      timeout: 20_000,
    });
    const themeSection = page.locator("label", {
      has: page.getByText(/interface theme architecture/i),
    });
    await expect(themeSection.getByRole("button")).toHaveCount(3, {
      timeout: 15_000,
    });
    const darkModeButton = themeSection.getByRole("button").nth(1);
    await expect(darkModeButton).toBeVisible({ timeout: 15_000 });
    await expect(darkModeButton).toBeEnabled();
    await darkModeButton.click();
    const inventoryButton = mainNav.getByRole("button", {
      name: /^inventory(\s+bo)?$/i,
    });
    await expect(inventoryButton).toBeVisible({ timeout: 15_000 });
    await expect(inventoryButton).toBeEnabled();
    await inventoryButton.click();
    await expect(page.getByText(/loading workspace/i)).toBeHidden({
      timeout: 60_000,
    });
    await expect(
      page.getByRole("heading", { level: 2, name: /inventory/i }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveScreenshot("inventory-dark.png", {
      fullPage: true,
      maxDiffPixelRatio: 0.03,
    });
  });

  test("visual baseline: customers workspace", async ({ page }) => {
    await signInToBackOffice(page);
    const customersButton = page
      .getByRole("navigation", { name: "Main Navigation" })
      .getByRole("button", { name: /customers/i });
    await expect(customersButton).toBeVisible({ timeout: 15_000 });
    await expect(customersButton).toBeEnabled();
    await customersButton.click();
    await expect(
      page.getByRole("heading", { level: 2, name: /customers/i }),
    ).toBeVisible({
      timeout: 25_000,
    });
    await expect(page).toHaveScreenshot("customers-workspace.png", {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });

  test("visual baseline: operations command center", async ({ page }) => {
    await signInToBackOffice(page);
    const operationsButton = page
      .getByRole("navigation", { name: "Main Navigation" })
      .getByRole("button", { name: /^operations(\s+bo)?$/i });
    await expect(operationsButton).toBeVisible({ timeout: 15_000 });
    await expect(operationsButton).toBeEnabled();
    await operationsButton.click();
    await expect(
      page.getByRole("heading", { name: /morning dashboard/i }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveScreenshot("operations-command-center.png", {
      fullPage: true,
      maxDiffPixelRatio: 0.03,
    });
  });
});
