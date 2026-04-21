import { expect, test } from "@playwright/test";
import {
  checkoutFinancedSale,
  getTransactionArtifacts,
  postCoreCardWebhook,
  prepareRmsRecord,
  resetFakeCoreCardHost,
  seedRmsFixture,
} from "./helpers/rmsCharge";

test.describe("CoreCard webhooks", () => {
  test.beforeEach(async ({ request }) => {
    await resetFakeCoreCardHost(request);
  });

  test("webhook ingestion updates state and replay is idempotent", async ({ request }) => {
    const fixture = await seedRmsFixture(request, "single_valid", "Webhook");
    const checkout = await checkoutFinancedSale(request, {
      fixture,
      programCode: "standard",
    });
    const artifacts = await getTransactionArtifacts(request, checkout.body!.transaction_id);
    const recordId = artifacts.rms_records[0]!.id;
    await prepareRmsRecord(request, "pending_webhook", recordId);

    const payload = {
      event_id: `evt-${recordId}`,
      event_type: "transaction.updated",
      rms_record_id: recordId,
      external_transaction_id: `WEBHOOK-${recordId}`,
      host_reference: "HOST-WEBHOOK-0001",
      posting_status: "posted",
      posted_at: new Date().toISOString(),
    };

    const first = await postCoreCardWebhook(request, payload);
    expect(first.status()).toBe(200);
    const firstBody = (await first.json()) as { duplicate?: boolean };
    expect(firstBody.duplicate).toBeFalsy();

    const second = await postCoreCardWebhook(request, payload);
    expect(second.status()).toBe(200);
    const secondBody = (await second.json()) as { duplicate?: boolean };
    expect(secondBody.duplicate).toBeTruthy();

    const updated = await getTransactionArtifacts(request, checkout.body!.transaction_id);
    expect(updated.rms_records[0]?.posting_status).toBe("posted");
  });
});
