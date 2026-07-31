import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const cartSource = readFileSync(
  new URL("../src/components/pos/Cart.tsx", import.meta.url),
  "utf8",
);
const weddingDrawerSource = readFileSync(
  new URL("../src/components/pos/WeddingLookupDrawer.tsx", import.meta.url),
  "utf8",
);
const weddingDepositWorkspaceSource = readFileSync(
  new URL("../src/components/pos/WeddingDepositWorkspace.tsx", import.meta.url),
  "utf8",
);
const receiptSummarySource = readFileSync(
  new URL("../src/components/pos/ReceiptSummaryModal.tsx", import.meta.url),
  "utf8",
);
const paymentDrawerSource = readFileSync(
  new URL("../src/components/pos/NexoCheckoutDrawer.tsx", import.meta.url),
  "utf8",
);
const checkoutSource = readFileSync(
  new URL("../src/hooks/useCartCheckout.ts", import.meta.url),
  "utf8",
);
const weddingWorkflowMigration = readFileSync(
  new URL("../../migrations/174_wedding_deposit_workflows.sql", import.meta.url),
  "utf8",
);
const weddingRefundSourceMigration = readFileSync(
  new URL("../../migrations/175_wedding_deposit_refund_sources.sql", import.meta.url),
  "utf8",
);
const weddingWorkflowLogic = readFileSync(
  new URL("../../server/src/logic/wedding_deposit_workflows.rs", import.meta.url),
  "utf8",
);
const openDepositLogic = readFileSync(
  new URL("../../server/src/logic/customer_open_deposit.rs", import.meta.url),
  "utf8",
);
const registerDayActivitySource = readFileSync(
  new URL("../../server/src/logic/register_day_activity.rs", import.meta.url),
  "utf8",
);
const transactionsApiSource = readFileSync(
  new URL("../../server/src/api/transactions.rs", import.meta.url),
  "utf8",
);

test("wedding deposits are a removable deposit-only Cart workflow", () => {
  expect(cartSource).toContain('data-testid="pos-action-wedding-deposit"');
  expect(cartSource).toContain("openWeddingDepositTool");
  expect(cartSource).toContain(
    "memberships.find((candidate) => candidate.active) ?? memberships[0]",
  );
  expect(cartSource).toContain('data-testid="pos-wedding-deposit-line"');
  expect(cartSource).toContain('data-testid="pos-wedding-deposit-remove"');
  expect(cartSource).toContain("initialPartyId={weddingDrawerInitialPartyId}");
  expect(cartSource).toContain(
    "payerCustomerId={selectedCustomer?.id ?? null}",
  );

  expect(weddingDrawerSource).toContain(
    "/api/weddings/parties/${encodeURIComponent(partyId)}",
  );
  expect(weddingDrawerSource).toContain("setGroupPayMode(true)");
  expect(weddingDrawerSource).toContain(
    "member.customer_id === payerCustomerId",
  );
  expect(weddingDrawerSource).toContain('{isPayer ? " · Payer" : ""}');

  expect(checkoutSource).toContain(
    "checkoutLines.length === 0 && disbursementMembers.length === 0",
  );
});

