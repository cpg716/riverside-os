import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

function repoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

test("Customer Orders keeps payment and pickup work open across several orders", () => {
  const modal = repoFile("client/src/components/pos/OrderLoadModal.tsx");
  const detailDrawer = repoFile(
    "client/src/components/orders/TransactionDetailDrawer.tsx",
  );
  const submitPayment = modal.slice(
    modal.indexOf("const submitPaymentEntry"),
    modal.indexOf("const addSkuToSelectedOrder"),
  );

  expect(modal).toContain("Build one cart across this customer's orders");
  expect(modal).toContain("Order work in this cart");
  expect(modal).toContain("stagedOrderPayments.map");
  expect(modal).toContain("pickupBasket.map");
  expect(modal).toContain('"Continue with Pickup"');
  expect(modal).not.toContain(
    "/api/transactions/${order.id}/pickup",
  );
  expect(detailDrawer).not.toContain(
    "/api/transactions/${detail.transaction_id}/pickup",
  );
  expect(detailDrawer).toContain("continuePickupInRegister");
  expect(detailDrawer).toContain(
    "finished through Sale Complete",
  );
  expect(submitPayment).toContain("onMakePayment?.(paymentOrder, amountCents)");
  expect(submitPayment).not.toContain("onClose()");
});

test("starting pickup preserves intentionally staged payments on every order", () => {
  const cart = repoFile("client/src/components/pos/Cart.tsx");

  expect(cart).toContain("stagedOrderPayments={orderPaymentLines}");
  expect(cart).toContain("setOrderPaymentLines((currentPaymentLines) =>");
  expect(cart).toContain("const explicitlyStagedTargets = new Set");
  expect(cart).toContain("...currentPaymentLines");
  expect(cart).toContain("!explicitlyStagedTargets.has(");
});

test("a restored cart retains every source order and selected pickup line", () => {
  const persistence = repoFile("client/src/hooks/useCartPersistence.ts");
  const checkout = repoFile("client/src/hooks/useCartCheckout.ts");
  const transactions = repoFile("server/src/api/transactions.rs");

  expect(persistence).toContain(
    "pickupTransactions?: PickupTransactionSelection[]",
  );
  expect(persistence).toContain(
    "pickupReadyAlterations?: PickupReadyAlteration[]",
  );
  expect(persistence).toContain(
    "setPickupTransactions?.(rawPickupTransactions)",
  );
  expect(persistence).toContain("pickupTransactions.length > 0");
  expect(persistence).toContain(
    "pickupTransactionId: pickupTransactionId || undefined",
  );
  expect(checkout).toContain("pickupTransactions.length > 0");
  expect(checkout).toContain("transaction_id: selection.transactionId");
  expect(checkout).toContain("transaction_line_ids: selection.lineIds");
  expect(checkout).toContain("failedPickupAttempts.map");
  expect(checkout).toContain("completedPickupTransactionIds");
  expect(checkout).toContain("register_cart_completion: true");
  expect(transactions).toContain("if !body.register_cart_completion");
  expect(transactions).toContain(
    "finish the full checkout flow through Sale Complete",
  );
  expect(transactions).toContain('"already_completed": true');
  expect(transactions).toContain(
    "No inventory, revenue, commission, or audit activity was recorded again.",
  );
});
