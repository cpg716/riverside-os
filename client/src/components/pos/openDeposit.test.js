import { describe, expect, it } from "vitest";
import {
  heldOpenDepositNoticeMessage,
  openDepositApplicationCents,
} from "./openDeposit";

describe("openDepositApplicationCents", () => {
  it("caps a held deposit to the deferred portion of a mixed sale", () => {
    expect(
      openDepositApplicationCents({
        heldBalanceCents: 7_500,
        alreadyAppliedCents: 0,
        remainingCheckoutCents: 10_000,
        currentSaleCents: 10_000,
        takeawayCents: 4_000,
        hasExternalAllocations: false,
      }),
    ).toBe(6_000);
  });

  it("accounts for a held deposit already added to the payment ledger", () => {
    expect(
      openDepositApplicationCents({
        heldBalanceCents: 7_500,
        alreadyAppliedCents: 2_000,
        remainingCheckoutCents: 8_000,
        currentSaleCents: 10_000,
        takeawayCents: 4_000,
        hasExternalAllocations: false,
      }),
    ).toBe(4_000);
  });

  it("does not allow a member deposit to fund party or existing-order allocations", () => {
    expect(
      openDepositApplicationCents({
        heldBalanceCents: 7_500,
        alreadyAppliedCents: 0,
        remainingCheckoutCents: 10_000,
        currentSaleCents: 10_000,
        takeawayCents: 0,
        hasExternalAllocations: true,
      }),
    ).toBe(0);
  });
});

describe("heldOpenDepositNoticeMessage", () => {
  it("names the most recent payer and explains where the deposit is applied", () => {
    const message = heldOpenDepositNoticeMessage({
      customerId: "customer-1",
      balanceCents: 7_500,
      lastPayerName: "Alex Morgan",
      lastCreditCents: 7_500,
    });

    expect(message).toContain("$75.00");
    expect(message).toContain("Alex Morgan");
  });
});
