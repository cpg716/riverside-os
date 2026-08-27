import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function repoSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

test.describe("Pick Up Later UI contract", () => {
  test("Register exposes Pick Up Later beside Take Now and Order", () => {
    const cartRow = repoSource(
      "client/src/components/pos/cart/CartItemRow.tsx",
    );
    const cartTypes = repoSource("client/src/components/pos/types.ts");
    const cartActions = repoSource("client/src/hooks/useCartActions.ts");

    expect(cartTypes).toContain('| "pickup_later"');
    expect(cartRow).toContain('updateLineFulfillment(line.cart_row_id, "pickup_later")');
    expect(cartRow).toContain("Pick Up Later");
    expect(cartActions).toContain(
      'toast("Select a customer before choosing Pick Up Later.", "info")',
    );
  });

  test("Orders and receipts retain the Pick Up Later label", () => {
    const orders = repoSource(
      "client/src/components/orders/OrdersWorkspace.tsx",
    );
    const orderPicker = repoSource(
      "client/src/components/pos/OrderLoadModal.tsx",
    );
    const transactionDetail = repoSource(
      "client/src/components/orders/TransactionDetailDrawer.tsx",
    );
    const receiptRenderer = repoSource(
      "server/src/logic/receipt_escpos.rs",
    );

    expect(orders).toContain('<option value="pickup_later">Pick Up Later</option>');
    expect(orderPicker).toContain('case "pickup_later":');
    expect(transactionDetail).toContain('return "Pick Up Later";');
    expect(receiptRenderer).toContain('"Pick Up Later",');
    expect(receiptRenderer).toContain("if !labels.contains(&section)");
  });
});
