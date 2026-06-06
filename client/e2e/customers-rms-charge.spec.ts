import { expect, test } from "@playwright/test";
import {
  checkoutFinancedSale,
  openCustomersRmsWorkspace,
  seedRmsFixture,
} from "./helpers/rmsCharge";
import { signInToBackOffice } from "./helpers/backofficeSignIn";

test.describe("Back Office RMS Charge workspace", () => {
  test.describe.configure({ timeout: 90_000 });

  test("transactions log shows manual RMS Charge activity without external host dependency", async ({
    request,
    page,
  }) => {
    const fixture = await seedRmsFixture(request, "single_valid", "Workspace");
    const checkout = await checkoutFinancedSale(request, {
      fixture,
      programCode: "standard",
      referenceNumber: "REF-RMS-WORKSPACE-001",
    });
    expect(checkout.response.status(), "Financed RMS checkout failed during spec setup.").toBe(200);

    await signInToBackOffice(page);
    await openCustomersRmsWorkspace(page);
    await expect(page.getByRole("heading", { name: /RMS Charge Workspace/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: /Transactions Log/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Weekly Account Import/i })).toBeVisible();

    await page.getByPlaceholder("Customer, ref, account…").fill("REF-RMS-WORKSPACE-001");
    await expect(page.getByText("REF-RMS-WORKSPACE-001").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/recorded_manually/i).first()).toBeVisible();
    await expect(page.getByText(/RMS Charge/i).first()).toBeVisible();
  });

  test("weekly account import exposes the current RMS account-list workflow", async ({ page }) => {
    await signInToBackOffice(page);
    await openCustomersRmsWorkspace(page);

    await page.getByRole("button", { name: /Weekly Account Import/i }).click();
    await expect(page.getByRole("heading", { name: /Import Nexo\/RMS Account List/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/weekly Account List Report/i)).toBeVisible();

    const fileInput = page.locator('input[type="file"]').first();
    await expect(fileInput).toHaveAttribute(
      "accept",
      ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });
});
