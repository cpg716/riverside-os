import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { apiBase, staffHeaders } from "./helpers/rmsCharge";

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
  const dbName =
    process.env.RIVERSIDE_DB_NAME?.trim() ||
    process.env.E2E_DB_NAME?.trim() ||
    "riverside_os_e2e";
  return (
    process.env.E2E_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    `postgres://postgres:password@127.0.0.1:5433/${dbName}`
  );
}

function sqlLiteral(value: string | null): string {
  if (value === null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

function runSql(sql: string): string {
  return execFileSync(
    "psql",
    ["-v", "ON_ERROR_STOP=1", "-q", "-At", "-F", "\t", "-f", "-", databaseUrl()],
    {
      encoding: "utf8",
      input: sql,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

function selectScalar(sql: string): string {
  return runSql(sql).trim();
}

function uniqueRef(label: string): string {
  return `e2e-payops-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type SeedIds = {
  suite: string;
  runId: string;
  batchA: string;
  batchB: string;
  paymentLink: string;
  paymentNonHelcim: string;
  paymentMismatch: string;
  paymentConflict: string;
  paymentAlreadyLinked: string;
  itemReview: string;
  itemLink: string;
  itemNonHelcim: string;
  itemMismatch: string;
  itemConflict: string;
  txLink: string;
  txNonHelcim: string;
  txMismatch: string;
  txConflict: string;
};

let serverReachable = false;
let seeded = false;
let seedError = "";
let ids: SeedIds;

function makeIds(): SeedIds {
  const suite = uniqueRef("suite");
  return {
    suite,
    runId: randomUUID(),
    batchA: randomUUID(),
    batchB: randomUUID(),
    paymentLink: randomUUID(),
    paymentNonHelcim: randomUUID(),
    paymentMismatch: randomUUID(),
    paymentConflict: randomUUID(),
    paymentAlreadyLinked: randomUUID(),
    itemReview: randomUUID(),
    itemLink: randomUUID(),
    itemNonHelcim: randomUUID(),
    itemMismatch: randomUUID(),
    itemConflict: randomUUID(),
    txLink: `${suite}-tx-link`,
    txNonHelcim: `${suite}-tx-nonhelcim`,
    txMismatch: `${suite}-tx-mismatch`,
    txConflict: `${suite}-tx-conflict`,
  };
}

function seedSql(seed: SeedIds): string {
  return `
BEGIN;

DELETE FROM payment_actual_deposit_events
WHERE deposit_id IN (
  SELECT id FROM payment_actual_deposits WHERE source_reference LIKE ${sqlLiteral(`${seed.suite}%`)}
);
DELETE FROM payment_deposit_reconciliation_items
WHERE deposit_id IN (
  SELECT id FROM payment_actual_deposits WHERE source_reference LIKE ${sqlLiteral(`${seed.suite}%`)}
)
OR provider_batch_id LIKE ${sqlLiteral(`${seed.suite}%`)};
DELETE FROM payment_actual_deposit_batches
WHERE deposit_id IN (
  SELECT id FROM payment_actual_deposits WHERE source_reference LIKE ${sqlLiteral(`${seed.suite}%`)}
)
OR provider_batch_id LIKE ${sqlLiteral(`${seed.suite}%`)};
DELETE FROM payment_actual_deposits WHERE source_reference LIKE ${sqlLiteral(`${seed.suite}%`)};
DELETE FROM payment_settlement_item_events
WHERE item_id IN (
  SELECT id FROM payment_settlement_items
  WHERE provider_transaction_id LIKE ${sqlLiteral(`${seed.suite}%`)}
     OR provider_batch_id LIKE ${sqlLiteral(`${seed.suite}%`)}
     OR message LIKE ${sqlLiteral(`${seed.suite}%`)}
);
DELETE FROM payment_settlement_items
WHERE provider_transaction_id LIKE ${sqlLiteral(`${seed.suite}%`)}
   OR provider_batch_id LIKE ${sqlLiteral(`${seed.suite}%`)}
   OR message LIKE ${sqlLiteral(`${seed.suite}%`)};
DELETE FROM payment_provider_batch_transactions
WHERE provider_transaction_id LIKE ${sqlLiteral(`${seed.suite}%`)}
   OR provider_batch_id LIKE ${sqlLiteral(`${seed.suite}%`)};
DELETE FROM payment_provider_batches WHERE provider_batch_id LIKE ${sqlLiteral(`${seed.suite}%`)};
DELETE FROM payment_transactions
WHERE metadata->>'e2e_suite' = ${sqlLiteral(seed.suite)}
   OR provider_transaction_id LIKE ${sqlLiteral(`${seed.suite}%`)};
DELETE FROM payment_settlement_runs WHERE id = ${sqlLiteral(seed.runId)};

INSERT INTO payment_settlement_runs (id, provider, scope, status, summary)
VALUES (${sqlLiteral(seed.runId)}, 'helcim', 'batch_sync', 'completed', '{"e2e": true}'::jsonb);

INSERT INTO payment_provider_batches (
  id, provider, provider_batch_id, status, currency, closed_at, settled_at,
  expected_deposit_at, gross_amount, fee_amount, net_amount, transaction_count, raw_payload
) VALUES
  (
    ${sqlLiteral(seed.batchA)}, 'helcim', ${sqlLiteral(`${seed.suite}-batch-a`)}, 'settled',
    'USD', now() - interval '2 days', now() - interval '1 day', now(),
    62.00, 2.00, 60.00, 2, jsonb_build_object('e2e_suite', ${sqlLiteral(seed.suite)})
  ),
  (
    ${sqlLiteral(seed.batchB)}, 'helcim', ${sqlLiteral(`${seed.suite}-batch-b`)}, 'settled',
    'USD', now() - interval '2 days', now() - interval '1 day', now(),
    41.50, 1.50, 40.00, 2, jsonb_build_object('e2e_suite', ${sqlLiteral(seed.suite)})
  );

INSERT INTO payment_transactions (
  id, payment_method, amount, metadata, status, merchant_fee, net_amount,
  payment_provider, provider_transaction_id, provider_payment_id, provider_status, created_at, occurred_at
) VALUES
  (
    ${sqlLiteral(seed.paymentLink)}, 'card', 100.00,
    jsonb_build_object('e2e_suite', ${sqlLiteral(seed.suite)}, 'helcim_fee_sync_status', 'not_ready', 'helcim_net_sync_status', 'not_ready'),
    'success', 0.00, 0.00, 'helcim', NULL, ${sqlLiteral(`${seed.suite}-payment-link`)}, 'approved', now(), now()
  ),
  (
    ${sqlLiteral(seed.paymentNonHelcim)}, 'cash', 100.00,
    jsonb_build_object('e2e_suite', ${sqlLiteral(seed.suite)}),
    'success', 0.00, 0.00, NULL, NULL, NULL, NULL, now(), now()
  ),
  (
    ${sqlLiteral(seed.paymentMismatch)}, 'card', 101.00,
    jsonb_build_object('e2e_suite', ${sqlLiteral(seed.suite)}, 'helcim_fee_sync_status', 'not_ready', 'helcim_net_sync_status', 'not_ready'),
    'success', 0.00, 0.00, 'helcim', NULL, ${sqlLiteral(`${seed.suite}-payment-mismatch`)}, 'approved', now(), now()
  ),
  (
    ${sqlLiteral(seed.paymentConflict)}, 'card', 100.00,
    jsonb_build_object('e2e_suite', ${sqlLiteral(seed.suite)}, 'helcim_fee_sync_status', 'not_ready', 'helcim_net_sync_status', 'not_ready'),
    'success', 0.00, 0.00, 'helcim', ${sqlLiteral(`${seed.suite}-other-provider-tx`)}, ${sqlLiteral(`${seed.suite}-payment-conflict`)}, 'approved', now(), now()
  ),
  (
    ${sqlLiteral(seed.paymentAlreadyLinked)}, 'card', 100.00,
    jsonb_build_object('e2e_suite', ${sqlLiteral(seed.suite)}, 'helcim_fee_sync_status', 'not_ready', 'helcim_net_sync_status', 'not_ready'),
    'success', 0.00, 0.00, 'helcim', NULL, ${sqlLiteral(`${seed.suite}-payment-linked`)}, 'approved', now(), now()
  );

INSERT INTO payment_provider_batch_transactions (
  provider, provider_batch_id, provider_transaction_id, payment_provider_batch_id,
  payment_transaction_id, transaction_type, status, currency, occurred_at, settled_at,
  gross_amount, fee_amount, net_amount, match_status, match_type, raw_payload
) VALUES
  (
    'helcim', ${sqlLiteral(`${seed.suite}-batch-a`)}, ${sqlLiteral(seed.txLink)}, ${sqlLiteral(seed.batchA)},
    NULL, 'purchase', 'approved', 'USD', now(), now(), 100.00, NULL, NULL,
    'unmatched', NULL, jsonb_build_object('e2e_suite', ${sqlLiteral(seed.suite)})
  ),
  (
    'helcim', ${sqlLiteral(`${seed.suite}-batch-a`)}, ${sqlLiteral(seed.txNonHelcim)}, ${sqlLiteral(seed.batchA)},
    NULL, 'purchase', 'approved', 'USD', now(), now(), 100.00, NULL, NULL,
    'unmatched', NULL, jsonb_build_object('e2e_suite', ${sqlLiteral(seed.suite)})
  ),
  (
    'helcim', ${sqlLiteral(`${seed.suite}-batch-a`)}, ${sqlLiteral(seed.txMismatch)}, ${sqlLiteral(seed.batchA)},
    NULL, 'purchase', 'approved', 'USD', now(), now(), 100.00, NULL, NULL,
    'unmatched', NULL, jsonb_build_object('e2e_suite', ${sqlLiteral(seed.suite)})
  ),
  (
    'helcim', ${sqlLiteral(`${seed.suite}-batch-a`)}, ${sqlLiteral(seed.txConflict)}, ${sqlLiteral(seed.batchA)},
    ${sqlLiteral(seed.paymentAlreadyLinked)}, 'purchase', 'approved', 'USD', now(), now(), 100.00, NULL, NULL,
    'matched', 'exact_provider_transaction_id', jsonb_build_object('e2e_suite', ${sqlLiteral(seed.suite)})
  );

INSERT INTO payment_settlement_items (
  id, run_id, provider, item_type, severity, status, provider_batch_id,
  provider_transaction_id, payment_transaction_id, payment_provider_batch_id,
  processor_values, ros_values, message
) VALUES
  (
    ${sqlLiteral(seed.itemReview)}, ${sqlLiteral(seed.runId)}, 'helcim', 'amount_mismatch',
    'warning', 'open', ${sqlLiteral(`${seed.suite}-batch-a`)}, NULL, NULL, ${sqlLiteral(seed.batchA)},
    jsonb_build_object('amount', '25.00', 'provider_batch_id', ${sqlLiteral(`${seed.suite}-batch-a`)}),
    jsonb_build_object('amount', '20.00'),
    ${sqlLiteral(`${seed.suite} review transition issue`)}
  ),
  (
    ${sqlLiteral(seed.itemLink)}, ${sqlLiteral(seed.runId)}, 'helcim', 'processor_missing_ros_payment',
    'critical', 'open', ${sqlLiteral(`${seed.suite}-batch-a`)}, ${sqlLiteral(seed.txLink)}, NULL, ${sqlLiteral(seed.batchA)},
    jsonb_build_object('amount', '100.00', 'provider_transaction_id', ${sqlLiteral(seed.txLink)}),
    '{}'::jsonb,
    ${sqlLiteral(`${seed.suite} link success issue`)}
  ),
  (
    ${sqlLiteral(seed.itemNonHelcim)}, ${sqlLiteral(seed.runId)}, 'helcim', 'processor_missing_ros_payment',
    'critical', 'open', ${sqlLiteral(`${seed.suite}-batch-a`)}, ${sqlLiteral(seed.txNonHelcim)}, NULL, ${sqlLiteral(seed.batchA)},
    jsonb_build_object('amount', '100.00', 'provider_transaction_id', ${sqlLiteral(seed.txNonHelcim)}),
    '{}'::jsonb,
    ${sqlLiteral(`${seed.suite} non helcim reject issue`)}
  ),
  (
    ${sqlLiteral(seed.itemMismatch)}, ${sqlLiteral(seed.runId)}, 'helcim', 'processor_missing_ros_payment',
    'critical', 'open', ${sqlLiteral(`${seed.suite}-batch-a`)}, ${sqlLiteral(seed.txMismatch)}, NULL, ${sqlLiteral(seed.batchA)},
    jsonb_build_object('amount', '100.00', 'provider_transaction_id', ${sqlLiteral(seed.txMismatch)}),
    '{}'::jsonb,
    ${sqlLiteral(`${seed.suite} amount mismatch reject issue`)}
  ),
  (
    ${sqlLiteral(seed.itemConflict)}, ${sqlLiteral(seed.runId)}, 'helcim', 'processor_missing_ros_payment',
    'critical', 'open', ${sqlLiteral(`${seed.suite}-batch-a`)}, ${sqlLiteral(seed.txConflict)}, NULL, ${sqlLiteral(seed.batchA)},
    jsonb_build_object('amount', '100.00', 'provider_transaction_id', ${sqlLiteral(seed.txConflict)}),
    '{}'::jsonb,
    ${sqlLiteral(`${seed.suite} linked conflict reject issue`)}
  );

COMMIT;
`;
}

async function getJson<T>(
  request: APIRequestContext,
  path: string,
): Promise<T> {
  const res = await request.get(`${apiBase()}${path}`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as T;
}

async function sendJson<T>(
  request: APIRequestContext,
  method: "post" | "patch",
  path: string,
  data: Record<string, unknown>,
  expectedStatus = 200,
): Promise<T> {
  const options = {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    data,
    failOnStatusCode: false,
  };
  const res =
    method === "post"
      ? await request.post(`${apiBase()}${path}`, options)
      : await request.patch(`${apiBase()}${path}`, options);
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(expectedStatus);
  return bodyText ? (JSON.parse(bodyText) as T) : ({} as T);
}

type Overview = {
  card_sales_gross: string;
  known_fees: string | null;
  known_net: string | null;
  expected_deposit_from_batches: string | null;
  fee_not_ready_count: number;
  net_not_ready_count: number;
};

type BatchRow = {
  id: string;
  provider_batch_id: string;
  net_amount: string | null;
  fee_amount: string | null;
};

type ReconciliationItem = {
  id: string;
  status: string;
  issue_label: string;
  severity: string;
  payment_transaction_id: string | null;
  reviewed_at: string | null;
  resolved_at: string | null;
  resolution_type: string | null;
  resolution_note: string | null;
  events: Array<{ action: string; note: string | null }>;
};

type ReconciliationAction = {
  item: ReconciliationItem;
};

type CandidatePayment = {
  payment_transaction_id: string;
  amount: string;
  warning_flags: string[];
};

type DepositAction = {
  deposit: DepositDetail;
};

type DepositDetail = {
  deposit: {
    id: string;
    amount: string;
    expected_amount: string | null;
    difference: string | null;
    status: string;
    qbo_deposit_id: string | null;
  };
  linked_batches: Array<{ payment_provider_batch_id: string; expected_net_amount: string | null }>;
  events: Array<{ action: string; note: string | null }>;
  issues: Array<{ item_type: string; status: string; amount: string | null }>;
};

test.describe.serial("Payments Operations backend contract", () => {
  test.beforeAll(async ({ request }) => {
    ids = makeIds();
    try {
      const res = await request.get(`${apiBase()}/api/staff/list-for-pos`, {
        timeout: 8000,
        failOnStatusCode: false,
      });
      serverReachable = res.status() > 0;
    } catch {
      serverReachable = false;
    }
    if (!serverReachable) return;

    try {
      runSql(seedSql(ids));
      seeded = true;
    } catch (error) {
      seedError = error instanceof Error ? error.message : String(error);
      seeded = false;
    }
  });

  test.beforeEach(() => {
    requireOrSkip(
      serverReachable,
      `API not reachable at ${apiBase()} - start Postgres + riverside-server to run payments operations contract`,
    );
    requireOrSkip(
      seeded,
      `Payments Operations seed unavailable via psql (${databaseUrl()}): ${seedError || "unknown error"}`,
    );
  });

  test("read endpoints expose staff-safe operations shapes without inferred fee or net", async ({
    request,
  }) => {
    const today = new Date().toISOString().slice(0, 10);
    const overview = await getJson<Overview>(
      request,
      `/api/payments/providers/helcim/operations/overview?date_from=${today}&date_to=${today}`,
    );
    expect(typeof overview.card_sales_gross).toBe("string");
    expect(overview.known_fees === null || typeof overview.known_fees === "string").toBeTruthy();
    expect(overview.known_net === null || typeof overview.known_net === "string").toBeTruthy();
    expect(overview.expected_deposit_from_batches === null || typeof overview.expected_deposit_from_batches === "string").toBeTruthy();
    expect(typeof overview.fee_not_ready_count).toBe("number");
    expect(typeof overview.net_not_ready_count).toBe("number");

    const batches = await getJson<BatchRow[]>(
      request,
      `/api/payments/providers/helcim/batches?search=${encodeURIComponent(ids.suite)}&limit=20`,
    );
    const batchA = batches.find((batch) => batch.id === ids.batchA);
    expect(batchA).toBeTruthy();
    expect(batchA?.fee_amount).toBe("2.00");
    expect(batchA?.net_amount).toBe("60.00");

    const batchDetail = await getJson<{ batch: BatchRow; critical_issue_count: number }>(
      request,
      `/api/payments/providers/helcim/batches/${ids.batchA}`,
    );
    expect(batchDetail.batch.id).toBe(ids.batchA);
    expect(typeof batchDetail.critical_issue_count).toBe("number");

    const batchTransactions = await getJson<Array<{ provider_transaction_id: string; fee_amount: string | null; net_amount: string | null }>>(
      request,
      `/api/payments/providers/helcim/batches/${ids.batchA}/transactions`,
    );
    const linkTx = batchTransactions.find((row) => row.provider_transaction_id === ids.txLink);
    expect(linkTx).toBeTruthy();
    expect(linkTx?.fee_amount).toBeNull();
    expect(linkTx?.net_amount).toBeNull();

    const transactions = await getJson<Array<{ payment_transaction_id: string; fee_amount: string | null; net_amount: string | null; fee_status: string; net_status: string }>>(
      request,
      `/api/payments/providers/helcim/transactions?search=${encodeURIComponent(ids.suite)}&limit=20`,
    );
    const payment = transactions.find((row) => row.payment_transaction_id === ids.paymentLink);
    expect(payment).toBeTruthy();
    expect(payment?.fee_status).toBe("not_ready");
    expect(payment?.net_status).toBe("not_ready");
    expect(payment?.fee_amount).toBeNull();
    expect(payment?.net_amount).toBeNull();

    const transactionDetail = await getJson<{ riverside_payment: { id: string }; fee_details: { fee_amount: string | null; net_amount: string | null }; timeline: Array<{ label: string }> }>(
      request,
      `/api/payments/providers/helcim/transactions/${ids.paymentLink}`,
    );
    expect(transactionDetail.riverside_payment.id).toBe(ids.paymentLink);
    expect(transactionDetail.fee_details.fee_amount).toBeNull();
    expect(transactionDetail.fee_details.net_amount).toBeNull();
    expect(transactionDetail.timeline.map((row) => row.label).join(" ")).not.toMatch(/webhook|payload|idempotency/i);

    const health = await getJson<Record<string, unknown>>(
      request,
      "/api/payments/providers/helcim/events/health",
    );
    expect(health).toHaveProperty("recent_event_count");
    expect(health).not.toHaveProperty("payload_json");

    const runs = await getJson<Array<{ id: string; status: string }>>(
      request,
      "/api/payments/providers/helcim/sync/runs?limit=20",
    );
    expect(runs.some((run) => run.id === ids.runId && run.status === "completed")).toBeTruthy();
  });

  test("reconciliation status and note actions preserve audit history", async ({
    request,
  }) => {
    const reviewed = await sendJson<ReconciliationAction>(
      request,
      "patch",
      `/api/payments/providers/helcim/reconciliation/items/${ids.itemReview}/status`,
      { action: "reviewed" },
    );
    expect(reviewed.item.status).toBe("open");
    expect(reviewed.item.reviewed_at).toBeTruthy();
    expect(reviewed.item.events.some((event) => event.action === "reviewed")).toBeTruthy();

    const noted = await sendJson<ReconciliationAction>(
      request,
      "post",
      `/api/payments/providers/helcim/reconciliation/items/${ids.itemReview}/notes`,
      { note: "E2E note only" },
    );
    expect(noted.item.status).toBe("open");
    expect(noted.item.events.some((event) => event.action === "noted" && event.note === "E2E note only")).toBeTruthy();

    const resolved = await sendJson<ReconciliationAction>(
      request,
      "patch",
      `/api/payments/providers/helcim/reconciliation/items/${ids.itemReview}/status`,
      { action: "resolved", resolution_type: "resolved", note: "E2E resolved" },
    );
    expect(resolved.item.status).toBe("resolved");
    expect(resolved.item.resolved_at).toBeTruthy();
    expect(resolved.item.resolution_note).toBe("E2E resolved");

    const reopened = await sendJson<ReconciliationAction>(
      request,
      "patch",
      `/api/payments/providers/helcim/reconciliation/items/${ids.itemReview}/status`,
      { action: "reopened" },
    );
    expect(reopened.item.status).toBe("open");
    expect(reopened.item.resolved_at).toBeNull();
    expect(reopened.item.events.some((event) => event.action === "reopened")).toBeTruthy();

    await sendJson<Record<string, unknown>>(
      request,
      "patch",
      `/api/payments/providers/helcim/reconciliation/items/${ids.itemReview}/status`,
      { action: "ignored" },
      400,
    );

    const ignored = await sendJson<ReconciliationAction>(
      request,
      "patch",
      `/api/payments/providers/helcim/reconciliation/items/${ids.itemReview}/status`,
      { action: "ignored", resolution_type: "expected", note: "E2E expected variance" },
    );
    expect(ignored.item.status).toBe("ignored");
    expect(ignored.item.resolution_type).toBe("expected");
    expect(ignored.item.events.some((event) => event.action === "ignored")).toBeTruthy();
  });

  test("guarded payment linking accepts only safe Helcim matches", async ({ request }) => {
    const candidates = await getJson<CandidatePayment[]>(
      request,
      `/api/payments/providers/helcim/reconciliation/items/${ids.itemLink}/candidate-payments`,
    );
    const candidate = candidates.find((row) => row.payment_transaction_id === ids.paymentLink);
    expect(candidate).toBeTruthy();
    expect(candidate?.warning_flags).toEqual([]);

    await sendJson<Record<string, unknown>>(
      request,
      "post",
      `/api/payments/providers/helcim/reconciliation/items/${ids.itemNonHelcim}/link-payment`,
      { payment_transaction_id: ids.paymentNonHelcim, note: "E2E non-Helcim reject" },
      400,
    );

    await sendJson<Record<string, unknown>>(
      request,
      "post",
      `/api/payments/providers/helcim/reconciliation/items/${ids.itemMismatch}/link-payment`,
      { payment_transaction_id: ids.paymentMismatch, note: "E2E amount mismatch reject" },
      400,
    );

    await sendJson<Record<string, unknown>>(
      request,
      "post",
      `/api/payments/providers/helcim/reconciliation/items/${ids.itemConflict}/link-payment`,
      { payment_transaction_id: ids.paymentLink, note: "E2E linked conflict reject" },
      409,
    );

    const linked = await sendJson<ReconciliationAction>(
      request,
      "post",
      `/api/payments/providers/helcim/reconciliation/items/${ids.itemLink}/link-payment`,
      { payment_transaction_id: ids.paymentLink, note: "E2E link payment" },
    );
    expect(linked.item.status).toBe("resolved");
    expect(linked.item.payment_transaction_id).toBe(ids.paymentLink);
    expect(linked.item.events.some((event) => event.action === "linked_payment")).toBeTruthy();

    expect(
      selectScalar(`
        SELECT amount::text || '|' || COALESCE(provider_transaction_id, '')
        FROM payment_transactions
        WHERE id = ${sqlLiteral(ids.paymentLink)}
      `),
    ).toBe(`100.00|${ids.txLink}`);
    expect(
      selectScalar(`
        SELECT COALESCE(payment_transaction_id::text, '') || '|' || match_status || '|' || COALESCE(match_type, '')
        FROM payment_provider_batch_transactions
        WHERE provider_transaction_id = ${sqlLiteral(ids.txLink)}
      `),
    ).toBe(`${ids.paymentLink}|matched|manual_staff_link`);
  });

  test("actual deposit workflow links expected batches without mutating money fields", async ({
    request,
  }) => {
    const beforeBatchMoney = selectScalar(`
      SELECT string_agg(provider_batch_id || ':' || gross_amount::text || ':' || COALESCE(fee_amount::text, '') || ':' || COALESCE(net_amount::text, ''), ',' ORDER BY provider_batch_id)
      FROM payment_provider_batches
      WHERE id IN (${sqlLiteral(ids.batchA)}, ${sqlLiteral(ids.batchB)})
    `);
    const beforePaymentMoney = selectScalar(`
      SELECT amount::text || '|' || merchant_fee::text || '|' || net_amount::text
      FROM payment_transactions
      WHERE id = ${sqlLiteral(ids.paymentMismatch)}
    `);

    const sourceReference = `${ids.suite}-manual-deposit`;
    const created = await sendJson<DepositAction>(
      request,
      "post",
      "/api/payments/providers/helcim/deposits",
      {
        posted_at: new Date().toISOString(),
        amount: "105.00",
        source_reference: sourceReference,
        note: "E2E created actual bank deposit",
      },
    );
    const depositId = created.deposit.deposit.id;
    expect(created.deposit.deposit.amount).toBe("105.00");
    expect(created.deposit.deposit.expected_amount).toBeNull();
    expect(created.deposit.deposit.qbo_deposit_id).toBeNull();
    expect(created.deposit.events.some((event) => event.action === "created")).toBeTruthy();

    const linked = await sendJson<DepositAction>(
      request,
      "post",
      `/api/payments/providers/helcim/deposits/${depositId}/link-batches`,
      {
        batch_ids: [ids.batchA, ids.batchB],
        note: "E2E link expected batches",
      },
    );
    expect(linked.deposit.linked_batches).toHaveLength(2);
    expect(linked.deposit.deposit.expected_amount).toBe("100.00");
    expect(linked.deposit.deposit.difference).toBe("5.00");
    expect(linked.deposit.deposit.status).toBe("needs_review");
    expect(linked.deposit.issues.some((issue) => issue.item_type === "deposit_amount_mismatch" && issue.status === "open")).toBeTruthy();

    const noted = await sendJson<DepositAction>(
      request,
      "post",
      `/api/payments/providers/helcim/deposits/${depositId}/notes`,
      { note: "E2E deposit note" },
    );
    expect(noted.deposit.events.some((event) => event.action === "noted" && event.note === "E2E deposit note")).toBeTruthy();

    const reviewed = await sendJson<DepositAction>(
      request,
      "patch",
      `/api/payments/providers/helcim/deposits/${depositId}/review`,
      { note: "E2E reviewed" },
    );
    expect(reviewed.deposit.deposit.status).toBe("needs_review");
    expect(reviewed.deposit.events.some((event) => event.action === "reviewed")).toBeTruthy();

    await sendJson<Record<string, unknown>>(
      request,
      "patch",
      `/api/payments/providers/helcim/deposits/${depositId}/review`,
      { accept_variance: true },
      400,
    );

    const reopened = await sendJson<DepositAction>(
      request,
      "post",
      `/api/payments/providers/helcim/deposits/${depositId}/reopen`,
      {},
    );
    expect(reopened.deposit.deposit.status).toBe("reopened");
    expect(reopened.deposit.events.some((event) => event.action === "reopened")).toBeTruthy();

    const detail = await getJson<DepositDetail>(
      request,
      `/api/payments/providers/helcim/deposits/${depositId}`,
    );
    expect(detail.deposit.qbo_deposit_id).toBeNull();
    expect(detail.events.map((event) => event.action)).toEqual(
      expect.arrayContaining(["created", "linked_batch", "noted", "reviewed", "reopened"]),
    );

    expect(
      selectScalar(`
        SELECT string_agg(provider_batch_id || ':' || gross_amount::text || ':' || COALESCE(fee_amount::text, '') || ':' || COALESCE(net_amount::text, ''), ',' ORDER BY provider_batch_id)
        FROM payment_provider_batches
        WHERE id IN (${sqlLiteral(ids.batchA)}, ${sqlLiteral(ids.batchB)})
      `),
    ).toBe(beforeBatchMoney);
    expect(
      selectScalar(`
        SELECT amount::text || '|' || merchant_fee::text || '|' || net_amount::text
        FROM payment_transactions
        WHERE id = ${sqlLiteral(ids.paymentMismatch)}
      `),
    ).toBe(beforePaymentMoney);
  });
});
