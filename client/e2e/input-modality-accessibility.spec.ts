import { expect, test } from "@playwright/test";
import {
  openBackofficeSidebarTab,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";
import {
  ensurePosRegisterSessionOpen,
  enterPosShell,
} from "./helpers/openPosRegister";

test("POS Staff Access traps keyboard focus inside the active dialog", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signInToBackOffice(page);
  await enterPosShell(page);
  await ensurePosRegisterSessionOpen(page);

  const dialog = page.getByTestId("pos-sale-cashier-overlay");
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBeTruthy();

  const focusable = dialog.locator(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  );
  const focusableCount = await focusable.count();
  expect(focusableCount).toBeGreaterThan(1);

  await focusable.last().focus();
  await page.keyboard.press("Tab");
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBeTruthy();

  await focusable.first().focus();
  await page.keyboard.press("Shift+Tab");
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBeTruthy();
});

test.describe("coarse pointer touch targets", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 834, height: 1194 },
  });

  test("global command controls preserve a 44px touch target", async ({ page }) => {
    await signInToBackOffice(page);

    for (const name of [/universal search/i, /help library/i, /notifications/i]) {
      const control = page.getByRole("button", { name }).first();
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box, `${name} should have a rendered box`).not.toBeNull();
      expect(box!.width, `${name} width`).toBeGreaterThanOrEqual(44);
      expect(box!.height, `${name} height`).toBeGreaterThanOrEqual(44);
    }
  });
});

test("audited compact search and filter fields have stable accessible names", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signInToBackOffice(page);

  await openBackofficeSidebarTab(page, "customers");
  await expect(page.getByRole("textbox", { name: "Search customers" })).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Filter customers by wedding party" }),
  ).toBeVisible();

  await openBackofficeSidebarTab(page, "orders");
  await expect(page.getByRole("textbox", { name: "Search orders" })).toBeVisible();
  for (const name of [
    "Filter orders by type",
    "Filter orders by payment status",
    "Filter orders by staff member",
    "Filter orders by lifecycle status",
    "Filter orders by date range",
  ]) {
    await expect(page.getByRole("combobox", { name })).toBeVisible();
  }

  await openBackofficeSidebarTab(page, "staff");
  await expect(page.getByRole("textbox", { name: "Search staff" })).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Filter staff by account status" }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Staff type for selected staff members" }),
  ).toBeVisible();
});
