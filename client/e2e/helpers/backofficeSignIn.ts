import { expect, type Page } from "@playwright/test";

const SESSION_KEY = "ros.backoffice.session.v1";

function resolveBackofficeStaffName(staffName?: string): string {
  return staffName?.trim() || process.env.E2E_BO_STAFF_NAME?.trim() || "Chris G";
}

export async function selectBackofficeStaffMember(
  container: Page | ReturnType<Page["getByRole"]>,
  staffName?: string,
) {
  const preferredName = resolveBackofficeStaffName(staffName);
  const selectorButton = container.getByRole("button", {
    name: /select staff member|select\.\.\.|select your name/i,
  });
  if (!(await selectorButton.isVisible().catch(() => false))) {
    return;
  }
  if ((await selectorButton.textContent())?.match(new RegExp(preferredName, "i"))) {
    return;
  }
  await selectorButton.click();
  const preferredOption = container.getByRole("button", {
    name: new RegExp(preferredName, "i"),
  });
  const selectedStaffButton = container
    .getByRole("button", { name: new RegExp(preferredName, "i") })
    .first();
  await preferredOption.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  if (await preferredOption.isVisible().catch(() => false)) {
    await preferredOption.click();
    await expect(selectedStaffButton).toBeVisible({ timeout: 5_000 });
    return;
  }
  const options = container
    .locator("button")
    .filter({ has: container.locator("img") })
    .filter({ hasNotText: /select staff member/i });
  await options.first().waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  const optionCount = await options.count();
  if (optionCount > 0) {
    await options.first().click();
  }
  if (staffName) {
    await expect(selectedStaffButton).toBeVisible({ timeout: 5_000 });
  }
}

export async function ensureMainNavigationVisible(page: Page) {
  const mainNav = page.getByRole("navigation", { name: "Main Navigation" });
  if (await mainNav.isVisible().catch(() => false)) {
    return mainNav;
  }
  const menuToggle = page.getByRole("button", { name: "Toggle menu" });
  if (await menuToggle.isVisible().catch(() => false)) {
    await menuToggle.click();
  }
  await expect(mainNav).toBeVisible({ timeout: 20_000 });
  return mainNav;
}

export async function openBackofficeSidebarTab(
  page: Page,
  tabId:
    | "home"
    | "register"
    | "customers"
    | "alterations"
    | "orders"
    | "inventory"
    | "weddings"
    | "gift-cards"
    | "loyalty"
    | "staff"
    | "qbo"
    | "appointments"
    | "reports"
    | "dashboard"
    | "settings",
) {
  const mainNav = await ensureMainNavigationVisible(page);
  const tabLabelPatterns: Record<typeof tabId, RegExp> = {
    home: /^operations(?:\s+bo)?$/i,
    register: /^pos$/i,
    customers: /^customers(?:\s+pos)?$/i,
    alterations: /^alterations(?:\s+pos)?$/i,
    orders: /^orders(?:\s+pos)?$/i,
    inventory: /^inventory(?:\s+bo)?$/i,
    weddings: /^weddings(?:\s+bo)?$/i,
    "gift-cards": /^gift cards(?:\s+bo)?$/i,
    loyalty: /^loyalty(?:\s+bo)?$/i,
    staff: /^staff(?:\s+bo)?$/i,
    qbo: /^qbo bridge(?:\s+bo)?$/i,
    appointments: /^appointments(?:\s+bo)?$/i,
    reports: /^reports(?:\s+bo)?$/i,
    dashboard: /^insights(?:\s+bo)?$/i,
    settings: /^settings(?:\s+bo)?$/i,
  };
  const tabButton = mainNav.getByRole("button", {
    name: tabLabelPatterns[tabId],
  });
  await expect(tabButton).toBeVisible({ timeout: 15_000 });
  await tabButton.scrollIntoViewIfNeeded().catch(() => {});
  await expect(tabButton).toBeEnabled();
  await tabButton.click();
  if (tabId === "register") {
    return tabButton;
  }
  if (tabId === "settings") {
    await expect(
      mainNav.getByRole("button", { name: /^help center$/i }),
    ).toBeVisible({ timeout: 20_000 });
  } else {
    await expect(tabButton).toHaveAttribute("aria-current", "page", {
      timeout: 15_000,
    });
  }
  return tabButton;
}

/** Default seeded admin in `scripts/seed_staff_register_test.sql` + migration `53_default_admin_chris_g_pin.sql`. */
export function e2eBackofficeStaffCode(staffCode?: string): string {
  return staffCode?.trim() || process.env.E2E_BO_STAFF_CODE?.trim() || "1234";
}

/**
 * Clears persisted Back Office session and reloads so the sign-in gate appears (when applicable).
 */
