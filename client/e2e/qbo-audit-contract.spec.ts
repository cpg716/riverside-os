import { expect, test, type APIRequestContext } from "@playwright/test";
import { centsToFixed2, parseMoneyToCents } from "../src/lib/money";
import { calculateNysErieTaxStringsForUnit } from "../src/lib/tax";
import {
  apiBase,
  ensureSessionAuth,
  staffHeaders,
  verifyStaffId,
} from "./helpers/rmsCharge";

type CreatedQboProduct = {
  categoryId: string;
  productId: string;
  variantId: string;
  sku: string;
  unitCost: string;
};

type CheckoutResponse = {
  transaction_id: string;
};

type QboJournalLine = {
  qbo_account_id: string;
  qbo_account_name: string;
  debit: string | number;
  credit: string | number;
  memo: string;
  detail?: Array<Record<string, unknown>>;
};

type QboStagingRow = {
  id: string;
  sync_date: string;
  status: string;
  payload: {
    activity_date: string;
    business_timezone?: string;
    lines: QboJournalLine[];
    totals?: {
      debits?: string | number;
      credits?: string | number;
      balanced?: boolean;
    };
    warnings?: string[];
  };
};

function uniqueSuffix(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function futureUtcDate(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function moneyToCents(value: string | number | undefined): number {
  if (value === undefined) return 0;
  return parseMoneyToCents(String(value));
}

function totalFor(unitPrice: string, stateTax: string, localTax: string): string {
  return centsToFixed2(
    parseMoneyToCents(unitPrice) + parseMoneyToCents(stateTax) + parseMoneyToCents(localTax),
  );
}

async function createQboProduct(
  request: APIRequestContext,
  actorStaffId: string,
): Promise<CreatedQboProduct> {
  const suffix = uniqueSuffix("qbo");
  const categoryRes = await request.post(`${apiBase()}/api/categories`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      name: `E2E QBO ${suffix}`,
      parent_id: null,
      is_clothing_footwear: true,
      changed_by_staff_id: actorStaffId,
      change_note: "Created for QBO audit E2E coverage",
    },
    failOnStatusCode: false,
  });
  expect(categoryRes.status()).toBe(200);
  const category = (await categoryRes.json()) as { id: string };

  const sku = `QBO-${suffix}`.toUpperCase();
  const createRes = await request.post(`${apiBase()}/api/products`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      category_id: category.id,
      name: `E2E QBO Journal Item ${suffix}`,
      brand: "Riverside E2E",
      description: "Deterministic QBO audit SKU",
      base_retail_price: "110.00",
      base_cost: "40.00",
      variation_axes: [],
      images: [],
      track_low_stock: false,
      publish_variants_to_web: false,
      variants: [
        {
          sku,
          variation_values: {},
          variation_label: "Standard",
          stock_on_hand: 20,
          retail_price_override: null,
          cost_override: null,
          track_low_stock: false,
        },
      ],
    },
    failOnStatusCode: false,
  });
  expect(createRes.status()).toBe(200);
  const product = (await createRes.json()) as { id: string };

  const variantsRes = await request.get(`${apiBase()}/api/products/${product.id}/variants`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  expect(variantsRes.status()).toBe(200);
  const variants = (await variantsRes.json()) as Array<{ id: string; sku: string }>;
  expect(variants[0]?.id).toBeTruthy();

  return {
    categoryId: category.id,
    productId: product.id,
    variantId: variants[0]!.id,
    sku,
    unitCost: "40.00",
  };
}

async function checkoutQboProduct(
  request: APIRequestContext,
  options: {
    product: CreatedQboProduct;
    sessionId: string;
    sessionToken: string;
    operatorStaffId: string;
  },
): Promise<CheckoutResponse> {
  const tax = calculateNysErieTaxStringsForUnit("clothing", parseMoneyToCents("110.00"));
  const total = totalFor("110.00", tax.stateTax, tax.localTax);
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
      total_price: total,
      amount_paid: total,
      checkout_client_id: crypto.randomUUID(),
      items: [
        {
          product_id: options.product.productId,
          variant_id: options.product.variantId,
          fulfillment: "takeaway",
          quantity: 1,
          unit_price: "110.00",
          unit_cost: options.product.unitCost,
          state_tax: tax.stateTax,
          local_tax: tax.localTax,
          salesperson_id: options.operatorStaffId,
        },
      ],
      payment_splits: [
        {
          payment_method: "cash",
          amount: total,
        },
      ],
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as CheckoutResponse;
}

