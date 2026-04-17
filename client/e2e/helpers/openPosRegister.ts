import { expect, type Page } from "@playwright/test";
import { e2eBackofficeStaffCode } from "./backofficeSignIn";

function e2eBackofficeStaffName(): string {
  return process.env.E2E_BO_STAFF_NAME?.trim() || "Chris Garcia";
}

async function closeStaffDropdownIfOpen(
  dialog: Page["locator"],
  selectorButton: Page["locator"],
  preferredName: string,
): Promise<void> {
  const placeholderOption = dialog.getByRole("button", {
    name: /select staff member/i,
  });
  const preferredButtons = dialog.getByRole("button", {
    name: new RegExp(preferredName, "i"),
  });

  const dropdownOpen = async () =>
    (await placeholderOption.isVisible().catch(() => false)) ||
    (await preferredButtons.count()) > 1;

  if (!(await dropdownOpen())) {
    return;
  }

  await selectorButton.press("Escape").catch(() => {});
  if (await dropdownOpen()) {
    await dialog.click({ position: { x: 24, y: 24 } }).catch(() => {});
  }

  await expect
    .poll(async () => !(await dropdownOpen()), {
      timeout: 5_000,
      message: "Staff selector dropdown never collapsed",
    })
    .toBeTruthy();
}

async function selectFirstStaffMember(dialog: Page["locator"]): Promise<void> {
  const preferredName = e2eBackofficeStaffName();
  const selectorButton = dialog
    .getByText(/select your name/i)
    .locator("xpath=following::button[1]");
  if (!(await selectorButton.isVisible().catch(() => false))) {
    return;
  }
  const selectorWarning = dialog.getByText(/please select a staff member first/i);
  await expect
    .poll(
      async () => ((await selectorButton.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim(),
      { timeout: 5_000, message: "Staff selector text never stabilized" },
    )
    .not.toEqual("");

  const currentLabel = ((await selectorButton.textContent().catch(() => "")) ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const selectionRequired =
    /select staff member/i.test(currentLabel) ||
    (await selectorWarning.isVisible().catch(() => false));

  if (!selectionRequired || currentLabel.match(new RegExp(preferredName, "i"))) {
    await closeStaffDropdownIfOpen(dialog, selectorButton, preferredName);
    return;
  }
  await selectorButton.click();
  const preferredOption = dialog.getByRole("button", {
    name: new RegExp(preferredName, "i"),
  });
  if (await preferredOption.isVisible().catch(() => false)) {
    await preferredOption.click();
    await closeStaffDropdownIfOpen(dialog, selectorButton, preferredName);
    return;
  }
  const options = dialog
    .locator("button")
    .filter({ has: dialog.locator("img") })
    .filter({ hasNotText: /select staff member/i });
  const optionCount = await options.count();
  if (optionCount > 0) {
    await options.nth(Math.min(1, optionCount - 1)).click();
  }
  await closeStaffDropdownIfOpen(dialog, selectorButton, preferredName);
}

/**
 * Completes `RegisterOverlay` when the till is closed (lane 1 + opening float).
 * No-op if the dialog is not shown (session already open).
 */
export async function ensurePosRegisterSessionOpen(page: Page): Promise<void> {
  // 1. Wait for initial bootstrap to clear
  await expect(page.getByText(/loading riverside pos/i)).toBeHidden({ timeout: 20_000 });

  const registerDialog = page.getByRole("dialog", { name: /riverside register/i });
  const cashierDialog = page.getByRole("dialog", { name: /sign-in for this sale/i });
  const pin1 = registerDialog.getByTestId("pin-key-1");
  const tillOpenBadge = page.getByText(/till open/i).first();
  const posNav = page.getByRole("navigation", { name: "POS Navigation" });

  // 2. Wait for state stabilization (either unmounted because session open, or enabled and ready)
  await expect
    .poll(
      async () => {
        const registerVisible = await registerDialog.isVisible().catch(() => false);
        if (
          !registerVisible &&
          (await posNav.isVisible().catch(() => false)) &&
          ((await cashierDialog.isVisible().catch(() => false)) ||
            (await tillOpenBadge.isVisible().catch(() => false)))
        ) {
          return true;
        }
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
  const giftCardAction = page.getByTestId("pos-action-gift-card");

  await expect
    .poll(
      async () =>
        ((await productSearch.isVisible().catch(() => false)) &&
          !(await cashierDlg.isVisible().catch(() => false))) ||
        (await cashierDlg.isVisible().catch(() => false)),
      { timeout: 20_000 },
    )
    .toBeTruthy();

  if (
    (await productSearch.isVisible().catch(() => false)) &&
    !(await cashierDlg.isVisible().catch(() => false))
  ) {
    return;
  }

  await selectFirstStaffMember(cashierDlg);

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
  await expect
    .poll(
      async () =>
        (await giftCardAction.isVisible().catch(() => false)) ||
        (await productSearch.isVisible().catch(() => false)),
      { timeout: 20_000 },
    )
    .toBeTruthy();
}
