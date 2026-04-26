import { expect, test } from "@playwright/test";
import {
  openBackofficeSidebarTab,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";
import {
  ensurePosRegisterSessionOpen,
  ensurePosSaleCashierSignedIn,
} from "./helpers/openPosRegister";

type SmokeViewport = {
  label: string;
  width: number;
  height: number;
};

const SMOKE_VIEWPORTS: SmokeViewport[] = [
  { label: "phone_390x844", width: 390, height: 844 },
  { label: "tablet_768x1024", width: 768, height: 1024 },
  { label: "ipad_1024x1366", width: 1024, height: 1366 },
  { label: "desktop_1440x900", width: 1440, height: 900 },
];

async function openPosRegisterSurface(
  page: Parameters<typeof test>[0]["page"],
): Promise<void> {
  await signInToBackOffice(page);
  await openBackofficeSidebarTab(page, "register");

  await expect(
    page.getByRole("navigation", { name: "POS Navigation" }),
  ).toBeVisible({ timeout: 20_000 });

  await ensurePosRegisterSessionOpen(page);
  await ensurePosSaleCashierSignedIn(page);

  await expect(page.getByTestId("pos-product-search")).toBeVisible({
    timeout: 20_000,
  });
}

async function addMinimalGiftCardLine(
  page: Parameters<typeof test>[0]["page"],
  codeSeed: string,
): Promise<void> {
  await page.getByTestId("pos-action-gift-card").click();
  const dialog = page.getByRole("dialog", { name: /gift card/i });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole("button", { name: "5", exact: true }).click();
  await dialog.getByLabel(/card code/i).fill(`E2E-SMOKE-${codeSeed}`);
  await dialog.getByRole("button", { name: /add to cart/i }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

for (const viewport of SMOKE_VIEWPORTS) {
  test(`POS smoke ${viewport.label}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });

    await openPosRegisterSurface(page);
    await addMinimalGiftCardLine(page, viewport.label);

    await page.getByTestId("pos-pay-button").click();
    const walkInDialog = page.getByRole("dialog", { name: /checkout as walk-in/i });
    if (await walkInDialog.isVisible().catch(() => false)) {
      await walkInDialog
        .getByRole("button", { name: /confirm walk-in/i })
        .click();
    }

    const checkoutDrawer = page.getByRole("dialog", { name: /checkout/i });
    await expect(checkoutDrawer).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("pos-finalize-checkout")).toBeVisible({
      timeout: 10_000,
    });
  });
}
