import { expect, test } from "@playwright/test";

import { signInToBackOffice } from "./helpers/backofficeSignIn";
import { ensurePosRegisterSessionOpen } from "./helpers/openPosRegister";

/**
 * Morning Compass coach: register dashboard + Operations morning home.
 * Requires back-office staff sign-in and an open POS session for the dashboard path.
 */
test.describe("Morning Compass coach", () => {
  test("shows coach on register dashboard when permissions allow", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await signInToBackOffice(page);
    const posButton = page
      .getByRole("navigation", { name: "Main Navigation" })
      .getByRole("button", { name: "POS", exact: true });
    await expect(posButton).toBeVisible({ timeout: 15_000 });
    await expect(posButton).toBeEnabled();
    await posButton.click();
    await expect(
      page.getByRole("navigation", { name: "POS Navigation" }),
    ).toBeVisible({ timeout: 15_000 });
    await ensurePosRegisterSessionOpen(page);

    const dashboardTab = page.getByTestId("pos-sidebar-tab-dashboard");
    await expect(dashboardTab).toBeVisible({ timeout: 15_000 });
    await expect(dashboardTab).toBeEnabled();
    await dashboardTab.click();

    await expect(
      page.getByRole("heading", { name: /priority feed/i }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("heading", { name: /wedding pulse/i }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("shows coach on Operations morning home when permissions allow", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await signInToBackOffice(page);

    const operationsButton = page
      .getByRole("navigation", { name: "Main Navigation" })
      .getByRole("button", { name: /^operations(\s+bo)?$/i });
    await expect(operationsButton).toBeVisible({ timeout: 15_000 });
    await operationsButton.click();
    await expect(
      page.getByRole("heading", { name: /operations overview/i }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole("heading", { name: /action board/i }),
    ).toBeVisible({ timeout: 20_000 });
  });
});
