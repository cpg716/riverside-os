import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  apiBase,
  getTransactionArtifacts,
  staffCode,
  staffHeaders,
} from "./helpers/rmsCharge";
import { createVendor } from "./helpers/inventoryReceiving";

const isCi = process.env.CI === "true" || process.env.CI === "1";

type OpenSessionResponse = {
  session_id: string;
  pos_api_token?: string | null;
};

type OpenSessionRow = {
  session_id: string;
  register_lane: number;
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

type ReconciliationResponse = {
  expected_cash: string;
  tenders: Array<{
    payment_method: string;
    total_amount: string;
    tx_count: number;
  }>;
};

type CheckoutResponse = {
  transaction_id: string;
};

type RegisterDaySummary = {
  reporting_basis: string;
  cash_collected: string;
  activities: Array<{
    transaction_id?: string | null;
    sales_total?: string | null;
    payment_summary?: string | null;
    balance_due?: string | null;
  }>;
};

function requireOrSkip(condition: boolean, message: string): void {
  if (condition) return;
  if (isCi) {
    expect(condition, message).toBeTruthy();
    return;
  }
  test.skip(true, message);
}

function parseMoneyToCents(value: string | number | undefined | null): number {
  if (value === undefined || value === null) return 0;
  const normalized = typeof value === "number" ? value.toFixed(2) : String(value).trim();
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [wholeRaw, fracRaw = ""] = unsigned.split(".");
  const whole = Number.parseInt(wholeRaw || "0", 10);
  const frac = Number.parseInt((fracRaw + "00").slice(0, 2), 10);
  const cents = whole * 100 + frac;
  return negative ? -cents : cents;
}

function storeLocalDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function listOpenSessions(request: APIRequestContext): Promise<OpenSessionRow[]> {
  const res = await request.get(`${apiBase()}/api/sessions/list-open`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as OpenSessionRow[];
}

async function issuePosToken(
  request: APIRequestContext,
  sessionId: string,
): Promise<string> {
  const res = await request.post(`${apiBase()}/api/sessions/${sessionId}/pos-api-token`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      cashier_code: staffCode(),
      pin: staffCode(),
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  const body = JSON.parse(bodyText) as { pos_api_token?: string };
  expect(body.pos_api_token).toBeTruthy();
  return body.pos_api_token ?? "";
}

async function fetchReconciliation(
  request: APIRequestContext,
  sessionId: string,
  sessionToken: string,
): Promise<ReconciliationResponse> {
  const res = await request.get(`${apiBase()}/api/sessions/${sessionId}/reconciliation`, {
    headers: {
      "x-riverside-pos-session-id": sessionId,
      "x-riverside-pos-session-token": sessionToken,
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as ReconciliationResponse;
}

async function closeRegisterGroup(
  request: APIRequestContext,
  sessionId: string,
  sessionToken: string,
): Promise<void> {
  const recon = await fetchReconciliation(request, sessionId, sessionToken);
  const res = await request.post(`${apiBase()}/api/sessions/${sessionId}/close`, {
    headers: {
      "Content-Type": "application/json",
      "x-riverside-pos-session-id": sessionId,
      "x-riverside-pos-session-token": sessionToken,
    },
    data: {
      actual_cash: recon.expected_cash,
      closing_notes: null,
      closing_comments: null,
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
}

async function closeAnyExistingOpenGroup(request: APIRequestContext): Promise<void> {
  const open = await listOpenSessions(request);
  const primary = open.find((row) => row.register_lane === 1);
  if (!primary) return;
  const token = await issuePosToken(request, primary.session_id);
  await closeRegisterGroup(request, primary.session_id, token);
}

async function openFreshPrimarySession(
  request: APIRequestContext,
): Promise<OpenSessionResponse> {
  const res = await request.post(`${apiBase()}/api/sessions/open`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      cashier_code: staffCode(),
      pin: staffCode(),
      opening_float: "200.00",
      register_lane: 1,
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  const body = JSON.parse(bodyText) as OpenSessionResponse;
  expect(body.session_id).toBeTruthy();
  expect(body.pos_api_token).toBeTruthy();
  return body;
}

async function verifyStaffId(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${apiBase()}/api/staff/verify-cashier-code`, {
    headers: { "Content-Type": "application/json" },
    data: {
      cashier_code: staffCode(),
      pin: staffCode(),
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  const body = JSON.parse(bodyText) as VerifyCashierResponse;
  expect(body.staff_id).toBeTruthy();
  return body.staff_id;
}

async function createReportingTrustProduct(
  request: APIRequestContext,
  actorStaffId: string,
): Promise<{ productId: string; variantId: string }> {
  const suffix = `reporting-trust-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const categoryRes = await request.post(`${apiBase()}/api/categories`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      name: `E2E Reporting Trust ${suffix}`,
      parent_id: null,
      is_clothing_footwear: false,
      changed_by_staff_id: actorStaffId,
      change_note: "Created for reporting trust contract coverage",
    },
    failOnStatusCode: false,
  });
  const categoryText = await categoryRes.text();
  expect(categoryRes.status(), categoryText.slice(0, 1000)).toBe(200);
  const category = JSON.parse(categoryText) as { id: string };
  const vendor = await createVendor(request, suffix);

  const createRes = await request.post(`${apiBase()}/api/products`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      category_id: category.id,
      primary_vendor_id: vendor.id,
      name: `E2E Reporting Trust Item ${suffix}`,
      brand: "Riverside E2E",
      description: "Deterministic reporting trust SKU",
      base_retail_price: "100.00",
      base_cost: "40.00",
      variation_axes: [],
      variants: [
        {
          sku: `E2E-REPORTING-TRUST-${suffix}`.toUpperCase(),
          variation_values: {},
          variation_label: "One Size",
          stock_on_hand: 8,
        },
      ],
    },
    failOnStatusCode: false,
  });
  const createText = await createRes.text();
  expect(createRes.status(), createText.slice(0, 1000)).toBe(200);
  const created = JSON.parse(createText) as ProductCreateResponse;

  const variantsRes = await request.get(`${apiBase()}/api/products/${created.id}/variants`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const variantsText = await variantsRes.text();
  expect(variantsRes.status(), variantsText.slice(0, 1000)).toBe(200);
  const variants = JSON.parse(variantsText) as ProductVariantRow[];
  expect(variants[0]?.id).toBeTruthy();

  return {
    productId: created.id,
    variantId: variants[0]!.id,
  };
}

async function checkoutCashSale(
  request: APIRequestContext,
  options: {
    productId: string;
    variantId: string;
    sessionId: string;
    sessionToken: string;
    operatorStaffId: string;
  },
): Promise<CheckoutResponse> {
  const res = await request.post(`${apiBase()}/api/transactions/checkout`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
      "x-riverside-pos-session-id": options.sessionId,
      "x-riverside-pos-session-token": options.sessionToken,
    },
    data: {
      session_id: options.sessionId,
      operator_staff_id: options.operatorStaffId,
      primary_salesperson_id: options.operatorStaffId,
      customer_id: null,
      payment_method: "cash",
      total_price: "108.75",
      amount_paid: "108.75",
      items: [
        {
          product_id: options.productId,
          variant_id: options.variantId,
          fulfillment: "takeaway",
          quantity: 1,
          unit_price: "100.00",
          unit_cost: "40.00",
          state_tax: "4.00",
          local_tax: "4.75",
          salesperson_id: options.operatorStaffId,
        },
      ],
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as CheckoutResponse;
}

async function fetchDailySalesActivity(
  request: APIRequestContext,
  sessionId: string,
): Promise<RegisterDaySummary> {
  const day = storeLocalDate();
  const res = await request.get(
    `${apiBase()}/api/insights/register-day-activity?basis=booked&from=${day}&to=${day}&register_session_id=${sessionId}`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as RegisterDaySummary;
}

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

test.describe("Reporting trust contracts", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(() => {
    requireOrSkip(
      serverReachable,
      `API not reachable at ${apiBase()} — start Postgres + server to run reporting-trust-contract`,
    );
  });

  test("daily sales activity reconciles to canonical register evidence", async ({
    request,
  }) => {
    await closeAnyExistingOpenGroup(request);

    const opened = await openFreshPrimarySession(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createReportingTrustProduct(request, operatorStaffId);

    const checkout = await checkoutCashSale(request, {
      ...product,
      sessionId: opened.session_id,
      sessionToken: opened.pos_api_token ?? "",
      operatorStaffId,
    });

    const artifacts = await getTransactionArtifacts(request, checkout.transaction_id);
    expect(artifacts.allocation_rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_transaction_id: checkout.transaction_id,
          payment_method: "cash",
          amount_allocated: "108.75",
          payment_amount: "108.75",
        }),
      ]),
    );

    const reconciliation = await fetchReconciliation(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
    );
    const cashTender = reconciliation.tenders.find(
      (row) => row.payment_method.toLowerCase() === "cash",
    );
    expect(cashTender).toBeTruthy();
    expect(cashTender?.tx_count).toBeGreaterThanOrEqual(1);

    const dailySales = await fetchDailySalesActivity(request, opened.session_id);
    expect(dailySales.reporting_basis).toBe("booked");
    expect(parseMoneyToCents(dailySales.cash_collected)).toBe(
      parseMoneyToCents(cashTender?.total_amount),
    );

    const activity = dailySales.activities.find(
      (row) => row.transaction_id === checkout.transaction_id,
    );
    expect(activity).toBeTruthy();
    expect(parseMoneyToCents(activity?.sales_total)).toBe(
      parseMoneyToCents(artifacts.total_price),
    );
    expect(activity?.payment_summary?.toLowerCase()).toContain("cash");
    expect(parseMoneyToCents(activity?.balance_due)).toBe(0);
  });
});
