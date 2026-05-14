import { expect, test } from "@playwright/test";
import { apiBase, seedRmsFixture, staffHeaders } from "./helpers/rmsCharge";
import {
  createSingleVariantProduct,
  createVendor,
  uniqueSuffix,
} from "./helpers/inventoryReceiving";
import {
  addDays,
  attachToNewWedding,
  checkoutWeddingOrderSeed,
  fetchReadiness,
  fetchTransactionDetail,
  pickupLine,
  transitionLine,
  type ReadinessStatus,
} from "./helpers/weddingReadiness";

type WalkthroughParty = {
  label: string;
  partyId: string;
  expectedStatus: ReadinessStatus;
  expectedBlocker?: string;
};

test.describe("Phase 4 wedding readiness walkthrough harness", () => {
  test("seeds repeatable readiness walkthrough parties", async ({ request }) => {
    test.setTimeout(240_000);
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 12);
    const fixture = await seedRmsFixture(request, "single_valid", "Phase 4 Wedding Walkthrough");
    const parties: WalkthroughParty[] = [];

    const safeProduct = await createSingleVariantProduct(request, uniqueSuffix("phase4-walk-safe"), {
      namePrefix: "Phase 4 Walkthrough Safe",
      skuPrefix: "P4WS",
    });
    const safeCheckout = await checkoutWeddingOrderSeed(request, {
      customerId: fixture.customer.id,
      products: [safeProduct],
    });
    const safeMember = await attachToNewWedding(
      request,
      safeCheckout.transaction_id,
      `Safe ${runId}`,
      45,
      { partyNamePrefix: "Phase 4 Walkthrough" },
    );
    const safeDetail = await fetchTransactionDetail(request, safeCheckout.transaction_id);
    await transitionLine(request, safeDetail.items[0]!.transaction_line_id, {
      next_status: "ready_for_pickup",
      reason: "Phase 4 walkthrough safe wedding",
    });
    const safeReadiness = await fetchReadiness(request, safeMember.wedding_party_id);
    expect(safeReadiness.status).toBe("safe");
    expect(safeReadiness.pickup.ready_members).toBeGreaterThan(0);
    parties.push({
      label: "safe wedding",
      partyId: safeMember.wedding_party_id,
      expectedStatus: "safe",
    });

    const criticalProduct = await createSingleVariantProduct(
      request,
      uniqueSuffix("phase4-walk-critical"),
      {
        namePrefix: "Phase 4 Walkthrough Critical",
        skuPrefix: "P4WC",
      },
    );
    const criticalCheckout = await checkoutWeddingOrderSeed(request, {
      customerId: fixture.customer.id,
      products: [criticalProduct],
    });
    const criticalMember = await attachToNewWedding(
      request,
      criticalCheckout.transaction_id,
      `Critical NTBO ${runId}`,
      10,
      { partyNamePrefix: "Phase 4 Walkthrough" },
    );
    const criticalReadiness = await fetchReadiness(request, criticalMember.wedding_party_id);
    expect(criticalReadiness.status).toBe("critical");
    expect(criticalReadiness.blockers.some((b) => b.label === "Needs vendor order")).toBeTruthy();
    parties.push({
      label: "critical NTBO wedding",
      partyId: criticalMember.wedding_party_id,
      expectedStatus: "critical",
      expectedBlocker: "Needs vendor order",
    });

    const vendor = await createVendor(request, uniqueSuffix("phase4-walk-vendor"));
    const vendorProduct = await createSingleVariantProduct(
      request,
      uniqueSuffix("phase4-walk-vendor-delay"),
      {
        vendorId: vendor.id,
        namePrefix: "Phase 4 Walkthrough Vendor Delay",
        skuPrefix: "P4WV",
      },
    );
    const vendorCheckout = await checkoutWeddingOrderSeed(request, {
      customerId: fixture.customer.id,
      products: [vendorProduct],
    });
    const vendorMember = await attachToNewWedding(
      request,
      vendorCheckout.transaction_id,
      `Vendor Delay ${runId}`,
      45,
      { partyNamePrefix: "Phase 4 Walkthrough" },
    );
    const vendorDetail = await fetchTransactionDetail(request, vendorCheckout.transaction_id);
    await transitionLine(request, vendorDetail.items[0]!.transaction_line_id, {
      next_status: "ordered",
      vendor_id: vendor.id,
      vendor_eta: addDays(-1),
      reason: "Phase 4 walkthrough delayed vendor",
    });
    const vendorReadiness = await fetchReadiness(request, vendorMember.wedding_party_id);
    expect(vendorReadiness.status).toBe("critical");
    expect(vendorReadiness.blockers.some((b) => b.label === "Vendor delay risk")).toBeTruthy();
    parties.push({
      label: "delayed vendor wedding",
      partyId: vendorMember.wedding_party_id,
      expectedStatus: "critical",
      expectedBlocker: "Vendor delay risk",
    });

    const partialReadyProduct = await createSingleVariantProduct(
      request,
      uniqueSuffix("phase4-walk-partial-ready"),
      {
        namePrefix: "Phase 4 Walkthrough Partial Ready",
        skuPrefix: "P4WPR",
      },
    );
    const partialBlockedProduct = await createSingleVariantProduct(
      request,
      uniqueSuffix("phase4-walk-partial-blocked"),
      {
        namePrefix: "Phase 4 Walkthrough Partial Blocked",
        skuPrefix: "P4WPB",
      },
    );
    const partialCheckout = await checkoutWeddingOrderSeed(request, {
      customerId: fixture.customer.id,
      products: [partialReadyProduct, partialBlockedProduct],
    });
    const partialMember = await attachToNewWedding(
      request,
      partialCheckout.transaction_id,
      `Partial Ready ${runId}`,
      60,
      { partyNamePrefix: "Phase 4 Walkthrough" },
    );
    const partialDetail = await fetchTransactionDetail(request, partialCheckout.transaction_id);
    const partialReadyLine = partialDetail.items.find((item) => item.sku === partialReadyProduct.sku);
    expect(partialReadyLine).toBeTruthy();
    await transitionLine(request, partialReadyLine!.transaction_line_id, {
      next_status: "ready_for_pickup",
      reason: "Phase 4 walkthrough partial ready",
    });
    const partialReadiness = await fetchReadiness(request, partialMember.wedding_party_id);
    expect(partialReadiness.status).toBe("at_risk");
    expect(partialReadiness.pickup.partial_ready_members).toBeGreaterThan(0);
    expect(partialReadiness.blockers.some((b) => b.label === "Partial party readiness")).toBeTruthy();
    parties.push({
      label: "partial-ready wedding",
      partyId: partialMember.wedding_party_id,
      expectedStatus: "at_risk",
      expectedBlocker: "Partial party readiness",
    });

    const balanceProduct = await createSingleVariantProduct(
      request,
      uniqueSuffix("phase4-walk-balance"),
      {
        namePrefix: "Phase 4 Walkthrough Balance Blocked",
        skuPrefix: "P4WBB",
      },
    );
    const balanceCheckout = await checkoutWeddingOrderSeed(request, {
      customerId: fixture.customer.id,
      products: [balanceProduct],
      amountPaid: "0.00",
    });
    const balanceMember = await attachToNewWedding(
      request,
      balanceCheckout.transaction_id,
      `Balance Blocked ${runId}`,
      60,
      { partyNamePrefix: "Phase 4 Walkthrough" },
    );
    const balanceDetail = await fetchTransactionDetail(request, balanceCheckout.transaction_id);
    await transitionLine(request, balanceDetail.items[0]!.transaction_line_id, {
      next_status: "ready_for_pickup",
      reason: "Phase 4 walkthrough balance blocked",
    });
    const balanceReadiness = await fetchReadiness(request, balanceMember.wedding_party_id);
    expect(balanceReadiness.status).toBe("at_risk");
    expect(balanceReadiness.pickup.balance_blocked_members).toBeGreaterThan(0);
    expect(
      balanceReadiness.blockers.some((b) => b.label === "Pickup blocked until balance is cleared"),
    ).toBeTruthy();
    parties.push({
      label: "balance-blocked pickup wedding",
      partyId: balanceMember.wedding_party_id,
      expectedStatus: "at_risk",
      expectedBlocker: "Pickup blocked until balance is cleared",
    });

    const completeProduct = await createSingleVariantProduct(
      request,
      uniqueSuffix("phase4-walk-complete"),
      {
        namePrefix: "Phase 4 Walkthrough Complete",
        skuPrefix: "P4WCO",
      },
    );
    const completeCheckout = await checkoutWeddingOrderSeed(request, {
      customerId: fixture.customer.id,
      products: [completeProduct],
    });
    const completeMember = await attachToNewWedding(
      request,
      completeCheckout.transaction_id,
      `Complete ${runId}`,
      75,
      { partyNamePrefix: "Phase 4 Walkthrough" },
    );
    const completeDetail = await fetchTransactionDetail(request, completeCheckout.transaction_id);
    const completeLine = completeDetail.items[0]!.transaction_line_id;
    await transitionLine(request, completeLine, {
      next_status: "ready_for_pickup",
      reason: "Phase 4 walkthrough complete wedding",
    });
    await pickupLine(request, completeCheckout.transaction_id, completeLine);
    const completeReadiness = await fetchReadiness(request, completeMember.wedding_party_id);
    expect(completeReadiness.status).toBe("complete");
    expect(completeReadiness.blockers).toHaveLength(0);
    parties.push({
      label: "fully complete wedding",
      partyId: completeMember.wedding_party_id,
      expectedStatus: "complete",
    });

    const dashboardRes = await request.get(
      `${apiBase()}/api/weddings/readiness-dashboard?start_date=${addDays(0)}&end_date=${addDays(120)}&limit=200`,
      {
        headers: staffHeaders(),
        failOnStatusCode: false,
      },
    );
    const dashboardText = await dashboardRes.text();
    expect(dashboardRes.status(), dashboardText.slice(0, 1000)).toBe(200);
    const dashboard = JSON.parse(dashboardText) as {
      parties: Array<{ wedding_party_id: string; status: ReadinessStatus }>;
    };
    for (const party of parties) {
      const dashboardParty = dashboard.parties.find((row) => row.wedding_party_id === party.partyId);
      expect(dashboardParty, `${party.label} missing from readiness dashboard`).toBeTruthy();
      expect(dashboardParty!.status, party.label).toBe(party.expectedStatus);
    }
  });
});
