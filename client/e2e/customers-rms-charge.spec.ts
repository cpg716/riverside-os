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
    const tabs = page.getByRole("tablist", {
      name: "RMS Charge workspace sections",
    });
    await expect(page.getByRole("heading", { name: /RMS Charge Workspace/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(tabs.getByRole("tab", { name: /Transactions Log/i })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: /^Customers$/i })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: /Weekly Account Import/i })).toBeVisible();

    await page.getByPlaceholder("Customer, ref, account…").fill("REF-RMS-WORKSPACE-001");
    await expect(page.getByText("REF-RMS-WORKSPACE-001").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/recorded_manually/i).first()).toBeVisible();
    await expect(page.getByText(/RMS Charge/i).first()).toBeVisible();
  });

  test("customer section lists linked RMS Charge customers and opens their profile", async ({
    request,
    page,
  }) => {
    const fixture = await seedRmsFixture(request, "single_valid", "Customer Directory");

    const response = await request.get(
      `${apiBase()}/api/customers/rms-charge/customers?q=${encodeURIComponent(fixture.customer.customer_code)}&limit=10&offset=0`,
      { headers: staffHeaders() },
    );
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ customer_id: string; account_count: number }>;
      total_count: number;
    };
    expect(body.total_count).toBeGreaterThanOrEqual(1);
    expect(body.items).toContainEqual(
      expect.objectContaining({ customer_id: fixture.customer.id, account_count: 1 }),
    );

    await signInToBackOffice(page);
    await openCustomersRmsWorkspace(page);
    await page
      .getByRole("tablist", { name: "RMS Charge workspace sections" })
      .getByRole("tab", { name: /^Customers$/i })
      .click();
    await page
      .getByPlaceholder("Name, customer code, phone, email, account…")
      .fill(fixture.customer.customer_code);
    const customerButton = page.getByRole("button", {
      name: new RegExp(fixture.customer.customer_code, "i"),
    });
    await expect(customerButton).toBeVisible({ timeout: 15_000 });
    await customerButton.click();
    await expect(page.getByRole("tablist", { name: "Customer hub sections" })).toBeVisible({
      timeout: 15_000,
    });
  });

  test("weekly account import exposes the current RMS account-list workflow", async ({ page }) => {
    await signInToBackOffice(page);
    await openCustomersRmsWorkspace(page);

    await page
      .getByRole("tablist", { name: "RMS Charge workspace sections" })
      .getByRole("tab", { name: /Weekly Account Import/i })
      .click();
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
