import { expect, test } from "@playwright/test";
import {
  apiBase,
  ensureSessionAuth,
  seedRmsFixture,
  staffHeaders,
  verifyStaffId,
  type SeedFixtureResponse,
} from "./helpers/rmsCharge";

type LoyaltyProgramSummary = {
  loyalty_point_threshold: number;
  loyalty_reward_amount: string | number;
};

type LoyaltyLedgerRow = {
  id: string;
  delta_points: number;
  balance_after: number;
  reason: string;
  activity_label: string;
  activity_detail: string;
  transaction_display_id?: string | null;
};

type LoyaltyCustomerSummary = {
  selected_customer_id: string;
  selected_customer_name: string;
  effective_customer_id: string;
  effective_customer_name: string;
  loyalty_points: number;
  shared_with_linked_customer: boolean;
};

type GiftCardLookup = {
  card_kind: string;
  current_balance: string;
};

type CustomerTimelineEvent = {
  kind: string;
  summary: string;
};

type CustomerTransactionHistoryItem = {
  transaction_id: string;
  transaction_display_id: string;
};

type CheckoutResponse = {
  transaction_id: string;
  transaction_display_id: string;
};

function rewardAmountString(value: string | number): string {
  return typeof value === "number" ? value.toFixed(2) : value;
}

