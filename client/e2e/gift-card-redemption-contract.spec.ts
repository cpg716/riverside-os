import { expect, test } from "@playwright/test";
import {
  apiBase, ensureSessionAuth, seedRmsFixture, staffHeaders, verifyStaffId,
} from "./helpers/rmsCharge";

type GiftCardLookup = {
  code: string;
  card_kind: string;
  current_balance: string;
};

type CheckoutResponse = {
  transaction_id: string;
};

type TransactionDetail = {
  payment_methods_summary: string;
};

type GiftCardEvent = {
  event_kind: string;
  balance_after: string;
};

type ControlBoardRow = {
  product_id: string;
  variant_id: string;
  sku: string;
  retail_price: string;
  cost_price: string;
  state_tax: string;
  local_tax: string;
};

function centsFromMoney(value: string): number {
  const normalized = Number.parseFloat(value);
  return Number.isFinite(normalized) ? Math.round(normalized * 100) : 0;
}

function moneyFromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

async function fetchCatalogPricing(
  request: Parameters<typeof test>[0]["request"],
  sku: string,
): Promise<ControlBoardRow> {
  const res = await request.get(
    `${apiBase()}/api/products/control-board?search=${encodeURIComponent(sku)}&limit=5`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { rows?: ControlBoardRow[] };
  const row = (body.rows ?? []).find((candidate) => candidate.sku === sku) ?? body.rows?.[0];
  expect(row).toBeTruthy();
  return row as ControlBoardRow;
}

async function issueGiftCard(
  request: Parameters<typeof test>[0]["request"],
  kind: "purchased" | "donated",
  code: string,
  amount: string,
) {
  const endpoint = kind === "purchased" ? "pos-load-purchased" : "issue-donated";
  const res = await request.post(`${apiBase()}/api/gift-cards/${endpoint}`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      code,
      amount,
    },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
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

async function lookupGiftCardEvents(
  request: Parameters<typeof test>[0]["request"],
  code: string,
): Promise<GiftCardEvent[]> {
  const res = await request.get(
    `${apiBase()}/api/gift-cards/code/${encodeURIComponent(code)}/events`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  expect(res.status()).toBe(200);
  return (await res.json()) as GiftCardEvent[];
}

async function fetchTransactionDetail(
  request: Parameters<typeof test>[0]["request"],
  transactionId: string,
): Promise<TransactionDetail> {
  const res = await request.get(`${apiBase()}/api/transactions/${transactionId}`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as TransactionDetail;
}

async function checkoutGiftCardRedemption(
  request: Parameters<typeof test>[0]["request"],
  sessionId: string,
  sessionToken: string,
  operatorStaffId: string,
  product: {
    product_id: string;
    variant_id: string;
    sku: string;
  },
  redeemCode: string,
  subType: "paid_liability" | "loyalty_giveaway" | "donated_giveaway",
) {
  const pricing = await fetchCatalogPricing(request, product.sku);
  const totalCents =
    centsFromMoney(pricing.retail_price) +
    centsFromMoney(pricing.state_tax) +
    centsFromMoney(pricing.local_tax);
  const amount = moneyFromCents(totalCents);
  return request.post(`${apiBase()}/api/transactions/checkout`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
      "x-riverside-pos-session-id": sessionId,
      "x-riverside-pos-session-token": sessionToken,
    },
    data: {
      session_id: sessionId,
      operator_staff_id: operatorStaffId,
      primary_salesperson_id: null,
      customer_id: null,
      wedding_member_id: null,
      payment_method: "gift_card",
      total_price: amount,
      amount_paid: amount,
      items: [
        {
          product_id: pricing.product_id,
          variant_id: pricing.variant_id,
          fulfillment: "takeaway",
          quantity: 1,
          unit_price: pricing.retail_price,
          unit_cost: pricing.cost_price,
          state_tax: pricing.state_tax,
          local_tax: pricing.local_tax,
        },
      ],
      payment_splits: [
        {
          payment_method: "gift_card",
          amount,
          sub_type: subType,
          gift_card_code: redeemCode,
        },
      ],
    },
    failOnStatusCode: false,
  });
}

test.describe("Gift card redemption accounting contract", () => {
  test("purchased gift card redemption succeeds and reduces the real card balance", async ({
    request,
  }) => {
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const fixture = await seedRmsFixture(request, "single_valid", "Gift Card Paid");
    const redeemCode = `GC-PAID-${Date.now()}`;
    const issuedCents = 50_000;
    const pricing = await fetchCatalogPricing(request, fixture.product.sku);

    await issueGiftCard(request, "purchased", redeemCode, moneyFromCents(issuedCents));

    const checkoutRes = await checkoutGiftCardRedemption(
      request,
      sessionId,
      sessionToken,
      operatorStaffId,
      fixture.product,
      redeemCode,
      "paid_liability",
    );
    expect(checkoutRes.status()).toBe(200);
    const checkout = (await checkoutRes.json()) as CheckoutResponse;
    expect(checkout.transaction_id).toBeTruthy();

    const card = await lookupGiftCard(request, redeemCode);
    expect(card.card_kind).toBe("purchased");
    const redeemedTotalCents =
      centsFromMoney(pricing.retail_price) +
      centsFromMoney(pricing.state_tax) +
      centsFromMoney(pricing.local_tax);
    expect(card.current_balance).toBe(
      moneyFromCents(issuedCents - redeemedTotalCents),
    );

    const transactionDetail = await fetchTransactionDetail(request, checkout.transaction_id);
    expect(transactionDetail.payment_methods_summary).toContain("Gift Card | Paid");
    expect(transactionDetail.payment_methods_summary).toContain("Card: ••••");

    const events = await lookupGiftCardEvents(request, redeemCode);
    expect(events[0]?.event_kind).toBe("redeemed");
    expect(events[0]?.balance_after).toBe(card.current_balance);
  });

  test("purchased gift cards cannot be issued from the Back Office API", async ({
    request,
  }) => {
    const res = await request.post(`${apiBase()}/api/gift-cards/issue-purchased`, {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
      },
      data: {
        code: `GC-BO-BLOCKED-${Date.now()}`,
        amount: "25.00",
      },
      failOnStatusCode: false,
    });

    expect([404, 405]).toContain(res.status());
  });

  test("donated gift card blocks mismatched subtype selection with a staff-safe error", async ({
    request,
  }) => {
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const fixture = await seedRmsFixture(request, "single_valid", "Gift Card Donated");
    const redeemCode = `GC-DONATED-${Date.now()}`;

    await issueGiftCard(request, "donated", redeemCode, "500.00");

    const checkoutRes = await checkoutGiftCardRedemption(
      request,
      sessionId,
      sessionToken,
      operatorStaffId,
      fixture.product,
      redeemCode,
      "paid_liability",
    );
    expect(checkoutRes.status()).toBe(400);
    const body = (await checkoutRes.json()) as { error?: string };
    expect(body.error).toContain("must be used as Donated");
  });

  test("gift card redemption reports insufficient balance clearly", async ({
    request,
  }) => {
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const fixture = await seedRmsFixture(request, "single_valid", "Gift Card Low Balance");
    const redeemCode = `GC-LOWBAL-${Date.now()}`;

    await issueGiftCard(request, "purchased", redeemCode, "5.00");

    const checkoutRes = await checkoutGiftCardRedemption(
      request,
      sessionId,
      sessionToken,
      operatorStaffId,
      fixture.product,
      redeemCode,
      "paid_liability",
    );
    expect(checkoutRes.status()).toBe(400);
    const body = (await checkoutRes.json()) as { error?: string };
    expect(body.error).toContain("only has $5.00 available");
  });
});
