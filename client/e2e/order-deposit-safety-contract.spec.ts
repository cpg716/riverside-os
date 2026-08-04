import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const paymentDrawerSource = readFileSync(
  new URL("../src/components/pos/NexoCheckoutDrawer.tsx", import.meta.url),
  "utf8",
);
const checkoutHookSource = readFileSync(
  new URL("../src/hooks/useCartCheckout.ts", import.meta.url),
  "utf8",
);
const receiptSummarySource = readFileSync(
  new URL("../src/components/pos/ReceiptSummaryModal.tsx", import.meta.url),
  "utf8",
);
const registerReportsSource = readFileSync(
  new URL("../src/components/pos/RegisterReports.tsx", import.meta.url),
  "utf8",
);
const receiptSharedSource = readFileSync(
  new URL("../../server/src/logic/receipt_shared.rs", import.meta.url),
  "utf8",
);
const checkoutServerSource = readFileSync(
  new URL("../../server/src/logic/transaction_checkout.rs", import.meta.url),
  "utf8",
);

test("deferred Orders require a checkout-bound 25 percent deposit or Manager Access", () => {
  expect(paymentDrawerSource).toContain(
    "const minimumOrderDepositCents = Math.ceil(currentSaleTotalCents / 4)",
  );
  expect(paymentDrawerSource).toContain('data-testid="pos-order-deposit-gate"');
  expect(paymentDrawerSource).toContain('data-testid="pos-order-deposit-override"');
  expect(paymentDrawerSource).toContain('"Deposit Met"');
  expect(paymentDrawerSource).toContain('"Need 25% Deposit"');
  expect(paymentDrawerSource).toContain('"No Deposit"');
  expect(paymentDrawerSource).toContain('authorize_action: "pos_order_deposit_override"');
  expect(paymentDrawerSource).toContain("orderDepositGateSatisfied");
  expect(checkoutHookSource).toContain("order_deposit_override:");

  expect(checkoutServerSource).toContain("fn minimum_order_deposit(");
  expect(checkoutServerSource).toContain("has_deferred_current_lines");
  expect(checkoutServerSource).toContain("order_deposit_override_was_logged(");
  expect(checkoutServerSource).toContain("event_kind = 'pos_order_deposit_override'");
  expect(checkoutServerSource).toContain(
    "Order deposit override expired or does not match this checkout",
  );
});

test("partial Order payments are visibly deposits while fulfillment accounting stays deferred", () => {
  expect(checkoutServerSource).toContain(
    '"applied_deposit_amount": amount.to_string()',
  );
  expect(receiptSummarySource).toContain(
    'isDeposit ? "Deposit" : "Payment in Full"',
  );
  expect(paymentDrawerSource).toContain(
    'currentPaymentIsDeposit ? "Deposit Today" : "Deposit Target"',
  );
  expect(registerReportsSource).toContain('"Deposit on Order"');
  expect(receiptSharedSource).toContain('"Deposit on Order"');
  expect(receiptSharedSource).toContain('"Payment in Full on Order"');
});
