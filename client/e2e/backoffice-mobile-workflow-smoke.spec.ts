import { expect, test, type Page } from "@playwright/test";
import {
  openBackofficeSidebarTab,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";

type WorkflowViewport = {
  label: string;
  width: number;
  height: number;
};

const WORKFLOW_VIEWPORTS: WorkflowViewport[] = [
  { label: "phone_390x844", width: 390, height: 844 },
  { label: "tablet_768x1024", width: 768, height: 1024 },
  { label: "ipad_1024x1366", width: 1024, height: 1366 },
  { label: "desktop_1440x900", width: 1440, height: 900 },
];

async function openMainNavSubItem(page: Page, label: RegExp): Promise<void> {
  const menuToggle = page.getByRole("button", { name: /toggle menu/i });
  if (await menuToggle.isVisible().catch(() => false)) {
    await menuToggle.click().catch(() => {});
  }
  const subButton = page.getByRole("button", { name: label }).first();
  await expect(subButton).toBeVisible({ timeout: 20_000 });
  await expect(subButton).toBeEnabled();
  await subButton.click();
}

for (const viewport of WORKFLOW_VIEWPORTS) {
  test(`Back Office mobile workflow smoke ${viewport.label}`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });

    await signInToBackOffice(page);

    // Scheduler interactions
    await openBackofficeSidebarTab(page, "appointments");
    await expect(page.getByRole("heading", { name: /appointment schedule/i })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: /^week$/i }).click();
    await page.getByRole("button", { name: /^day$/i }).click();
    await page.getByRole("button", { name: /^today$/i }).click();

    // Inventory section interaction
    await openBackofficeSidebarTab(page, "inventory");
    await openMainNavSubItem(page, /^receive stock$/i);
    await expect(page.getByText(/start with the vendor paperwork in hand/i)).toBeVisible({
      timeout: 20_000,
    });
    await openMainNavSubItem(page, /^order stock$/i);
    await expect(page.getByRole("heading", { name: /^order stock$/i }).first()).toBeVisible({
      timeout: 20_000,
    });

    // Customers -> Shipments Hub interaction
    await openBackofficeSidebarTab(page, "customers");
    await openMainNavSubItem(page, /^shipments hub$/i);
    await expect(page.getByRole("heading", { name: /all shipments|customer shipments/i })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: /^refresh$/i }).first().click();

    // Gift cards interaction
    await openBackofficeSidebarTab(page, "gift-cards");
    await expect(page.getByRole("heading", { name: /^gift cards$/i })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: /refresh cards/i }).click();

    // Loyalty interaction
    await openBackofficeSidebarTab(page, "loyalty");
    await expect(
      page.getByRole("heading", { name: /^customers ready for reward$/i }),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /refresh eligible customers/i }).click();
  });
}
