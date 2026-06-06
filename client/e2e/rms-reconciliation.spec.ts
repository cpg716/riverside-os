import { expect, test } from "@playwright/test";
import {
  apiBase,
  checkoutFinancedSale,
  getTransactionArtifacts,
  prepareRmsRecord,
  seedRmsFixture,
  staffHeaders,
} from "./helpers/rmsCharge";

test.describe("RMS reconciliation", () => {
  test("reconciliation endpoint surfaces seeded RMS mismatch records", async ({ request }) => {
    const fixture = await seedRmsFixture(request, "single_valid", "Recon");
    const checkout = await checkoutFinancedSale(request, {
      fixture,
      programCode: "standard",
    });
    expect(checkout.response.status(), "Financed RMS checkout failed during reconciliation setup.").toBe(200);
    const artifacts = await getTransactionArtifacts(request, checkout.body!.transaction_id);
    const prepared = (await prepareRmsRecord(
      request,
      "reconciliation_mismatch",
      artifacts.rms_records[0]!.id,
    )) as { reconciliation_run_id?: string | null };

    const reconciliationRes = await request.get(`${apiBase()}/api/customers/rms-charge/reconciliation?limit=10`, {
      headers: staffHeaders(),
      failOnStatusCode: false,
    });
    expect(reconciliationRes.status()).toBe(200);
    const reconciliation = (await reconciliationRes.json()) as {
      items?: Array<{ mismatch_type?: string; severity?: string; status?: string }>;
      runs?: Array<{ status?: string; summary_json?: { mismatch_count?: number } }>;
    };

    expect(prepared.reconciliation_run_id).toBeTruthy();
    expect(reconciliation.items).toContainEqual(
      expect.objectContaining({
        mismatch_type: "posting_status_mismatch",
        severity: "high",
        status: "open",
      }),
    );
    expect(reconciliation.runs).toContainEqual(
      expect.objectContaining({
        status: "completed",
        summary_json: expect.objectContaining({ mismatch_count: 1 }),
      }),
    );
  });
});