export async function clearBackofficeSession(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate((key) => sessionStorage.removeItem(key), SESSION_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function waitForBackofficeShellReady(page: Page, message: string): Promise<void> {
  const mainNav = page.getByRole("navigation", { name: "Main Navigation" });
  await expect(page.getByText(/loading riverside/i)).not.toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(
      async () =>
        (await page
          .getByRole("heading", { name: /operations overview/i })
          .isVisible()
          .catch(() => false)) ||
        (await page
          .getByRole("navigation", { name: "POS Navigation" })
          .isVisible()
          .catch(() => false)) ||
        (await mainNav.isVisible().catch(() => false)),
      { timeout: 20_000, message },
    )
    .toBeTruthy();
}

export async function signInToBackOffice(
  page: Page,
  options?: {
    staffCode?: string;
    staffName?: string;
    persistSession?: boolean;
  },
): Promise<void> {
  const code = e2eBackofficeStaffCode(options?.staffCode);
  if (code.length !== 4 || !/^\d{4}$/.test(code)) {
    throw new Error(
      "Back Office E2E staff code must be exactly four digits.",
    );
  }

  /** Unified staff gate (`BackofficeSignInGate`) h1 is "Sign in". */
  const signInHeading = page.getByRole("heading", {
    name: /^sign in$/i,
  });
  const mainNav = page.getByRole("navigation", { name: "Main Navigation" });

  const headerStaffAuth =
    Boolean(process.env.E2E_STAFF_CODE?.trim()) &&
    Boolean(process.env.E2E_STAFF_PIN?.trim());
  const effectivePermAfterShellLoad = headerStaffAuth
    ? page.waitForResponse(
        (r) =>
          r.url().includes("/api/staff/effective-permissions") &&
          r.request().method() === "GET" &&
          r.status() === 200,
        { timeout: 30_000 },
      )
    : null;

  await page.goto("/", { waitUntil: "domcontentloaded" });
  if (options?.persistSession) {
    const effectivePermAfterRestore = page
      .waitForResponse(
        (r) =>
          r.url().includes("/api/staff/effective-permissions") &&
          r.request().method() === "GET" &&
          r.status() === 200,
        { timeout: 25_000 },
      )
      .catch(() => null);
    const sessionBootstrapAfterRestore = page
      .waitForResponse(
        (r) =>
          r.url().includes("/api/sessions/current") &&
          r.request().method() === "GET" &&
          (r.status() === 200 || r.status() === 409),
        { timeout: 25_000 },
      )
      .catch(() => null);
    await page.evaluate(
      ({ key, staffCode }) => {
        sessionStorage.setItem(
          key,
          JSON.stringify({ staffCode, staffPin: staffCode }),
        );
      },
      { key: SESSION_KEY, staffCode: code },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await effectivePermAfterRestore;
    await sessionBootstrapAfterRestore;
    await waitForBackofficeShellReady(
      page,
      "Back Office shell never stabilized after session restore",
    );
    return;
  }
  await page.evaluate((key) => sessionStorage.removeItem(key), SESSION_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText(/loading riverside/i)).not.toBeVisible({
    timeout: 30_000,
  });

  if (!(await signInHeading.isVisible().catch(() => false))) {
    if (effectivePermAfterShellLoad) await effectivePermAfterShellLoad;
    else
      await page.waitForLoadState("domcontentloaded", { timeout: 25_000 }).catch(() => {});
    await waitForBackofficeShellReady(
      page,
      "Back Office shell never stabilized after session restore",
    );
    return;
  }

  await selectBackofficeStaffMember(page, options?.staffName);

  const effectivePerm200 = page.waitForResponse(
    (r) =>
      r.url().includes("/api/staff/effective-permissions") &&
      r.request().method() === "GET" &&
      r.status() === 200,
    { timeout: 25_000 },
  );
  const sessionBootstrapSettled = page
    .waitForResponse(
      (r) =>
        r.url().includes("/api/sessions/current") &&
        r.request().method() === "GET" &&
        (r.status() === 200 || r.status() === 409),
      { timeout: 25_000 },
    )
    .catch(() => null);

  for (const digit of code) {
    await page.getByTestId(`pin-key-${digit}`).click();
  }
  await page.getByRole("button", { name: /^continue$/i }).click();

  await expect(signInHeading).toBeHidden({ timeout: 20_000 });

  /**
   * Below `lg`, the primary nav can be off-canvas while the shell is still ready.
   * On phone widths both the drawer nav and the menu toggle can exist — avoid `locator.or` + `toBeVisible`,
   * which errors in strict mode when two matches are visible.
   */
  await effectivePerm200;
  await sessionBootstrapSettled;
  await waitForBackofficeShellReady(
    page,
    "Back Office shell never finished bootstrap after sign-in",
  );
}
