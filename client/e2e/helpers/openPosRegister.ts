import { expect, type Page } from "@playwright/test";
import { e2eBackofficeStaffCode } from "./backofficeSignIn";

/**
 * Completes `RegisterOverlay` when the till is closed (lane 1 + opening float).
 * No-op if the dialog is not shown (session already open).
 */
export async function ensurePosRegisterSessionOpen(page: Page): Promise<void> {
  // 1. Wait for initial bootstrap to clear
  await expect(page.getByText(/loading riverside pos/i)).toBeHidden({ timeout: 20_000 });

  const registerDialog = page.getByRole("dialog", { name: /riverside register/i });
  const pin1 = registerDialog.getByTestId("pin-key-1");

  // 2. Wait for state stabilization (either unmounted because session open, or enabled and ready)
  await expect
    .poll(
      async () => {
        const visible = await registerDialog.isVisible().catch(() => false);
        if (!visible) return true;
        const enabled = await pin1.isEnabled().catch(() => false);
        return enabled;
      },
      {
        timeout: 30_000,
        message: "Register dialog state never stabilized (never hidden, never enabled)",
      },
    )
    .toBeTruthy();

  if (!(await registerDialog.isVisible().catch(() => false))) return;

  const code = e2eBackofficeStaffCode();
  for (const digit of code) {
    // No force: true, let Playwright wait for enablement
    await registerDialog.getByTestId(`pin-key-${digit}`).click();
  }

  await registerDialog.getByLabel("Physical register number").selectOption("1");

  const floatInput = registerDialog.locator("input[type='number']").first();
  await floatInput.fill("200");

  await registerDialog.getByRole("button", { name: /^open register$/i }).click();

  await expect(registerDialog).toBeHidden({ timeout: 30_000 });
}

/**
 * Dismisses {@link PosSaleCashierSignInOverlay} so cart search / tools are usable.
 */
export async function ensurePosSaleCashierSignedIn(page: Page): Promise<void> {
  const cashierDlg = page.getByRole("dialog", { name: /sign-in for this sale/i });
  const productSearch = page.getByTestId("pos-product-search");

  await expect
    .poll(
      async () =>
        (await productSearch.isVisible().catch(() => false)) ||
        (await cashierDlg.isVisible().catch(() => false)),
      { timeout: 20_000 },
    )
    .toBeTruthy();

  if (await productSearch.isVisible().catch(() => false)) return;

  // Wait for roster to load
  await expect.poll(
    async () => await cashierDlg.locator("button").filter({ has: page.locator("img") }).count(), 
    { timeout: 15_000 }
  ).toBeGreaterThan(0);
  
  const staffButtons = cashierDlg.locator("button").filter({ has: page.locator("img") });
  
  // Click the first staff and wait for the keypad to become actionable.
  await staffButtons.first().click();

  const pin1 = cashierDlg.getByTestId("pin-key-1");
  await expect(pin1).toBeVisible({ timeout: 15_000 });
  await expect(pin1).toBeEnabled({ timeout: 15_000 });

  const code = e2eBackofficeStaffCode();
  for (const digit of code) {
    await cashierDlg.getByTestId(`pin-key-${digit}`).click();
  }
  
  const contBtn = cashierDlg.getByRole("button", { name: /^continue$/i });
  await expect(contBtn).toBeEnabled({ timeout: 10_000 });
  await contBtn.click();
  
  await expect(cashierDlg).toBeHidden({ timeout: 20_000 });
}
