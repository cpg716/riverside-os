import { expect, test } from "@playwright/test";
import { signInToBackOffice } from "./helpers/backofficeSignIn";
import {
  ensurePosRegisterSessionOpen,
  ensurePosSaleCashierSignedIn,
} from "./helpers/openPosRegister";

test.describe("POS exchange wizard", () => {
  test("opens from cart when register is open", async ({ page }) => {
    test.setTimeout(60_000);
    await signInToBackOffice(page);
    await page
      .getByRole("navigation", { name: "Main Navigation" })
      .getByRole("button", { name: "POS", exact: true })
      .click({ force: true });
    const posNav = page.getByRole("navigation", { name: "POS Navigation" });
    await expect(posNav).toBeVisible({ timeout: 15_000 });
    await ensurePosRegisterSessionOpen(page);
    await expect(posNav).toBeVisible({ timeout: 5_000 });
    await page.getByTestId("pos-sidebar-tab-register").click({ force: true });
    await ensurePosSaleCashierSignedIn(page);
    await expect(page.getByTestId("pos-product-search")).toBeVisible({
      timeout: 20_000,
    });
    const trigger = page.getByTestId("pos-exchange-wizard-trigger");
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await trigger.focus();
    await trigger.press("Enter");
    await expect(page.getByTestId("pos-exchange-wizard-dialog")).toBeVisible({
      timeout: 15_000,
    });
  });
});
