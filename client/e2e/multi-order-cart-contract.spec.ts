import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { hasCheckoutSalespersonAttribution } from "../src/components/pos/cartSalespersonPreflight";
import {
  mergePickupCartLines,
  mergePickupTransactionSelections,
} from "../src/components/pos/cartPickupMerge";
import type {
  CartLineItem,
  PickupTransactionSelection,
} from "../src/components/pos/types";

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
  expect(modal).not.toContain("/api/transactions/${order.id}/pickup");
  expect(detailDrawer).not.toContain(
    "/api/transactions/${detail.transaction_id}/pickup",
  );
  expect(detailDrawer).toContain("continuePickupInRegister");
  expect(detailDrawer).toContain("finished through Sale Complete");
  expect(submitPayment).toContain("onMakePayment?.(paymentOrder, amountCents)");
  expect(submitPayment).not.toContain("onClose()");
});

test("Update Item variation drawer stays above Customer Orders", () => {
  const modal = repoFile("client/src/components/pos/OrderLoadModal.tsx");
  const variantPicker = repoFile(
    "client/src/components/pos/VariantSelectionModal.tsx",
  );
  const detailDrawer = repoFile(
    "client/src/components/layout/DetailDrawer.tsx",
  );

  expect(modal).toContain('className="ui-overlay-backdrop !z-[200]"');
  expect(modal).toContain('layerClassName="z-[220]"');
  expect(variantPicker).toContain("layerClassName={layerClassName}");
  expect(detailDrawer).toContain('layerClassName = "z-[100]"');
  expect(detailDrawer).toContain("${layerClassName}");
});

test("Register Customer Orders exposes audited line cancellation and refund handoff", () => {
  const modal = repoFile("client/src/components/pos/OrderLoadModal.tsx");
  const cart = repoFile("client/src/components/pos/Cart.tsx");
  const server = repoFile("server/src/logic/order_line_cancellation.rs");

  expect(modal).toContain("Cancel Item");
  expect(modal).toContain("Review Balance & Refund");
  expect(modal).toContain("inventory_disposition");
  expect(modal).toContain("credit_applied_to_balance");
  expect(modal).toContain("onRecordedRefundToCart");
  expect(cart).toContain("RETURN_TRANSACTION_REFUND_HANDOFF");
  expect(server).toContain("balance_due - cancellation_total");
  expect(server).toContain("reserved_stock = reserved_stock - $1");
  expect(server).toContain("on_layaway = on_layaway - $1");
});

test("starting pickup returns selected items to Cart without forcing Payment", () => {
  const cart = repoFile("client/src/components/pos/Cart.tsx");
  const pickupHandoff = cart.slice(
    cart.indexOf("onPickupToCart={async"),
    cart.indexOf("onCancelledToRefundCart"),
  );

  expect(cart).toContain("stagedOrderPayments={orderPaymentLines}");
  expect(pickupHandoff).toContain("mergePickupCartLines(");
  expect(pickupHandoff).toContain(
    "use Add Payment only if the customer is paying a balance today.",
  );
  expect(pickupHandoff).not.toContain("const paymentLines");
  expect(pickupHandoff).not.toContain("setOrderPaymentLines(");
  expect(pickupHandoff).not.toContain("setCheckoutDrawerOpen(true)");
  expect(pickupHandoff).not.toContain("hasSalespersonAttribution(cartLines)");
});

test("pickup with a remaining balance requires an explicit payment choice", () => {
  const modal = repoFile("client/src/components/pos/OrderLoadModal.tsx");
  const transactions = repoFile("server/src/api/transactions.rs");

  expect(modal).toContain('title="Balance Will Remain Open"');
  expect(modal).toContain('confirmLabel="Pick Up Without Payment"');
  expect(modal).toContain('cancelLabel="Go Back / Add Payment"');
  expect(modal).toContain("remainingBalanceCents > 0");
  expect(transactions).toContain("fully_picked_up_transaction_status(balance_due)");
  expect(transactions).toContain("DbOrderStatus::Open");
  expect(transactions).toContain("fulfilled_at = COALESCE(fulfilled_at, CURRENT_TIMESTAMP)");
});

test("starting pickup from a second order merges it into the active cart", () => {
  const cart = repoFile("client/src/components/pos/Cart.tsx");
  const pickupHandoff = cart.slice(
    cart.indexOf("onPickupToCart={async"),
    cart.indexOf("onCancelledToRefundCart"),
  );

  expect(pickupHandoff).toContain(
    "setPickupTransactionId(\n                  (currentTransactionId) =>",
  );
  expect(pickupHandoff).toContain("currentTransactionId ??");
  expect(pickupHandoff).toContain("mergePickupTransactionSelections(");
  expect(pickupHandoff).toContain("mergePickupCartLines(");
  expect(pickupHandoff).not.toContain(
    "setPickupTransactions(selectionsForCheckout)",
  );
  expect(pickupHandoff).not.toContain("setLines(cartLines)");
});

