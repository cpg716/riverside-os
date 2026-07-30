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
const orderLoadModal = repoFile("client/src/components/pos/OrderLoadModal.tsx");
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
const transactionsApi = repoFile("server/src/api/transactions.rs");
const customerRelationshipHub = repoFile(
  "client/src/components/customers/CustomerRelationshipHubDrawer.tsx",
);
const posShell = repoFile("client/src/components/layout/PosShell.tsx");
const registerOverlay = repoFile(
  "client/src/components/pos/RegisterOverlay.tsx",
);
const staffProfilePanel = repoFile(
  "client/src/components/settings/StaffProfilePanel.tsx",
);

test("paid order cancellation hands the refund directly back to the Register", () => {
  expect(orderLoadModal).toContain(
    "await onCancelledToRefundCart(cancelOrder)",
  );
  expect(orderLoadModal).toContain(
    "Cancellation refund staged. Nothing changes until Record Sale completes",
  );
  expect(orderLoadModal).toContain("Retry Refund Load");
  expect(orderLoadModal).toContain("if (paidCents <= 0)");
  expect(orderLoadModal).toContain(
    "if (!orderMutationBusy && !cancelRefundLoadPending)",
  );
  expect(orderLoadModal).not.toContain(
    "Any refund due was queued for Register refund processing.",
  );
  expect(cart).toContain("onCancelledToRefundCart={(order) =>");
  expect(cart).toContain("CANCEL_TRANSACTION_REFUND_HANDOFF");
  expect(cart).toContain(
    "return_tender_cancel_transaction: cancellationRefund",
  );
  expect(cart).toContain(
    "return_tender_original_transaction_id: detail.transaction_id",
  );
  expect(cart).toContain(
    "item.quantity - Math.max(0, item.quantity_returned ?? 0)",
  );
  expect(cart).toContain(
    "cancel_transaction: pendingReturnTender.cancelTransaction",
  );
  expect(transactionsApi).toContain("if body.cancel_transaction");
  expect(transactionsApi).toContain(
    '"Paid order cancelled with completed refund"',
  );
  expect(cart).toContain("Select Original Card to complete the Helcim refund.");
  expect(cart).toContain(
    "[detail.transaction_id]: Array.from(settledReturnLinesById.values())",
  );
  expect(cart).toContain("returnLineIntegrityOk:");
  expect(cart).toContain(
    "Refund blocked before tender: the selected item details are incomplete.",
  );
  expect(transactionsApi).toContain(
    "Refund blocked before payment: at least one exact returned item line is required",
  );
  expect(transactionsApi).toContain(
    "/{transaction_id}/refunds/{refund_event_id}/repair-lines",
  );
  expect(transactionsApi).toContain('"refund_lines_repaired"');
  expect(transactionsApi).toContain(
    "event_kind IN ('exchange_settled', 'refund_processed')",
  );
  expect(transactionsApi).toContain(
    "cancelled_refund_receipt_rows(original_detail, refund_total, created_at)",
  );
});

test("fully returned order lines do not remain open for pickup", () => {
  expect(transactionDetailDrawer).toContain("!isFullyReturned(item) &&");
  expect(transactionDetailDrawer).toContain('title: "Returned Items"');
  expect(transactionDetailDrawer).toContain(
    "These items were returned and no longer require pickup or shipping work.",
  );
  expect(transactionDetailDrawer).toContain('return "Return is complete.";');
});

test("direct paid returns cannot bypass Record Sale atomicity", () => {
  expect(transactionsApi).toContain(
    "Paid returns must be staged in Register Pay and committed with their refund at Record Sale; nothing was changed.",
  );
  expect(transactionsApi).toContain("if amount_paid > Decimal::ZERO");
});

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

  expect(checkoutDrawer).toContain('label: "HELCIM REFUND — PENDING APPROVAL"');
  expect(checkoutDrawer).toContain(
    "? `Refund $${centsToFixed2(Math.abs(p.amountCents))}`",
  );
});

test("receipt generation is event-scoped while detail stays on the replacement transaction", () => {
  const queryStart = receiptModal.indexOf(
    "const buildReceiptQuery = useCallback",
  );
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
    "refund queue. Receipt printing and delivery stay",
  );
  expect(receiptModal).toContain(
    "unavailable until the provider refund is complete.",
  );
  expect(receiptModal).toContain("refundResult.refund_amount");
  expect(receiptModal).toContain("refundResult.provider_refund_id");
  expect(receiptModal).toContain(
    "refundResult.original_provider_transaction_id",
  );
  expect(receiptModal).toContain("refundResult.card_last4");

  expect(registerReports).toContain("refund_event_id?: string | null");
  expect(registerReports).toContain(
    "replacement_transaction_id?: string | null",
  );
  expect(registerReports).toContain(
    "normalizeActivityId(row.replacement_transaction_id)",
  );
  expect(registerReports).toContain("setReceiptRefundEventId(");
  expect(registerReports).toContain("normalizeActivityId(row.transaction_id)");
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
  expect(transactionDetailDrawer).toContain("receiptEventTransactionId={");
  expect(transactionDetailDrawer).toContain(
    "detail?.receipt_event_transaction_id ?? null",
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

test("historical receipt entry points do not reuse checkout completion actions", () => {
  expect(receiptModal).toContain('presentation?: "completion" | "historical"');
  expect(receiptModal).toContain('presentation = "completion"');
  expect(receiptModal).toContain('"Transaction receipt"');
  expect(receiptModal).toContain("Close receipt");
  expect(receiptModal).toContain("!historicalPresentation &&");
  expect(registerReports).toContain('presentation="historical"');
  expect(transactionDetailDrawer).toContain('presentation="historical"');
  expect(staffProfilePanel).toContain('presentation="historical"');
});

test("idle security locks and rejoins the existing drawer without closing it", () => {
  expect(posShell).toContain("setIsRegisterLocked(true)");
  expect(posShell).not.toContain(
    "idleTimerRef.current = setTimeout(() => {\n        handleSessionClosed();",
  );
  expect(posShell).toContain('accessMode="unlock"');
  expect(registerOverlay).toContain("Register Locked");
  expect(registerOverlay).toContain(
    'data-testid="pos-register-idle-lock-overlay"',
  );
  expect(registerOverlay).toContain("The drawer remains open.");
  expect(registerOverlay).toContain("if (unlocking) {");
  expect(registerOverlay).toContain(
    "if (unlocking) {\n      if (await attachOpenLane(lane))",
  );
});
