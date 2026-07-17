import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { ensurePosRegisterSessionOpen, ensurePosSaleCashierSignedIn, enterPosShell } from "./openPosRegister";
import { openBackofficeSidebarTab } from "./backofficeSignIn";

export function apiBase(): string {
  const raw =
    process.env.E2E_API_BASE?.trim() ||
    process.env.VITE_API_BASE?.trim() ||
    "http://127.0.0.1:43300";
  return raw.replace(/\/$/, "");
}

export function staffCode(code?: string): string {
  return code?.trim() || process.env.E2E_BO_STAFF_CODE?.trim() || "1234";
}

export function staffHeaders(code?: string): Record<string, string> {
  const resolved = staffCode(code);
  return {
    "x-riverside-staff-code": resolved,
    "x-riverside-staff-pin": resolved,
  };
}

export type SeedFixtureResponse = {
  fixture: string;
  customer: {
    id: string;
    display_name: string;
    search_label: string;
    customer_code: string;
  };
  linked_accounts: Array<{
    id: string;
    rms_customer_id: string;
    rms_account_id: string;
    masked_account: string;
    status: string;
    is_primary: boolean;
    program_group?: string | null;
  }>;
  product: {
    product_id: string;
    variant_id: string;
    sku: string;
    name: string;
    unit_price: string;
    unit_cost: string;
  };
};

type SessionListRow = {
  session_id?: string;
  id?: string;
  register_lane?: number;
};

type SessionOpenResponse = {
  session_id: string;
  pos_api_token?: string | null;
};

type VerifyCashierResponse = {
  staff_id: string;
};

type CheckoutResponse = {
  transaction_id: string;
};

export type TransactionArtifacts = {
  transaction_id: string;
  transaction_display_id: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  rounding_adjustment: string;
  final_cash_due?: string | null;
  metadata: Record<string, unknown>;
  payment_rows: Array<{
    payment_method: string;
    check_number?: string | null;
    metadata: Record<string, unknown>;
  }>;
  allocation_rows: Array<{
    payment_transaction_id: string;
    target_transaction_id: string;
    target_display_id?: string | null;
    amount_allocated: string;
    payment_method: string;
    payment_amount: string;
    payment_check_number?: string | null;
    allocation_check_number?: string | null;
    allocation_metadata: Record<string, unknown>;
  }>;
  rms_records: Array<{
    id: string;
    record_kind: string;
    payment_method: string;
    program_code?: string | null;
    program_label?: string | null;
    masked_account?: string | null;
    posting_status: string;
    host_reference?: string | null;
    source_mode: string;
    external_transaction_id?: string | null;
    metadata_json?: Record<string, unknown> | null;
  }>;
};

