import { expect, test } from "@playwright/test";
import { signInToBackOffice } from "./helpers/backofficeSignIn";
import {
  ensurePosRegisterSessionOpen,
  ensurePosSaleCashierSignedIn,
} from "./helpers/openPosRegister";

test("POS golden flow shell: scan to checkout drawer", async ({ page }) => {
  test.setTimeout(60_000);
  await signInToBackOffice(page);
  const posButton = page
    .getByRole("navigation", { name: "Main Navigation" })
    .getByRole("button", { name: "POS", exact: true });
  await expect(posButton).toBeVisible({ timeout: 15_000 });
  await expect(posButton).toBeEnabled();
  await posButton.click();
  const posNav = page.getByRole("navigation", { name: "POS Navigation" });
  await expect(posNav).toBeVisible({ timeout: 20_000 });

  await ensurePosRegisterSessionOpen(page);
  await ensurePosSaleCashierSignedIn(page);

  await expect(page.getByTestId("pos-product-search")).toBeVisible({
    timeout: 25_000,
  });
});
