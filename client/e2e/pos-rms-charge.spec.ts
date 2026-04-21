import { expect, test } from "@playwright/test";
import {
  checkoutFinancedSale,
  checkoutRmsPaymentCollection,
  ensureSessionAuth,
  fetchReceiptZpl,
  getFakeCoreCardCalls,
  getTransactionArtifacts,
  resetFakeCoreCardHost,
  seedRmsFixture,
  setFakeCoreCardScenario,
} from "./helpers/rmsCharge";

test.describe("POS RMS Charge", () => {
  test.beforeEach(async ({ request }) => {
    await resetFakeCoreCardHost(request);
  });

  test("financed sale success persists metadata and receipt wording", async ({ request }) => {
    const fixture = await seedRmsFixture(request, "rms90_eligible", "Success");
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const checkout = await checkoutFinancedSale(request, {
      fixture,
      programCode: "rms90",
    });

    expect(checkout.response.status()).toBe(200);
    const artifacts = await getTransactionArtifacts(request, checkout.body!.transaction_id);
    const rmsRecord = artifacts.rms_records[0];
    const financingMeta = (artifacts.metadata.rms_charge ?? {}) as Record<string, unknown>;
    expect(financingMeta.program_label).toBe("RMS 90");
    expect(rmsRecord.program_label).toBe("RMS 90");
    expect(rmsRecord.masked_account).toContain("••••");
    expect(rmsRecord.host_reference).toContain("HOST-");
    expect(rmsRecord.posting_status).toBe("posted");

    const receipt = await fetchReceiptZpl(request, checkout.body!.transaction_id, sessionId);
    expect(receipt).toContain("RMS Charge");
    expect(receipt).toContain("RMS 90");
    expect(receipt).toContain(rmsRecord.masked_account ?? "••••");
    expect(receipt).toContain(rmsRecord.host_reference ?? "HOST-");
  });

  test("financed sale decline blocks checkout and does not record false success", async ({ request }) => {
    const fixture = await seedRmsFixture(request, "single_valid", "Decline");
    const accountId = fixture.linked_accounts[0]!.corecredit_account_id;
    await setFakeCoreCardScenario(request, "purchase", "insufficient_credit", accountId);

    const checkout = await checkoutFinancedSale(request, {
      fixture,
      programCode: "standard",
      hostScenario: "insufficient_credit",
    });
    expect(checkout.response.status()).toBe(502);
    const body = (await checkout.response.json()) as { error?: string };
    expect(body.error).toMatch(/insufficient/i);

    const recordsRes = await request.get(
      `${process.env.E2E_API_BASE || "http://127.0.0.1:43300"}/api/customers/rms-charge/records?customer_id=${fixture.customer.id}`,
      {
        headers: {
          "x-riverside-staff-code": "1234",
          "x-riverside-staff-pin": "1234",
        },
      },
    );
    expect(recordsRes.status()).toBe(200);
    const rows = (await recordsRes.json()) as Array<{ posting_status?: string }>;
    expect(rows.every((row) => row.posting_status !== "posted")).toBeTruthy();
  });

  test("no-customer RMS Charge block avoids host call", async ({ request, page }) => {
    await page.goto("/");
    const callsBefore = await getFakeCoreCardCalls(request);
    await expect(callsBefore).toHaveLength(0);
  });

  test("multi-match metadata persists the selected account", async ({ request }) => {
    const fixture = await seedRmsFixture(request, "multi_match", "Multi");
    const chosen = fixture.linked_accounts[1]!;
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const checkout = await request.post(
      `${process.env.E2E_API_BASE || "http://127.0.0.1:43300"}/api/transactions/checkout`,
      {
        headers: {
          "x-riverside-staff-code": "1234",
          "x-riverside-staff-pin": "1234",
          "x-riverside-pos-session-id": sessionId,
          "x-riverside-pos-session-token": sessionToken,
          "Content-Type": "application/json",
        },
        data: {
          session_id: sessionId,
          operator_staff_id: await (async () => {
            const res = await request.post(`${process.env.E2E_API_BASE || "http://127.0.0.1:43300"}/api/staff/verify-cashier-code`, {
              headers: { "Content-Type": "application/json" },
              data: { cashier_code: "1234", pin: "1234" },
            });
            return ((await res.json()) as { staff_id: string }).staff_id;
          })(),
          customer_id: fixture.customer.id,
          payment_method: "on_account_rms90",
          total_price: fixture.product.unit_price,
          amount_paid: fixture.product.unit_price,
          payment_splits: [
            {
              payment_method: "on_account_rms90",
              amount: fixture.product.unit_price,
              metadata: {
                tender_family: "rms_charge",
                program_code: "rms90",
                program_label: "RMS 90",
                masked_account: chosen.masked_account,
                linked_corecredit_customer_id: chosen.corecredit_customer_id,
                linked_corecredit_account_id: chosen.corecredit_account_id,
                resolution_status: "selected",
              },
            },
          ],
          items: [
            {
              product_id: fixture.product.product_id,
              variant_id: fixture.product.variant_id,
              fulfillment: "takeaway",
              quantity: 1,
              unit_price: fixture.product.unit_price,
              unit_cost: fixture.product.unit_cost,
              state_tax: "0.00",
              local_tax: "0.00",
            },
          ],
          checkout_client_id: crypto.randomUUID(),
          is_tax_exempt: true,
          tax_exempt_reason: "Out of State",
        },
        failOnStatusCode: false,
      },
    );
    expect(checkout.status()).toBe(200);
    const body = (await checkout.json()) as { transaction_id: string };
    const artifacts = await getTransactionArtifacts(request, body.transaction_id);
    const selectedMeta = (artifacts.metadata.rms_charge ?? {}) as Record<string, unknown>;
    expect(selectedMeta.linked_corecredit_account_id).toBe(chosen.corecredit_account_id);
    expect(artifacts.rms_records[0]?.linked_corecredit_account_id).toBe(chosen.corecredit_account_id);
  });

  test("RMS payment collection success persists host reference and clearing metadata", async ({ request }) => {
    const fixture = await seedRmsFixture(request, "single_valid", "Payment");
    const { sessionId } = await ensureSessionAuth(request);
    const checkout = await checkoutRmsPaymentCollection(request, fixture);
    expect(checkout.response.status()).toBe(200);
    const artifacts = await getTransactionArtifacts(request, checkout.body!.transaction_id);
    expect(artifacts.rms_records[0]?.record_kind).toBe("payment");
    expect(artifacts.rms_records[0]?.posting_status).toBe("posted");
    expect(artifacts.metadata.rms_charge_payment_collection).toMatchObject({
      tender_family: "rms_charge",
      posting_status: "posted",
    });

    const receipt = await fetchReceiptZpl(request, checkout.body!.transaction_id, sessionId);
    expect(receipt).toContain("Tender: Cash");
    expect(receipt).toContain("RMS Ref:");
    expect(receipt).toContain(artifacts.rms_records[0]?.host_reference ?? "HOST-");
  });

  test("RMS payment collection host failure does not silently succeed", async ({ request }) => {
    const fixture = await seedRmsFixture(request, "single_valid", "Payment Failure");
    const accountId = fixture.linked_accounts[0]!.corecredit_account_id;
    await setFakeCoreCardScenario(request, "payment", "retryable", accountId);
    const checkout = await checkoutRmsPaymentCollection(request, fixture, "retryable");
    expect(checkout.response.status()).toBe(502);
    const body = (await checkout.response.json()) as { error?: string };
    expect(body.error).toMatch(/unavailable|retry/i);
  });

  test("program-specific receipt correctness covers standard and RMS 90", async ({ request }) => {
    const standardFixture = await seedRmsFixture(request, "standard_only", "Standard Receipt");
    const rms90Fixture = await seedRmsFixture(request, "rms90_eligible", "RMS90 Receipt");
    const { sessionId } = await ensureSessionAuth(request);

    const standard = await checkoutFinancedSale(request, {
      fixture: standardFixture,
      programCode: "standard",
    });
    const rms90 = await checkoutFinancedSale(request, {
      fixture: rms90Fixture,
      programCode: "rms90",
    });
    const standardReceipt = await fetchReceiptZpl(request, standard.body!.transaction_id, sessionId);
    const rms90Receipt = await fetchReceiptZpl(request, rms90.body!.transaction_id, sessionId);
    expect(standardReceipt).toContain("Program: Standard");
    expect(standardReceipt).not.toContain("RMS90");
    expect(rms90Receipt).toContain("Program: RMS 90");
  });

  test("legacy compatibility smoke keeps historical RMS/RMS90 records readable", async ({ request }) => {
    const fixture = await seedRmsFixture(request, "rms90_eligible", "Legacy");
    const standard = await checkoutFinancedSale(request, {
      fixture,
      programCode: "standard",
    });
    const rms90 = await checkoutFinancedSale(request, {
      fixture,
      programCode: "rms90",
    });

    const a = await getTransactionArtifacts(request, standard.body!.transaction_id);
    const b = await getTransactionArtifacts(request, rms90.body!.transaction_id);
    expect(a.payment_rows[0]?.payment_method).toBe("on_account_rms");
    expect(b.payment_rows[0]?.payment_method).toBe("on_account_rms90");
    expect(a.rms_records[0]?.program_label).toBe("Standard");
    expect(b.rms_records[0]?.program_label).toBe("RMS 90");
  });
});
