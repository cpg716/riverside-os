import { expect, type Locator, type Page } from "@playwright/test";
import {
  e2eBackofficeStaffCode,
  ensureMainNavigationVisible,
} from "./backofficeSignIn";

function e2eBackofficeStaffName(): string {
  return process.env.E2E_BO_STAFF_NAME?.trim() || "Chris G";
}

async function closeStaffDropdownIfOpen(
  dialog: Locator,
  selectorButton: Locator,
  preferredName: string,
): Promise<void> {
  const page = dialog.page();
  const placeholderOption = dialog.getByRole("button", {
    name: /select staff member/i,
  });
  const dropdownOpen = async () =>
    await placeholderOption.isVisible().catch(() => false);

  if (!(await dropdownOpen())) {
    return;
  }

  await selectorButton.click().catch(() => {});
  if (!(await dropdownOpen())) {
    return;
  }

  await selectorButton.press("Escape").catch(() => {});
  if (await dropdownOpen()) {
    await dialog.click({ position: { x: 24, y: 24 } }).catch(() => {});
  }
  if (await dropdownOpen()) {
    await dialog.getByText(/select your name/i).click().catch(() => {});
  }
  if (await dropdownOpen()) {
    await page.mouse.click(8, 8).catch(() => {});
  }

  await expect
    .poll(async () => !(await dropdownOpen()), {
      timeout: 5_000,
      message: "Staff selector dropdown never collapsed",
    })
    .toBeTruthy();
}

