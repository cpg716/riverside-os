import { describe, expect, it } from "vitest";
import { buildCheckoutPaymentSplits } from "./useCartCheckout";

function payment(amountCents, overrides = {}) {
  return {
    id: `line-${amountCents}`,
    method: "cash",
    amountCents,
    label: "Cash",
    ...overrides,
  };
}

describe("buildCheckoutPaymentSplits", () => {
  it("allocates deposit onto collected tender instead of double-counting it", () => {
    const { paymentSplits, unallocatedDepositCents } = buildCheckoutPaymentSplits(
      [payment(4400)],
      4400,
    );

    expect(unallocatedDepositCents).toBe(0);
    expect(paymentSplits).toEqual([
      {
        payment_method: "cash",
        amount: "44.00",
        applied_deposit_amount: "44.00",
      },
    ]);
  });

  it("preserves odd-cent partial deposit math without overage drift", () => {
    const { paymentSplits, unallocatedDepositCents } = buildCheckoutPaymentSplits(
      [payment(4400)],
      4400,
    );

    expect(unallocatedDepositCents).toBe(0);
    expect(paymentSplits[0]?.amount).toBe("44.00");
    expect(paymentSplits[0]?.applied_deposit_amount).toBe("44.00");
  });

  it("refuses to silently over-allocate deposit beyond tender collected", () => {
    const { paymentSplits, unallocatedDepositCents } = buildCheckoutPaymentSplits(
      [payment(4400)],
      8800,
    );

    expect(paymentSplits[0]?.applied_deposit_amount).toBe("44.00");
    expect(unallocatedDepositCents).toBe(4400);
  });
});
