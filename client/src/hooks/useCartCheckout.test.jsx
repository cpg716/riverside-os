import { describe, expect, it } from "vitest";
import {
  buildCheckoutPaymentSplits,
  checkoutTaxCategoryOverride,
  maxCollectableTenderCents,
  optionalCentsField,
} from "./useCartCheckout";
import { calculateNysErieTaxForUnit } from "../lib/tax";

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

describe("maxCollectableTenderCents", () => {
  it("allows a cash tender that matches the deposit being collected today", () => {
    expect(maxCollectableTenderCents(0, 12500)).toBe(12500);
  });

  it("keeps normal sale collection as the upper bound when it exceeds the deposit", () => {
    expect(maxCollectableTenderCents(20000, 12500)).toBe(20000);
  });
});

describe("optionalCentsField", () => {
  it("preserves an intentional zero-cent value for checkout audit fields", () => {
    expect(optionalCentsField(0)).toBe("0.00");
  });

  it("omits only undefined checkout audit fields", () => {
    expect(optionalCentsField(undefined)).toBeUndefined();
  });
});

describe("checkoutTaxCategoryOverride", () => {
  it("allows only sale-line tax categories that the Register can override", () => {
    expect(checkoutTaxCategoryOverride("clothing")).toBe("clothing");
    expect(checkoutTaxCategoryOverride("footwear")).toBe("footwear");
    expect(checkoutTaxCategoryOverride("other")).toBe("other");
  });

  it("does not turn accessory or service categories into cashier overrides", () => {
    expect(checkoutTaxCategoryOverride("accessory")).toBeUndefined();
    expect(checkoutTaxCategoryOverride("service")).toBeUndefined();
    expect(checkoutTaxCategoryOverride(undefined)).toBeUndefined();
  });
});

describe("calculateNysErieTaxForUnit", () => {
  it("matches server half-away-from-zero rounding for negative adjustments", () => {
    expect(calculateNysErieTaxForUnit("other", -200)).toEqual({
      stateTaxCents: -8,
      localTaxCents: -10,
    });
  });
});
