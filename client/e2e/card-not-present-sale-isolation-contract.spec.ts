import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

function repoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

const drawer = repoFile("client/src/components/pos/NexoCheckoutDrawer.tsx");
const handoff = repoFile("client/src/components/pos/HelcimManualCardHandoff.tsx");
const paymentsWorkspace = repoFile("client/src/components/payments/PaymentsWorkspace.tsx");

test("checkout and customer changes clear sale-scoped tender state only", () => {
  const resetStart = drawer.indexOf("// Tender UI is scoped to one exact sale/customer.");
  const resetEnd = drawer.indexOf("const registerLane =", resetStart);
  const resetBoundary = drawer.slice(resetStart, resetEnd);

  expect(resetStart).toBeGreaterThan(-1);
  expect(resetBoundary).toContain("activeHostedManualCardContextRef.current = null");
  expect(resetBoundary).toContain("setDonationNote(\"\")");
  expect(resetBoundary).toContain("setManualRefundApprovalOpen(false)");
  expect(resetBoundary).toContain("setPendingManualRefundCents(null)");
  expect(resetBoundary).toContain("setHelcimCards([])");
  expect(resetBoundary).toContain("setHelcimCustomerId(\"\")");
  expect(resetBoundary).toContain("setSelectedHelcimCardId(\"\")");
  expect(resetBoundary).toContain("setTerminalPickerOpen(false)");
  expect(resetBoundary).toContain("saleTerminalRoute?.default_terminal_key");
  expect(resetBoundary).toContain("setRmsResolve(null)");
  expect(resetBoundary).toContain("setStaffAccount(null)");
  expect(drawer).toContain("latestSaleIdentityRef.current.customerId !== requestedCustomerIdentity");
  expect(drawer).toContain("requestStillMatchesCustomer()");
  expect(resetBoundary).not.toContain("/release");
  expect(resetBoundary).not.toContain("/refund");
  expect(resetBoundary).toContain("Provider attempts remain server-side for Payments Health review");
  expect(drawer).toContain("helcimAttemptLoading ||");
});

test("CNP approval and handoff messages require the exact request, attempt, sale, and customer", () => {
  expect(drawer).toContain("hostedManualCardContextMatches(");
  expect(drawer).toContain("context.attemptId === attempt.id");
  expect(drawer).toContain("context.checkoutClientId === checkoutClientId");
  expect(drawer).toContain("context.customerId === customerId");
  expect(drawer).toContain("activeHostedManualCardContextRef.current?.requestId !== requestContext.requestId");
  expect(drawer).toContain("body.attempt.checkout_client_id !== requestContext.checkoutClientId");
  expect(drawer).toContain("data.cnp_request_id !== activeContext.requestId");
  expect(drawer).toContain("data.attempt_id !== attemptId");
  expect(drawer).toContain("key={currentManualCardHandoffUrl}");

  expect(handoff).toContain("cnp_request_id: params.get(\"ros_cnp_request_id\")");
  expect(handoff).not.toContain("ros_customer_id");
  expect(handoff).not.toContain("ros_checkout_client_id");
  expect(handoff).toContain("postHandoffOutcome(attemptId, \"approved\", saleContext)");
});

test("an exact approved or pending CNP is handled before a new initialize call", () => {
  const tenderStart = drawer.indexOf(
    'if (["card_terminal", "card_manual", "card_saved", "card_credit"].includes(tab))',
  );
  const tenderEnd = drawer.indexOf("const meta = TAB_META[tab]", tenderStart);
  const tenderFlow = drawer.slice(tenderStart, tenderEnd);
  const approvalRecovery = tenderFlow.indexOf("const restored = addApprovedHelcimAttempt(");
  const manualBranch = tenderFlow.indexOf('if (tab === "card_manual")');
  const initialize = tenderFlow.indexOf("await startHostedManualCardPayment(amtCents)");

  expect(approvalRecovery).toBeGreaterThan(-1);
  expect(manualBranch).toBeGreaterThan(approvalRecovery);
  expect(initialize).toBeGreaterThan(manualBranch);
  expect(tenderFlow.indexOf('if (helcimAttempt?.status === "pending")')).toBeLessThan(
    tenderFlow.indexOf('if (tab === "card_saved")'),
  );
  expect(tenderFlow).toContain("pendingAttemptIsDemonstrablyStale");
  expect(tenderFlow).toContain("Recover or cancel that attempt before starting another card payment.");
  expect(tenderFlow).toContain("It remains visible in Payments Health.");
  expect(tenderFlow).toContain("hostedManualCardContextMatches(");
});

test("pending or unverified Helcim outcomes lock alternate tenders and sale recording", () => {
  expect(drawer).toContain("const helcimOutcomeBlocksCheckout =");
  expect(drawer).toContain('helcimAttempt?.status === "pending"');
  expect(drawer).toContain("helcimAttemptOutcomeUnverified;");
  expect(drawer).toContain(
    "const canFinalize = balanced && operator != null && !busy && !helcimOutcomeBlocksCheckout;",
  );
  expect(drawer).toContain("if (helcimOutcomeBlocksCheckout) {");
  expect(drawer).toContain("disabled={helcimOutcomeBlocksCheckout}");
  expect(drawer).toContain("Another tender and Record Sale stay locked");

  const releaseStart = drawer.indexOf("const releasePendingTerminalAttempt = useCallback");
  const releaseEnd = drawer.indexOf("const handlePendingTerminalCancel", releaseStart);
  const releaseFlow = drawer.slice(releaseStart, releaseEnd);
  expect(releaseStart).toBeGreaterThan(-1);
  expect(releaseFlow).toContain("const attempt = await releaseHelcimAttempt(attemptId)");
  expect(releaseFlow).toContain("resetHelcimAttemptAfterRelease(attempt, options)");
  expect(releaseFlow).toContain("ROS could not confirm that Helcim released this card request.");
  expect(drawer).toContain("providerSettings?.helcim.simulator_enabled &&");
  expect(drawer).toContain("Release simulated request");
  expect(drawer).not.toContain("Release & use another tender");
  expect(drawer).not.toContain("forceExitPendingHelcimAttempt");
  expect(drawer).not.toContain("Close & use another tender");
});

test("saved-card checkout keeps provider tokens out of client source and DOM state", () => {
  expect(drawer).toContain("helcim_customer_id: providerCustomerId");
  expect(drawer).toContain("helcim_card_id: providerCardId");
  expect(drawer).toContain("customer_id: customerId");
  expect(drawer).toContain("customer_code: code || undefined");
  expect(drawer).toContain("if (!customerId || !code || !providerCustomerId || !providerCardId)");
  expect(drawer).toContain("value={selectedHelcimCardId}");
  expect(drawer).not.toContain("cardToken");
  expect(drawer).not.toContain("card_token");
});

test("card refunds remain in the canonical Transaction Record settlement path", () => {
  expect(drawer).toContain('refund_processing: "server_settlement"');
  expect(drawer).toContain("Start card refunds from the original Transaction Record");
  expect(drawer).not.toContain("/terminal/refund");
  expect(drawer).not.toContain("/card/refund");

  expect(paymentsWorkspace).not.toContain("StandaloneRefundPanel");
  expect(paymentsWorkspace).not.toContain('/card/refund');
  expect(paymentsWorkspace).not.toContain('SectionButton id="refunds"');
});
