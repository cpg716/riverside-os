import { expect, test } from "@playwright/test";
import { signInToBackOffice } from "./helpers/backofficeSignIn";
import {
  ensurePosRegisterSessionOpen,
  ensurePosSaleCashierSignedIn,
} from "./helpers/openPosRegister";

test("POS golden flow shell: scan to checkout drawer", async ({ page }) => {
  test.setTimeout(60_000);
  await signInToBackOffice(page);
  await page
    .getByRole("navigation", { name: "Main Navigation" })
    .getByRole("button", { name: "POS", exact: true })
    .click({ force: true });
  const posNav = page.getByRole("navigation", { name: "POS Navigation" });
  await expect(posNav).toBeVisible({ timeout: 20_000 });

  await ensurePosRegisterSessionOpen(page);
  await page.getByTestId("pos-sidebar-tab-register").click({ force: true });
  await ensurePosSaleCashierSignedIn(page);

  await expect(page.getByTestId("pos-product-search")).toBeVisible({
    timeout: 25_000,
  });
});

