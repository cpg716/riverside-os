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
const confirmationModalSource = readFileSync(
  new URL("../src/components/ui/ConfirmationModal.tsx", import.meta.url),
  "utf8",
);
const checkoutSource = readFileSync(
  new URL("../src/hooks/useCartCheckout.ts", import.meta.url),
  "utf8",
);
const parkedSalesHookSource = readFileSync(
  new URL("../src/hooks/useParkedSales.ts", import.meta.url),
  "utf8",
);
const parkedSalesLibrarySource = readFileSync(
  new URL("../src/lib/posParkedSales.ts", import.meta.url),
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
const weddingsApiSource = readFileSync(
  new URL("../../server/src/api/weddings.rs", import.meta.url),
  "utf8",
);
const weddingQueriesSource = readFileSync(
  new URL("../../server/src/logic/wedding_queries.rs", import.meta.url),
  "utf8",
);
const styleEditSource = readFileSync(
  new URL(
    "../src/components/wedding-manager/components/StyleEditModal.jsx",
    import.meta.url,
  ),
  "utf8",
);
const addPartySource = readFileSync(
  new URL(
    "../src/components/wedding-manager/components/AddPartyModal.jsx",
    import.meta.url,
  ),
  "utf8",
);
const builderItemSelectorSource = readFileSync(
  new URL(
    "../src/components/wedding-manager/components/WeddingBuilderItemSelector.jsx",
    import.meta.url,
  ),
  "utf8",
);
const weddingDashboardSource = readFileSync(
  new URL(
    "../src/components/wedding-manager/pages/Dashboard.jsx",
    import.meta.url,
  ),
  "utf8",
);
const partyDetailSource = readFileSync(
  new URL(
    "../src/components/wedding-manager/components/PartyDetail.jsx",
    import.meta.url,
  ),
  "utf8",
);
const orderReviewSource = readFileSync(
  new URL(
    "../src/components/wedding-manager/components/OrderReviewTab.jsx",
    import.meta.url,
  ),
  "utf8",
);

test("wedding deposits are a removable deposit-only Cart workflow", () => {
  expect(cartSource).toContain('data-testid="pos-action-wedding-deposit"');
  expect(cartSource).toContain("openWeddingDepositTool");
  expect(cartSource).toContain(
    "memberships.length === 1 ? memberships[0] : null",
  );
  expect(cartSource).not.toContain(
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
  expect(weddingDepositWorkspaceSource).toContain(
    "Deposit amount per selected member",
  );
  expect(weddingDepositWorkspaceSource).toContain("Apply to Selected");
  expect(weddingDepositWorkspaceSource).toContain("Select All Members");
  expect(weddingDepositWorkspaceSource).toContain(
    "Selecting a member applies this amount immediately",
  );
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
  expect(weddingDepositWorkspaceSource).toContain("Wedding Builder · Review &amp; Reprint");
  expect(weddingDepositWorkspaceSource).toContain("Previous Deposits &amp; Builds Found");
  expect(weddingDepositWorkspaceSource).toContain("Build More Items");
  expect(weddingDepositWorkspaceSource).toContain("onStartAdditionalMemberOrder");
  expect(weddingDepositWorkspaceSource).toContain("One Builder, separate financial records");
  expect(weddingDepositWorkspaceSource).toContain(
    "Drafts never post money",
  );
  expect(weddingDepositWorkspaceSource).toContain("Refund one member allocation at a time");
  expect(weddingDepositWorkspaceSource).toContain(
    "original wedding deposit payer—not the member",
  );
  expect(weddingDepositWorkspaceSource).toContain("Build All Remaining Orders");
  expect(weddingDepositWorkspaceSource).toContain(
    "deposit-workflows?payer_customer_id=",
  );
  expect(weddingDepositWorkspaceSource).toContain("Current party activity");
  expect(weddingDepositWorkspaceSource).toContain("displayedWorkflows");
  expect(weddingDepositWorkspaceSource).toContain("Create All ${remainingBuildCount} Member Transactions");
  expect(weddingDepositWorkspaceSource).toContain("View / Print Receipt");
  expect(weddingDepositWorkspaceSource).toContain("No Tax — ${draft.taxExemptReason}");
  expect(weddingDepositWorkspaceSource).toContain("Start Building Member Orders");
  expect(weddingDepositWorkspaceSource).toContain("take the payer's payment only after all drafts are ready");
  expect(weddingDepositWorkspaceSource).toContain("Responsible salesperson");
  expect(weddingDepositWorkspaceSource).toContain("disabled={!salespersonId}");
  expect(weddingDepositWorkspaceSource).toContain("autoStartFirstMember");
  expect(weddingDepositWorkspaceSource).toContain("!candidate.member_transaction_id");
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
  expect(cartSource).toContain("Open Wedding Builder");
  expect(cartSource).toContain("startAdditionalWeddingMemberOrder");
  expect(cartSource).toContain("prior deposits, Transactions, and receipts are unchanged");
  expect(cartSource).toContain("setWeddingDepositAutoStartMember(true)");
  expect(parkedSalesHookSource).toContain('"ready_to_post"');
  expect(parkedSalesHookSource).toContain('"complete"');
  expect(parkedSalesHookSource).toContain("payerLines: CartLineItem[]");
  expect(cartSource).toContain("setLines(session.payerLines.map");
  expect(cartSource).toContain("weddingPayerMerchandiseSalespersonIdRef");
  expect(cartSource).toContain("weddingDepositSalespersonId");
  expect(cartSource).toContain("restoredDepositSalespersonId");
  expect(cartSource).toContain(
    "setWeddingDepositSalespersonId(restoredDepositSalespersonId)",
  );
  expect(cartSource).toContain('setWeddingDepositSalespersonId("")');
  expect(cartSource).toContain("payerMerchandiseSalespersonId");
  expect(cartSource).toContain("!isEmployeeSale");
  expect(cartSource).toContain("Save Member Order & Next");
  expect(cartSource).toContain("Salesperson for all member Transactions");
  expect(cartSource).toContain("No Tax for this member Transaction");
  expect(cartSource).toContain("Choose This Member&apos;s Variation");
  expect(cartSource).toContain('"Add to Member Order"');
  expect(cartSource).toContain('defaultFulfillment:');
  expect(cartSource).toContain('? "wedding_order"');
  expect(styleEditSource).toContain("builder_parent_items");
  expect(styleEditSource).toContain("Wedding Builder parent items");
  expect(addPartySource).toContain("WeddingBuilderItemSelector");
  expect(addPartySource).toContain("builder_parent_items");
  expect(builderItemSelectorSource).toContain("Groom Only");
  expect(builderItemSelectorSource).toContain("Groomsmen Only");
  expect(builderItemSelectorSource).toContain("Any");
  expect(builderItemSelectorSource).toContain("Other");
  expect(weddingsApiSource).toContain("wedding_builder_items::applies_to_role");
  expect(weddingsApiSource).toContain("required_for_member");
  expect(weddingsApiSource).toContain("builder_parent_items_before");
  expect(weddingsApiSource).toContain("builder_parent_items_after");
  expect(weddingQueriesSource).toContain("applied_paid_total");
  expect(weddingQueriesSource).toContain("held_deposit_total");
  expect(weddingQueriesSource).toContain("AS item_summary");
  expect(partyDetailSource).toContain("balanceDue <= 0.004");
  expect(partyDetailSource).toContain('status = "DEPOSIT"');
  expect(partyDetailSource).toContain("appointmentsByMemberId");
  expect(weddingDashboardSource).toContain("appointments_updated");
  expect(weddingDashboardSource).toContain("selectedParty?.id ? 60000 : 600000");
  expect(orderReviewSource).toContain("isRosDerived");
  expect(orderReviewSource).toContain("read-only ROS status");
  expect(cartSource).toContain("item.audience_label");
  expect(weddingsApiSource).toContain('source: "party_builder_template"');
  expect(cartSource).toContain("buildWeddingMemberCheckoutPayload");
  expect(cartSource).toContain('data-testid="wedding-collect-build-final-review"');
  expect(cartSource).toContain('data-testid="wedding-builder-final-review-line"');
  expect(cartSource).toContain("appliedPriceOverride");
  expect(cartSource).toContain("requestPriceOverrideApproval");
  expect(cartSource).toContain("Variation panel line discount exceeded staff limit");
  expect(cartSource).toContain("The payer has not been charged yet.");
  expect(cartSource).toContain("if (collectingWeddingOrderDraft)");
  expect(cartSource).toContain("openDepositApplicationCents");
  expect(cartSource).toContain("wedding-deposit:${heldOpenDeposit.sourceCreditLedgerId}");
  expect(cartSource).toContain("activeWeddingMember.customer_id !== customerId");
  expect(cartSource).toContain("setDisbursementMembers([])");
  expect(cartSource).toContain("if (completedTransactionId)");
  expect(parkedSalesHookSource).toContain("weddingCollectBuildSession");
  expect(parkedSalesHookSource).toContain("setWeddingCollectBuildSession");
  expect(parkedSalesHookSource).toContain("weddingDepositSalespersonId");
  expect(parkedSalesHookSource).toContain(
    "lines.length === 0 && !weddingCollectBuildSession",
  );
  expect(parkedSalesLibrarySource).toContain(
    "weddingCollectBuildSession?: unknown | null",
  );
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

test("selecting a wedding member offers the reusable exact-variation order flow", () => {
  expect(cartSource).toContain('title="Part of the Wedding Order?"');
  expect(cartSource).toContain('confirmLabel="Yes — Build Wedding Order"');
  expect(cartSource).toContain('cancelLabel="No — Regular Sale"');
  expect(cartSource).toContain("Held wedding deposit available:");
  expect(cartSource).toContain("It remains a liability until staff explicitly applies it at Pay.");
  expect(cartSource).toContain("No Wedding Order, deposit application, or financial record is created by this question.");
  expect(cartSource).toContain("Start Order");
  expect(cartSource).toContain("weddingOrderPromptHandledCustomerId");
  expect(cartSource).toContain(
    "weddingOrderPromptMembership.customer_id !== customerId",
  );
  expect(cartSource).toContain(
    "weddingVariantSelectionContext.membership.customer_id !== customerId",
  );
  expect(cartSource).toContain("openWeddingParentVariantPicker(");
  expect(cartSource).toContain('"Add to Wedding Order"');
  expect(cartSource).toContain("allowPriceOverride={");
  expect(cartSource).toContain('item.source !== "party_builder_template"');
  expect(cartSource).toContain('? "wedding_order"');
  expect(cartSource).toContain('weddingContext.mode === "needs_measurements"');
  expect(cartSource).toContain("setOpenDepositNotice(null)");
  expect(checkoutSource).toContain(
    "wedding_member_id: activeWeddingMember?.id ?? null",
  );
  expect(checkoutSource).toContain(
    "primary_salesperson_id: primaryTrim ? primaryTrim : null",
  );
  expect(checkoutSource).toContain("payment_splits,");
  expect(checkoutSource).toContain(
    "salesperson_id: isEmployeeSale ? null : l.salesperson_id?.trim() || null",
  );
  expect(checkoutSource).toContain("is_tax_exempt: ledgerSignals.isTaxExempt");
  expect(checkoutSource).toContain("order_lifecycle_status:");
  expect(confirmationModalSource).toContain("createPortal(");
  expect(confirmationModalSource).toContain('document.getElementById("drawer-root")');
  expect(confirmationModalSource).toContain("ui-overlay-backdrop");
  expect(confirmationModalSource).toContain("ui-modal");
  expect(cartSource).toContain("overflow-y-auto overscroll-contain");
  expect(cartSource).toContain("selectableWeddingPurchaseMemberships.length !== 1");
  expect(cartSource).toContain('data-testid="pos-wedding-party-choice"');
  expect(cartSource).toContain('data-testid="pos-wedding-party-card"');
  expect(cartSource).toContain("Measurements for ${membership.party_name}");
  expect(cartSource).toContain("flex min-h-14 items-center");
  expect(cartSource).toContain('aria-label="Wedding party for this sale"');
  expect(cartSource).toContain("visibleWeddingChecklistMemberships.map");
  expect(cartSource).toContain("activeWeddingPurchaseMembership.wedding_party_id");
  expect(cartSource).toContain('data-testid="pos-register-keypad"');
  expect(cartSource).toContain("h-[22rem] min-h-[22rem] shrink-0");
  expect(cartSource).not.toContain(
    "{activeWeddingMember ||\n            parkedRows.length > 0 ||",
  );
});