test("multiple items from different orders remain in one pickup cart", () => {
  const selectionA: PickupTransactionSelection = {
    transactionId: "order-a",
    lineIds: ["line-a-1", "line-a-2"],
  };
  const selectionB: PickupTransactionSelection = {
    transactionId: "order-b",
    lineIds: ["line-b-1", "line-b-2"],
  };
  const pickupLine = (
    transactionLineId: string,
    cartRowId: string,
  ): CartLineItem => ({
    product_id: `product-${transactionLineId}`,
    variant_id: `variant-${transactionLineId}`,
    sku: transactionLineId,
    name: transactionLineId,
    standard_retail_price: "100.00",
    unit_cost: "0.00",
    state_tax: "0.00",
    local_tax: "0.00",
    quantity: 1,
    fulfillment: "special_order",
    cart_row_id: cartRowId,
    transaction_line_id: transactionLineId,
  });

  let selections: PickupTransactionSelection[] = [];
  let lines: CartLineItem[] = [];

  lines = mergePickupCartLines(
    lines,
    selections,
    [selectionA],
    [
      pickupLine("line-a-1", "cart-a-1"),
      pickupLine("line-a-2", "cart-a-2"),
    ],
  );
  selections = mergePickupTransactionSelections(selections, [selectionA]);

  lines = mergePickupCartLines(
    lines,
    selections,
    [selectionB],
    [
      pickupLine("line-b-1", "cart-b-1"),
      pickupLine("line-b-2", "cart-b-2"),
    ],
  );
  selections = mergePickupTransactionSelections(selections, [selectionB]);

  expect(selections).toEqual([selectionA, selectionB]);
  expect(lines.map((line) => line.transaction_line_id)).toEqual([
    "line-a-1",
    "line-a-2",
    "line-b-1",
    "line-b-2",
  ]);
});

test("pickup attribution cannot cover a new fee line before payment", () => {
  const pickupLine = {
    sku: "B-1350131",
    transaction_line_id: "existing-pickup-line",
    salesperson_id: "robyn",
  };
  const alterationFee = {
    sku: "ROS-ALTERATION-SERVICE",
    salesperson_id: null,
  };

  expect(
    hasCheckoutSalespersonAttribution({
      lines: [pickupLine, alterationFee],
      primarySalespersonId: "",
      isEmployeeSale: false,
    }),
  ).toBe(false);
  expect(
    hasCheckoutSalespersonAttribution({
      lines: [pickupLine, alterationFee],
      primarySalespersonId: "robyn",
      isEmployeeSale: false,
    }),
  ).toBe(true);
  expect(
    hasCheckoutSalespersonAttribution({
      lines: [pickupLine, { ...alterationFee, salesperson_id: "robyn" }],
      primarySalespersonId: "",
      isEmployeeSale: false,
    }),
  ).toBe(true);
  expect(
    hasCheckoutSalespersonAttribution({
      lines: [pickupLine],
      primarySalespersonId: "",
      isEmployeeSale: false,
    }),
  ).toBe(true);
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
  expect(checkout).toContain(
    "const receiptTransactionId = data.transaction_id",
  );
  expect(checkout).not.toContain("receiptTransactionId = pickupTransactionId");
  expect(transactions).toContain("if !body.register_cart_completion");
  expect(transactions).toContain(
    "finish the full checkout flow through Sale Complete",
  );
  expect(transactions).toContain('"already_completed": true');
  expect(transactions).toContain(
    "No inventory, revenue, commission, or audit activity was recorded again.",
  );
  expect(transactions).toContain(
    "LEFT JOIN fulfillment_orders fo ON fo.id = tl.fulfillment_order_id",
  );
  expect(transactions).toContain(
    "DISTINCT NULLIF(TRIM(fo.display_id), '')",
  );
});

test("checkout recovery reports an error without persistent blocking badges", () => {
  const cart = repoFile("client/src/components/pos/Cart.tsx");
  const topBar = repoFile("client/src/components/layout/GlobalTopBar.tsx");
  const offlineQueue = repoFile("client/src/lib/offlineQueue.ts");

  expect(cart).not.toContain("checkout recovery item");
  expect(topBar).not.toContain("checkout recovery item");
  expect(offlineQueue).toContain(
    'dispatchAppToast(`Checkout synchronization failed: ${normalizedMessage}`, "error")',
  );
});
