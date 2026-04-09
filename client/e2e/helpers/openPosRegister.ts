import { expect, type Page } from "@playwright/test";
import { e2eBackofficeStaffCode } from "./backofficeSignIn";

/**
 * Completes `RegisterOverlay` when the till is closed (lane 1 + opening float).
 * No-op if the dialog is not shown (session already open).
 */
export async function ensurePosRegisterSessionOpen(page: Page): Promise<void> {
  const registerDialog = page.getByRole("dialog", { name: /riverside register/i });
  if (!(await registerDialog.isVisible().catch(() => false))) return;

  const code = e2eBackofficeStaffCode();
  for (const digit of code) {
    await registerDialog.getByTestId(`pin-key-${digit}`).click({ force: true });
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
  /** Named via `aria-labelledby` on {@link PosSaleCashierSignInOverlay} (avoid matching other `role="dialog"` shells). */
  const cashierDlg = page.getByRole("dialog", { name: /cashier for this sale/i });
  const productSearch = page.getByTestId("pos-product-search");

  // Cart sets `saleHydrated` after localforage; the cashier gate mounts only then.
  await expect
    .poll(
      async () =>
        (await productSearch.isVisible().catch(() => false)) ||
        (await cashierDlg.isVisible().catch(() => false)),
      { timeout: 20_000 },
    )
    .toBeTruthy();

  if (await productSearch.isVisible().catch(() => false)) return;

  await expect(cashierDlg.getByTestId("pin-key-1")).toBeVisible({ timeout: 15_000 });

  const code = e2eBackofficeStaffCode();
  for (const digit of code) {
    await cashierDlg.getByTestId(`pin-key-${digit}`).click({ force: true });
  }
  await cashierDlg.getByRole("button", { name: /^continue$/i }).click({ force: true });
  await expect(cashierDlg).toBeHidden({ timeout: 20_000 });
}