export async function ensureSessionAuth(
  request: APIRequestContext,
  code?: string,
): Promise<{ sessionId: string; sessionToken: string }> {
  const listRes = await request.get(`${apiBase()}/api/sessions/list-open`, {
    headers: staffHeaders(code),
    failOnStatusCode: false,
  });
  const rows =
    listRes.status() === 200
      ? ((await listRes.json()) as SessionListRow[])
      : [];
  if (![200, 401, 403].includes(listRes.status())) {
    const bodyText = await listRes.text();
    throw new Error(
      `Failed to inspect open register sessions for ${staffCode(code)} (status ${listRes.status()}): ${bodyText || "<empty body>"}`,
    );
  }
  let sessionId = (rows[0]?.session_id || rows[0]?.id || "").trim();

  if (!sessionId) {
    const openRes = await request.post(`${apiBase()}/api/sessions/open`, {
      headers: {
        ...staffHeaders(code),
        "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
      },
      data: {
        cashier_code: staffCode(code),
        pin: staffCode(code),
        opening_float: "200.00",
        register_lane: 1,
      },
      failOnStatusCode: false,
    });
    expect(openRes.status()).toBe(200);
    const opened = (await openRes.json()) as SessionOpenResponse;
    sessionId = opened.session_id;
    return {
      sessionId,
      sessionToken: opened.pos_api_token ?? "",
    };
  }

  const tokenRes = await request.post(`${apiBase()}/api/sessions/${sessionId}/attach`, {
    headers: {
      ...staffHeaders(code),
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    failOnStatusCode: false,
  });
  expect(tokenRes.status()).toBe(200);
  const tokenBody = (await tokenRes.json()) as { pos_api_token?: string };
  return {
    sessionId,
    sessionToken: tokenBody.pos_api_token ?? "",
  };
}

export async function resetOpenRegisterSessions(request: APIRequestContext) {
  const listRes = await request.get(`${apiBase()}/api/sessions/list-open`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  if (listRes.status() !== 200) {
    const bodyText = await listRes.text();
    throw new Error(
      `Failed to list open register sessions for E2E reset (status ${listRes.status()}): ${bodyText || "<empty body>"}`,
    );
  }

  const rows = (await listRes.json()) as SessionListRow[];
  const primary = rows.find((row) => row.register_lane === 1) ?? rows[0];
  if (!primary) return;
  const sessionId = (primary.session_id || primary.id || "").trim();
  if (!sessionId) return;

  const tokenRes = await request.post(`${apiBase()}/api/sessions/${sessionId}/attach`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    failOnStatusCode: false,
  });
  if (tokenRes.status() !== 200) {
    const bodyText = await tokenRes.text();
    throw new Error(
      `Failed to attach to open register session ${sessionId} during E2E reset (status ${tokenRes.status()}): ${bodyText || "<empty body>"}`,
    );
  }
  const tokenBody = (await tokenRes.json()) as { pos_api_token?: string };
  const token = tokenBody.pos_api_token?.trim() || "";
  const reconRes = await request.get(`${apiBase()}/api/sessions/${sessionId}/reconciliation`, {
    headers: {
      "x-riverside-pos-session-id": sessionId,
      "x-riverside-pos-session-token": token,
      "x-riverside-station-key": "station-e2e",
    },
    failOnStatusCode: false,
  });
  if (reconRes.status() !== 200) {
    const bodyText = await reconRes.text();
    throw new Error(
      `Failed to read open register session ${sessionId} during E2E reset (status ${reconRes.status()}): ${bodyText || "<empty body>"}`,
    );
  }
  const reconciliation = (await reconRes.json()) as { expected_cash: string };
  const expectedCash = reconciliation.expected_cash.trim();
  const actualCash = expectedCash.startsWith("-") ? "0.00" : expectedCash;
  const closeRes = await request.post(`${apiBase()}/api/sessions/${sessionId}/close`, {
      headers: {
        "Content-Type": "application/json",
        "x-riverside-pos-session-id": sessionId,
        "x-riverside-pos-session-token": token,
        "x-riverside-station-key": "station-e2e",
      },
      data: {
        actual_cash: actualCash,
        closing_notes: actualCash === expectedCash
          ? "E2E RMS permissions reset"
          : "E2E RMS permissions reset; negative expected cash clamped to zero",
        closing_comments: actualCash === expectedCash
          ? "E2E RMS permissions reset"
          : "E2E RMS permissions reset; negative expected cash clamped to zero",
      },
      failOnStatusCode: false,
    });
  if (closeRes.status() !== 200) {
    const bodyText = await closeRes.text();
    throw new Error(
      `Failed to close open register session ${sessionId} during E2E reset (status ${closeRes.status()}): ${bodyText || "<empty body>"}`,
    );
  }
}

export async function verifyStaffId(
  request: APIRequestContext,
  code?: string,
) {
  const res = await request.post(`${apiBase()}/api/staff/verify-cashier-code`, {
    headers: { "Content-Type": "application/json" },
    data: {
      cashier_code: staffCode(code),
      pin: staffCode(code),
    },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as VerifyCashierResponse;
  return body.staff_id;
}

export async function seedRmsFixture(
  request: APIRequestContext,
  fixture: string,
  customerLabel?: string,
): Promise<SeedFixtureResponse> {
  const safeCustomerLabel = customerLabel?.trim()
    ? customerLabel.trim().slice(0, 32)
    : null;
  const res = await request.post(`${apiBase()}/api/test-support/rms/seed-fixture`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      fixture,
      customer_label: safeCustomerLabel,
    },
    failOnStatusCode: false,
  });
  if (res.status() !== 200) {
    const bodyText = await res.text();
    throw new Error(
      `Failed to seed RMS fixture "${fixture}" (status ${res.status()}): ${bodyText || "<empty body>"}`,
    );
  }
  const raw = (await res.json()) as Omit<SeedFixtureResponse, "linked_accounts"> & {
    linked_accounts: Array<
      Omit<SeedFixtureResponse["linked_accounts"][number], "rms_customer_id" | "rms_account_id"> & {
        corecredit_customer_id: string;
        corecredit_account_id: string;
      }
    >;
  };
  return {
    ...raw,
    linked_accounts: raw.linked_accounts.map((account) => ({
      id: account.id,
      rms_customer_id: account.corecredit_customer_id,
      rms_account_id: account.corecredit_account_id,
      masked_account: account.masked_account,
      status: account.status,
      is_primary: account.is_primary,
      program_group: account.program_group,
    })),
  };
}

export async function prepareRmsRecord(
  request: APIRequestContext,
  mode: string,
  recordId: string,
) {
  const res = await request.post(`${apiBase()}/api/test-support/rms/prepare-record`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      mode,
      record_id: recordId,
    },
    failOnStatusCode: false,
  });
  if (res.status() !== 200) {
    const bodyText = await res.text();
    throw new Error(
      `Failed to prepare RMS record ${recordId} with mode "${mode}" (status ${res.status()}): ${bodyText || "<empty body>"}`,
    );
  }
  return res.json();
}