test("wedding deposit posting is prevention-first, source-tracked, and receipt truthful", () => {
  expect(weddingDepositWorkspaceSource).toContain("Wedding Party");
  expect(weddingDepositWorkspaceSource).toContain("Choose Workflow");
  expect(weddingDepositWorkspaceSource).toContain("What are you doing today?");
  expect(weddingDepositWorkspaceSource).toContain("Members & Amounts");
  expect(weddingDepositWorkspaceSource).toContain("Review Before Payment");
  expect(weddingDepositWorkspaceSource).toContain("Start a New Wedding Party");
  expect(weddingDepositWorkspaceSource).toContain("Find Existing Customer");
  expect(weddingDepositWorkspaceSource).toContain("Create New Customer");
  expect(weddingDepositWorkspaceSource).toContain("Deposit destination");
  expect(weddingDepositWorkspaceSource).toContain("Hold for this member's future order");
  expect(weddingDepositWorkspaceSource).toContain("Deposit Only");
  expect(weddingDepositWorkspaceSource).toContain("Collect &amp; Build Orders");
  expect(weddingDepositWorkspaceSource).toContain(
    "selected without an amount (excluded)",
  );
  expect(weddingDepositWorkspaceSource).toContain(
    "fundedMembers.map((member)",
  );
  expect(weddingDepositWorkspaceSource).toContain("Wedding Orders &amp; Receipts");
  expect(weddingDepositWorkspaceSource).toContain("How item selection works");
  expect(weddingDepositWorkspaceSource).toContain(
    "Only a successful Pay → Complete Sale / Record Sale atomic checkout",
  );
  expect(weddingDepositWorkspaceSource).toContain("Refund one member allocation at a time");
  expect(weddingDepositWorkspaceSource).toContain(
    "original wedding deposit payer—not the member",
  );
  expect(weddingDepositWorkspaceSource).toContain("Choose Member &amp; Add Items");
  expect(weddingDepositWorkspaceSource).toContain("sourceCreditLedgerId");
  expect(weddingDepositWorkspaceSource).toContain("View / Print Payer Receipt");
  expect(weddingDepositWorkspaceSource).toContain("Receipt · {postedDisplayId}");

  expect(checkoutSource).toContain("deposit_destination_kind");
  expect(checkoutSource).toContain("deposit_target_transaction_id");
  expect(cartSource).toContain("/api/weddings/deposit-workflows/preflight");
  expect(cartSource).toContain(
    "Select the salesperson responsible for this wedding deposit before applying payment.",
  );
  expect(weddingWorkflowLogic).toContain("pub async fn preflight");
  expect(weddingWorkflowLogic).toContain("target_transaction_id");
  expect(weddingWorkflowMigration).toContain("wedding_deposit_workflows");
  expect(weddingWorkflowMigration).toContain("customer_open_deposit_source_events");
  expect(weddingRefundSourceMigration).toContain(
    "wedding_deposit_workflow_allocation_payments",
  );
  expect(weddingRefundSourceMigration).toContain(
    "customer_open_deposit_source_event_payments",
  );
  expect(openDepositLogic).toContain("SourceRequired");
  expect(openDepositLogic).toContain("source_credit_ledger_id");
  expect(registerDayActivitySource).toContain("Wedding Deposit Disbursement");
  expect(registerDayActivitySource).toContain(
    "sales_total: Some(money_label(Decimal::ZERO))",
  );
  expect(transactionsApiSource).toContain(
    "cannot be cancelled as an ordinary order",
  );
  expect(transactionsApiSource).toContain(
    "cannot use the ordinary same-day void",
  );
  expect(receiptSummarySource).toContain("Wedding Party Deposit");
  expect(receiptSummarySource).toContain("beneficiary_name");
  expect(receiptSummarySource).toContain("destination_label");
  expect(receiptSummarySource).toContain("Paid by {source.payer_name}");
  expect(receiptSummarySource).toContain("Refund returned to");
  expect(receiptSummarySource).toContain("wedding deposit payer—not the member");
  expect(paymentDrawerSource).toContain("Refund recipient: {refundRecipientName}");
  expect(paymentDrawerSource).toContain("not go to the member.");
  expect(cartSource).toContain('data-testid="pos-wedding-order-guidance"');
  expect(cartSource).toContain("Order (Wedding), confirm the salesperson");
  expect(cartSource).toContain("Continue Wedding Orders");
  expect(cartSource).toContain("if (completedTransactionId)");
  expect(cartSource).not.toContain('activeWeddingMember ? "Switch" : "Wedding"');
  expect(receiptSummarySource).toContain("completionNextActionLabel");
  expect(receiptSummarySource).toContain("receipt-completion-next-action");
  expect(receiptSummarySource).toContain("Finish without building orders now");
  expect(transactionsApiSource).toContain("wedding_refund_recipient");
  expect(transactionsApiSource).toContain("original_provider_transaction_id");
});

test("a declined deposit tender posts nothing and keeps reviewed allocations staged", () => {
  expect(paymentDrawerSource).toContain(
    "Card declined. The payment ledger is ready to retry.",
  );
  expect(paymentDrawerSource).toContain("No wedding deposits were posted.");
  expect(paymentDrawerSource).toContain("reviewed member allocation");
  expect(paymentDrawerSource).toContain("Retry card");
  expect(paymentDrawerSource).toContain("await onFinalize(applied, operator");
});
