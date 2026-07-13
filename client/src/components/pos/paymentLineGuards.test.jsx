import { describe, expect, it } from "vitest";

import { hasApprovedProviderPayment, isApprovedProviderPayment } from "./paymentLineGuards";

function payment(metadata) {
  return {
    id: "payment-1",
    method: "card_terminal",
    amountCents: 14138,
    label: "HELCIM CARD",
    metadata,
  };
}

describe("approved provider payment guards", () => {
  it("protects an approved Helcim terminal payment", () => {
    const line = payment({
      payment_provider: "helcim",
      provider_status: "approved",
      payment_provider_attempt_id: "attempt-1",
      provider_transaction_id: "51300146",
    });

    expect(isApprovedProviderPayment(line)).toBe(true);
    expect(hasApprovedProviderPayment([line])).toBe(true);
  });

  it("does not protect ordinary non-provider tenders", () => {
    expect(isApprovedProviderPayment(payment())).toBe(false);
  });
});
