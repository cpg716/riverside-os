import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  ensureMainNavigationVisible,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";

const isCi = process.env.CI === "true" || process.env.CI === "1";

function requireOrSkip(condition: boolean, message: string): void {
  if (condition) return;
  if (isCi) {
    expect(condition, message).toBeTruthy();
    return;
  }
  test.skip(true, message);
}

function databaseUrl(): string {
  return (
    process.env.E2E_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    `postgres://postgres:postgres@127.0.0.1:5432/${process.env.RIVERSIDE_DB_NAME?.trim() || "riverside_os"}`
  );
}

function sqlLiteral(value: string | null): string {
  if (value === null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

function runSql(sql: string): void {
  execFileSync(
    "psql",
    ["-v", "ON_ERROR_STOP=1", "-q", "-At", "-F", "\t", "-f", "-", databaseUrl()],
    {
      encoding: "utf8",
      input: sql,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

type UiSeed = {
  suite: string;
  runId: string;
  batchId: string;
  paymentId: string;
  itemId: string;
  depositId: string;
  providerBatchId: string;
  providerTransactionId: string;
  sourceReference: string;
};

let seeded = false;
let seedError = "";
let seed: UiSeed;

function makeSeed(): UiSeed {
  const suite = `e2e-payments-ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    suite,
    runId: randomUUID(),
    batchId: randomUUID(),
    paymentId: randomUUID(),
    itemId: randomUUID(),
    depositId: randomUUID(),
    providerBatchId: `${suite}-batch`,
    providerTransactionId: `${suite}-tx`,
    sourceReference: `${suite}-deposit`,
  };
}

function seedSql(row: UiSeed): string {
  return `
BEGIN;

DELETE FROM payment_actual_deposit_events WHERE deposit_id = ${sqlLiteral(row.depositId)};
DELETE FROM payment_deposit_reconciliation_items WHERE deposit_id = ${sqlLiteral(row.depositId)} OR provider_batch_id = ${sqlLiteral(row.providerBatchId)};
DELETE FROM payment_actual_deposit_batches WHERE deposit_id = ${sqlLiteral(row.depositId)} OR provider_batch_id = ${sqlLiteral(row.providerBatchId)};
DELETE FROM payment_actual_deposits WHERE id = ${sqlLiteral(row.depositId)} OR source_reference = ${sqlLiteral(row.sourceReference)};
DELETE FROM payment_settlement_item_events WHERE item_id = ${sqlLiteral(row.itemId)};
DELETE FROM payment_settlement_items WHERE id = ${sqlLiteral(row.itemId)} OR provider_batch_id = ${sqlLiteral(row.providerBatchId)};
DELETE FROM payment_provider_batch_transactions WHERE provider_transaction_id = ${sqlLiteral(row.providerTransactionId)};
DELETE FROM payment_provider_batches WHERE id = ${sqlLiteral(row.batchId)} OR provider_batch_id = ${sqlLiteral(row.providerBatchId)};
DELETE FROM payment_transactions WHERE id = ${sqlLiteral(row.paymentId)} OR metadata->>'e2e_suite' = ${sqlLiteral(row.suite)};
DELETE FROM payment_settlement_runs WHERE id = ${sqlLiteral(row.runId)};

INSERT INTO payment_settlement_runs (id, provider, scope, status, summary)
VALUES (${sqlLiteral(row.runId)}, 'helcim', 'batch_sync', 'completed', '{"e2e_ui": true}'::jsonb);

INSERT INTO payment_provider_batches (
  id, provider, provider_batch_id, status, currency, closed_at, settled_at,
  expected_deposit_at, gross_amount, fee_amount, net_amount, transaction_count, raw_payload
) VALUES (
  ${sqlLiteral(row.batchId)}, 'helcim', ${sqlLiteral(row.providerBatchId)}, 'settled',
  'USD', now() - interval '2 days', now() - interval '1 day', now(),
  100.00, NULL, 98.00, 1, jsonb_build_object('e2e_suite', ${sqlLiteral(row.suite)})
);

INSERT INTO payment_transactions (
  id, payment_method, amount, metadata, status, merchant_fee, net_amount,
  payment_provider, provider_transaction_id, provider_status, created_at, occurred_at
) VALUES (
  ${sqlLiteral(row.paymentId)}, 'card', 100.00,
  jsonb_build_object('e2e_suite', ${sqlLiteral(row.suite)}, 'helcim_fee_sync_status', 'not_ready', 'helcim_net_sync_status', 'not_ready'),
  'success', 0.00, 0.00, 'helcim', ${sqlLiteral(row.providerTransactionId)}, 'approved', now(), now()
);

INSERT INTO payment_provider_batch_transactions (
  provider, provider_batch_id, provider_transaction_id, payment_provider_batch_id,
  payment_transaction_id, transaction_type, status, currency, occurred_at, settled_at,
  gross_amount, fee_amount, net_amount, match_status, match_type, raw_payload
) VALUES (
  'helcim', ${sqlLiteral(row.providerBatchId)}, ${sqlLiteral(row.providerTransactionId)}, ${sqlLiteral(row.batchId)},
  ${sqlLiteral(row.paymentId)}, 'purchase', 'approved', 'USD', now(), now(),
  100.00, NULL, NULL, 'matched', 'exact_provider_transaction_id',
  jsonb_build_object('e2e_suite', ${sqlLiteral(row.suite)})
);

INSERT INTO payment_settlement_items (
  id, run_id, provider, item_type, severity, status, provider_batch_id,
  provider_transaction_id, payment_transaction_id, payment_provider_batch_id,
  processor_values, ros_values, message
) VALUES (
  ${sqlLiteral(row.itemId)}, ${sqlLiteral(row.runId)}, 'helcim', 'amount_mismatch',
  'warning', 'open', ${sqlLiteral(row.providerBatchId)}, ${sqlLiteral(row.providerTransactionId)},
  ${sqlLiteral(row.paymentId)}, ${sqlLiteral(row.batchId)},
  jsonb_build_object('amount', '100.00', 'provider_transaction_id', ${sqlLiteral(row.providerTransactionId)}),
  jsonb_build_object('amount', '99.00'),
  'E2E payment needs review'
);

INSERT INTO payment_actual_deposits (
  id, provider, source_system, source_reference, posted_at, amount, currency, status, raw_payload
) VALUES (
  ${sqlLiteral(row.depositId)}, 'helcim', 'manual', ${sqlLiteral(row.sourceReference)},
  now(), 98.00, 'USD', 'open', jsonb_build_object('e2e_suite', ${sqlLiteral(row.suite)})
);

INSERT INTO payment_actual_deposit_events (deposit_id, action, note, before_state, after_state)
VALUES (${sqlLiteral(row.depositId)}, 'created', 'E2E UI deposit', '{}'::jsonb, jsonb_build_object('id', ${sqlLiteral(row.depositId)}));

COMMIT;
`;
}

async function openPaymentsWorkspace(page: Page): Promise<void> {
  await signInToBackOffice(page, { persistSession: true });
  const nav = await ensureMainNavigationVisible(page);
  const paymentsButton = nav.getByRole("button", {
    name: /^payments(?:\s+bo)?$/i,
  });
  await expect(paymentsButton).toBeVisible({ timeout: 20_000 });
  await paymentsButton.scrollIntoViewIfNeeded().catch(() => {});
  await paymentsButton.click({ force: true });
  await expect(page.getByRole("heading", { name: /^payments$/i })).toBeVisible({
    timeout: 20_000,
  });
}

test.describe.serial("Payments Operations workspace smoke", () => {
  test.beforeAll(() => {
    seed = makeSeed();
    try {
      runSql(seedSql(seed));
      seeded = true;
    } catch (error) {
      seedError = error instanceof Error ? error.message : String(error);
      seeded = false;
    }
  });

  test("tabs, drawers, empty states, and staff-safe copy render", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      consoleErrors.push(error.message);
    });

    await openPaymentsWorkspace(page);
    requireOrSkip(
      seeded,
      `Payments UI seed unavailable via psql (${databaseUrl()}): ${seedError || "unknown error"}`,
    );

    const paymentsHeader = page
      .getByRole("banner")
      .filter({ has: page.getByRole("heading", { name: /^Payments$/i }) });
    const tabs = ["Overview", "Batches", "Reconciliation", "Transactions", "Deposits", "Health"];
    for (const tab of tabs) {
      await expect(
        paymentsHeader.getByRole("button", { name: new RegExp(`^${tab}`, "i") }),
      ).toBeVisible();
    }

    await expect(page.getByText("Fee not ready").first()).toBeVisible();
    await expect(page.getByText("Net not ready").first()).toBeVisible();
    await expect(page.getByText("Expected Deposit").first()).toBeVisible();

    await paymentsHeader.getByRole("button", { name: /^batches/i }).click();
    await expect(page.getByText(seed.providerBatchId)).toBeVisible({ timeout: 20_000 });
    await page.getByText(seed.providerBatchId).first().click();
    await expect(page.getByRole("dialog")).toContainText(`Batch ${seed.providerBatchId}`);
    await expect(page.getByRole("dialog")).toContainText("Transactions");
    await page.keyboard.press("Escape");

    await paymentsHeader.getByRole("button", { name: /^transactions/i }).click();
    await page.getByPlaceholder("Search payments").fill(seed.suite);
    await expect(page.getByText(seed.providerBatchId).first()).toBeVisible();
    await page.getByText(seed.providerBatchId).first().click();
    await expect(page.getByRole("dialog")).toContainText("Payment Detail");
    await expect(page.getByRole("dialog")).toContainText("Processor Reference");
    await expect(page.getByRole("dialog")).toContainText("Fee not ready");
    await expect(page.getByRole("dialog")).toContainText("Net not ready");
    await page.keyboard.press("Escape");

    await paymentsHeader.getByRole("button", { name: /^reconciliation/i }).click();
    await expect(page.getByText("E2E payment needs review").first()).toBeVisible();
    await page.getByRole("button", { name: "Open Issue" }).first().click();
    await expect(page.getByRole("dialog")).toContainText("Issue Summary");
    await expect(page.getByRole("dialog")).toContainText("Link Payment");
    await page.keyboard.press("Escape");

    await paymentsHeader.getByRole("button", { name: /^deposits/i }).click();
    await expect(page.getByText("Actual Bank Deposit").first()).toBeVisible();
    await expect(page.getByText("Expected Deposit").first()).toBeVisible();
    await expect(page.getByText(seed.sourceReference)).toBeVisible();
    await page.getByText(seed.sourceReference).click();
    await expect(page.getByRole("dialog")).toContainText("Actual Bank Deposit");
    await expect(page.getByRole("dialog")).toContainText("Expected Deposit");
    await expect(page.getByRole("dialog")).toContainText("Reviewing does not post to QuickBooks");
    await page.keyboard.press("Escape");

    await paymentsHeader.getByRole("button", { name: /^health/i }).click();
    await expect(page.getByText("Payment Alerts")).toBeVisible();
    await expect(
      page
        .getByText(
          /No payment alerts|Sync failed|Fee still not ready|Payment update failed|Payment issues need review|Deposit needs review/i,
        )
        .first(),
    ).toBeVisible();

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/\bwebhook\b|\bpayload\b|\bidempotency\b|settlement item/i);
    expect(consoleErrors).toEqual([]);
  });
});
