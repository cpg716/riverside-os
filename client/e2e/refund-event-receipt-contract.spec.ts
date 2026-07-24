import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

function repoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

const cart = repoFile("client/src/components/pos/Cart.tsx");
const checkoutDrawer = repoFile(
  "client/src/components/pos/NexoCheckoutDrawer.tsx",
);
const receiptModal = repoFile(
  "client/src/components/pos/ReceiptSummaryModal.tsx",
);
const registerReports = repoFile(
  "client/src/components/pos/RegisterReports.tsx",
);
const transactionDetailDrawer = repoFile(
  "client/src/components/orders/TransactionDetailDrawer.tsx",
);
const customerRelationshipHub = repoFile(
  "client/src/components/customers/CustomerRelationshipHubDrawer.tsx",
);

test("deferred original-card refunds retain the server event and exact provider result", () => {
  expect(cart).toContain("parseRefundEventId(settlementPayload)");
  expect(cart).toContain("refund_event_id: exchangeRefundEventId");
  expect(cart).toContain("parseRefundProcessResult(cardRefundPayload)");
  expect(cart).toContain("parseRefundProcessResult(");
  expect(cart).toContain("refundResult?.refund_event_id ??");
  expect(cart).toContain("parseRefundEventId(refundPayload)");
  expect(cart).toContain("setLastRefundResult(refundResult)");
  expect(cart).toContain('toast(refundResult.message, "success")');
  expect(cart).toContain(
    "The refund was recorded, but its provider confirmation could not be loaded.",
  );

  expect(checkoutDrawer).toContain(
    'label: "HELCIM REFUND — PENDING APPROVAL"',
  );
  expect(checkoutDrawer).toContain(
    "? `Refund $${centsToFixed2(Math.abs(p.amountCents))}`",
  );
});

test("receipt generation is event-scoped while detail stays on the replacement transaction", () => {
  const queryStart = receiptModal.indexOf("const buildReceiptQuery = useCallback");
  const queryEnd = receiptModal.indexOf(
    "const shouldKickCashDrawer",
    queryStart,
  );
  const receiptQuery = receiptModal.slice(queryStart, queryEnd);

  expect(receiptQuery).toContain('sp.set("refund_event_id", refundEventId)');
  expect(receiptQuery.indexOf('sp.set("refund_event_id"')).toBeLessThan(
    receiptQuery.indexOf('sp.set("transaction_line_ids"'),
  );
  expect(receiptModal).toContain(
    "/api/transactions/${receiptDeliveryTransactionId}/receipt.escpos",
  );
  expect(receiptModal).toContain(
    "/api/transactions/${receiptDeliveryTransactionId}/receipt.html",
  );
  expect(receiptModal).toContain(
    "/api/transactions/${receiptDeliveryTransactionId}/receipt/send-email",
  );
  expect(receiptModal).toContain(
    "/api/transactions/${receiptDeliveryTransactionId}/receipt/send-sms",
  );
  expect(receiptModal).toContain(
    "const detailUrl = `${baseUrl}/api/transactions/${transactionId}",
  );
  expect(receiptModal).toContain(
    "/api/transactions/${transactionId}/review-invite",
  );
  expect(receiptModal).not.toContain(
    "parseMoneyToCents(transactionDetail?.refund_total",
  );
});

test("approval UI and Daily Sales reprints retain one refund event", () => {
  expect(receiptModal).toContain('data-testid="refund-approval-panel"');
  expect(receiptModal).toContain('data-testid="refund-pending-panel"');
  expect(receiptModal).toContain("pendingRefundAmountCents == null");
  expect(receiptModal).toContain(
    "Receipt printing and delivery stay unavailable",
  );
  expect(receiptModal).toContain("refundResult.refund_amount");
  expect(receiptModal).toContain("refundResult.provider_refund_id");
  expect(receiptModal).toContain("refundResult.original_provider_transaction_id");
  expect(receiptModal).toContain("refundResult.card_last4");

  expect(registerReports).toContain("refund_event_id?: string | null");
  expect(registerReports).toContain("replacement_transaction_id?: string | null");
  expect(registerReports).toContain(
    "normalizeActivityId(row.replacement_transaction_id)",
  );
  expect(registerReports).toContain(
    "setReceiptRefundEventId(",
  );
  expect(registerReports).toContain(
    "normalizeActivityId(row.transaction_id)",
  );
  expect(registerReports).toContain(
    "receiptEventTransactionId={receiptEventTransactionId}",
  );
});

test("transaction history reprints settled exchanges through the event receipt", () => {
  expect(transactionDetailDrawer).toContain(
    "receipt_refund_event_id?: string | null",
  );
  expect(transactionDetailDrawer).toContain(
    "refundEventId={detail?.receipt_refund_event_id ?? null}",
  );
  expect(transactionDetailDrawer).toContain(
    "receiptEventTransactionId={detail?.receipt_event_transaction_id ?? null}",
  );
  expect(transactionDetailDrawer).toContain(
    'if (detail.exchange_group_id) return "Exchange"',
  );
  expect(customerRelationshipHub).toContain("is_exchange?: boolean");
  expect(customerRelationshipHub).toContain("row.is_exchange");
  expect(customerRelationshipHub).toContain("has_returns?: boolean");
  expect(customerRelationshipHub).toContain("row.has_returns");
  expect(customerRelationshipHub).toContain("Returned Item");
});
