import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  recoveryJobsOutsideCurrentTillGroup,
  type ServerRecoveryJob,
} from "../src/lib/serverRecovery";

const serverRecoverySource = readFileSync(
  new URL("../src/lib/serverRecovery.ts", import.meta.url),
  "utf8",
);
const closeRegisterSource = readFileSync(
  new URL("../src/components/pos/CloseRegisterModal.tsx", import.meta.url),
  "utf8",
);
const transactionsSource = readFileSync(
  new URL("../../server/src/api/transactions.rs", import.meta.url),
  "utf8",
);

function recoveryJob(
  clientJobKey: string,
  kind: ServerRecoveryJob["kind"],
): ServerRecoveryJob {
  return {
    client_job_key: clientJobKey,
    kind,
    status: "blocked",
    payload: {},
    attempt_count: 1,
  };
}

test.describe("Register recovery history UI contracts", () => {
  test("global manager recovery is deduped from current till-group blockers", () => {
    const current = [recoveryJob("checkout:current", "checkout_unconfirmed")];
    const global = [
      recoveryJob("checkout:current", "checkout_unconfirmed"),
      recoveryJob("checkout:prior", "checkout_offline"),
      recoveryJob("checkout:pickup", "pickup_after_payment"),
      recoveryJob("exchange:prior", "exchange_settlement"),
      recoveryJob("receipt:prior", "receipt_print"),
    ];

    expect(recoveryJobsOutsideCurrentTillGroup(current, global)).toEqual([
      global[1],
      global[2],
      global[3],
      global[4],
    ]);

    const blockerExpression = closeRegisterSource.slice(
      closeRegisterSource.lastIndexOf("const hasRecoveryBlockers"),
      closeRegisterSource.lastIndexOf("const closeBlockers"),
    );
    expect(blockerExpression).toContain("serverRecoveryJobs.length");
    expect(blockerExpression).not.toContain("globalRecoveryJobs");
    expect(blockerExpression).not.toContain("historicalRecoveryJobs");
  });

  test("current reads stay POS-scoped while global reads require Staff Access", () => {
    const currentContext = serverRecoverySource.slice(
      serverRecoverySource.indexOf("function recoveryRequestContext"),
      serverRecoverySource.indexOf("function staffRecoveryRequestContext"),
    );
    const globalContext = serverRecoverySource.slice(
      serverRecoverySource.indexOf("function staffRecoveryRequestContext"),
      serverRecoverySource.indexOf("async function recoveryResponseError"),
    );

    expect(currentContext).toContain("const posHeaders = posRegisterAuthHeaders()");
    expect(currentContext).toContain("? posHeaders");
    expect(globalContext).toContain('delete headers["x-riverside-pos-session-id"]');
    expect(globalContext).toContain('delete headers["x-riverside-pos-session-token"]');
    expect(serverRecoverySource).toContain("prior till-group recovery was not checked");
  });

  test("historical recovery reports errors and uses audited replay or evidence verification", () => {
    expect(closeRegisterSource).toContain("Prior or other till-group recovery");
    expect(closeRegisterSource).toMatch(/do\s+not block its Z-close/);
    expect(closeRegisterSource).toMatch(
      /This is not\s+confirmation that no prior recovery exists/,
    );
    expect(closeRegisterSource).toContain(
      'openRecoveryManagerApproval(\n                    "replay_historical"',
    );
    expect(closeRegisterSource).toContain(
      '"verify_historical_follow_up",\n                    historicalPickupFollowUpJobs',
    );
    expect(closeRegisterSource).toContain("recoveryManagerJobKeys");
    expect(closeRegisterSource).toMatch(
      /Complete every named step in Orders or Alterations first/,
    );
    expect(closeRegisterSource).toContain('"settle_historical_exchange"');
    expect(closeRegisterSource).toMatch(/locked server record, verifies the original tender/);
    expect(closeRegisterSource).toMatch(/receipt\s+print job from Print Recovery/);
    expect(serverRecoverySource).toContain("/verify-follow-up");
    expect(serverRecoverySource).toContain("manager_staff_id: approval.managerStaffId");
  });

  test("existing-payment reconciliation requires exact server evidence and clears only its checkout", () => {
    const helper = serverRecoverySource.slice(
      serverRecoverySource.indexOf(
        "export async function resolveExternallyReconciledCheckoutJob",
      ),
      serverRecoverySource.indexOf(
        "/** Verify the recorded Orders/Alterations follow-up",
      ),
    );
    expect(helper).toContain("/resolve-external");
    expect(helper).toContain("target_transaction_display_id");
    expect(helper).toContain("provider_transaction_id");
    expect(helper).toContain("manager_staff_id: approval.managerStaffId");
    expect(helper).toContain("manager_pin: approval.managerPin");
    expect(helper).toContain("checkout_client_id");
    expect(helper).toContain("register_session_id");
    expect(helper).toContain(
      "Keep the recovery record visible and contact support",
    );

    expect(closeRegisterSource).toContain("Match Existing Paid Transaction");
    expect(closeRegisterSource).toContain("Manager Verify Exact Match");
    expect(closeRegisterSource).toMatch(
      /creates no new payment|No new charge or payment movement was created/,
    );
    expect(closeRegisterSource).toContain(
      "recoveryKey: job.client_job_key",
    );
    expect(closeRegisterSource).toContain(
      "checkoutClientId: result.checkoutClientId",
    );
    expect(closeRegisterSource).toContain(
      "checkoutClientId: job.checkout_client_id ?? \"\"",
    );
    expect(closeRegisterSource).toContain(
      "transactionId: result.transactionId",
    );
  });

  test("exchange recovery accepts only job identity, current posting session, and Manager approval", () => {
    const helper = serverRecoverySource.slice(
      serverRecoverySource.indexOf("export async function recoverExchangeSettlementJob"),
      serverRecoverySource.indexOf("/** Replay a recovery from outside", serverRecoverySource.indexOf("export async function recoverExchangeSettlementJob")),
    );
    expect(helper).toContain("/api/transactions/exchange-settlement-recovery/");
    expect(helper).toContain("posting_session_id: postingSessionId");
    expect(helper).toContain("manager_staff_id: approval.managerStaffId");
    expect(helper).toContain("manager_pin: approval.managerPin");
    expect(helper).toContain("reason: approval.reason");
    expect(helper).not.toContain("exchange_credit_amount");
    expect(helper).not.toContain("refund_remainder");
    expect(helper).not.toContain("return_lines");

    const recoveryExecutor = transactionsSource.slice(
      transactionsSource.indexOf("async fn resolve_exchange_recovery_job_in_tx"),
      transactionsSource.indexOf("async fn get_transaction_receipt_escpos"),
    );
    expect(recoveryExecutor).toContain("FOR UPDATE");
    expect(recoveryExecutor).toContain('client_job_key != format!("exchange:{job_checkout_client_id}")');
    expect(recoveryExecutor).toContain("checkout_request_fingerprint");
    expect(recoveryExecutor).toContain("checkout_payment_fingerprint");
    expect(recoveryExecutor).toContain("origin_session_id");
    expect(recoveryExecutor).toContain("posting_session_id");
    expect(recoveryExecutor).toContain("register_exchange_settlement_recovery");
    expect(recoveryExecutor).toContain('"deferred_card_refund_amount"');
    expect(closeRegisterSource).toContain(
      "linked card refund remains due. Open each original Transaction Record",
    );
  });
});
