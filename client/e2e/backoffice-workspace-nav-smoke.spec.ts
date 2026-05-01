import { expect, test } from "@playwright/test";
import {
  openBackofficeSidebarTab,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";

type WorkspaceViewport = {
  label: string;
  width: number;
  height: number;
};

const WORKSPACE_VIEWPORTS: WorkspaceViewport[] = [
  { label: "phone_390x844", width: 390, height: 844 },
  { label: "tablet_768x1024", width: 768, height: 1024 },
  { label: "ipad_1024x1366", width: 1024, height: 1366 },
  { label: "desktop_1440x900", width: 1440, height: 900 },
];

const WORKSPACE_TABS: Array<
  | "customers"
  | "orders"
  | "gift-cards"
  | "loyalty"
  | "appointments"
  | "inventory"
> = [
  "customers",
  "orders",
  "gift-cards",
  "loyalty",
  "appointments",
  "inventory",
];

for (const viewport of WORKSPACE_VIEWPORTS) {
  test(`Back Office workspace nav smoke ${viewport.label}`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });

    await signInToBackOffice(page);

    const appShellState = page.getByTestId("app-shell-state");
    await expect(appShellState).toBeVisible({ timeout: 20_000 });

    for (const tab of WORKSPACE_TABS) {
      await openBackofficeSidebarTab(page, tab);
      await expect(appShellState).toHaveAttribute("data-active-tab", tab, {
        timeout: 20_000,
      });
      await expect(page.getByText(/loading workspace/i)).toBeHidden({
        timeout: 20_000,
      });
    }

    await openBackofficeSidebarTab(page, "settings");
    await expect(appShellState).toHaveAttribute("data-active-tab", "settings", {
      timeout: 20_000,
    });
  });
}
