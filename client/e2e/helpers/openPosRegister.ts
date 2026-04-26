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
  const preferredName = e2eBackofficeStaffName();
  const chevronSelectorButton = dialog
    .locator("button")
    .filter({ has: dialog.locator("svg.lucide-chevron-down") })
    .first();
  const fallbackSelectorButton = dialog.getByRole("button", {
    name: /select staff member|select\.\.\.|select your name/i,
  });
  const selectedButton = dialog
    .getByRole("button", { name: new RegExp(preferredName, "i") })
    .first();
  const selectorButton = (await chevronSelectorButton.isVisible().catch(() => false))
    ? chevronSelectorButton
    : (await fallbackSelectorButton.isVisible().catch(() => false))
    ? fallbackSelectorButton
    : selectedButton;
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
  }).last();
  const rosterOptions = dialog
    .locator("button")
    .filter({ has: dialog.locator("img") })
    .filter({ hasNotText: /select staff member/i });
  await expect
    .poll(async () => await rosterOptions.count(), {
      timeout: 10_000,
      message: "Staff roster options never loaded in POS cashier selector",
    })
    .toBeGreaterThan(0);
  if (await preferredOption.isVisible().catch(() => false)) {
    await preferredOption.click();
    await closeStaffDropdownIfOpen(dialog, selectorButton, preferredName);
    return;
  }
  const optionCount = await rosterOptions.count();
  if (optionCount > 0) {
    await rosterOptions.first().click();
  }
  await closeStaffDropdownIfOpen(dialog, selectorButton, preferredName);
}

async function waitForPosRegisterPanel(page: Page): Promise<void> {
  const shell = page.getByTestId("pos-shell-root");
  if (!(await shell.isVisible().catch(() => false))) {
    await enterPosShell(page);
  }
  await expect(shell).toBeVisible({ timeout: 20_000 });

  if ((await shell.getAttribute("data-pos-active-tab").catch(() => null)) !== "register") {
    const registerTab = page.getByTestId("pos-sidebar-tab-register");
    const registerNavButton = page
      .getByRole("navigation", { name: "POS Navigation" })
      .getByRole("button", { name: /^register$/i });
    const target = (await registerTab.isVisible().catch(() => false))
      ? registerTab
      : registerNavButton;
    await expect(target).toBeVisible({ timeout: 20_000 });
    await expect(target).toBeEnabled();
    await target.click();
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

export async function ensurePosRegisterSessionOpen(
  page: Page,
  options?: {
    staffCode?: string;
  },
): Promise<void> {
  // 1. Wait for initial bootstrap to clear
  await expect(page.getByText(/loading riverside pos/i)).toBeHidden({ timeout: 20_000 });

  await waitForPosRegisterPanel(page);
  const registerDialog = page.getByRole("dialog", { name: /riverside register/i });
  const pin1 = registerDialog.getByTestId("pin-key-1");
  const posNav = page.getByRole("navigation", { name: "POS Navigation" });

  // 2. Wait for state stabilization (either unmounted because session open, or enabled and ready)
  await expect
    .poll(
      async () => {
        const registerVisible = await registerDialog.isVisible().catch(() => false);
        if (!registerVisible && (await posNav.isVisible().catch(() => false))) return true;
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

  if (!(await registerDialog.isVisible().catch(() => false))) {
    if (!(await posNav.isVisible().catch(() => false))) {
      await enterPosShell(page);
    }
    await waitForRegisterCartMounted(page).catch(() => {});
    return;
  }

  const code = e2eBackofficeStaffCode(options?.staffCode);
  for (const digit of code) {
    // No force: true, let Playwright wait for enablement
    await registerDialog.getByTestId(`pin-key-${digit}`).click();
  }

  await registerDialog.getByLabel("Physical register number").selectOption("1");

  const floatInput = registerDialog.locator("input[type='number']").first();
  await floatInput.fill("200");

  await registerDialog.getByRole("button", { name: /^open register$/i }).click();

  await expect(registerDialog).toBeHidden({ timeout: 30_000 });
  if (!(await posNav.isVisible().catch(() => false))) {
    await enterPosShell(page);
  }
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

  await expect(cashierDlg).toHaveAttribute("data-roster-ready", "true", {
    timeout: 15_000,
  });
  await selectFirstStaffMember(cashierDlg);
  await expect(cashierDlg).toHaveAttribute("data-pin-entry-ready", "true", {
    timeout: 10_000,
  });

  const pin1 = cashierDlg.getByTestId("pin-key-1");
  await expect(pin1).toBeVisible({ timeout: 15_000 });
  await expect(pin1).toBeEnabled({ timeout: 15_000 });

  const code = e2eBackofficeStaffCode();
  for (const digit of code) {
    await cashierDlg.getByTestId(`pin-key-${digit}`).click();
  }
  
  const contBtn = cashierDlg.getByTestId("pos-sale-cashier-continue");
  await expect(contBtn).toBeEnabled({ timeout: 10_000 });
  await contBtn.click();
  
  await expect(cashierDlg).toBeHidden({ timeout: 20_000 });
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
  if (await posNav.isVisible().catch(() => false)) {
    return;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await posNav.isVisible().catch(() => false)) {
      return;
    }

    const enterPosButton = page.getByRole("button", {
      name: /^(enter|return) to pos$/i,
    });
    if (await enterPosButton.isVisible().catch(() => false)) {
      await expect(enterPosButton).toBeEnabled({ timeout: 10_000 });
      await enterPosButton.click();
      if (await posNav.isVisible().catch(() => false)) {
        return;
      }
      await page.waitForTimeout(600);
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

    if (await posNav.isVisible().catch(() => false)) {
      return;
    }
    await page.waitForTimeout(800);
  }

  await expect(posNav).toBeVisible({ timeout: 20_000 });
}
