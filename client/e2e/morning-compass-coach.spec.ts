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
    await page
      .getByRole("navigation", { name: "Main Navigation" })
      .getByRole("button", { name: "POS", exact: true })
      .click({ force: true });
    await expect(
      page.getByRole("navigation", { name: "POS Navigation" }),
    ).toBeVisible({ timeout: 15_000 });
    await ensurePosRegisterSessionOpen(page);

    await page.getByTestId("pos-sidebar-tab-dashboard").click({ force: true });
    await expect(page.getByText("POS · Dashboard")).toBeVisible({
      timeout: 15_000,
    });

    const coach = page.getByTestId("register-morning-compass-coach");
    const empty = page.getByTestId("register-morning-compass-coach-empty");
    const list = page.getByTestId("register-morning-compass-coach-list");

    await expect(coach).toBeVisible({ timeout: 30_000 });
    await expect(empty.or(list)).toBeVisible({ timeout: 30_000 });
  });

  test("shows coach on Operations morning home when permissions allow", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await signInToBackOffice(page);

    await page.getByRole("button", { name: /operations/i }).click();
    await expect(
      page.getByRole("heading", { name: /operations hub/i }),
    ).toBeVisible({ timeout: 15_000 });

    const coach = page.getByTestId("operations-morning-compass-coach");
    const empty = page.getByTestId("operations-morning-compass-coach-empty");
    const list = page.getByTestId("operations-morning-compass-coach-list");

    await expect(coach).toBeVisible();
    await expect(empty.or(list)).toBeVisible();
  });
});
