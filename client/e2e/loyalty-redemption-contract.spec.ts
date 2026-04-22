import { expect, test } from "@playwright/test";
import { apiBase, seedRmsFixture, staffHeaders } from "./helpers/rmsCharge";

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

    const issueRes = await request.post(`${apiBase()}/api/gift-cards/issue-purchased`, {
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
});
