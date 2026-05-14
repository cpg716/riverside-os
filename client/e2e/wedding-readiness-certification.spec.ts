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
} from "./helpers/weddingReadiness";

test.describe("Phase 4 wedding readiness certification", () => {
  test("certifies wedding readiness risk, vendor delay, partial pickup, balance block, and completion", async ({
    request,
  }) => {
    test.setTimeout(180_000);
    const fixture = await seedRmsFixture(request, "single_valid", "Phase 4 Wedding Readiness");

    const criticalProduct = await createSingleVariantProduct(request, uniqueSuffix("phase4-critical"), {
      namePrefix: "Phase 4 Critical",
      skuPrefix: "P4C",
    });
    const criticalCheckout = await checkoutWeddingOrderSeed(request, {
      customerId: fixture.customer.id,
      products: [criticalProduct],
    });
    const criticalMember = await attachToNewWedding(
      request,
      criticalCheckout.transaction_id,
      "Critical",
      10,
    );
    const criticalReadiness = await fetchReadiness(request, criticalMember.wedding_party_id);
    expect(criticalReadiness.status).toBe("critical");
    expect(criticalReadiness.lifecycle.ntbo).toBeGreaterThan(0);
    expect(criticalReadiness.blockers.some((b) => b.label === "Needs vendor order")).toBeTruthy();

    const vendor = await createVendor(request, uniqueSuffix("phase4-vendor-delay"));
    const vendorProduct = await createSingleVariantProduct(request, uniqueSuffix("phase4-vendor"), {
      vendorId: vendor.id,
      namePrefix: "Phase 4 Vendor Delay",
      skuPrefix: "P4V",
    });
    const vendorCheckout = await checkoutWeddingOrderSeed(request, {
      customerId: fixture.customer.id,
      products: [vendorProduct],
    });
    const vendorMember = await attachToNewWedding(request, vendorCheckout.transaction_id, "Vendor", 45);
    const vendorDetail = await fetchTransactionDetail(request, vendorCheckout.transaction_id);
    await transitionLine(request, vendorDetail.items[0]!.transaction_line_id, {
      next_status: "ordered",
      vendor_id: vendor.id,
      vendor_eta: addDays(-1),
      reason: "Phase 4 vendor delay simulation",
    });
    const vendorReadiness = await fetchReadiness(request, vendorMember.wedding_party_id);
    expect(vendorReadiness.vendor_risk.delayed_vendor_count).toBeGreaterThan(0);
    expect(vendorReadiness.blockers.some((b) => b.label === "Vendor delay risk")).toBeTruthy();

    const readyProduct = await createSingleVariantProduct(request, uniqueSuffix("phase4-ready"), {
      namePrefix: "Phase 4 Ready",
      skuPrefix: "P4R",
    });
    const blockedProduct = await createSingleVariantProduct(request, uniqueSuffix("phase4-blocked"), {
      namePrefix: "Phase 4 Blocked",
      skuPrefix: "P4B",
    });
    const partialCheckout = await checkoutWeddingOrderSeed(request, {
      customerId: fixture.customer.id,
      products: [readyProduct, blockedProduct],
    });
    const partialMember = await attachToNewWedding(
      request,
      partialCheckout.transaction_id,
      "Partial",
      60,
    );
    const partialDetail = await fetchTransactionDetail(request, partialCheckout.transaction_id);
    const readyLine = partialDetail.items.find((item) => item.sku === readyProduct.sku);
    expect(readyLine).toBeTruthy();
    await transitionLine(request, readyLine!.transaction_line_id, {
      next_status: "ready_for_pickup",
      reason: "Phase 4 partial readiness simulation",
    });
    const partialReadiness = await fetchReadiness(request, partialMember.wedding_party_id);
    expect(partialReadiness.pickup.partial_ready_members).toBeGreaterThan(0);
    expect(partialReadiness.members.some((member) => member.status === "partial")).toBeTruthy();
    expect(partialReadiness.blockers.some((b) => b.label === "Partial party readiness")).toBeTruthy();

    const balanceProduct = await createSingleVariantProduct(request, uniqueSuffix("phase4-balance"), {
      namePrefix: "Phase 4 Balance",
      skuPrefix: "P4D",
    });
    const balanceCheckout = await checkoutWeddingOrderSeed(request, {
      customerId: fixture.customer.id,
      products: [balanceProduct],
      amountPaid: "0.00",
    });
    const balanceMember = await attachToNewWedding(
      request,
      balanceCheckout.transaction_id,
      "Balance",
      60,
    );
    const balanceDetail = await fetchTransactionDetail(request, balanceCheckout.transaction_id);
    await transitionLine(request, balanceDetail.items[0]!.transaction_line_id, {
      next_status: "ready_for_pickup",
      reason: "Phase 4 balance block simulation",
    });
    const balanceReadiness = await fetchReadiness(request, balanceMember.wedding_party_id);
    expect(balanceReadiness.pickup.balance_blocked_members).toBeGreaterThan(0);
    expect(
      balanceReadiness.blockers.some((b) => b.label === "Pickup blocked until balance is cleared"),
    ).toBeTruthy();

    const completeProduct = await createSingleVariantProduct(request, uniqueSuffix("phase4-complete"), {
      namePrefix: "Phase 4 Complete",
      skuPrefix: "P4X",
    });
    const completeCheckout = await checkoutWeddingOrderSeed(request, {
      customerId: fixture.customer.id,
      products: [completeProduct],
    });
    const completeMember = await attachToNewWedding(
      request,
      completeCheckout.transaction_id,
      "Complete",
      75,
    );
    const completeDetail = await fetchTransactionDetail(request, completeCheckout.transaction_id);
    const completeLine = completeDetail.items[0]!.transaction_line_id;
    await transitionLine(request, completeLine, {
      next_status: "ready_for_pickup",
      reason: "Phase 4 complete readiness simulation",
    });
    await pickupLine(request, completeCheckout.transaction_id, completeLine);
    const completeReadiness = await fetchReadiness(request, completeMember.wedding_party_id);
    expect(completeReadiness.status).toBe("complete");
    expect(completeReadiness.lifecycle.open).toBe(0);
    expect(completeReadiness.lifecycle.picked_up).toBeGreaterThan(0);
    expect(completeReadiness.blockers).toHaveLength(0);

    const dashboardRes = await request.get(`${apiBase()}/api/weddings/readiness-dashboard?limit=25`, {
      headers: staffHeaders(),
      failOnStatusCode: false,
    });
    const dashboardText = await dashboardRes.text();
    expect(dashboardRes.status(), dashboardText.slice(0, 1000)).toBe(200);
    const dashboard = JSON.parse(dashboardText) as { parties: Array<{ status: string }> };
    expect(Array.isArray(dashboard.parties)).toBeTruthy();
  });
});
