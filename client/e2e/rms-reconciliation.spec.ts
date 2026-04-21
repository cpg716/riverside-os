import { expect, test } from "@playwright/test";
import {
  checkoutFinancedSale,
  getTransactionArtifacts,
  openCustomersRmsWorkspace,
  prepareRmsRecord,
  resetFakeCoreCardHost,
  seedRmsFixture,
  staffHeaders,
} from "./helpers/rmsCharge";
import { signInToBackOffice } from "./helpers/backofficeSignIn";

test.describe("RMS reconciliation", () => {
  test.beforeEach(async ({ request }) => {
    await resetFakeCoreCardHost(request);
  });

  test("reconciliation visibility surfaces mismatch and clearing-path support", async ({ request, page }) => {
    const fixture = await seedRmsFixture(request, "single_valid", "Recon");
    const checkout = await checkoutFinancedSale(request, {
      fixture,
      programCode: "standard",
    });
    const artifacts = await getTransactionArtifacts(request, checkout.body!.transaction_id);
    await prepareRmsRecord(request, "reconciliation_mismatch", artifacts.rms_records[0]!.id);

    await signInToBackOffice(page);
    await openCustomersRmsWorkspace(page);
    await page.getByTestId("rms-workspace-tab-reconciliation").click();
    await expect(
      page.getByRole("heading", { name: /latest reconciliation mismatches/i }),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("rms-run-reconciliation").click();

    const api = process.env.E2E_API_BASE || "http://127.0.0.1:43300";
    const reconciliationRes = await request.get(`${api}/api/customers/rms-charge/reconciliation?limit=10`, {
      headers: staffHeaders(),
      failOnStatusCode: false,
    });
    expect(reconciliationRes.status()).toBe(200);
    const reconciliation = (await reconciliationRes.json()) as {
      items?: Array<{ qbo_value_json?: { expected_clearing_account?: string } }>;
    };
    expect(
      reconciliation.items?.some(
        (item) =>
          item.qbo_value_json?.expected_clearing_account === "RMS_CHARGE_FINANCING_CLEARING",
      ),
    ).toBeTruthy();
  });
});
