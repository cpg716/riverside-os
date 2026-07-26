import { expect, test } from "@playwright/test";
import {
  apiBase,
  checkoutFinancedSale,
  openCustomersRmsWorkspace,
  seedRmsFixture,
  staffHeaders,
} from "./helpers/rmsCharge";
import { signInToBackOffice } from "./helpers/backofficeSignIn";

test.describe("Back Office RMS Charge workspace", () => {
  test.describe.configure({ timeout: 90_000 });

  test("customer browse and Register search expose RMS Charge account presence", async ({
    request,
  }) => {
    const fixture = await seedRmsFixture(request, "single_valid", "Customer Pill");
    const params = new URLSearchParams({
      q: fixture.customer.search_label,
      limit: "50",
      offset: "0",
    });

    const searchResponse = await request.get(
      `${apiBase()}/api/customers/search?${params.toString()}`,
      { headers: staffHeaders() },
    );
    expect(searchResponse.status()).toBe(200);
    const searchRows = (await searchResponse.json()) as Array<{
      id: string;
      has_rms_charge?: boolean;
    }>;
    expect(searchRows.find((row) => row.id === fixture.customer.id)).toMatchObject({
      has_rms_charge: true,
    });

    const browseResponse = await request.get(
      `${apiBase()}/api/customers/browse?${params.toString()}`,
      { headers: staffHeaders() },
    );
    expect(browseResponse.status()).toBe(200);
    const browseRows = (await browseResponse.json()) as Array<{
      id: string;
      has_rms_charge?: boolean;
    }>;
    expect(browseRows.find((row) => row.id === fixture.customer.id)).toMatchObject({
      has_rms_charge: true,
    });
  });

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
