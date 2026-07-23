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
const paymentsApi = repoFile("server/src/api/payments.rs");

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
  expect(drawer).toContain("!helcimAttemptMatchesCheckout(");
  expect(drawer).toContain("requestContext.checkoutClientId,");
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
  expect(tenderFlow).toContain("helcimAttemptBelongsToCurrentCheckout");
});

test("only an exact register-session and checkout Helcim attempt can import or lock tenders", () => {
  const matcherStart = drawer.indexOf("function helcimAttemptMatchesCheckout(");
  const matcherEnd = drawer.indexOf("interface HelcimPayInitializeResponse", matcherStart);
  const matcher = drawer.slice(matcherStart, matcherEnd);
  expect(matcherStart).toBeGreaterThan(-1);
  expect(matcher).toContain("currentRegisterSessionId");
  expect(matcher).toContain("currentCheckoutClientId");
  expect(matcher).toContain(
    "attempt.register_session_id?.trim() === currentRegisterSessionId",
  );
  expect(matcher).toContain(
    "attempt.checkout_client_id?.trim() === currentCheckoutClientId",
  );

  const routingMatcherStart = drawer.indexOf(
    "function helcimRoutingAttemptMatchesCheckout(",
  );
  const routingMatcherEnd = drawer.indexOf(
    "interface HelcimPayInitializeResponse",
    routingMatcherStart,
  );
  const routingMatcher = drawer.slice(routingMatcherStart, routingMatcherEnd);
  expect(routingMatcherStart).toBeGreaterThan(-1);
  expect(routingMatcher).toContain("route?.active_attempt_id?.trim()");
  expect(routingMatcher).toContain(
    "route.register_session_id?.trim() === currentRegisterSessionId",
  );
  expect(routingMatcher).toContain(
    "route.checkout_client_id?.trim() === currentCheckoutClientId",
  );

  const routingStateStart = drawer.indexOf(
    "const currentCheckoutRoutingTerminal =",
  );
  const routingStateEnd = drawer.indexOf(
    "const helcimAttemptBelongsToCurrentCheckout =",
    routingStateStart,
  );
  const routingState = drawer.slice(routingStateStart, routingStateEnd);
  expect(routingStateStart).toBeGreaterThan(-1);
  expect(routingState).toContain("terminalStatuses.find((terminal) =>");
  expect(routingState).toContain("helcimRoutingAttemptMatchesCheckout(");
  expect(routingState).toContain("registerSessionIdentity");
  expect(routingState).toContain("checkoutIdentity");
  expect(routingState).toContain(
    "currentCheckoutRoutingTerminal?.active_attempt_id?.trim() || null",
  );

  const outcomeStart = drawer.indexOf(
    "const helcimAttemptBelongsToCurrentCheckout =",
  );
  const outcomeEnd = drawer.indexOf("const helcimAttemptId =", outcomeStart);
  const outcomeGuard = drawer.slice(outcomeStart, outcomeEnd);
  expect(outcomeStart).toBeGreaterThan(-1);
  expect(outcomeGuard).toContain("helcimAttemptMatchesCheckout(");
  expect(outcomeGuard).toContain(
    'helcimAttemptBelongsToCurrentCheckout && helcimAttempt?.status === "pending"',
  );
  expect(outcomeGuard).toContain(
    'helcimAttemptBelongsToCurrentCheckout && helcimAttempt?.status === "expired"',
  );
  expect(outcomeGuard).toContain("helcimRoutingAttemptBelongsToCurrentCheckout ||");

  const applyStart = drawer.indexOf(
    "const applyHelcimAttemptUpdate = useCallback",
  );
  const applyEnd = drawer.indexOf("const loadHelcimCards", applyStart);
  const applyFlow = drawer.slice(applyStart, applyEnd);
  expect(applyStart).toBeGreaterThan(-1);
  expect(applyFlow.indexOf("!helcimAttemptMatchesCheckout(")).toBeGreaterThan(-1);
  expect(applyFlow.indexOf("setHelcimAttempt(attempt)")).toBeGreaterThan(
    applyFlow.indexOf("!helcimAttemptMatchesCheckout("),
  );

  const refreshStart = drawer.indexOf(
    "const refreshHelcimAttempt = useCallback",
  );
  const refreshEnd = drawer.indexOf("useEffect(() => {", refreshStart);
  const refreshFlow = drawer.slice(refreshStart, refreshEnd);
  expect(refreshStart).toBeGreaterThan(-1);
  expect(refreshFlow).toContain("importOnlyIfCurrentCheckout?: boolean");
  expect(refreshFlow).toContain(
    "const blockWhileLoading = !options.importOnlyIfCurrentCheckout",
  );
  expect(refreshFlow).toContain(
    "if (blockWhileLoading) setHelcimAttemptLoading(true)",
  );
  expect(refreshFlow).toContain(
    "options.importOnlyIfCurrentCheckout &&",
  );
  expect(refreshFlow).toContain("!helcimAttemptMatchesCheckout(");
  expect(refreshFlow).toContain("return null;");
  expect(refreshFlow).toContain(
    "if (!options.importOnlyIfCurrentCheckout) {",
  );

  const routeLookupStart = drawer.indexOf(
    "if (!isOpen || !currentCheckoutRoutingAttemptId)",
  );
  const routeLookupEnd = drawer.indexOf(
    "const simulateHelcimAttempt",
    routeLookupStart,
  );
  const routeLookup = drawer.slice(routeLookupStart, routeLookupEnd);
  expect(routeLookupStart).toBeGreaterThan(-1);
  expect(routeLookup).toContain(
    "refreshHelcimAttempt(currentCheckoutRoutingAttemptId",
  );
  expect(routeLookup).toContain("quietPending: true");
  expect(routeLookup).toContain("importOnlyIfCurrentCheckout: true");
  expect(routeLookup).toContain("attempt.status !== \"pending\"");
  expect(routeLookup).toContain("void loadProviderSettings()");
  expect(routeLookup).not.toContain("selectedTerminalInUseByCurrentRegister");
  expect(routeLookup).not.toContain("selectedTerminalActiveAttemptId");
  expect(routeLookup).not.toContain("setHelcimAttemptLoading(true)");

  expect(drawer).toContain(
    ": currentCheckoutRoutingAttemptId;",
  );
  expect(drawer).toContain(
    "const canFinalize = balanced && operator != null && !busy && !helcimOutcomeBlocksCheckout;",
  );
  expect(drawer).toContain("if (helcimOutcomeBlocksCheckout) {");
  expect(drawer).toContain("disabled={helcimOutcomeBlocksCheckout}");
  expect(drawer).toContain(
    "const helcimAttentionBannerVisible =",
  );
  expect(drawer).toContain(
    "helcimAttemptOutcomeUnverified || pendingHelcimAttemptNeedsAttention",
  );
  expect(drawer).toContain("{helcimAttentionBannerVisible ? (");
  expect(drawer).not.toContain("Helcim outcome required");

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

  const routingApiStart = paymentsApi.indexOf(
    "async fn helcim_terminal_routing_status(",
  );
  const routingApiEnd = paymentsApi.indexOf(
    "fn mask_terminal_suffix(",
    routingApiStart,
  );
  const routingApi = paymentsApi.slice(routingApiStart, routingApiEnd);
  expect(routingApiStart).toBeGreaterThan(-1);
  expect(paymentsApi).toContain("pub register_session_id: Option<Uuid>");
  expect(paymentsApi).toContain("pub checkout_client_id: Option<Uuid>");
  expect(routingApi).toContain("ppa.register_session_id");
  expect(routingApi).toContain("ppa.checkout_client_id");
  expect(routingApi).toContain("register_session_id: active");
  expect(routingApi).toContain("checkout_client_id: active");

  const staleCleanupStart = paymentsApi.indexOf(
    "async fn expire_closed_session_helcim_terminal_attempts_before_dispatch(",
  );
  const staleCleanupEnd = paymentsApi.indexOf(
    "fn is_provider_idempotency_violation(",
    staleCleanupStart,
  );
  const staleCleanup = paymentsApi.slice(staleCleanupStart, staleCleanupEnd);
  expect(staleCleanupStart).toBeGreaterThan(-1);
  expect(staleCleanup).toContain("SET status = 'expired'");
  expect(staleCleanup).toContain("NULLIF(BTRIM(ppa.error_code), '')");
  expect(staleCleanup).toContain("'closed_session_pending_isolated'");
  expect(staleCleanup).toContain("CONCAT_WS(");
  expect(staleCleanup).toContain("NULLIF(BTRIM(ppa.error_message), '')");
  expect(staleCleanup).toContain("AND NOT EXISTS");
  expect(staleCleanup).toContain("rs.is_open = true");
  expect(staleCleanup).toContain("rs.lifecycle_status = 'open'");

  const purchaseStart = paymentsApi.indexOf("async fn start_helcim_purchase(");
  const purchaseEnd = paymentsApi.indexOf("#[allow(dead_code)]", purchaseStart);
  const purchase = paymentsApi.slice(purchaseStart, purchaseEnd);
  const staleCleanupCall = purchase.indexOf(
    "expire_closed_session_helcim_terminal_attempts_before_dispatch(",
  );
  const openSessionGuard = purchase.indexOf(
    "reject_unresolved_helcim_terminal_before_dispatch(",
  );
  const attemptInsert = purchase.indexOf("INSERT INTO payment_provider_attempts");
  expect(staleCleanupCall).toBeGreaterThan(-1);
  expect(openSessionGuard).toBeGreaterThan(staleCleanupCall);
  expect(attemptInsert).toBeGreaterThan(openSessionGuard);
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
