import { execFileSync } from "node:child_process";
import { expect, test, type APIResponse } from "@playwright/test";
import { resetOpenRegisterSessions } from "./helpers/rmsCharge";

function apiBase(): string {
  const raw =
    process.env.E2E_API_BASE?.trim() ||
    process.env.VITE_API_BASE?.trim() ||
    "http://127.0.0.1:43300";
  return raw.replace(/\/$/, "");
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

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runSql(sql: string): string {
  return execFileSync(
    "psql",
    ["-v", "ON_ERROR_STOP=1", "-q", "-At", "-f", "-", databaseUrl()],
    {
      encoding: "utf8",
      input: sql,
      stdio: ["pipe", "pipe", "pipe"],
    },
  ).trim();
}

function e2eAdminCode(): string {
  return process.env.E2E_BO_STAFF_CODE?.trim() || "1234";
}

function adminHeaders(): Record<string, string> {
  const code = e2eAdminCode();
  return {
    "x-riverside-staff-code": code,
    "x-riverside-staff-pin": code,
  };
}

const isCi = process.env.CI === "true" || process.env.CI === "1";

function requireOrSkip(condition: boolean, message: string): void {
  if (condition) return;
  if (isCi) {
    expect(condition, message).toBeTruthy();
    return;
  }
  test.skip(true, message);
}

function parseMoneyToCents(value: string | number): number {
  const normalized =
    typeof value === "number" ? value.toFixed(2) : String(value).trim();
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [wholeRaw, fracRaw = ""] = unsigned.split(".");
  const whole = Number.parseInt(wholeRaw || "0", 10);
  const frac = Number.parseInt((fracRaw + "00").slice(0, 2), 10);
  const cents = whole * 100 + frac;
  return negative ? -cents : cents;
}

function centsToFixed2(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole}.${frac}`;
}

type OpenSessionResponse = {
  session_id: string;
  pos_api_token?: string | null;
};

type OpenSessionRow = {
  session_id: string;
  register_lane: number;
  till_close_group_id: string;
  lifecycle_status: string;
};

type VerifyCashierResponse = {
  staff_id: string;
};

type ProductCreateResponse = {
  id: string;
};

type ProductVariantRow = {
  id: string;
};

async function ensureVendorId(
  request: Parameters<typeof test>[0]["request"],
  suffix: string,
): Promise<string> {
  const existingRes = await request.get(`${apiBase()}/api/vendors`, {
    headers: adminHeaders(),
    failOnStatusCode: false,
  });
  expect(existingRes.status()).toBe(200);
  const existing = (await existingRes.json()) as Array<{ id: string }>;
  if (existing[0]?.id) {
    return existing[0].id;
  }

  const createRes = await request.post(`${apiBase()}/api/vendors`, {
    headers: {
      ...adminHeaders(),
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      name: `E2E Register Vendor ${suffix}`,
      vendor_code: `REG-${suffix}`,
    },
    failOnStatusCode: false,
  });
  expect(createRes.status()).toBe(200);
  const created = (await createRes.json()) as { id: string };
  expect(created.id).toBeTruthy();
  return created.id;
}

type CheckoutResponse = {
  transaction_id: string;
};

type HelcimAttemptResponse = {
  id: string;
  status: string;
  amount_cents: number;
  provider_payment_id?: string | null;
  provider_transaction_id?: string | null;
  selected_terminal_key?: string | null;
  checkoutClientId: string;
};

type TransactionDetailResponse = {
  total_price: string;
  items: Array<{
    unit_price: string;
    transaction_line_id: string;
    quantity: number;
    quantity_returned: number;
  }>;
};

type ReconciliationResponse = {
  expected_cash: string;
  physical_expected_cash: string;
  qbo_activity_date: string;
  pending_business_dates: string[];
  unresolved_close_issues: UnresolvedCloseIssues | null;
  unresolved_helcim_attempts: Array<{
    id: string;
    review_reason: string;
  }>;
};

async function assignTransactionDate(
  request: Parameters<typeof test>[0]["request"],
  transactionId: string,
  activityDate: string,
): Promise<void> {
  const response = await request.post(
    `${apiBase()}/api/test-support/qbo/assign-transaction-date`,
    {
      headers: {
        ...adminHeaders(),
        "Content-Type": "application/json",
        "x-riverside-station-key": "station-e2e",
      },
      data: { transaction_id: transactionId, activity_date: activityDate },
      failOnStatusCode: false,
    },
  );
  const bodyText = await response.text();
  expect(response.status(), bodyText.slice(0, 1000)).toBe(200);
}

function addIsoDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

type RegisterSessionHistoryRow = {
  id: string;
  register_lane: number;
  total_sales: string;
  z_report_json?: {
    session_id?: string;
    unresolved_close_issues?: UnresolvedCloseIssues | null;
  } | null;
};

type UnresolvedCloseIssues = {
  recovery_job_keys: string[];
  recovery_jobs: Array<{
    client_job_key: string;
    kind: string;
    status: string;
    register_session_id: string | null;
    transaction_id: string | null;
    checkout_client_id: string | null;
    station_key: string | null;
    label: string | null;
    last_error: string | null;
    attempt_count: number;
    first_seen_at: string;
    last_seen_at: string;
  }>;
  station_warnings: string[];
  helcim_attempts: Array<{
    id: string;
    review_reason: string;
  }>;
};

type CloseSessionResponse = {
  status: string;
  till_group_closed: boolean;
  unresolved_close_issues: UnresolvedCloseIssues | null;
  reconciliation: ReconciliationResponse;
  z_report_snapshot: {
    unresolved_close_issues: UnresolvedCloseIssues | null;
  };
};

let serverReachable = false;

test.beforeAll(async ({ request }) => {
  try {
    const res = await request.get(`${apiBase()}/api/staff/list-for-pos`, {
      timeout: 8000,
      failOnStatusCode: false,
    });
    serverReachable = res.status() > 0;
  } catch {
    serverReachable = false;
  }
});

test.beforeEach(() => {
  requireOrSkip(
    serverReachable,
    `API not reachable at ${apiBase()} — start Postgres + server to run register-close-reconciliation`,
  );
});

async function verifyAdminStaffId(
  request: Parameters<typeof test>[0]["request"],
): Promise<string> {
  const res = await request.post(`${apiBase()}/api/staff/verify-cashier-code`, {
    headers: { "Content-Type": "application/json" },
    data: {
      cashier_code: e2eAdminCode(),
      pin: e2eAdminCode(),
    },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as VerifyCashierResponse;
  expect(body.staff_id).toBeTruthy();
  return body.staff_id;
}

async function listOpenSessions(
  request: Parameters<typeof test>[0]["request"],
): Promise<OpenSessionRow[]> {
  const res = await request.get(`${apiBase()}/api/sessions/list-open`, {
    headers: adminHeaders(),
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as OpenSessionRow[];
}

async function issuePosToken(
  request: Parameters<typeof test>[0]["request"],
  sessionId: string,
): Promise<string> {
  const res = await request.post(
    `${apiBase()}/api/sessions/${sessionId}/pos-api-token`,
    {
      headers: {
        ...adminHeaders(),
        "Content-Type": "application/json",
        "x-riverside-station-key": "station-e2e",
      },
      data: {
        cashier_code: e2eAdminCode(),
        pin: e2eAdminCode(),
      },
      failOnStatusCode: false,
    },
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { pos_api_token?: string };
  expect(body.pos_api_token).toBeTruthy();
  return body.pos_api_token ?? "";
}

async function fetchReconciliation(
  request: Parameters<typeof test>[0]["request"],
  sessionId: string,
  sessionToken: string,
): Promise<ReconciliationResponse> {
  const res = await request.get(
    `${apiBase()}/api/sessions/${sessionId}/reconciliation`,
    {
      headers: {
        "x-riverside-pos-session-id": sessionId,
        "x-riverside-pos-session-token": sessionToken,
        "x-riverside-station-key": "station-e2e",
      },
      failOnStatusCode: false,
    },
  );
  expect(res.status()).toBe(200);
  return (await res.json()) as ReconciliationResponse;
}

async function beginReconcile(
  request: Parameters<typeof test>[0]["request"],
  sessionId: string,
): Promise<void> {
  const res = await request.post(
    `${apiBase()}/api/sessions/${sessionId}/begin-reconcile`,
    {
      headers: {
        ...adminHeaders(),
        "Content-Type": "application/json",
        "x-riverside-station-key": "station-e2e",
      },
      data: {
        active: true,
      },
      failOnStatusCode: false,
    },
  );
  expect(res.status()).toBe(200);
}

async function prepareGroupForClose(
  request: Parameters<typeof test>[0]["request"],
  primarySessionId: string,
  primarySessionToken: string,
): Promise<void> {
  await beginReconcile(request, primarySessionId);
  const rows = await listOpenSessions(request);
  const primary = rows.find((row) => row.session_id === primarySessionId);
  expect(primary).toBeTruthy();
  const group = rows.filter(
    (row) => row.till_close_group_id === primary?.till_close_group_id,
  );
  for (const session of group) {
    const token =
      session.session_id === primarySessionId
        ? primarySessionToken
        : await issuePosToken(request, session.session_id);
    const acknowledgement = await request.post(
      `${apiBase()}/api/recovery/station-close-status`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-riverside-pos-session-id": session.session_id,
          "x-riverside-pos-session-token": token,
          "x-riverside-station-key": "station-e2e",
        },
        data: {
          pending_checkout_count: 0,
          blocked_checkout_count: 0,
        },
        failOnStatusCode: false,
      },
    );
    const acknowledgementText = await acknowledgement.text();
    expect(acknowledgement.status(), acknowledgementText.slice(0, 1000)).toBe(
      200,
    );
  }
}

async function closeRegisterGroup(
  request: Parameters<typeof test>[0]["request"],
  sessionId: string,
  sessionToken: string,
): Promise<CloseSessionResponse> {
  await prepareGroupForClose(request, sessionId, sessionToken);
  const recon = await fetchReconciliation(request, sessionId, sessionToken);
  const res = await request.post(
    `${apiBase()}/api/sessions/${sessionId}/close`,
    {
      headers: {
        "Content-Type": "application/json",
        "x-riverside-pos-session-id": sessionId,
        "x-riverside-pos-session-token": sessionToken,
        "x-riverside-station-key": "station-e2e",
      },
      data: {
        actual_cash: recon.expected_cash,
        closing_notes: "E2E exact-cash cleanup close",
        closing_comments: null,
      },
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as CloseSessionResponse;
}

async function startHelcimPurchaseOrSkip(
  request: Parameters<typeof test>[0]["request"],
  sessionId: string,
  sessionToken: string,
  amountCents: number,
): Promise<HelcimAttemptResponse> {
  const checkoutClientId = crypto.randomUUID();
  const res = await request.post(
    `${apiBase()}/api/payments/providers/helcim/purchase`,
    {
      headers: {
        "Content-Type": "application/json",
        "x-riverside-pos-session-id": sessionId,
        "x-riverside-pos-session-token": sessionToken,
        "x-riverside-station-key": "station-e2e",
      },
      data: {
        amount_cents: amountCents,
        currency: "usd",
        selected_terminal_key: "terminal_1",
        checkout_client_id: checkoutClientId,
      },
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  if (res.status() !== 200) {
    test.skip(
      true,
      `Helcim simulator is not available for this environment: ${bodyText.slice(0, 300)}`,
    );
  }
  const attempt = {
    ...(JSON.parse(bodyText) as Omit<
      HelcimAttemptResponse,
      "checkoutClientId"
    >),
    checkoutClientId,
  };
  expect(attempt.id).toBeTruthy();
  expect(attempt.status).toBe("pending");
  return attempt;
}

async function simulateHelcimAttempt(
  request: Parameters<typeof test>[0]["request"],
  sessionId: string,
  sessionToken: string,
  attempt: HelcimAttemptResponse,
  outcome: "approve" | "decline" | "cancel",
): Promise<HelcimAttemptResponse> {
  const res = await request.post(
    `${apiBase()}/api/payments/providers/helcim/attempts/${attempt.id}/simulate`,
    {
      headers: {
        "Content-Type": "application/json",
        "x-riverside-pos-session-id": sessionId,
        "x-riverside-pos-session-token": sessionToken,
        "x-riverside-station-key": "station-e2e",
      },
      data: { outcome },
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return {
    ...(JSON.parse(bodyText) as Omit<
      HelcimAttemptResponse,
      "checkoutClientId"
    >),
    checkoutClientId: attempt.checkoutClientId,
  };
}

async function releaseHelcimAttemptAsStaff(
  request: Parameters<typeof test>[0]["request"],
  attemptId: string,
): Promise<void> {
  const res = await request.post(
    `${apiBase()}/api/payments/providers/helcim/attempts/${attemptId}/release`,
    {
      headers: adminHeaders(),
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
}

async function postCheckoutWithApprovedHelcimAttempt(
  request: Parameters<typeof test>[0]["request"],
  sessionId: string,
  sessionToken: string,
  operatorStaffId: string,
  product: { productId: string; variantId: string },
  attempt: HelcimAttemptResponse,
): Promise<APIResponse> {
  return request.post(`${apiBase()}/api/transactions/checkout`, {
    headers: {
      "Content-Type": "application/json",
      "x-riverside-pos-session-id": sessionId,
      "x-riverside-pos-session-token": sessionToken,
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      session_id: sessionId,
      operator_staff_id: operatorStaffId,
      primary_salesperson_id: operatorStaffId,
      customer_id: null,
      payment_method: "card_terminal",
      total_price: "108.75",
      amount_paid: "108.75",
      checkout_client_id: attempt.checkoutClientId,
      payment_splits: [
        {
          payment_method: "card_terminal",
          amount: "108.75",
          metadata: {
            payment_provider: "helcim",
            payment_provider_attempt_id: attempt.id,
            provider_status: attempt.status,
            provider_payment_id: attempt.provider_payment_id,
            provider_transaction_id: attempt.provider_transaction_id,
            selected_terminal_key: attempt.selected_terminal_key,
          },
        },
      ],
      items: [
        {
          product_id: product.productId,
          variant_id: product.variantId,
          fulfillment: "takeaway",
          quantity: 1,
          unit_price: "100.00",
          unit_cost: "40.00",
          state_tax: "4.00",
          local_tax: "4.75",
          salesperson_id: operatorStaffId,
        },
      ],
    },
    failOnStatusCode: false,
  });
}

async function checkoutWithApprovedHelcimAttempt(
  request: Parameters<typeof test>[0]["request"],
  sessionId: string,
  sessionToken: string,
  operatorStaffId: string,
  product: { productId: string; variantId: string },
  attempt: HelcimAttemptResponse,
): Promise<void> {
  const res = await postCheckoutWithApprovedHelcimAttempt(
    request,
    sessionId,
    sessionToken,
    operatorStaffId,
    product,
    attempt,
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
}

async function checkoutWithCash(
  request: Parameters<typeof test>[0]["request"],
  sessionId: string,
  sessionToken: string,
  operatorStaffId: string,
  product: { productId: string; variantId: string },
): Promise<CheckoutResponse> {
  const res = await request.post(`${apiBase()}/api/transactions/checkout`, {
    headers: {
      "Content-Type": "application/json",
      "x-riverside-pos-session-id": sessionId,
      "x-riverside-pos-session-token": sessionToken,
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      session_id: sessionId,
      operator_staff_id: operatorStaffId,
      primary_salesperson_id: operatorStaffId,
      customer_id: null,
      payment_method: "cash",
      total_price: "108.75",
      amount_paid: "108.75",
      checkout_client_id: crypto.randomUUID(),
      items: [
        {
          product_id: product.productId,
          variant_id: product.variantId,
          fulfillment: "takeaway",
          quantity: 1,
          unit_price: "100.00",
          unit_cost: "40.00",
          state_tax: "4.00",
          local_tax: "4.75",
          salesperson_id: operatorStaffId,
        },
      ],
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as CheckoutResponse;
}

async function fetchTransactionDetail(
  request: Parameters<typeof test>[0]["request"],
  transactionId: string,
  sessionId: string,
  sessionToken: string,
): Promise<TransactionDetailResponse> {
  const res = await request.get(
    `${apiBase()}/api/transactions/${transactionId}?register_session_id=${encodeURIComponent(sessionId)}`,
    {
      headers: {
        ...adminHeaders(),
        "x-riverside-pos-session-id": sessionId,
        "x-riverside-pos-session-token": sessionToken,
        "x-riverside-station-key": "station-e2e",
      },
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as TransactionDetailResponse;
}

async function createReturnQueue(
  request: Parameters<typeof test>[0]["request"],
  transactionId: string,
  transactionLineId: string,
  sessionId: string,
  sessionToken: string,
): Promise<void> {
  const res = await request.post(
    `${apiBase()}/api/transactions/${transactionId}/returns?register_session_id=${encodeURIComponent(sessionId)}`,
    {
      headers: {
        ...adminHeaders(),
        "Content-Type": "application/json",
        "x-riverside-pos-session-id": sessionId,
        "x-riverside-pos-session-token": sessionToken,
        "x-riverside-station-key": "station-e2e",
      },
      data: {
        lines: [
          {
            transaction_line_id: transactionLineId,
            quantity: 1,
            reason: "refund",
          },
        ],
      },
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
}

async function closeRegisterGroupWithNote(
  request: Parameters<typeof test>[0]["request"],
  sessionId: string,
  sessionToken: string,
): Promise<{ status: number; bodyText: string }> {
  await prepareGroupForClose(request, sessionId, sessionToken);
  const recon = await fetchReconciliation(request, sessionId, sessionToken);
  const res = await request.post(
    `${apiBase()}/api/sessions/${sessionId}/close`,
    {
      headers: {
        "Content-Type": "application/json",
        "x-riverside-pos-session-id": sessionId,
        "x-riverside-pos-session-token": sessionToken,
        "x-riverside-station-key": "station-e2e",
      },
      data: {
        actual_cash: recon.expected_cash,
        closing_notes: "Concurrent refund/register-close certification",
        closing_comments: null,
      },
      failOnStatusCode: false,
    },
  );
  return { status: res.status(), bodyText: await res.text() };
}

async function processCashRefund(
  request: Parameters<typeof test>[0]["request"],
  transactionId: string,
  sessionId: string,
  amount: string,
): Promise<{ status: number; bodyText: string }> {
  const res = await request.post(
    `${apiBase()}/api/transactions/${transactionId}/refunds/process`,
    {
      headers: {
        ...adminHeaders(),
        "Content-Type": "application/json",
        "x-riverside-station-key": "station-e2e",
      },
      data: {
        session_id: sessionId,
        payment_method: "cash",
        amount,
      },
      failOnStatusCode: false,
    },
  );
  return { status: res.status(), bodyText: await res.text() };
}

async function closeAnyExistingOpenGroup(
  request: Parameters<typeof test>[0]["request"],
): Promise<void> {
  await resetOpenRegisterSessions(request);
}

async function openFreshPrimarySession(
  request: Parameters<typeof test>[0]["request"],
): Promise<OpenSessionResponse> {
  const res = await request.post(`${apiBase()}/api/sessions/open`, {
    headers: {
      ...adminHeaders(),
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      cashier_code: e2eAdminCode(),
      pin: e2eAdminCode(),
      opening_float: "200.00",
      register_lane: 1,
    },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as OpenSessionResponse;
  expect(body.session_id).toBeTruthy();
  expect(body.pos_api_token).toBeTruthy();
  return body;
}

async function createDeterministicProduct(
  request: Parameters<typeof test>[0]["request"],
  actorStaffId: string,
): Promise<{ productId: string; variantId: string }> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  const categoryRes = await request.post(`${apiBase()}/api/categories`, {
    headers: {
      ...adminHeaders(),
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      name: `E2E Register Close ${suffix}`,
      parent_id: null,
      is_clothing_footwear: false,
      changed_by_staff_id: actorStaffId,
      change_note: "Created for register close reconciliation coverage",
    },
    failOnStatusCode: false,
  });
  expect(categoryRes.status()).toBe(200);
  const category = (await categoryRes.json()) as { id: string };
  const vendorId = await ensureVendorId(request, suffix);

  const createRes = await request.post(`${apiBase()}/api/products`, {
    headers: {
      ...adminHeaders(),
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      category_id: category.id,
      primary_vendor_id: vendorId,
      name: `E2E Register Close Item ${suffix}`,
      brand: "Riverside E2E",
      description: "Deterministic register close test product",
      base_retail_price: "100.00",
      base_cost: "40.00",
      variation_axes: [],
      variants: [
        {
          sku: `E2E-REG-CLOSE-${suffix}`,
          variation_values: {},
          variation_label: "One Size",
          stock_on_hand: 8,
        },
      ],
    },
    failOnStatusCode: false,
  });
  expect(createRes.status()).toBe(200);
  const created = (await createRes.json()) as ProductCreateResponse;

  const variantsRes = await request.get(
    `${apiBase()}/api/products/${created.id}/variants`,
    {
      headers: adminHeaders(),
      failOnStatusCode: false,
    },
  );
  expect(variantsRes.status()).toBe(200);
  const variants = (await variantsRes.json()) as ProductVariantRow[];
  expect(variants.length).toBeGreaterThan(0);

  return {
    productId: created.id,
    variantId: variants[0]?.id ?? "",
  };
}

test.describe("Register close / reconciliation", () => {
  test.describe.configure({ mode: "serial" });

  test("cash discrepancies over five dollars require closing notes", async ({
    request,
  }) => {
    await closeAnyExistingOpenGroup(request);

    const opened = await openFreshPrimarySession(request);
    await prepareGroupForClose(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
    );
    const recon = await fetchReconciliation(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
    );
    const expectedCents = parseMoneyToCents(recon.expected_cash);
    const shortBySix = centsToFixed2(expectedCents - 600);

    const withoutNotes = await request.post(
      `${apiBase()}/api/sessions/${opened.session_id}/close`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-riverside-pos-session-id": opened.session_id,
          "x-riverside-pos-session-token": opened.pos_api_token ?? "",
          "x-riverside-station-key": "station-e2e",
        },
        data: {
          actual_cash: shortBySix,
          closing_notes: null,
          closing_comments: null,
        },
        failOnStatusCode: false,
      },
    );
    expect(withoutNotes.status()).toBe(400);
    const withoutNotesBody = (await withoutNotes.json()) as { error?: string };
    expect(withoutNotesBody.error).toContain(
      "closing notes are required when cash is over or short by more than $5",
    );

    const withNotes = await request.post(
      `${apiBase()}/api/sessions/${opened.session_id}/close`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-riverside-pos-session-id": opened.session_id,
          "x-riverside-pos-session-token": opened.pos_api_token ?? "",
          "x-riverside-station-key": "station-e2e",
        },
        data: {
          actual_cash: shortBySix,
          closing_notes:
            "Customer cash recount found drawer short during reconciliation.",
          closing_comments: null,
        },
        failOnStatusCode: false,
      },
    );
    expect(withNotes.status()).toBe(200);
  });

  test("one Z-close keeps the Register open-period date across transaction dates", async ({
    request,
  }) => {
    await closeAnyExistingOpenGroup(request);

    const operatorStaffId = await verifyAdminStaffId(request);
    const opened = await openFreshPrimarySession(request);
    const product = await createDeterministicProduct(request, operatorStaffId);
    const firstCheckout = await checkoutWithCash(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
      operatorStaffId,
      product,
    );
    const initialReconciliation = await fetchReconciliation(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
    );
    const yesterday = addIsoDays(initialReconciliation.qbo_activity_date, -1);
    await assignTransactionDate(
      request,
      firstCheckout.transaction_id,
      yesterday,
    );
    await checkoutWithCash(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
      operatorStaffId,
      product,
    );

    await prepareGroupForClose(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
    );
    const closeReconciliation = await fetchReconciliation(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
    );
    expect(closeReconciliation.qbo_activity_date).toBe(
      initialReconciliation.qbo_activity_date,
    );
    expect(closeReconciliation.pending_business_dates).toEqual([
      initialReconciliation.qbo_activity_date,
    ]);
    const closeResponse = await request.post(
      `${apiBase()}/api/sessions/${opened.session_id}/close`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-riverside-pos-session-id": opened.session_id,
          "x-riverside-pos-session-token": opened.pos_api_token ?? "",
          "x-riverside-station-key": "station-e2e",
        },
        data: {
          actual_cash: closeReconciliation.physical_expected_cash,
          closing_notes:
            "E2E exact physical drawer count for one Register open period",
          closing_comments: null,
        },
        failOnStatusCode: false,
      },
    );
    const closeBodyText = await closeResponse.text();
    expect(
      closeResponse.status(),
      closeBodyText.slice(0, 1000),
    ).toBe(200);
    expect(JSON.parse(closeBodyText)).toMatchObject({
      status: "closed",
      business_date: initialReconciliation.qbo_activity_date,
      till_group_closed: true,
    });
    const openAfterClose = await listOpenSessions(request);
    expect(
      openAfterClose.some((row) => row.session_id === opened.session_id),
    ).toBeFalsy();
  });

  test("pending Helcim terminal attempt is captured without blocking Z-close", async ({
    request,
  }) => {
    await closeAnyExistingOpenGroup(request);

    const opened = await openFreshPrimarySession(request);
    const attempt = await startHelcimPurchaseOrSkip(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
      10875,
    );

    const pendingReview = await request.post(
      `${apiBase()}/api/sessions/${opened.session_id}/helcim-close-review/${attempt.id}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-riverside-pos-session-id": opened.session_id,
          "x-riverside-pos-session-token": opened.pos_api_token ?? "",
          "x-riverside-station-key": "station-e2e",
        },
        data: { action: "reviewed", note: null },
        failOnStatusCode: false,
      },
    );
    const pendingReviewText = await pendingReview.text();
    expect(pendingReview.status(), pendingReviewText.slice(0, 1000)).toBe(400);
    expect(pendingReviewText).toMatch(
      /pending terminal attempt cannot be marked reviewed/i,
    );

    const recon = await fetchReconciliation(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
    );
    expect(recon.unresolved_close_issues?.helcim_attempts).toContainEqual(
      expect.objectContaining({
        id: attempt.id,
        review_reason: "waiting_on_terminal",
      }),
    );
    const close = await closeRegisterGroup(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
    );
    expect(close.unresolved_close_issues?.helcim_attempts).toContainEqual(
      expect.objectContaining({
        id: attempt.id,
        review_reason: "waiting_on_terminal",
      }),
    );

    const historyRes = await request.get(
      `${apiBase()}/api/insights/register-sessions?limit=10`,
      {
        headers: adminHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(historyRes.status()).toBe(200);
    const history = (await historyRes.json()) as RegisterSessionHistoryRow[];
    const snapshot = history.find(
      (row) => row.z_report_json?.session_id === opened.session_id,
    )?.z_report_json;
    expect(snapshot?.unresolved_close_issues?.helcim_attempts).toContainEqual(
      expect.objectContaining({
        id: attempt.id,
        review_reason: "waiting_on_terminal",
      }),
    );
    await releaseHelcimAttemptAsStaff(request, attempt.id);
  });

  test("approved Helcim attempt without ROS payment is reported without blocking Z-close", async ({
    request,
  }) => {
    await closeAnyExistingOpenGroup(request);

    const opened = await openFreshPrimarySession(request);
    const pendingAttempt = await startHelcimPurchaseOrSkip(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
      10875,
    );
    const approvedAttempt = await simulateHelcimAttempt(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
      pendingAttempt,
      "approve",
    );
    expect(approvedAttempt.status).toBe("approved");

    const recon = await fetchReconciliation(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
    );
    expect(recon.unresolved_helcim_attempts).toContainEqual(
      expect.objectContaining({
        id: approvedAttempt.id,
        review_reason: "approved_not_recorded",
      }),
    );
    const review = await request.post(
      `${apiBase()}/api/sessions/${opened.session_id}/helcim-close-review/${approvedAttempt.id}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-riverside-pos-session-id": opened.session_id,
          "x-riverside-pos-session-token": opened.pos_api_token ?? "",
          "x-riverside-station-key": "station-e2e",
        },
        data: {
          action: "reviewed",
          note: "E2E review does not establish ledger attachment",
        },
        failOnStatusCode: false,
      },
    );
    const reviewText = await review.text();
    expect(review.status(), reviewText.slice(0, 1000)).toBe(200);
    const afterReview = await fetchReconciliation(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
    );
    expect(afterReview.unresolved_helcim_attempts).toContainEqual(
      expect.objectContaining({ id: approvedAttempt.id }),
    );
    const close = await closeRegisterGroup(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
    );
    expect(close.unresolved_close_issues?.helcim_attempts).toContainEqual(
      expect.objectContaining({
        id: approvedAttempt.id,
        review_reason: "approved_not_recorded",
      }),
    );

    const historyRes = await request.get(
      `${apiBase()}/api/insights/register-sessions?limit=10`,
      {
        headers: adminHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(historyRes.status()).toBe(200);
    const history = (await historyRes.json()) as RegisterSessionHistoryRow[];
    const snapshot = history.find(
      (row) => row.z_report_json?.session_id === opened.session_id,
    )?.z_report_json;
    expect(snapshot?.unresolved_close_issues?.helcim_attempts).toContainEqual(
      expect.objectContaining({ id: approvedAttempt.id }),
    );
  });

  test("matching Helcim tender without an allocation remains unresolved at Z-close", async ({
    request,
  }) => {
    await closeAnyExistingOpenGroup(request);

    const opened = await openFreshPrimarySession(request);
    const pendingAttempt = await startHelcimPurchaseOrSkip(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
      10875,
    );
    const approvedAttempt = await simulateHelcimAttempt(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
      pendingAttempt,
      "approve",
    );
    expect(approvedAttempt.status).toBe("approved");

    const unallocatedPaymentId = crypto.randomUUID();
    try {
      runSql(`
        INSERT INTO payment_transactions (
          id, session_id, category, payment_method, amount, metadata, status,
          payment_provider, provider_status
        ) VALUES (
          ${sqlLiteral(unallocatedPaymentId)}::uuid,
          ${sqlLiteral(opened.session_id)}::uuid,
          'retail_sale',
          'card_terminal',
          ${sqlLiteral((approvedAttempt.amount_cents / 100).toFixed(2))}::numeric,
          jsonb_build_object(
            'payment_provider_attempt_id', ${sqlLiteral(approvedAttempt.id)},
            'e2e_unallocated_tender', true
          ),
          'success',
          'helcim',
          'approved'
        );
      `);
    } catch (error) {
      requireOrSkip(
        false,
        `Could not seed an unallocated Helcim tender: ${String(error)}`,
      );
    }

    try {
      const recon = await fetchReconciliation(
        request,
        opened.session_id,
        opened.pos_api_token ?? "",
      );
      expect(recon.unresolved_close_issues?.helcim_attempts).toContainEqual(
        expect.objectContaining({
          id: approvedAttempt.id,
          review_reason: "approved_not_recorded",
        }),
      );

      const close = await closeRegisterGroup(
        request,
        opened.session_id,
        opened.pos_api_token ?? "",
      );
      expect(close.unresolved_close_issues?.helcim_attempts).toContainEqual(
        expect.objectContaining({
          id: approvedAttempt.id,
          review_reason: "approved_not_recorded",
        }),
      );
    } finally {
      runSql(`
        DELETE FROM payment_transactions
        WHERE id = ${sqlLiteral(unallocatedPaymentId)}::uuid;
      `);
    }
  });

  test("matching Helcim tender allocated to another checkout remains unresolved at Z-close", async ({
    request,
  }) => {
    await closeAnyExistingOpenGroup(request);

    const operatorStaffId = await verifyAdminStaffId(request);
    const opened = await openFreshPrimarySession(request);
    const product = await createDeterministicProduct(request, operatorStaffId);
    const wrongTarget = await checkoutWithCash(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
      operatorStaffId,
      product,
    );
    const pendingAttempt = await startHelcimPurchaseOrSkip(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
      10875,
    );
    const approvedAttempt = await simulateHelcimAttempt(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
      pendingAttempt,
      "approve",
    );
    expect(approvedAttempt.status).toBe("approved");

    const wrongPaymentId = crypto.randomUUID();
    try {
      runSql(`
        INSERT INTO payment_transactions (
          id, session_id, category, payment_method, amount, metadata, status,
          payment_provider, provider_status
        ) VALUES (
          ${sqlLiteral(wrongPaymentId)}::uuid,
          ${sqlLiteral(opened.session_id)}::uuid,
          'retail_sale',
          'card_terminal',
          ${sqlLiteral((approvedAttempt.amount_cents / 100).toFixed(2))}::numeric,
          jsonb_build_object(
            'payment_provider_attempt_id', ${sqlLiteral(approvedAttempt.id)},
            'e2e_wrong_checkout_tender', true
          ),
          'success',
          'helcim',
          'approved'
        );
        INSERT INTO payment_allocations (
          transaction_id, target_transaction_id, amount_allocated
        ) VALUES (
          ${sqlLiteral(wrongPaymentId)}::uuid,
          ${sqlLiteral(wrongTarget.transaction_id)}::uuid,
          ${sqlLiteral((approvedAttempt.amount_cents / 100).toFixed(2))}::numeric
        );
      `);
    } catch (error) {
      requireOrSkip(
        false,
        `Could not seed a wrong-checkout Helcim allocation: ${String(error)}`,
      );
    }

    try {
      const recon = await fetchReconciliation(
        request,
        opened.session_id,
        opened.pos_api_token ?? "",
      );
      expect(recon.unresolved_close_issues?.helcim_attempts).toContainEqual(
        expect.objectContaining({
          id: approvedAttempt.id,
          review_reason: "approved_not_recorded",
        }),
      );

      const close = await closeRegisterGroup(
        request,
        opened.session_id,
        opened.pos_api_token ?? "",
      );
      expect(close.unresolved_close_issues?.helcim_attempts).toContainEqual(
        expect.objectContaining({ id: approvedAttempt.id }),
      );
      expect(
        close.reconciliation.unresolved_close_issues?.helcim_attempts,
      ).toContainEqual(expect.objectContaining({ id: approvedAttempt.id }));
      expect(
        close.z_report_snapshot.unresolved_close_issues?.helcim_attempts,
      ).toContainEqual(expect.objectContaining({ id: approvedAttempt.id }));
    } finally {
      runSql(`
        DELETE FROM payment_allocations
        WHERE transaction_id = ${sqlLiteral(wrongPaymentId)}::uuid;
        DELETE FROM payment_transactions
        WHERE id = ${sqlLiteral(wrongPaymentId)}::uuid;
      `);
    }
  });

  test("approved Helcim attempt cannot be used twice", async ({ request }) => {
    await closeAnyExistingOpenGroup(request);

    const operatorStaffId = await verifyAdminStaffId(request);
    const opened = await openFreshPrimarySession(request);
    const product = await createDeterministicProduct(request, operatorStaffId);
    const pendingAttempt = await startHelcimPurchaseOrSkip(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
      10875,
    );
    const approvedAttempt = await simulateHelcimAttempt(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
      pendingAttempt,
      "approve",
    );

    await checkoutWithApprovedHelcimAttempt(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
      operatorStaffId,
      product,
      approvedAttempt,
    );

    const duplicateCheckout = await postCheckoutWithApprovedHelcimAttempt(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
      operatorStaffId,
      product,
      { ...approvedAttempt, checkoutClientId: crypto.randomUUID() },
    );
    const duplicateBody = await duplicateCheckout.text();
    expect(duplicateCheckout.status(), duplicateBody.slice(0, 1000)).toBe(400);
    expect(duplicateBody).toMatch(/different sale|already been used/i);

    await closeRegisterGroup(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
    );
  });

  test("concurrent refund and register close serialize on register session state", async ({
    request,
  }) => {
    await closeAnyExistingOpenGroup(request);

    const operatorStaffId = await verifyAdminStaffId(request);
    const opened = await openFreshPrimarySession(request);
    const sessionToken = opened.pos_api_token ?? "";
    const product = await createDeterministicProduct(request, operatorStaffId);
    const checkout = await checkoutWithCash(
      request,
      opened.session_id,
      sessionToken,
      operatorStaffId,
      product,
    );
    const detail = await fetchTransactionDetail(
      request,
      checkout.transaction_id,
      opened.session_id,
      sessionToken,
    );
    const line = detail.items[0];
    expect(line?.transaction_line_id).toBeTruthy();
    await createReturnQueue(
      request,
      checkout.transaction_id,
      line?.transaction_line_id ?? "",
      opened.session_id,
      sessionToken,
    );

    const closePromise = closeRegisterGroupWithNote(
      request,
      opened.session_id,
      sessionToken,
    );
    const refundPromise = processCashRefund(
      request,
      checkout.transaction_id,
      opened.session_id,
      "108.75",
    );
    const [closeResult, refundResult] = await Promise.all([
      closePromise,
      refundPromise,
    ]);

    expect(closeResult.status, closeResult.bodyText.slice(0, 1000)).toBe(200);
    if (refundResult.status !== 200) {
      expect(refundResult.bodyText).toMatch(/register session is not open/i);
    }

    const afterCloseRefund = await processCashRefund(
      request,
      checkout.transaction_id,
      opened.session_id,
      "1.00",
    );
    expect(afterCloseRefund.status).toBe(400);
    expect(afterCloseRefund.bodyText).toMatch(
      /register session is not open|no open refund/i,
    );
  });

  test("historical Z session list stays unified to Register #1 for a till-close group", async ({
    request,
  }) => {
    await closeAnyExistingOpenGroup(request);

    const operatorStaffId = await verifyAdminStaffId(request);
    const opened = await openFreshPrimarySession(request);
    const openRows = await listOpenSessions(request);
    const openGroup = openRows.filter(
      (row) => row.till_close_group_id === openRows[0]?.till_close_group_id,
    );
    expect(openGroup.map((row) => row.register_lane).sort()).toEqual([
      1, 2, 3, 4,
    ]);

    const primary = openGroup.find((row) => row.register_lane === 1);
    const satellite = openGroup.find((row) => row.register_lane === 2);
    const tertiary = openGroup.find((row) => row.register_lane === 3);
    expect(primary?.session_id).toBe(opened.session_id);
    expect(satellite?.session_id).toBeTruthy();
    expect(tertiary?.session_id).toBeTruthy();

    const lane2Token = await issuePosToken(
      request,
      satellite?.session_id ?? "",
    );
    const product = await createDeterministicProduct(request, operatorStaffId);

    const checkoutRes = await request.post(
      `${apiBase()}/api/transactions/checkout`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-riverside-pos-session-id": satellite?.session_id ?? "",
          "x-riverside-pos-session-token": lane2Token,
          "x-riverside-station-key": "station-e2e",
        },
        data: {
          session_id: satellite?.session_id,
          operator_staff_id: operatorStaffId,
          primary_salesperson_id: operatorStaffId,
          customer_id: null,
          payment_method: "cash",
          total_price: "108.75",
          amount_paid: "108.75",
          checkout_client_id: crypto.randomUUID(),
          items: [
            {
              product_id: product.productId,
              variant_id: product.variantId,
              fulfillment: "takeaway",
              quantity: 1,
              unit_price: "100.00",
              unit_cost: "40.00",
              state_tax: "4.00",
              local_tax: "4.75",
              salesperson_id: operatorStaffId,
            },
          ],
        },
        failOnStatusCode: false,
      },
    );
    expect(checkoutRes.status()).toBe(200);
    const checkout = (await checkoutRes.json()) as CheckoutResponse;

    const detailRes = await request.get(
      `${apiBase()}/api/transactions/${checkout.transaction_id}?register_session_id=${encodeURIComponent(satellite?.session_id ?? "")}`,
      {
        headers: {
          "x-riverside-pos-session-id": satellite?.session_id ?? "",
          "x-riverside-pos-session-token": lane2Token,
          "x-riverside-station-key": "station-e2e",
        },
        failOnStatusCode: false,
      },
    );
    expect(detailRes.status()).toBe(200);
    const detail = (await detailRes.json()) as TransactionDetailResponse;

    await closeRegisterGroup(
      request,
      primary?.session_id ?? "",
      opened.pos_api_token ?? "",
    );

    const historyRes = await request.get(
      `${apiBase()}/api/insights/register-sessions?limit=10`,
      {
        headers: adminHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(historyRes.status()).toBe(200);
    const history = (await historyRes.json()) as RegisterSessionHistoryRow[];
    const primaryHistory = history.find(
      (row) => row.z_report_json?.session_id === primary?.session_id,
    );
    expect(primaryHistory).toBeTruthy();
    expect(primaryHistory?.register_lane).toBe(1);
    const expectedNetSales = detail.items
      .reduce((sum, item) => sum + Number(item.unit_price) * item.quantity, 0)
      .toFixed(2);
    expect(primaryHistory?.total_sales).toBe(expectedNetSales);
    expect(
      history.some(
        (row) => row.z_report_json?.session_id === satellite?.session_id,
      ),
    ).toBeFalsy();
    expect(
      history.some(
        (row) => row.z_report_json?.session_id === tertiary?.session_id,
      ),
    ).toBeFalsy();
  });

  test("open session coordination exposes pending close state for the full till group", async ({
    request,
  }) => {
    await closeAnyExistingOpenGroup(request);

    const opened = await openFreshPrimarySession(request);
    const openRows = await listOpenSessions(request);
    const primaryRow = openRows.find(
      (row) => row.session_id === opened.session_id,
    );
    const openGroup = openRows.filter(
      (row) => row.till_close_group_id === primaryRow?.till_close_group_id,
    );
    expect(openGroup.map((row) => row.register_lane).sort()).toEqual([
      1, 2, 3, 4,
    ]);
    expect(
      openGroup.every((row) => row.lifecycle_status === "open"),
    ).toBeTruthy();

    await beginReconcile(request, opened.session_id);

    const reconcilingRows = await listOpenSessions(request);
    const reconcilingGroup = reconcilingRows.filter(
      (row) => row.till_close_group_id === openGroup[0]?.till_close_group_id,
    );
    expect(reconcilingGroup.map((row) => row.register_lane).sort()).toEqual([
      1, 2, 3, 4,
    ]);
    expect(
      reconcilingGroup.every((row) => row.lifecycle_status === "reconciling"),
    ).toBeTruthy();

    await closeRegisterGroup(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
    );
  });
});