async function seedQboMappings(
  request: APIRequestContext,
  categoryId: string,
  activityDate: string,
) {
  const res = await request.post(`${apiBase()}/api/test-support/qbo/seed-tax-mapping`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      category_id: categoryId,
      activity_date: activityDate,
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
}

async function assignQboTimestamp(
  request: APIRequestContext,
  transactionId: string,
  timestampUtc: string,
) {
  const res = await request.post(`${apiBase()}/api/test-support/qbo/assign-transaction-timestamp`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      transaction_id: transactionId,
      timestamp_utc: timestampUtc,
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
}

async function proposeJournal(
  request: APIRequestContext,
  activityDate: string,
): Promise<QboStagingRow> {
  const res = await request.post(`${apiBase()}/api/qbo/staging/propose`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      activity_date: activityDate,
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as QboStagingRow;
}

test.describe("QBO audit contract", () => {
  test("proposed journal is balanced, deduped while pending, drillable, and approval-gated", async ({
    request,
  }) => {
    test.setTimeout(90_000);
    const activityDate = futureUtcDate(7);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createQboProduct(request, operatorStaffId);
    await seedQboMappings(request, product.categoryId, activityDate);
    const checkout = await checkoutQboProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
    });
    const assignDateRes = await request.post(
      `${apiBase()}/api/test-support/qbo/assign-transaction-date`,
      {
        headers: {
          ...staffHeaders(),
          "Content-Type": "application/json",
        },
        data: {
          transaction_id: checkout.transaction_id,
          activity_date: activityDate,
        },
        failOnStatusCode: false,
      },
    );
    const assignDateText = await assignDateRes.text();
    expect(assignDateRes.status(), assignDateText.slice(0, 1000)).toBe(200);

    const proposed = await proposeJournal(request, activityDate);
    expect(proposed.sync_date).toBe(activityDate);
    expect(proposed.status).toBe("pending");
    expect(proposed.payload.activity_date).toBe(activityDate);
    expect(proposed.payload.totals?.balanced).toBe(true);
    expect(moneyToCents(proposed.payload.totals?.debits)).toBe(
      moneyToCents(proposed.payload.totals?.credits),
    );

    const postableLines = proposed.payload.lines.filter(
      (line) => line.qbo_account_id && (moneyToCents(line.debit) > 0 || moneyToCents(line.credit) > 0),
    );
    expect(postableLines.length).toBeGreaterThanOrEqual(3);
    const lineDebits = postableLines.reduce((sum, line) => sum + moneyToCents(line.debit), 0);
    const lineCredits = postableLines.reduce((sum, line) => sum + moneyToCents(line.credit), 0);
    expect(lineDebits).toBe(lineCredits);

    expect(postableLines.some((line) => line.qbo_account_id === "E2E_CASH")).toBe(true);
    expect(postableLines.some((line) => line.qbo_account_id === "E2E_REVENUE")).toBe(true);
    expect(postableLines.some((line) => line.qbo_account_id === "E2E_SALES_TAX")).toBe(true);
    expect(proposed.payload.warnings ?? []).not.toContain(
      "Sales tax collected but no `tax` / SALES_TAX or MISC mapping; add qbo_mappings row.",
    );

    const duplicate = await proposeJournal(request, activityDate);
    expect(duplicate.id).toBe(proposed.id);
    expect(duplicate.status).toBe("pending");

    const listRes = await request.get(
      `${apiBase()}/api/qbo/staging?from=${activityDate}&to=${activityDate}`,
      {
        headers: staffHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(listRes.status()).toBe(200);
    const stagingRows = (await listRes.json()) as QboStagingRow[];
    const matchingPendingRows = stagingRows.filter(
      (row) => row.id === proposed.id && row.sync_date === activityDate && row.status === "pending",
    );
    expect(matchingPendingRows).toHaveLength(1);

    const tenderLineIndex = proposed.payload.lines.findIndex(
      (line) => line.memo.startsWith("Tenders") && line.qbo_account_id === "E2E_CASH",
    );
    expect(tenderLineIndex).toBeGreaterThanOrEqual(0);
    const drilldownRes = await request.get(
      `${apiBase()}/api/qbo/staging/${proposed.id}/drilldown?line_index=${tenderLineIndex}`,
      {
        headers: staffHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(drilldownRes.status()).toBe(200);
    const drilldown = (await drilldownRes.json()) as {
      contributors?: Array<{ transaction_id: string; amount: string | number }>;
    };
    const contributor = drilldown.contributors?.find(
      (row) => row.transaction_id === checkout.transaction_id,
    );
    expect(contributor).toBeTruthy();
    expect(moneyToCents(contributor?.amount)).toBe(parseMoneyToCents("119.63"));

    const approveRes = await request.post(`${apiBase()}/api/qbo/staging/${proposed.id}/approve`, {
      headers: staffHeaders(),
      failOnStatusCode: false,
    });
    const approveText = await approveRes.text();
    expect(approveRes.status(), approveText.slice(0, 1000)).toBe(200);
    expect(JSON.parse(approveText)).toMatchObject({ status: "approved" });

    const approveAgainRes = await request.post(`${apiBase()}/api/qbo/staging/${proposed.id}/approve`, {
      headers: staffHeaders(),
      failOnStatusCode: false,
    });
    expect(approveAgainRes.status()).toBe(409);
    await expect(approveAgainRes.text()).resolves.toMatch(/only pending entries can be approved/i);
  });

  test("store-local business date wins over UTC date near midnight", async ({ request }) => {
    test.setTimeout(90_000);
    const base = new Date();
    base.setUTCDate(base.getUTCDate() + 180 + Math.floor(Math.random() * 120));
    const localBusinessDate = base.toISOString().slice(0, 10);
    const utcNext = new Date(base);
    utcNext.setUTCDate(utcNext.getUTCDate() + 1);
    const utcCalendarDate = utcNext.toISOString().slice(0, 10);
    const timestampUtc = `${utcCalendarDate}T03:30:00Z`;

    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createQboProduct(request, operatorStaffId);
    await seedQboMappings(request, product.categoryId, localBusinessDate);
    await seedQboMappings(request, product.categoryId, utcCalendarDate);

    const checkout = await checkoutQboProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
    });
    await assignQboTimestamp(request, checkout.transaction_id, timestampUtc);

    const localProposal = await proposeJournal(request, localBusinessDate);
    expect(localProposal.payload.activity_date).toBe(localBusinessDate);
    expect(localProposal.payload.business_timezone).toBeTruthy();
    const localTenderLineIndex = localProposal.payload.lines.findIndex(
      (line) => line.memo.startsWith("Tenders") && line.qbo_account_id === "E2E_CASH",
    );
    expect(localTenderLineIndex).toBeGreaterThanOrEqual(0);
    const localDrilldownRes = await request.get(
      `${apiBase()}/api/qbo/staging/${localProposal.id}/drilldown?line_index=${localTenderLineIndex}`,
      {
        headers: staffHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(localDrilldownRes.status()).toBe(200);
    const localDrilldown = (await localDrilldownRes.json()) as {
      contributors?: Array<{ transaction_id: string; amount: string | number }>;
    };
    expect(
      localDrilldown.contributors?.some((row) => row.transaction_id === checkout.transaction_id),
    ).toBe(true);

    const utcProposal = await proposeJournal(request, utcCalendarDate);
    const utcTenderLineIndex = utcProposal.payload.lines.findIndex(
      (line) => line.memo.startsWith("Tenders") && line.qbo_account_id === "E2E_CASH",
    );
    if (utcTenderLineIndex >= 0) {
      const utcDrilldownRes = await request.get(
        `${apiBase()}/api/qbo/staging/${utcProposal.id}/drilldown?line_index=${utcTenderLineIndex}`,
        {
          headers: staffHeaders(),
          failOnStatusCode: false,
        },
      );
      expect(utcDrilldownRes.status()).toBe(200);
      const utcDrilldown = (await utcDrilldownRes.json()) as {
        contributors?: Array<{ transaction_id: string; amount: string | number }>;
      };
      expect(
        utcDrilldown.contributors?.some((row) => row.transaction_id === checkout.transaction_id),
      ).toBe(false);
    }
  });
});
