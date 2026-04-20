import { expect, test } from "@playwright/test";
import { signInToBackOffice } from "./helpers/backofficeSignIn";
import {
  ensurePosRegisterSessionOpen,
  ensurePosSaleCashierSignedIn,
} from "./helpers/openPosRegister";

const quarantineUnstablePosUi =
  process.env.ROS_QUARANTINE_UNSTABLE_POS_E2E === "1";

test("POS golden flow shell: scan to checkout drawer", async ({ page }) => {
  test.skip(
    quarantineUnstablePosUi,
    "Temporarily quarantined in CI due to shared POS register-ready / cashier-overlay instability. See docs/POS_E2E_TESTABILITY_FOLLOWUP.md.",
  );
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
  const registerTab = page.getByTestId("pos-sidebar-tab-register");
  await expect(registerTab).toBeVisible({ timeout: 15_000 });
  await expect(registerTab).toBeEnabled();
  await registerTab.click();
  await ensurePosSaleCashierSignedIn(page);

  await expect(page.getByTestId("pos-product-search")).toBeVisible({
    timeout: 25_000,
  });
});
