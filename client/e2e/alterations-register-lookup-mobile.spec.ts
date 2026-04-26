import { expect, test, type Page } from "@playwright/test";
import { openBackofficeSidebarTab, signInToBackOffice } from "./helpers/backofficeSignIn";
import { ensurePosRegisterSessionOpen, ensurePosSaleCashierSignedIn } from "./helpers/openPosRegister";

type SurfaceViewport = {
  label: string;
  width: number;
  height: number;
};

const SURFACE_VIEWPORTS: SurfaceViewport[] = [
  { label: "phone_390x844", width: 390, height: 844 },
  { label: "tablet_768x1024", width: 768, height: 1024 },
  { label: "ipad_1024x1366", width: 1024, height: 1366 },
  { label: "desktop_1440x900", width: 1440, height: 900 },
];

async function openAlterationsAndVerify(page: Page): Promise<void> {
  await openBackofficeSidebarTab(page, "alterations");
  await expect(page.getByTestId("alterations-status-filter")).toBeVisible({ timeout: 20_000 });
  const search = page.getByTestId("alterations-search");
  await expect(search).toBeVisible({ timeout: 20_000 });
  await search.fill("hem");
  await expect(search).toHaveValue("hem");
}

async function openRegisterAndVerifyLookup(page: Page): Promise<void> {
  await openBackofficeSidebarTab(page, "register");
  await ensurePosRegisterSessionOpen(page);
  await ensurePosSaleCashierSignedIn(page);
  const lookupInput = page.getByTestId("pos-product-search");
  await expect(lookupInput).toBeVisible({ timeout: 20_000 });
  await lookupInput.fill("navy suit");
  await expect(lookupInput).toHaveValue("navy suit");
}

for (const viewport of SURFACE_VIEWPORTS) {
  test(`Alterations + register lookup mobile ${viewport.label}`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await signInToBackOffice(page);

    await openAlterationsAndVerify(page);
    await openRegisterAndVerifyLookup(page);
  });
}
