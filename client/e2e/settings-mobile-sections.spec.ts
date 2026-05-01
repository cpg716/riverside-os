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

async function openSettingsSubItem(page: Page, label: RegExp): Promise<void> {
  const menuToggle = page.getByRole("button", { name: /toggle menu/i });
  if (await menuToggle.isVisible().catch(() => false)) {
    await menuToggle.click().catch(() => {});
  }
  const subButton = page.getByRole("button", { name: label }).first();
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

    await openSettingsSubItem(page, /^general$/i);
    await expect(page.getByRole("heading", { name: /system settings/i })).toBeVisible({
      timeout: 20_000,
    });

    await openSettingsSubItem(page, /^help center$/i);
    await expect(page.getByRole("heading", { name: /help center manager/i })).toBeVisible({
      timeout: 20_000,
    });

    await openSettingsSubItem(page, /^bug reports$/i);
    await expect(page.getByRole("heading", { name: /^bug reports$/i })).toBeVisible({
      timeout: 20_000,
    });
  });
}
