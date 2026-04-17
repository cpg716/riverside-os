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
  });

  test("toggle menu exposes Main Navigation", async ({ page }) => {
    await signInToBackOffice(page);
    await page.getByRole("button", { name: "Toggle menu" }).click();
    await expect(page.getByRole("navigation", { name: "Main Navigation" })).toBeVisible();
  });
});

test.describe("PWA layout — tablet (768×1024, iPad Mini preset)", () => {
  test.use({ viewport: devices["iPad Mini"].viewport });

  test("shell loads with main navigation", async ({ page }) => {
    await signInToBackOffice(page);
    await expect(page.getByRole("navigation", { name: "Main Navigation" })).toBeVisible();
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
});
