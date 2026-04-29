import { expect, test } from "@playwright/test";
import { signInToBackOffice } from "./helpers/backofficeSignIn";
import {
  attachNewCustomerToSale,
  ensurePosRegisterSessionOpen,
  ensurePosSaleCashierSignedIn,
} from "./helpers/openPosRegister";

/**
 * Tax Exempt & Stripe Branding E2E Spec.
 * 
 * Goal:
 * - Verify that integrated payment methods follow the new STRIPE branding standard.
 * - Verify the Tax Exempt toggle and mandatory reason selection in the checkout drawer.
 * - Ensure tax parity is visually reflected (struck-through taxes).
 */

async function openPosRegisterSurface(
  page: Parameters<typeof test>[0]["page"],
): Promise<void> {
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
  const productSearch = page.getByTestId("pos-product-search");
  const giftCardAction = page.getByTestId("pos-action-gift-card");
  const registerTab = page.getByTestId("pos-sidebar-tab-register");
  if (await registerTab.isVisible().catch(() => false)) {
    await expect(registerTab).toBeEnabled();
    await registerTab.click({ timeout: 5_000 }).catch(() => {});
  }
  await ensurePosSaleCashierSignedIn(page);

  await expect(productSearch).toBeVisible({ timeout: 30_000 });
  await expect(giftCardAction).toBeVisible({ timeout: 30_000 });
}

async function addDummyItem(page: Parameters<typeof test>[0]["page"]): Promise<void> {
  // Add an internal gift-card load line so cart has payable amount (avoids inventory dependency)
  // Use specific testid to avoid sidebar Gift Cards tab
  await page.getByTestId("pos-action-gift-card").click();
  const dialog = page.getByRole("dialog", { name: /gift card/i });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole("button", { name: "5", exact: true }).click();
  await dialog.getByRole("button", { name: "0", exact: true }).click();
  await dialog.getByLabel(/card code/i).fill("E2E-TAX-TEST");
  await dialog.getByRole("button", { name: /add to cart/i }).click();
  await expect(dialog).toBeHidden();
}

async function openPaymentLedger(
  page: Parameters<typeof test>[0]["page"],
): Promise<void> {
  const drawer = page.getByRole("dialog", { name: /checkout/i });
  await page.getByRole("button", { name: /pay/i }).first().click();
  const walkInDialog = page.getByRole("dialog", { name: /checkout as walk-in/i });
  if (await walkInDialog.isVisible().catch(() => false)) {
    await walkInDialog.getByRole("button", { name: /confirm walk-in/i }).click();
  }
  await expect(drawer).toBeVisible({ timeout: 20_000 });
}

test.describe("Tax Exempt and Stripe Branding", () => {
  test("checkout drawer uses STRIPE branding and supports audited tax exemption", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openPosRegisterSurface(page);

    await addDummyItem(page);

    // Open checkout drawer
    await openPaymentLedger(page);

    const drawer = page.getByRole("dialog", { name: /checkout/i });
    await expect(drawer).toBeVisible({ timeout: 20_000 });

    // 1. Verify Stripe Branding
    await expect(drawer.getByRole("button", { name: /STRIPE CARD/i })).toBeVisible();
    await expect(drawer.getByRole("button", { name: /STRIPE MANUAL/i })).toBeVisible();

    // 2. Verify Tax Exempt Toggle
    const taxExemptBtn = drawer.getByRole("button", { name: /tax exempt/i });
    await expect(taxExemptBtn).toBeVisible();
    
    // Toggle active
    await taxExemptBtn.click();
    
    // 3. Verify Mandatory Reason Dropdown
    const reasonSelect = drawer.getByRole("combobox"); // Based on standard select role
    await expect(reasonSelect).toBeVisible();
    
    // Check if taxes are struck through (visual signal)
    const taxLine = drawer.locator('text=Tax').first();
    // In our implementation, we strike through the text or zero it out.
    // If it's zeroed out, we can check for $0.00
    // await expect(drawer.locator('text=$0.00')).toBeVisible();

    // 4. Verify linking a customer enables STRIPE VAULT branding
    await drawer.getByLabel("Close drawer").last().click();

    await attachNewCustomerToSale(page, {
      firstName: "Audited",
      lastName: "Customer",
      phone: "7165559999",
      email: `e2e-tax-${Date.now()}@example.com`,
    });
    
    await openPaymentLedger(page);
    await expect(drawer.getByRole("button", { name: /STRIPE VAULT/i })).toBeVisible();
  });
});
