import { expect, test } from "@playwright/test";
import {
  checkoutFinancedSale,
  getTransactionArtifacts,
  openCustomersRmsWorkspace,
  prepareRmsRecord,
  resetFakeCoreCardHost,
  seedRmsFixture,
} from "./helpers/rmsCharge";
import { signInToBackOffice } from "./helpers/backofficeSignIn";

test.describe("Back Office RMS Charge workspace", () => {
  test.beforeEach(async ({ request }) => {
    await resetFakeCoreCardHost(request);
  });

  test("exception retry flow transitions a seeded failure to resolved", async ({ request, page }) => {
    const fixture = await seedRmsFixture(request, "single_valid", "Exception");
    const checkout = await checkoutFinancedSale(request, {
      fixture,
      programCode: "standard",
    });
    const artifacts = await getTransactionArtifacts(request, checkout.body!.transaction_id);
    const prepared = (await prepareRmsRecord(request, "failed_exception", artifacts.rms_records[0]!.id)) as {
      exception_id: string;
    };

    await signInToBackOffice(page);
    await openCustomersRmsWorkspace(page);
    await page.getByTestId("rms-workspace-tab-exceptions").click();
    await expect(page.getByText(/failed purchase post/i).first()).toBeVisible({ timeout: 15_000 });
    await page.getByTestId(`rms-exception-retry-${prepared.exception_id}`).click();
    await expect
      .poll(
        async () => {
          const refreshed = await getTransactionArtifacts(request, checkout.body!.transaction_id);
          return refreshed.rms_records[0]?.posting_status;
        },
        { timeout: 15_000, message: "Seeded RMS exception never transitioned back to posted." },
      )
      .toBe("posted");
  });
});
