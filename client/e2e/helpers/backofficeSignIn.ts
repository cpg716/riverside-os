import { expect, type Page } from "@playwright/test";

const SESSION_KEY = "ros.backoffice.session.v1";

function e2eBackofficeStaffName(): string {
  return process.env.E2E_BO_STAFF_NAME?.trim() || "Chris G";
}

async function selectFirstStaffMember(container: Page | ReturnType<Page["getByRole"]>) {
  const preferredName = e2eBackofficeStaffName();
  const selectorButton = container
    .getByText(/select your name/i)
    .locator("xpath=following::button[1]");
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
  if (await preferredOption.isVisible().catch(() => false)) {
    await preferredOption.click();
    return;
  }
  const options = container
    .locator("button")
    .filter({ has: container.locator("img") })
    .filter({ hasNotText: /select staff member/i });
  const optionCount = await options.count();
  if (optionCount > 0) {
    await options.nth(Math.min(1, optionCount - 1)).click();
  }
}

/** Default seeded admin in `scripts/seed_staff_register_test.sql` + migration `53_default_admin_chris_g_pin.sql`. */
export function e2eBackofficeStaffCode(): string {
  return process.env.E2E_BO_STAFF_CODE?.trim() || "1234";
}

/**
 * Clears persisted Back Office session and reloads so the sign-in gate appears (when applicable).
 */
export async function clearBackofficeSession(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate((key) => sessionStorage.removeItem(key), SESSION_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
}

/**
 * Completes Back Office sign-in via the 4-digit keypad when the gate is shown.
 * No-op if the main shell is already visible (e.g. session restored).
 */
export async function signInToBackOffice(page: Page): Promise<void> {
  const code = e2eBackofficeStaffCode();
  if (code.length !== 4 || !/^\d{4}$/.test(code)) {
    throw new Error(
      "E2E_BO_STAFF_CODE must be exactly four digits when set (default 1234).",
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
  await page.evaluate((key) => sessionStorage.removeItem(key), SESSION_KEY);
  await page.reload({ waitUntil: "networkidle" }).catch(() =>
    page.reload({ waitUntil: "domcontentloaded" }),
  );

  await expect(page.getByText(/loading riverside/i)).not.toBeVisible({
    timeout: 30_000,
  });

  if (!(await signInHeading.isVisible().catch(() => false))) {
    if (effectivePermAfterShellLoad) await effectivePermAfterShellLoad;
    else
      await page.waitForLoadState("domcontentloaded", { timeout: 25_000 }).catch(() => {});
    return;
  }

  await selectFirstStaffMember(page);

  const effectivePerm200 = page.waitForResponse(
    (r) =>
      r.url().includes("/api/staff/effective-permissions") &&
      r.request().method() === "GET" &&
      r.status() === 200,
    { timeout: 25_000 },
  );

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
  const menuToggle = page.getByRole("button", { name: "Toggle menu" });
  await expect
    .poll(
      async () =>
        (await menuToggle.isVisible().catch(() => false)) ||
        (await mainNav.isVisible().catch(() => false)),
      { timeout: 20_000 },
    )
    .toBeTruthy();

  await effectivePerm200;
}
