import { expect, test, type Page } from "@playwright/test";
import { openBackofficeSidebarTab, signInToBackOffice } from "./helpers/backofficeSignIn";

type SettingsViewport = {
  label: string;
  width: number;
  height: number;
};

const SETTINGS_VIEWPORTS: SettingsViewport[] = [
  { label: "phone_390x844", width: 390, height: 844 },
  { label: "tablet_768x1024", width: 768, height: 1024 },
  { label: "ipad_1024x1366", width: 1024, height: 1366 },
  { label: "desktop_1440x900", width: 1440, height: 900 },
];

async function openSettingsSubItem(
  page: Page,
  groupLabel: RegExp,
  label: RegExp,
): Promise<void> {
  const settingsHub = page.getByTestId("settings-workspace-content");
  let categories = settingsHub.getByRole("navigation", {
    name: "Settings categories",
  });
  if (!(await categories.isVisible().catch(() => false))) {
    const viewportWidth = page.viewportSize()?.width ?? 1024;
    if (viewportWidth <= 1024) {
      await openBackofficeSidebarTab(page, "settings");
    } else {
      await page
        .getByRole("navigation", { name: "Breadcrumb" })
        .getByRole("button", { name: "Settings", exact: true })
        .click();
    }
    categories = settingsHub.getByRole("navigation", {
      name: "Settings categories",
    });
    await expect(categories).toBeVisible({ timeout: 20_000 });
  }
  const subButton = settingsHub.getByRole("button", { name: label }).first();
  if (!(await subButton.isVisible().catch(() => false))) {
    const groupButton = categories
      .getByRole("button", { name: groupLabel })
      .first();
    await expect(groupButton).toBeVisible({ timeout: 20_000 });
    await groupButton.click();
  }
  await expect(subButton).toBeVisible({ timeout: 20_000 });
  await subButton.click();
}

for (const viewport of SETTINGS_VIEWPORTS) {
  test(`Settings mobile sections ${viewport.label}`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await signInToBackOffice(page);

    await openBackofficeSidebarTab(page, "settings");
    await expect(page.getByTestId("settings-workspace-content")).toBeVisible({
      timeout: 20_000,
    });

    await openSettingsSubItem(page, /^store & staff/i, /^profile/i);
    await expect(page.getByRole("heading", { name: /staff profile/i })).toBeVisible({
      timeout: 20_000,
    });

    await openSettingsSubItem(page, /^help & system/i, /^help center/i);
    await expect(page.getByRole("heading", { name: /help center manager/i })).toBeVisible({
      timeout: 20_000,
    });

    await openSettingsSubItem(
      page,
      /^help & system/i,
      /^ros operations & support center/i,
    );
    await expect(
      page.getByRole("heading", { name: /operations today/i }),
    ).toBeVisible({ timeout: 20_000 });
  });
}