export async function getTransactionArtifacts(
  request: APIRequestContext,
  transactionId: string,
): Promise<TransactionArtifacts> {
  const res = await request.get(`${apiBase()}/api/test-support/rms/transaction/${transactionId}`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  if (res.status() !== 200) {
    const bodyText = await res.text();
    throw new Error(
      `Failed to fetch RMS transaction artifacts for ${transactionId} (status ${res.status()}): ${bodyText || "<empty body>"}`,
    );
  }
  return (await res.json()) as TransactionArtifacts;
}

export async function fetchRmsPaymentMeta(request: APIRequestContext) {
  const res = await request.get(`${apiBase()}/api/pos/rms-payment-line-meta`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as {
    product_id: string;
    variant_id: string;
    sku: string;
    name: string;
  };
}

export async function checkoutFinancedSale(
  request: APIRequestContext,
  options: {
    fixture: SeedFixtureResponse;
    programCode: "standard" | "rms90";
    referenceNumber?: string;
  },
): Promise<{ response: Awaited<ReturnType<APIRequestContext["post"]>>; body?: CheckoutResponse }> {
  const { sessionId, sessionToken } = await ensureSessionAuth(request);
  const operatorStaffId = await verifyStaffId(request);
  const account =
    options.programCode === "rms90"
      ? options.fixture.linked_accounts.find((row) => row.program_group?.toLowerCase().includes("90"))
      : options.fixture.linked_accounts[0];
  expect(account).toBeTruthy();
  const paymentMethod = options.programCode === "rms90" ? "on_account_rms90" : "on_account_rms";
  const checkoutClientId = crypto.randomUUID();
  const res = await request.post(`${apiBase()}/api/transactions/checkout`, {
    headers: {
      ...staffHeaders(),
      "x-riverside-pos-session-id": sessionId,
      "x-riverside-pos-session-token": sessionToken,
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      session_id: sessionId,
      operator_staff_id: operatorStaffId,
      primary_salesperson_id: operatorStaffId,
      customer_id: options.fixture.customer.id,
      payment_method: paymentMethod,
      total_price: options.fixture.product.unit_price,
      amount_paid: options.fixture.product.unit_price,
      payment_splits: [
        {
          payment_method: paymentMethod,
          amount: options.fixture.product.unit_price,
          metadata: {
            tender_family: "rms_charge",
            program_code: options.programCode,
            program_label: options.programCode === "rms90" ? "RMS 90" : "Standard",
            masked_account: account?.masked_account,
            linked_rms_customer_id: account?.rms_customer_id,
            linked_rms_account_id: account?.rms_account_id,
            resolution_status: "selected",
            reference_number: options.referenceNumber,
          },
        },
      ],
      items: [
        {
          product_id: options.fixture.product.product_id,
          variant_id: options.fixture.product.variant_id,
          fulfillment: "takeaway",
          quantity: 1,
          unit_price: options.fixture.product.unit_price,
          unit_cost: options.fixture.product.unit_cost,
          state_tax: "0.00",
          local_tax: "0.00",
          salesperson_id: operatorStaffId,
        },
      ],
      checkout_client_id: checkoutClientId,
      is_tax_exempt: true,
      tax_exempt_reason: "Out of State",
    },
    failOnStatusCode: false,
  });
  const body =
    res.status() === 200 ? ((await res.json()) as CheckoutResponse) : undefined;
  return { response: res, body };
}

export async function checkoutRmsPaymentCollection(
  request: APIRequestContext,
  fixture: SeedFixtureResponse,
  referenceNumber?: string,
) {
  const { sessionId, sessionToken } = await ensureSessionAuth(request);
  const operatorStaffId = await verifyStaffId(request);
  const paymentMeta = await fetchRmsPaymentMeta(request);

  const res = await request.post(`${apiBase()}/api/transactions/checkout`, {
    headers: {
      ...staffHeaders(),
      "x-riverside-pos-session-id": sessionId,
      "x-riverside-pos-session-token": sessionToken,
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      session_id: sessionId,
      operator_staff_id: operatorStaffId,
      customer_id: fixture.customer.id,
      payment_method: "cash",
      total_price: "50.00",
      amount_paid: "50.00",
      items: [
        {
          product_id: paymentMeta.product_id,
          variant_id: paymentMeta.variant_id,
          fulfillment: "takeaway",
          quantity: 1,
          unit_price: "50.00",
          unit_cost: "0.00",
          state_tax: "0.00",
          local_tax: "0.00",
        },
      ],
      payment_splits: [
        {
          payment_method: "cash",
          amount: "50.00",
          metadata: {
            rms_charge_collection: true,
            reference_number: referenceNumber,
          },
        },
      ],
      checkout_client_id: crypto.randomUUID(),
      target_transaction_id: null,
      is_tax_exempt: true,
      tax_exempt_reason: "Out of State",
    },
    failOnStatusCode: false,
  });
  return {
    response: res,
    body: res.status() === 200 ? ((await res.json()) as CheckoutResponse) : undefined,
  };
}

export async function fetchReceiptEscpos(
  request: APIRequestContext,
  transactionId: string,
  registerSessionId: string,
) {
  const receiptUrl = `${apiBase()}/api/transactions/${transactionId}/receipt.escpos`;
  let res = await request.get(
    `${receiptUrl}?register_session_id=${encodeURIComponent(registerSessionId)}`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  if (res.status() === 403) {
    res = await request.get(receiptUrl, {
      headers: staffHeaders(),
      failOnStatusCode: false,
    });
  }
  const body = await res.text();
  expect(res.status(), body.slice(0, 1000)).toBe(200);

  const parsed = JSON.parse(body) as { receiptline_markdown?: string };
  expect(parsed.receiptline_markdown, body.slice(0, 1000)).toBeDefined();

  return parsed.receiptline_markdown ?? "";
}

export async function openCustomersRmsWorkspace(page: Page) {
  await page.evaluate(() => {
    localStorage.removeItem("ros_api_base_override");
  });
  await openBackofficeSidebarTab(page, "customers");
  await page.getByRole("button", { name: /^RMS Charge$/i }).click();
  await expect(page.getByText(/RMS Charge/i).first()).toBeVisible({ timeout: 15_000 });
}

export async function openPosRmsWorkspace(page: Page) {
  await page.evaluate(() => {
    localStorage.removeItem("ros_api_base_override");
  });
  const posNav = page.getByRole("navigation", { name: "POS Navigation" });
  if (!(await posNav.isVisible().catch(() => false))) {
    await enterPosShell(page);
  }
  await ensurePosRegisterSessionOpen(page);
  const cashierDialog = page.getByRole("dialog", { name: /sign-in for this sale/i });
  if (await cashierDialog.isVisible().catch(() => false)) {
    await ensurePosSaleCashierSignedIn(page);
  }
  const customersButton = posNav.getByRole("button", { name: /^Customers$/i });
  await customersButton.click({ force: true });

  const rmsSubsectionButton = posNav.getByRole("button", { name: /^RMS Charge$/i }).first();
  await expect(rmsSubsectionButton).toBeVisible({ timeout: 10_000 });
  await rmsSubsectionButton.click({ force: true });
  await expect(page.getByText(/Slim RMS Charge Workspace/i)).toBeVisible({ timeout: 15_000 });
}