async function fetchLoyaltyProgramSummary(
  request: Parameters<typeof test>[0]["request"],
): Promise<LoyaltyProgramSummary> {
  const res = await request.get(`${apiBase()}/api/loyalty/program-summary`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as LoyaltyProgramSummary;
}

async function adjustPoints(
  request: Parameters<typeof test>[0]["request"],
  customerId: string,
  deltaPoints: number,
  reason: string,
): Promise<{ new_balance: number; effective_customer_id?: string }> {
  const res = await request.post(`${apiBase()}/api/loyalty/adjust-points`, {
    headers: {
      "Content-Type": "application/json",
      ...staffHeaders(),
    },
    data: {
      customer_id: customerId,
      delta_points: deltaPoints,
      reason,
      manager_cashier_code: "1234",
      manager_pin: "1234",
    },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as { new_balance: number; effective_customer_id?: string };
}

async function lookupGiftCard(
  request: Parameters<typeof test>[0]["request"],
  code: string,
): Promise<GiftCardLookup> {
  const res = await request.get(`${apiBase()}/api/gift-cards/code/${encodeURIComponent(code)}`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as GiftCardLookup;
}

async function fetchLoyaltyLedger(
  request: Parameters<typeof test>[0]["request"],
  customerId: string,
): Promise<LoyaltyLedgerRow[]> {
  const res = await request.get(`${apiBase()}/api/loyalty/ledger?customer_id=${customerId}`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as LoyaltyLedgerRow[];
}

async function fetchLoyaltyCustomerSummary(
  request: Parameters<typeof test>[0]["request"],
  customerId: string,
): Promise<LoyaltyCustomerSummary> {
  const res = await request.get(`${apiBase()}/api/loyalty/customer-summary?customer_id=${customerId}`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as LoyaltyCustomerSummary;
}

async function linkCouple(
  request: Parameters<typeof test>[0]["request"],
  primaryId: string,
  partnerId: string,
) {
  const res = await request.post(`${apiBase()}/api/customers/${primaryId}/couple-link`, {
    headers: {
      "Content-Type": "application/json",
      ...staffHeaders(),
    },
    data: { partner_id: partnerId },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
}

async function unlinkCouple(
  request: Parameters<typeof test>[0]["request"],
  customerId: string,
) {
  const res = await request.delete(`${apiBase()}/api/customers/${customerId}/couple-link`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
}

async function fetchCustomerTimeline(
  request: Parameters<typeof test>[0]["request"],
  customerId: string,
): Promise<CustomerTimelineEvent[]> {
  const res = await request.get(`${apiBase()}/api/customers/${customerId}/timeline`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { events: CustomerTimelineEvent[] };
  return body.events;
}

async function checkoutFixtureSale(
  request: Parameters<typeof test>[0]["request"],
  fixture: SeedFixtureResponse,
  customerId: string,
): Promise<CheckoutResponse> {
  const { sessionId, sessionToken } = await ensureSessionAuth(request);
  const operatorStaffId = await verifyStaffId(request);
  const res = await request.post(`${apiBase()}/api/transactions/checkout`, {
    headers: {
      ...staffHeaders(),
      "x-riverside-pos-session-id": sessionId,
      "x-riverside-pos-session-token": sessionToken,
      "Content-Type": "application/json",
    },
    data: {
      session_id: sessionId,
      operator_staff_id: operatorStaffId,
      customer_id: customerId,
      payment_method: "cash",
      total_price: fixture.product.unit_price,
      amount_paid: fixture.product.unit_price,
      payment_splits: [
        {
          payment_method: "cash",
          amount: fixture.product.unit_price,
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
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as CheckoutResponse;
}

async function fetchCustomerTransactionHistory(
  request: Parameters<typeof test>[0]["request"],
  customerId: string,
): Promise<CustomerTransactionHistoryItem[]> {
  const res = await request.get(
    `${apiBase()}/api/customers/${customerId}/transaction-history?record_scope=transactions&limit=50`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { items: CustomerTransactionHistoryItem[] };
  return body.items;
}

test.describe("Loyalty redemption contract", () => {
  test("redeeming a reward issues the full value to a loyalty gift card", async ({
    request,
  }) => {
    const fixture = await seedRmsFixture(request, "single_valid", "Loyalty Reward");
    const summary = await fetchLoyaltyProgramSummary(request);
    const rewardCode = `LOY-${Date.now()}`;

    await adjustPoints(
      request,
      fixture.customer.id,
      summary.loyalty_point_threshold,
      "E2E loyalty reward issue",
    );

    const redeemRes = await request.post(`${apiBase()}/api/loyalty/redeem-reward`, {
      headers: {
        "Content-Type": "application/json",
        ...staffHeaders(),
      },
      data: {
        customer_id: fixture.customer.id,
        apply_to_sale: "0.00",
        remainder_card_code: rewardCode,
      },
      failOnStatusCode: false,
    });
    expect(redeemRes.status()).toBe(200);
    const body = (await redeemRes.json()) as {
      applied_to_sale: string | number;
      remainder_loaded: string | number;
      remainder_card_id?: string | null;
      new_balance: number;
    };
    expect(Number(body.applied_to_sale)).toBe(0);
    expect(rewardAmountString(body.remainder_loaded)).toBe(
      rewardAmountString(summary.loyalty_reward_amount),
    );
    expect(body.remainder_card_id).toBeTruthy();

    const card = await lookupGiftCard(request, rewardCode);
    expect(card.card_kind).toBe("loyalty_reward");
    expect(card.current_balance).toBe(rewardAmountString(summary.loyalty_reward_amount));

    const ledger = await fetchLoyaltyLedger(request, fixture.customer.id);
    expect(ledger[0]?.reason).toBe("reward_redemption");
    expect(ledger[0]?.activity_label).toBe("Reward issued");
    expect(ledger[0]?.activity_detail).toContain("loyalty card");
    expect(ledger[0]?.activity_detail).toContain("••••");
    expect(ledger[0]?.delta_points).toBe(-summary.loyalty_point_threshold);
  });

  test("manual loyalty adjustments return operator-friendly history detail", async ({
    request,
  }) => {
    const fixture = await seedRmsFixture(request, "single_valid", "Loyalty History");

    const adjustment = await adjustPoints(
      request,
      fixture.customer.id,
      125,
      "CSR goodwill after missed pickup follow-up",
    );

    expect(adjustment.effective_customer_id).toBe(fixture.customer.id);

    const ledger = await fetchLoyaltyLedger(request, fixture.customer.id);
    expect(ledger[0]?.activity_label).toBe("Manual adjustment");
    expect(ledger[0]?.activity_detail).toContain("Adjusted by");
    expect(ledger[0]?.activity_detail).toContain("CSR goodwill");
    expect(ledger[0]?.delta_points).toBe(125);
  });

  test("immediate-use amounts are blocked because loyalty redemption is issuance-only", async ({
    request,
  }) => {
    const fixture = await seedRmsFixture(request, "single_valid", "Loyalty Block");
    const summary = await fetchLoyaltyProgramSummary(request);

    await adjustPoints(
      request,
      fixture.customer.id,
      summary.loyalty_point_threshold,
      "E2E loyalty immediate-use block",
    );

    const redeemRes = await request.post(`${apiBase()}/api/loyalty/redeem-reward`, {
      headers: {
        "Content-Type": "application/json",
        ...staffHeaders(),
      },
      data: {
        customer_id: fixture.customer.id,
        apply_to_sale: "10.00",
        remainder_card_code: `LOY-BLOCK-${Date.now()}`,
      },
      failOnStatusCode: false,
    });
    expect(redeemRes.status()).toBe(400);
    const body = (await redeemRes.json()) as { error?: string };
    expect(body.error).toContain("issued to a loyalty gift card only");
  });

  test("redemption blocks a code that belongs to a non-loyalty gift card", async ({
    request,
  }) => {
    const fixture = await seedRmsFixture(request, "single_valid", "Loyalty Wrong Card");
    const summary = await fetchLoyaltyProgramSummary(request);
    const wrongCardCode = `PAID-${Date.now()}`;

    await adjustPoints(
      request,
      fixture.customer.id,
      summary.loyalty_point_threshold,
      "E2E loyalty wrong card type",
    );

    const issueRes = await request.post(`${apiBase()}/api/gift-cards/pos-load-purchased`, {
      headers: {
        "Content-Type": "application/json",
        ...staffHeaders(),
      },
      data: {
        code: wrongCardCode,
        amount: "25.00",
      },
      failOnStatusCode: false,
    });
    expect(issueRes.status()).toBe(200);

    const redeemRes = await request.post(`${apiBase()}/api/loyalty/redeem-reward`, {
      headers: {
        "Content-Type": "application/json",
        ...staffHeaders(),
      },
      data: {
        customer_id: fixture.customer.id,
        apply_to_sale: "0.00",
        remainder_card_code: wrongCardCode,
      },
      failOnStatusCode: false,
    });
    expect(redeemRes.status()).toBe(400);
    const body = (await redeemRes.json()) as { error?: string };
    expect(body.error).toContain("different gift card type");
  });

  test("couple-linked reward issuance resolves a partner selection to the shared primary loyalty account", async ({
    request,
  }) => {
    const primary = await seedRmsFixture(request, "single_valid", "Loyalty Couple Primary");
    const partner = await seedRmsFixture(request, "single_valid", "Loyalty Couple Partner");
    const summary = await fetchLoyaltyProgramSummary(request);
    const rewardCode = `LOY-COUPLE-${Date.now()}`;

    await linkCouple(request, primary.customer.id, partner.customer.id);

    const adjustment = await adjustPoints(
      request,
      partner.customer.id,
      summary.loyalty_point_threshold,
      "E2E couple-linked reward setup",
    );
    expect(adjustment.effective_customer_id).toBe(primary.customer.id);

    const redeemRes = await request.post(`${apiBase()}/api/loyalty/redeem-reward`, {
      headers: {
        "Content-Type": "application/json",
        ...staffHeaders(),
      },
      data: {
        customer_id: partner.customer.id,
        apply_to_sale: "0.00",
        remainder_card_code: rewardCode,
      },
      failOnStatusCode: false,
    });
    expect(redeemRes.status()).toBe(200);
    const body = (await redeemRes.json()) as { effective_customer_id?: string };
    expect(body.effective_customer_id).toBe(primary.customer.id);

    const partnerSummary = await fetchLoyaltyCustomerSummary(request, partner.customer.id);
    const primarySummary = await fetchLoyaltyCustomerSummary(request, primary.customer.id);
    expect(partnerSummary.shared_with_linked_customer).toBe(true);
    expect(partnerSummary.effective_customer_id).toBe(primary.customer.id);
    expect(partnerSummary.effective_customer_name).toBe(primarySummary.effective_customer_name);
    expect(partnerSummary.loyalty_points).toBe(primarySummary.loyalty_points);

    const partnerLedger = await fetchLoyaltyLedger(request, partner.customer.id);
    const primaryLedger = await fetchLoyaltyLedger(request, primary.customer.id);
    expect(partnerLedger[0]?.activity_label).toBe("Reward issued");
    expect(primaryLedger[0]?.id).toBe(partnerLedger[0]?.id);
  });

  test("couple link and unlink are recorded in each customer timeline", async ({
    request,
  }) => {
    const primary = await seedRmsFixture(request, "single_valid", "Timeline Couple Primary");
    const partner = await seedRmsFixture(request, "single_valid", "Timeline Couple Partner");

    await linkCouple(request, primary.customer.id, partner.customer.id);

    const primaryAfterLink = await fetchCustomerTimeline(request, primary.customer.id);
    const partnerAfterLink = await fetchCustomerTimeline(request, partner.customer.id);
    expect(primaryAfterLink.some((event) =>
      event.kind === "note" &&
      event.summary.includes("Linked profile with") &&
      event.summary.includes(partner.customer.customer_code),
    )).toBe(true);
    expect(partnerAfterLink.some((event) =>
      event.kind === "note" &&
      event.summary.includes("Linked profile with") &&
      event.summary.includes(primary.customer.customer_code),
    )).toBe(true);

    await unlinkCouple(request, primary.customer.id);

    const primaryAfterUnlink = await fetchCustomerTimeline(request, primary.customer.id);
    const partnerAfterUnlink = await fetchCustomerTimeline(request, partner.customer.id);
    expect(primaryAfterUnlink.some((event) =>
      event.kind === "note" &&
      event.summary.includes("Unlinked profile from") &&
      event.summary.includes(partner.customer.customer_code),
    )).toBe(true);
    expect(partnerAfterUnlink.some((event) =>
      event.kind === "note" &&
      event.summary.includes("Unlinked profile from") &&
      event.summary.includes(primary.customer.customer_code),
    )).toBe(true);
  });

  test("unlinked profiles keep only transactions from the linked period shared", async ({
    request,
  }) => {
    const primary = await seedRmsFixture(request, "single_valid", "History Period Primary");
    const partner = await seedRmsFixture(request, "single_valid", "History Period Partner");

    await linkCouple(request, primary.customer.id, partner.customer.id);
    const duringLinkedSale = await checkoutFixtureSale(request, partner, partner.customer.id);
    await unlinkCouple(request, primary.customer.id);
    const afterUnlinkSale = await checkoutFixtureSale(request, partner, partner.customer.id);

    const primaryHistory = await fetchCustomerTransactionHistory(
      request,
      primary.customer.id,
    );
    const primaryIds = primaryHistory.map((row) => row.transaction_id);
    expect(primaryIds).toContain(duringLinkedSale.transaction_id);
    expect(primaryIds).not.toContain(afterUnlinkSale.transaction_id);

    const primaryTimeline = await fetchCustomerTimeline(request, primary.customer.id);
    expect(primaryTimeline.some((event) =>
      event.summary.includes(duringLinkedSale.transaction_display_id),
    )).toBe(true);
    expect(primaryTimeline.some((event) =>
      event.summary.includes(afterUnlinkSale.transaction_display_id),
    )).toBe(false);
  });
});
