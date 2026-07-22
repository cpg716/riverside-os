import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { scrubSensitivePinKeys } from "../src/lib/sensitiveData";

function repoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

test("legacy and new Register payment state never persists an Access PIN", () => {
  const sanitized = scrubSensitivePinKeys({
    manager_pin: "1234",
    nested: {
      accessPin: "5678",
      "x-riverside-staff-pin": "2468",
      "Legacy.Manager-PIN": "1357",
      manager_reason: "audited",
    },
    rows: [{ pin: "9999", manager_staff_id: "staff-id" }],
    encoded: '{"x-riverside-staff-pin":"8642","reference":"safe"}',
  });
  expect(sanitized).toEqual({
    nested: { manager_reason: "audited" },
    rows: [{ manager_staff_id: "staff-id" }],
    encoded: '{"reference":"safe"}',
  });

  const drawer = repoFile("client/src/components/pos/NexoCheckoutDrawer.tsx");
  const cart = repoFile("client/src/components/pos/Cart.tsx");
  expect(drawer).not.toContain("manager_pin: pin");
  expect(drawer).toContain("manager_approval_reference");
  expect(cart).not.toContain("metadata?.manager_pin");

  const migration = repoFile(
    "migrations/143_register_financial_recovery_integrity.sql",
  );
  expect(migration).toContain("ros_143_scrub_sensitive_pin_keys");
  expect(migration).toContain("UPDATE public.payment_transactions");
  expect(migration).toContain("UPDATE public.payment_allocations");
  expect(migration).toContain("UPDATE public.operational_recovery_job");
});

test("Orders manual external-card refunds use a server-issued approval without forwarding the PIN", () => {
  const orders = repoFile("client/src/components/orders/OrdersWorkspace.tsx");
  const refundModal = repoFile("client/src/components/pos/PosRefundModal.tsx");
  const manualPayloadStart = orders.indexOf(
    'manualExternalCardRefund &&\n        managerApproval?.kind === "manual_external_card"',
  );
  const rmsPayloadStart = orders.indexOf(
    'else if (rmsRefund && managerApproval?.kind === "rms")',
    manualPayloadStart,
  );

  expect(manualPayloadStart).toBeGreaterThan(-1);
  expect(rmsPayloadStart).toBeGreaterThan(manualPayloadStart);
  const manualPayload = orders.slice(manualPayloadStart, rmsPayloadStart);
  expect(manualPayload).toContain("body.manager_approval_reference");
  expect(manualPayload).toContain("body.card_last4");
  expect(manualPayload).not.toContain("manager_pin");
  expect(orders).toContain(
    'authorize_action: "manual_external_card_refund_authorization"',
  );
  expect(orders).toContain("register_session_id: sessionId");
  expect(orders).toContain(
    "external_refund_reference: refundExternalReference.trim()",
  );
  expect(orders).toContain("manager_reason: refundManagerReason.trim()");
  expect(refundModal).toContain("Card last four");
  expect(refundModal).toContain('method === "card_terminal_manual"');
});

test("server recovery creation is session-locked and exchange recovery is server-owned", () => {
  const recovery = repoFile("server/src/api/recovery.rs");
  expect(recovery).toContain("exchange settlement recovery is server-owned");
  expect(recovery).toMatch(
    /SELECT id[\s\S]*WHERE id = \$1 AND is_open = true[\s\S]*FOR UPDATE/,
  );
  expect(recovery).toContain("exact non-null checkout_client_id");
  expect(recovery).toContain("legacy_committed_without_replay");
  expect(recovery).toContain(
    "IS NOT DISTINCT FROM EXCLUDED.register_session_id",
  );
  expect(recovery).toContain(
    "IS NOT DISTINCT FROM EXCLUDED.checkout_client_id",
  );

  const checkout = repoFile("server/src/logic/transaction_checkout.rs");
  expect(checkout).toContain("requires a matching exchange settlement intent");
  expect(checkout).toContain(
    "operational_recovery_job.kind = 'exchange_settlement'",
  );
  expect(checkout).toContain("checkout_processing_intent_fingerprint");

  const transactions = repoFile("server/src/api/transactions.rs");
  const offlineQueue = repoFile("client/src/lib/offlineQueue.ts");
  expect(transactions).toContain(
    "Register checkout requires a non-null checkout_client_id",
  );
  expect(offlineQueue).toContain(
    "Legacy queued checkout is missing its exact checkout identity",
  );
});
