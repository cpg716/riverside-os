import { describe, expect, it } from "vitest";
import {
  heldOpenDepositNoticeMessage,
  openDepositApplicationCents,
} from "./openDeposit";

describe("openDepositApplicationCents", () => {
  it("allows a held wedding deposit to fund the selected customer's mixed sale", () => {
    expect(
      openDepositApplicationCents({
        heldBalanceCents: 7_500,
        alreadyAppliedCents: 0,
        remainingCheckoutCents: 10_000,
        currentSaleCents: 10_000,
        hasExternalAllocations: false,
      }),
    ).toBe(7_500);
  });

  it("accounts for a held deposit already added to the payment ledger", () => {
    expect(
      openDepositApplicationCents({
        heldBalanceCents: 7_500,
        alreadyAppliedCents: 2_000,
        remainingCheckoutCents: 8_000,
        currentSaleCents: 10_000,
        hasExternalAllocations: false,
      }),
    ).toBe(5_500);
  });

  it("does not allow a member deposit to fund party or existing-order allocations", () => {
    expect(
      openDepositApplicationCents({
        heldBalanceCents: 7_500,
        alreadyAppliedCents: 0,
        remainingCheckoutCents: 10_000,
        currentSaleCents: 10_000,
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