async function selectFirstStaffMember(dialog: Locator): Promise<void> {
  const page = dialog.page();
  const preferredName = e2eBackofficeStaffName();
  
  // Use the new test-id for the selector button if available
  const selectorButton = dialog.getByTestId("staff-selector-button");
  
  await expect(selectorButton).toBeVisible({ timeout: 15_000 });
  await selectorButton.scrollIntoViewIfNeeded();

  const currentLabel = ((await selectorButton.textContent().catch(() => "")) ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const selectionRequired =
    /select staff member|select\.\.\.|select your name/i.test(currentLabel) ||
    (await dialog.getByText(/please select a staff member first/i).isVisible().catch(() => false));

  if (!selectionRequired || currentLabel.match(new RegExp(preferredName, "i"))) {
    return;
  }

  // Click to open dropdown
  await selectorButton.click();
  
  const dropdown = page.getByTestId("staff-selector-dropdown");
  await expect(dropdown).toBeVisible({ timeout: 10_000 });

  const preferredOption = dropdown.getByRole("button", {
    name: new RegExp(preferredName, "i"),
  });
  
  if (await preferredOption.isVisible().catch(() => false)) {
    await preferredOption.click();
  } else {
    // Fallback to first identity selector if name doesn't match
    const firstIdentity = dropdown.getByTestId("staff-identity-selector-1");
    await expect(firstIdentity).toBeVisible({ timeout: 5_000 });
    await firstIdentity.click();
  }

  await expect(dropdown).toBeHidden({ timeout: 10_000 });
}

async function waitForPosRegisterPanel(page: Page): Promise<void> {
  const shell = page.getByTestId("pos-shell-root");
  if (!(await shell.isVisible().catch(() => false))) {
    await enterPosShell(page);
  }
  await expect(shell).toBeVisible({ timeout: 20_000 });

  if ((await shell.getAttribute("data-pos-active-tab").catch(() => null)) !== "register") {
    const registerPanel = page.getByTestId("pos-register-panel");
    await expect
      .poll(
        async () => {
          if ((await shell.getAttribute("data-pos-active-tab").catch(() => null)) === "register") {
            return true;
          }
          if (await registerPanel.isVisible().catch(() => false)) {
            return true;
          }

          const registerTab = page.getByTestId("pos-sidebar-tab-register");
          const registerNavButton = page
            .getByRole("navigation", { name: "POS Navigation" })
            .getByRole("button", { name: /^register$/i });
          const target = (await registerTab.isVisible().catch(() => false))
            ? registerTab
            : registerNavButton;

          if (!(await target.isVisible().catch(() => false))) return false;
          if (!(await target.isEnabled().catch(() => false))) return false;
          await target.click({ force: true }).catch(() => {});
          return (
            (await shell.getAttribute("data-pos-active-tab").catch(() => null)) === "register" ||
            (await registerPanel.isVisible().catch(() => false))
          );
        },
        { timeout: 20_000 },
      )
      .toBeTruthy();
  }

  await expect(shell).toHaveAttribute("data-pos-active-tab", "register", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("pos-register-panel")).toBeVisible({
    timeout: 20_000,
  });
}

async function waitForRegisterCartMounted(page: Page): Promise<void> {
  const cartShell = page.getByTestId("pos-register-cart-shell");
  await expect(cartShell).toBeVisible({ timeout: 25_000 });
  await expect(cartShell).toHaveAttribute("data-sale-hydrated", "true", {
    timeout: 25_000,
  });
}

async function waitForRegisterReady(page: Page): Promise<void> {
  const cartShell = page.getByTestId("pos-register-cart-shell");
  await expect(cartShell).toHaveAttribute("data-register-ready", "true", {
    timeout: 25_000,
  });
  await expect(page.getByTestId("pos-product-search")).toBeVisible({
    timeout: 25_000,
  });
  await expect(page.getByTestId("pos-action-gift-card")).toBeVisible({
    timeout: 25_000,
  });
}

async function fillOpeningFloatIfPresent(
  registerDialog: Locator,
  cartShell: Locator,
): Promise<void> {
  if (await cartShell.isVisible().catch(() => false)) {
    return;
  }

  const floatInput = registerDialog
    .locator("input[type='number']:not(:disabled)")
    .first();
  if (!(await floatInput.isVisible({ timeout: 3_000 }).catch(() => false))) {
    return;
  }

  await floatInput.scrollIntoViewIfNeeded().catch(() => {});
  await floatInput.fill("200", { timeout: 3_000 }).catch(async () => {
    if (await cartShell.isVisible().catch(() => false)) {
      return;
    }
    const value = await floatInput.inputValue({ timeout: 1_000 }).catch(() => "");
    if (!value.trim()) {
      throw new Error("Opening float input was visible but not ready to accept a value.");
    }
  });
}

export async function ensurePosRegisterSessionOpen(
  page: Page,
  options?: {
    staffCode?: string;
  },
): Promise<void> {
  // 1. Wait for initial bootstrap to clear
  await expect(page.getByText(/loading riverside pos/i)).toBeHidden({ timeout: 20_000 });

  const registerPanel = page.getByTestId("pos-register-panel");
  const posNav = page.getByRole("navigation", { name: "POS Navigation" });
  const goToRegisterButton = page.getByRole("button", {
    name: /go to register/i,
  });
  const registerNavButton = posNav.getByRole("button", { name: /^register$/i });
  if (!(await registerPanel.isVisible().catch(() => false))) {
    if (await goToRegisterButton.isVisible().catch(() => false)) {
      await goToRegisterButton.click();
    } else if (await registerNavButton.isVisible().catch(() => false)) {
      await registerNavButton.click();
    }
  }

  await waitForPosRegisterPanel(page);
  const registerDialog = page.getByRole("dialog", {
    name: /access register|riverside register|open register/i,
  });
  const openPrimaryRegisterButton = page.getByRole("button", {
    name: /open register #1/i,
  });
  const cartShell = page.getByTestId("pos-register-cart-shell");

  // 2. Wait for state stabilization: cart already mounted, primary-register gate, or PIN dialog.
  await expect
    .poll(
      async () => {
        if (await cartShell.isVisible().catch(() => false)) return "cart";
        if (await registerDialog.isVisible().catch(() => false)) return "pin";
        if (await openPrimaryRegisterButton.isVisible().catch(() => false)) return "primary-gate";
        if (await goToRegisterButton.isVisible().catch(() => false)) {
          await goToRegisterButton.click();
          return "waiting";
        }
        if (
          !(await registerPanel.isVisible().catch(() => false)) &&
          (await registerNavButton.isVisible().catch(() => false))
        ) {
          await registerNavButton.click();
          return "waiting";
        }
        return "waiting";
      },
      {
        timeout: 30_000,
        message: "Register state never stabilized",
      },
    )
    .not.toBe("waiting");

  if (await openPrimaryRegisterButton.isVisible().catch(() => false)) {
    await openPrimaryRegisterButton.click();
    await expect
      .poll(
        async () =>
          (await cartShell.isVisible().catch(() => false)) ||
          (await registerDialog.isVisible().catch(() => false)),
        {
          timeout: 15_000,
          message: "Register did not show cart or open-register dialog",
        },
      )
      .toBeTruthy();
  }

  if (!(await registerDialog.isVisible().catch(() => false))) {
    if (!(await posNav.isVisible().catch(() => false))) {
      await enterPosShell(page);
    }
    await waitForPosRegisterPanel(page);
    await waitForRegisterCartMounted(page).catch(() => {});
    return;
  }

  const laneSelect = registerDialog.getByLabel(/terminal #|physical register number/i);
  if (await laneSelect.isVisible().catch(() => false)) {
    await laneSelect.selectOption("1", { timeout: 3_000 }).catch(() => {});
  }

  await fillOpeningFloatIfPresent(registerDialog, cartShell);

  const pin1 = registerDialog.getByTestId("pin-key-1");
  await expect(pin1).toBeVisible({ timeout: 15_000 });
  await expect(pin1).toBeEnabled({ timeout: 15_000 });

  const code = e2eBackofficeStaffCode(options?.staffCode);
  for (const digit of code) {
    // No force: true, let Playwright wait for enablement
    await registerDialog.getByTestId(`pin-key-${digit}`).click();
  }

  const openRegisterButton = registerDialog.getByRole("button", {
    name: /^open register$/i,
  });
  if (await openRegisterButton.isVisible().catch(() => false)) {
    await openRegisterButton.click();
  }

  await expect(registerDialog).toBeHidden({ timeout: 30_000 });
  if (!(await posNav.isVisible().catch(() => false))) {
    await enterPosShell(page);
  }
  await waitForPosRegisterPanel(page);
  await waitForRegisterCartMounted(page);
}

/**
 * Dismisses {@link PosSaleCashierSignInOverlay} so cart search / tools are usable.
 */
export async function ensurePosSaleCashierSignedIn(page: Page): Promise<void> {
  await waitForRegisterCartMounted(page);

  const cashierDlg = page.getByTestId("pos-sale-cashier-overlay");
  const cartShell = page.getByTestId("pos-register-cart-shell");

  await expect
    .poll(
      async () =>
        ((await cartShell.getAttribute("data-register-ready").catch(() => null)) === "true") ||
        (await cashierDlg.isVisible().catch(() => false)),
      { timeout: 20_000 },
    )
    .toBeTruthy();

  if ((await cartShell.getAttribute("data-register-ready").catch(() => null)) === "true") {
    return;
  }

  await expect
    .poll(
      async () =>
        ((await cashierDlg.getAttribute("data-roster-ready").catch(() => null)) === "true") ||
        ((await cashierDlg.getAttribute("data-pin-entry-ready").catch(() => null)) === "true"),
      { timeout: 15_000 },
    )
    .toBeTruthy();

  if ((await cashierDlg.getAttribute("data-roster-ready").catch(() => null)) === "true") {
    await selectFirstStaffMember(cashierDlg);
  }

  await expect(cashierDlg).toHaveAttribute("data-pin-entry-ready", "true", {
    timeout: 10_000,
  });

  const pin1 = cashierDlg.getByTestId("pin-key-1");
  await expect(pin1).toBeVisible({ timeout: 15_000 });
  await expect(pin1).toBeEnabled({ timeout: 15_000 });

  const code = e2eBackofficeStaffCode();
  for (const [index, digit] of Array.from(code).entries()) {
    await cashierDlg.getByTestId(`pin-key-${digit}`).click();
    const expectedLength = String(index + 1);
    if ((await cashierDlg.getAttribute("data-pin-length").catch(() => null)) !== expectedLength) {
      await page.keyboard.press(digit);
    }
    await expect(cashierDlg).toHaveAttribute("data-pin-length", expectedLength, {
      timeout: 5_000,
    });
  }

  const contBtn = cashierDlg.getByTestId("pos-sale-cashier-continue");
  await expect
    .poll(
      async () =>
        ((await cartShell.getAttribute("data-register-ready").catch(() => null)) === "true") ||
        !(await cashierDlg.isVisible().catch(() => false)) ||
        ((await contBtn.isVisible().catch(() => false)) &&
          (await contBtn.isEnabled().catch(() => false))),
      { timeout: 10_000 },
    )
    .toBeTruthy();
  if (
    (await cashierDlg.isVisible().catch(() => false)) &&
    ((await cartShell.getAttribute("data-register-ready").catch(() => null)) !== "true")
  ) {
    await contBtn.click();
  }

  await expect
    .poll(
      async () =>
        !(await cashierDlg.isVisible().catch(() => false)) ||
        ((await cartShell.getAttribute("data-register-ready").catch(() => null)) === "true"),
      { timeout: 20_000 },
    )
    .toBeTruthy();
  if (
    (await cashierDlg.isVisible().catch(() => false)) &&
    ((await cartShell.getAttribute("data-register-ready").catch(() => null)) === "true")
  ) {
    await cashierDlg.getByRole("button", { name: /^cancel$/i }).click().catch(() => {});
  }
  await expect(cashierDlg).toBeHidden({ timeout: 5_000 });
  await waitForRegisterReady(page);
}

export async function attachNewCustomerToSale(
  page: Page,
  options?: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
  },
): Promise<void> {
  const suffix = Date.now();
  await page.getByRole("button", { name: /^add customer$/i }).click();

  const addCustomerDrawer = page.getByRole("dialog", {
    name: /add customer/i,
  });
  await expect(addCustomerDrawer).toBeVisible({ timeout: 20_000 });

  await addCustomerDrawer
    .getByLabel(/first name/i)
    .fill(options?.firstName ?? "E2E");
  await addCustomerDrawer
    .getByLabel(/last name/i)
    .fill(options?.lastName ?? "Customer");
  await addCustomerDrawer
    .getByPlaceholder("(555) 000-0000")
    .first()
    .fill(options?.phone ?? "7165550123");
  await addCustomerDrawer
    .getByLabel(/^email$/i)
    .fill(options?.email ?? `e2e-pos-${suffix}@example.com`);
  await addCustomerDrawer
    .getByRole("button", { name: /create customer/i })
    .click();

  await expect(
    page.getByRole("button", { name: /remove customer from sale/i }),
  ).toBeVisible({ timeout: 20_000 });
}

export async function enterPosShell(page: Page): Promise<void> {
  const posNav = page.getByRole("navigation", { name: "POS Navigation" });
  const posShell = page.getByTestId("pos-shell-root");
  if (await posNav.isVisible().catch(() => false)) {
    return;
  }
  if (await posShell.isVisible().catch(() => false)) {
    return;
  }

  const waitForPosShellReady = async (timeoutMs: number): Promise<boolean> => {
    try {
      await expect
        .poll(
          async () =>
            (await posNav.isVisible().catch(() => false)) ||
            (await posShell.isVisible().catch(() => false)),
          { timeout: timeoutMs },
        )
        .toBeTruthy();
      return true;
    } catch {
      return false;
    }
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (
      (await posNav.isVisible().catch(() => false)) ||
      (await posShell.isVisible().catch(() => false))
    ) {
      return;
    }

    const enterPosButton = page.getByRole("button", {
      name: /^(enter|return) to pos$/i,
    });
    if (await enterPosButton.isVisible().catch(() => false)) {
      await expect(enterPosButton).toBeEnabled({ timeout: 10_000 });
      await enterPosButton.click();
      if (
        (await posNav.isVisible().catch(() => false)) ||
        (await posShell.isVisible().catch(() => false))
      ) {
        return;
      }
      if (await waitForPosShellReady(2_000)) {
        return;
      }
      continue;
    }

    const openPosRegisterButton = page.getByRole("button", {
      name: /open pos register/i,
    });
    if (await openPosRegisterButton.isVisible().catch(() => false)) {
      await expect(openPosRegisterButton).toBeEnabled({ timeout: 10_000 });
      await openPosRegisterButton.click({ timeout: 5_000 }).catch(() => {});
      if (await waitForPosShellReady(2_000)) {
        return;
      }
      continue;
    }

    const mainNav = await ensureMainNavigationVisible(page).catch(() => null);
    if (mainNav) {
      const boPosButton = mainNav.getByRole("button", { name: /^pos$/i });
      if (await boPosButton.isVisible().catch(() => false)) {
        await boPosButton.scrollIntoViewIfNeeded().catch(() => {});
        await boPosButton.click({ timeout: 5_000 }).catch(() => {});
      }
    }

    if (
      (await posNav.isVisible().catch(() => false)) ||
      (await posShell.isVisible().catch(() => false))
    ) {
      return;
    }
    if (await waitForPosShellReady(2_000)) {
      return;
    }
  }

  await expect(posShell.or(posNav)).toBeVisible({ timeout: 20_000 });
}
