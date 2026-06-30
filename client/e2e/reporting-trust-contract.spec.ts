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
  sku: string;
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
  sales_count: number;
  cash_collected: string;
  sales_subtotal_no_tax: string;
  sales_tax_total: string;
  activities: Array<{
    transaction_id?: string | null;
    sales_total?: string | null;
    tax_total?: string | null;
    payment_summary?: string | null;
    balance_due?: string | null;
    is_takeaway?: boolean;
    items?: Array<{ fulfillment?: string | null }>;
  }>;
};

type TransactionDetail = {
  total_price: string;
  items: Array<{
    transaction_line_id: string;
    sku: string;
    quantity: number;
    quantity_returned: number;
  }>;
};

type MarginPivotRow = {
  bucket: string;
  gross_revenue: string | number;
  cost_of_goods: string | number;
  gross_margin: string | number;
  line_units: number;
};

type MarginPivotResponse = {
  rows: MarginPivotRow[];
};

type SalesPivotRow = {
  bucket: string;
  gross_revenue: string | number;
  tax_collected: string | number;
  line_units: number;
};

type SalesPivotResponse = {
  rows: SalesPivotRow[];
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

function addDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map((part) => Number.parseInt(part, 10));
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return date.toISOString().slice(0, 10);
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
): Promise<{
  productId: string;
  variantId: string;
  sku: string;
  categoryName: string;
}> {
  const suffix = `reporting-trust-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const categoryName = `E2E Reporting Trust ${suffix}`;
  const categoryRes = await request.post(`${apiBase()}/api/categories`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      name: categoryName,
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
    sku: variants[0]!.sku,
    categoryName,
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
    fulfillment?: "takeaway" | "special_order";
    quantity?: number;
  },
): Promise<CheckoutResponse> {
  const quantity = options.quantity ?? 1;
  const totalCents = 10875 * quantity;
  const totalPrice = `${Math.floor(totalCents / 100)}.${String(totalCents % 100).padStart(2, "0")}`;
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
      total_price: totalPrice,
      amount_paid: totalPrice,
      items: [
        {
          product_id: options.productId,
          variant_id: options.variantId,
          fulfillment: options.fulfillment ?? "takeaway",
          quantity,
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

async function fetchTransactionDetail(
  request: APIRequestContext,
  transactionId: string,
): Promise<TransactionDetail> {
  const res = await request.get(`${apiBase()}/api/transactions/${transactionId}`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as TransactionDetail;
}

async function returnFirstTransactionLine(
  request: APIRequestContext,
  options: {
    transactionId: string;
    sessionId: string;
    sessionToken: string;
    productSku: string;
  },
): Promise<TransactionDetail> {
  const before = await fetchTransactionDetail(request, options.transactionId);
  const line = before.items.find((item) => item.sku === options.productSku);
  expect(line?.transaction_line_id).toBeTruthy();

  const res = await request.post(
    `${apiBase()}/api/transactions/${options.transactionId}/returns?register_session_id=${encodeURIComponent(options.sessionId)}`,
    {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
        "x-riverside-pos-session-id": options.sessionId,
        "x-riverside-pos-session-token": options.sessionToken,
      },
      data: {
        lines: [
          {
            transaction_line_id: line?.transaction_line_id,
            quantity: 1,
            reason: "reporting_trust_margin_return",
          },
        ],
      },
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as TransactionDetail;
}

async function fetchDailySalesActivity(
  request: APIRequestContext,
  sessionId: string,
  options: {
    basis?: "booked" | "fulfilled";
    date?: string;
  } = {},
): Promise<RegisterDaySummary> {
  const day = options.date ?? storeLocalDate();
  const basis = options.basis ?? "booked";
  const res = await request.get(
    `${apiBase()}/api/insights/register-day-activity?basis=${basis}&from=${day}&to=${day}&register_session_id=${sessionId}`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as RegisterDaySummary;
}

async function markPickup(
  request: APIRequestContext,
  transactionId: string,
  sessionId: string,
  sessionToken: string,
): Promise<void> {
  const res = await request.post(`${apiBase()}/api/transactions/${transactionId}/pickup`, {
    headers: {
      ...staffHeaders(),
      "x-riverside-pos-session-id": sessionId,
      "x-riverside-pos-session-token": sessionToken,
      "Content-Type": "application/json",
    },
    data: {
      delivered_item_ids: [],
      actor: "Reporting trust contract",
      override_readiness: true,
      override_reason: "Reporting trust fixture controls pickup recognition timing.",
      register_session_id: sessionId,
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
}

async function assignFulfillmentTimestamp(
  request: APIRequestContext,
  transactionId: string,
  timestampUtc: string,
): Promise<void> {
  const res = await request.post(
    `${apiBase()}/api/test-support/qbo/assign-transaction-fulfillment-timestamp`,
    {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
      },
      data: {
        transaction_id: transactionId,
        timestamp_utc: timestampUtc,
      },
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
}

async function fetchMarginPivotByCategory(
  request: APIRequestContext,
  date: string,
): Promise<MarginPivotResponse> {
  const res = await request.get(
    `${apiBase()}/api/insights/margin-pivot?basis=fulfilled&group_by=category&from=${date}&to=${date}`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as MarginPivotResponse;
}

async function fetchMarginPivotByDate(
  request: APIRequestContext,
  date: string,
): Promise<MarginPivotResponse> {
  const res = await request.get(
    `${apiBase()}/api/insights/margin-pivot?basis=fulfilled&group_by=date&from=${date}&to=${date}`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as MarginPivotResponse;
}

async function fetchSalesPivotByCategory(
  request: APIRequestContext,
  date: string,
): Promise<SalesPivotResponse> {
  const res = await request.get(
    `${apiBase()}/api/insights/sales-pivot?basis=fulfilled&group_by=category&from=${date}&to=${date}`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as SalesPivotResponse;
}

async function fetchSalesPivotByDate(
  request: APIRequestContext,
  date: string,
): Promise<SalesPivotResponse> {
  const res = await request.get(
    `${apiBase()}/api/insights/sales-pivot?basis=fulfilled&group_by=date&from=${date}&to=${date}`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as SalesPivotResponse;
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

  test("daily sales completed basis includes immediate takeaway sales", async ({
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
      fulfillment: "takeaway",
    });

    const fulfilledReport = await fetchDailySalesActivity(request, opened.session_id, {
      basis: "fulfilled",
    });

    expect(fulfilledReport.reporting_basis).toBe("completed");
    expect(fulfilledReport.sales_count).toBeGreaterThanOrEqual(1);
    expect(parseMoneyToCents(fulfilledReport.sales_subtotal_no_tax)).toBeGreaterThanOrEqual(10000);

    const activity = fulfilledReport.activities.find(
      (row) => row.transaction_id === checkout.transaction_id,
    );
    expect(activity).toBeTruthy();
    expect(activity?.is_takeaway).toBe(true);
    expect(activity?.items?.every((item) => item.fulfillment === "takeaway")).toBe(true);
    expect(parseMoneyToCents(activity?.sales_total)).toBe(10875);
  });

  test("daily sales activity reports tax using effective item quantity", async ({
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
      quantity: 2,
    });

    const dailySales = await fetchDailySalesActivity(request, opened.session_id);
    expect(dailySales.reporting_basis).toBe("booked");
    expect(dailySales.sales_count).toBe(1);
    expect(parseMoneyToCents(dailySales.sales_subtotal_no_tax)).toBe(20000);
    expect(parseMoneyToCents(dailySales.sales_tax_total)).toBe(1750);

    const activity = dailySales.activities.find(
      (row) => row.transaction_id === checkout.transaction_id,
    );
    expect(activity).toBeTruthy();
    expect(parseMoneyToCents(activity?.sales_total)).toBe(21750);
    expect(parseMoneyToCents(activity?.tax_total)).toBe(1750);
  });

  test("margin pivot uses effective quantity after partial return", async ({
    request,
  }) => {
    await closeAnyExistingOpenGroup(request);

    const bookedDate = storeLocalDate();
    const recognitionDate = addDays(bookedDate, 1);
    const recognitionTimestampUtc = `${recognitionDate}T16:00:00Z`;
    const opened = await openFreshPrimarySession(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createReportingTrustProduct(request, operatorStaffId);

    const checkout = await checkoutCashSale(request, {
      ...product,
      sessionId: opened.session_id,
      sessionToken: opened.pos_api_token ?? "",
      operatorStaffId,
      fulfillment: "special_order",
      quantity: 2,
    });

    await markPickup(
      request,
      checkout.transaction_id,
      opened.session_id,
      opened.pos_api_token ?? "",
    );
    await assignFulfillmentTimestamp(
      request,
      checkout.transaction_id,
      recognitionTimestampUtc,
    );

    const returnedDetail = await returnFirstTransactionLine(request, {
      transactionId: checkout.transaction_id,
      sessionId: opened.session_id,
      sessionToken: opened.pos_api_token ?? "",
      productSku: product.sku,
    });
    const returnedLine = returnedDetail.items.find((item) => item.sku === product.sku);
    expect(returnedLine?.quantity).toBe(2);
    expect(returnedLine?.quantity_returned).toBe(1);

    const effectiveQuantity =
      (returnedLine?.quantity ?? 0) - (returnedLine?.quantity_returned ?? 0);
    expect(effectiveQuantity).toBe(1);

    const margin = await fetchMarginPivotByCategory(request, recognitionDate);
    const row = margin.rows.find((candidate) => candidate.bucket === product.categoryName);
    expect(row).toBeTruthy();
    expect(row?.line_units).toBe(effectiveQuantity);
    expect(parseMoneyToCents(row?.gross_revenue)).toBe(10000 * effectiveQuantity);
    expect(parseMoneyToCents(row?.cost_of_goods)).toBe(4000 * effectiveQuantity);
    expect(parseMoneyToCents(row?.gross_margin)).toBe(6000 * effectiveQuantity);

    expect(parseMoneyToCents(row?.gross_revenue)).not.toBe(20000);
    expect(parseMoneyToCents(row?.cost_of_goods)).not.toBe(8000);
    expect(parseMoneyToCents(row?.gross_margin)).not.toBe(12000);
  });

  test("margin pivot uses store-local fulfilled date around UTC boundary", async ({
    request,
  }) => {
    await closeAnyExistingOpenGroup(request);

    const localBusinessDate = addDays(storeLocalDate(), 1);
    const utcCalendarDate = addDays(localBusinessDate, 1);
    const recognitionTimestampUtc = `${utcCalendarDate}T03:30:00Z`;
    const opened = await openFreshPrimarySession(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createReportingTrustProduct(request, operatorStaffId);

    const checkout = await checkoutCashSale(request, {
      ...product,
      sessionId: opened.session_id,
      sessionToken: opened.pos_api_token ?? "",
      operatorStaffId,
      fulfillment: "special_order",
    });
    const artifacts = await getTransactionArtifacts(request, checkout.transaction_id);
    expect(parseMoneyToCents(artifacts.total_price)).toBe(10875);

    await markPickup(
      request,
      checkout.transaction_id,
      opened.session_id,
      opened.pos_api_token ?? "",
    );
    await assignFulfillmentTimestamp(
      request,
      checkout.transaction_id,
      recognitionTimestampUtc,
    );

    const registerActivity = await fetchDailySalesActivity(request, opened.session_id, {
      basis: "fulfilled",
      date: localBusinessDate,
    });
    expect(registerActivity.reporting_basis).toBe("completed");
    expect(
      registerActivity.activities.some((row) => row.transaction_id === checkout.transaction_id),
    ).toBe(true);

    const localMargin = await fetchMarginPivotByCategory(request, localBusinessDate);
    const localRow = localMargin.rows.find((candidate) => candidate.bucket === product.categoryName);
    expect(localRow).toBeTruthy();
    expect(localRow?.line_units).toBe(1);
    expect(parseMoneyToCents(localRow?.gross_revenue)).toBe(10000);
    expect(parseMoneyToCents(localRow?.cost_of_goods)).toBe(4000);
    expect(parseMoneyToCents(localRow?.gross_margin)).toBe(6000);

    const dateMargin = await fetchMarginPivotByDate(request, localBusinessDate);
    const dateRow = dateMargin.rows.find((candidate) => candidate.bucket === localBusinessDate);
    expect(dateRow).toBeTruthy();
    expect(dateRow?.line_units).toBeGreaterThanOrEqual(1);
    expect(parseMoneyToCents(dateRow?.gross_revenue)).toBeGreaterThanOrEqual(10000);
    expect(parseMoneyToCents(dateRow?.cost_of_goods)).toBeGreaterThanOrEqual(4000);

    const utcDateMargin = await fetchMarginPivotByCategory(request, utcCalendarDate);
    expect(
      utcDateMargin.rows.some((candidate) => candidate.bucket === product.categoryName),
    ).toBe(false);
  });

  test("sales pivot uses store-local fulfilled date around UTC boundary", async ({
    request,
  }) => {
    await closeAnyExistingOpenGroup(request);

    const localBusinessDate = addDays(storeLocalDate(), 1);
    const utcCalendarDate = addDays(localBusinessDate, 1);
    const recognitionTimestampUtc = `${utcCalendarDate}T03:30:00Z`;
    const opened = await openFreshPrimarySession(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createReportingTrustProduct(request, operatorStaffId);

    const checkout = await checkoutCashSale(request, {
      ...product,
      sessionId: opened.session_id,
      sessionToken: opened.pos_api_token ?? "",
      operatorStaffId,
      fulfillment: "special_order",
    });
    const artifacts = await getTransactionArtifacts(request, checkout.transaction_id);
    expect(parseMoneyToCents(artifacts.total_price)).toBe(10875);

    await markPickup(
      request,
      checkout.transaction_id,
      opened.session_id,
      opened.pos_api_token ?? "",
    );
    await assignFulfillmentTimestamp(
      request,
      checkout.transaction_id,
      recognitionTimestampUtc,
    );

    const registerActivity = await fetchDailySalesActivity(request, opened.session_id, {
      basis: "fulfilled",
      date: localBusinessDate,
    });
    expect(registerActivity.reporting_basis).toBe("completed");
    expect(
      registerActivity.activities.some((row) => row.transaction_id === checkout.transaction_id),
    ).toBe(true);

    const localSales = await fetchSalesPivotByCategory(request, localBusinessDate);
    const localRow = localSales.rows.find((candidate) => candidate.bucket === product.categoryName);
    expect(localRow).toBeTruthy();
    expect(localRow?.line_units).toBe(1);
    expect(parseMoneyToCents(localRow?.gross_revenue)).toBe(10000);
    expect(parseMoneyToCents(localRow?.tax_collected)).toBe(875);

    const dateSales = await fetchSalesPivotByDate(request, localBusinessDate);
    const dateRow = dateSales.rows.find((candidate) => candidate.bucket === localBusinessDate);
    expect(dateRow).toBeTruthy();
    expect(dateRow?.line_units).toBeGreaterThanOrEqual(1);
    expect(parseMoneyToCents(dateRow?.gross_revenue)).toBeGreaterThanOrEqual(10000);

    const utcDateSales = await fetchSalesPivotByCategory(request, utcCalendarDate);
    expect(
      utcDateSales.rows.some((candidate) => candidate.bucket === product.categoryName),
    ).toBe(false);
  });

  test("fulfilled basis reporting reconciles to canonical recognition evidence", async ({
    request,
  }) => {
    await closeAnyExistingOpenGroup(request);

    const bookedDate = storeLocalDate();
    const recognitionDate = addDays(bookedDate, 1);
    const recognitionTimestampUtc = `${recognitionDate}T16:00:00Z`;
    const opened = await openFreshPrimarySession(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createReportingTrustProduct(request, operatorStaffId);

    const checkout = await checkoutCashSale(request, {
      ...product,
      sessionId: opened.session_id,
      sessionToken: opened.pos_api_token ?? "",
      operatorStaffId,
      fulfillment: "special_order",
    });
    const artifacts = await getTransactionArtifacts(request, checkout.transaction_id);
    expect(parseMoneyToCents(artifacts.total_price)).toBe(10875);

    const unfulfilledReport = await fetchDailySalesActivity(request, opened.session_id, {
      basis: "fulfilled",
      date: bookedDate,
    });
    expect(unfulfilledReport.reporting_basis).toBe("completed");
    expect(
      unfulfilledReport.activities.some(
        (row) => row.transaction_id === checkout.transaction_id,
      ),
    ).toBe(false);

    await markPickup(
      request,
      checkout.transaction_id,
      opened.session_id,
      opened.pos_api_token ?? "",
    );
    await assignFulfillmentTimestamp(
      request,
      checkout.transaction_id,
      recognitionTimestampUtc,
    );

    const bookedDayFulfilledReport = await fetchDailySalesActivity(
      request,
      opened.session_id,
      {
        basis: "fulfilled",
        date: bookedDate,
      },
    );
    expect(
      bookedDayFulfilledReport.activities.some(
        (row) => row.transaction_id === checkout.transaction_id,
      ),
    ).toBe(false);

    const recognitionReport = await fetchDailySalesActivity(request, opened.session_id, {
      basis: "fulfilled",
      date: recognitionDate,
    });
    expect(recognitionReport.reporting_basis).toBe("completed");
    expect(recognitionReport.sales_count).toBe(1);

    const activity = recognitionReport.activities.find(
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
