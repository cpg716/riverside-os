import { expect, test } from "@playwright/test";
import {
  openBackofficeSidebarTab,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";
import {
  ensurePosRegisterSessionOpen,
  ensurePosSaleCashierSignedIn,
} from "./helpers/openPosRegister";

type ModalViewport = {
  label: string;
  width: number;
  height: number;
};

const MODAL_VIEWPORTS: ModalViewport[] = [
  { label: "phone_390x844", width: 390, height: 844 },
  { label: "tablet_768x1024", width: 768, height: 1024 },
];

async function openPosRegisterSurface(
  page: Parameters<typeof test>[0]["page"],
): Promise<void> {
  await signInToBackOffice(page);
  await openBackofficeSidebarTab(page, "register");
  await ensurePosRegisterSessionOpen(page);
  await ensurePosSaleCashierSignedIn(page);
  await expect(page.getByTestId("pos-product-search")).toBeVisible({
    timeout: 20_000,
  });
}

async function addGiftCardLoadLine(
  page: Parameters<typeof test>[0]["page"],
  codeSeed: string,
): Promise<void> {
  await page.getByTestId("pos-action-gift-card").click();
  const giftDialog = page.getByRole("dialog", { name: /gift card/i });
  await expect(giftDialog).toBeVisible({ timeout: 10_000 });
  await giftDialog.getByRole("button", { name: "5", exact: true }).click();
  await giftDialog.getByLabel(/card code/i).fill(`E2E-MODAL-${codeSeed}`);
  await giftDialog.getByRole("button", { name: /add to cart/i }).click();
  await expect(giftDialog).toBeHidden({ timeout: 10_000 });
}

async function openCheckoutDrawer(
  page: Parameters<typeof test>[0]["page"],
): Promise<void> {
  await page.getByTestId("pos-pay-button").click();
  const walkInDialog = page.getByRole("dialog", { name: /checkout as walk-in/i });
  if (await walkInDialog.isVisible().catch(() => false)) {
    await walkInDialog.getByRole("button", { name: /confirm walk-in/i }).click();
  }
  await expect(page.getByRole("dialog", { name: /checkout/i })).toBeVisible({
    timeout: 20_000,
  });
}

for (const viewport of MODAL_VIEWPORTS) {
  test(`POS modal smoke ${viewport.label}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });

    await openPosRegisterSurface(page);
    await addGiftCardLoadLine(page, viewport.label);
    await openCheckoutDrawer(page);

    const checkout = page.getByRole("dialog", { name: /checkout/i });
    await checkout.getByRole("button", { name: /^cash$/i }).click();
    await checkout.getByRole("button", { name: /pay balance/i }).click();
    await checkout.getByRole("button", { name: /add payment/i }).click();
    await expect(checkout.getByTestId("pos-finalize-checkout")).toBeEnabled({
      timeout: 10_000,
    });
    await checkout.getByRole("button", { name: /finalize/i }).click({ force: true });

    await expect(page.getByText(/sale complete/i)).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: /begin new sale/i }).click();
    await expect(page.getByText(/sale complete/i)).toBeHidden({
      timeout: 10_000,
    });
  });
}
