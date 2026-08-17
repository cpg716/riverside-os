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

test("Insights stays in the standard Back Office workspace shell", async ({ page }) => {
  await signInToBackOffice(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const navigation = page.getByRole("navigation", { name: "Main Navigation" });
  await openBackofficeSidebarTab(page, "dashboard");
  const insightsNav = page.getByTestId("sidebar-nav-dashboard");
  await expect(insightsNav.locator("svg.lucide-sparkles")).toBeVisible({
    timeout: 20_000,
  });

  await expect(navigation).toBeVisible();
  await expect(page.getByTestId("app-shell-state")).toHaveAttribute(
    "data-active-tab",
    "dashboard",
  );
  await expect(page.getByTestId("backoffice-workspace-root")).toHaveAttribute(
    "data-workspace-section",
    "dashboard",
  );
  await expect(page.getByRole("heading", { name: /^insights$/i })).toBeVisible({
    timeout: 25_000,
  });
  await expect(page.getByRole("button", { name: "Back to Back Office" })).toHaveCount(0);
});

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
    const workspaceRoot = page.getByTestId("backoffice-workspace-root");

    for (const tab of WORKSPACE_TABS) {
      await openBackofficeSidebarTab(page, tab);
      await expect(appShellState).toHaveAttribute("data-active-tab", tab, {
        timeout: 20_000,
      });
      await expect(page.getByText(/loading workspace/i)).toBeHidden({
        timeout: 20_000,
      });
      await expect(workspaceRoot).toHaveAttribute("data-workspace-theme", "ros");
      await expect(workspaceRoot).toHaveAttribute("data-workspace-section", tab);

      if (tab === "customers") {
        await expect(workspaceRoot.getByText("Customer overview")).toBeVisible({
          timeout: 20_000,
        });
        await expect(
          workspaceRoot.locator("[data-workspace-metric]").first(),
        ).toBeAttached();
      } else if (["orders", "loyalty"].includes(tab)) {
        await expect(
          workspaceRoot.locator("[data-workspace-metric]").first(),
        ).toBeVisible({ timeout: 20_000 });
      }

      if (tab === "inventory") {
        await page
          .getByTestId("backoffice-workspace-root")
          .getByRole("button", { name: /^Find item$/i })
          .click();
        await expect(
          workspaceRoot.locator(".ui-workspace-page-header"),
        ).toBeVisible({ timeout: 20_000 });
        await expect(
          workspaceRoot.locator(".ui-workspace-toolbar"),
        ).toBeVisible({ timeout: 20_000 });
      }
    }

    await openBackofficeSidebarTab(page, "settings");
    await expect(appShellState).toHaveAttribute("data-active-tab", "settings", {
      timeout: 20_000,
    });
  });
}
