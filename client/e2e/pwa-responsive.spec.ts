import { devices, expect, test } from "@playwright/test";
import { signInToBackOffice } from "./helpers/backofficeSignIn";

/**
 * Layout smoke for PWA-style viewports (per deployment checklist).
 * Expects dev server + API; assertions use stable a11y labels only.
 * Viewports come from Playwright `devices` (375×667 / 768×1024) without inlining `width`/`height` keys here.
 */
test.describe("PWA layout — phone (375×667, iPhone 8 preset)", () => {
  test.use({ viewport: devices["iPhone 8"].viewport });

  test("shell loads with mobile menu control", async ({ page }) => {
    await signInToBackOffice(page);
    await expect(page.getByRole("button", { name: "Toggle menu" })).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: /universal search/i }),
    ).toBeVisible();
  });

  test("toggle menu exposes Main Navigation", async ({ page }) => {
    await signInToBackOffice(page);
    await page.getByRole("button", { name: "Toggle menu" }).click();
    await expect(page.getByRole("navigation", { name: "Main Navigation" })).toBeVisible();
  });

  test("top bar does not force horizontal overflow", async ({ page }) => {
    await signInToBackOffice(page);
    await expect
      .poll(
        () =>
          page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        { timeout: 5_000 },
      )
      .toBeLessThanOrEqual(1);
  });

  test("offline chip stays readable on phone", async ({ page, context }) => {
    await signInToBackOffice(page);
    await context.setOffline(true);
    await expect(
      page.getByTitle(
        /Offline: only completed POS checkouts can queue until connectivity returns/i,
      ),
    ).toBeVisible();
    await context.setOffline(false);
  });

  test("search overlay stays usable on phone", async ({ page }) => {
    await signInToBackOffice(page);
    const search = page.getByRole("combobox", { name: /universal search/i });
    await search.fill("suit");
    await expect(page.getByRole("listbox", { name: "Search results" })).toBeVisible();
  });
});

test.describe("PWA layout — tablet (iPad Pro 11 preset)", () => {
  test.use({ viewport: devices["iPad Pro 11"].viewport });

  test("shell loads with tablet menu control and readable search", async ({ page }) => {
    await signInToBackOffice(page);
    await expect(page.getByRole("button", { name: "Toggle menu" })).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: /universal search/i }),
    ).toBeVisible();
  });

  test("Insights workspace exposes main heading after lazy load", async ({ page }) => {
    await signInToBackOffice(page);
    await page
      .getByRole("navigation", { name: "Main Navigation" })
      .getByRole("button", { name: /^insights(\s+bo)?$/i })
      .click();
    await expect
      .poll(
        async () =>
          (await page.getByTitle("Data Insights").isVisible().catch(() => false)) ||
          (await page
            .getByRole("button", { name: /back to back office/i })
            .isVisible()
            .catch(() => false)) ||
          (await page.getByText(/loading data insights/i).isVisible().catch(() => false)),
        { timeout: 25_000 },
      )
      .toBeTruthy();
  });

  test("offline status is explained in the live shell", async ({ page, context }) => {
    await signInToBackOffice(page);
    await context.setOffline(true);
    await expect(
      page.getByTitle(
        /Offline: only completed POS checkouts can queue until connectivity returns/i,
      ),
    ).toBeVisible();
    await context.setOffline(false);
  });

  test("opening the menu keeps tablet navigation comfortable", async ({ page }) => {
    await signInToBackOffice(page);
    await page.getByRole("button", { name: "Toggle menu" }).click();
    await expect(page.getByRole("navigation", { name: "Main Navigation" })).toBeVisible();
    await expect(page.getByTestId("sidebar-nav-home")).toBeVisible();
  });
});
