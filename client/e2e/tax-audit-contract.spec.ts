import { expect, test, type APIRequestContext } from "@playwright/test";
import { centsToFixed2, parseMoneyToCents } from "../src/lib/money";
import { calculateNysErieTaxStringsForUnit, type TaxCategory } from "../src/lib/tax";
import {
  apiBase,
  ensureSessionAuth,
  staffHeaders,
  verifyStaffId,
} from "./helpers/rmsCharge";

type CreatedTaxProduct = {
  categoryId: string;
  productId: string;
  variantId: string;
  sku: string;
  unitCost: string;
};

type CheckoutResponse = {
  transaction_id: string;
};

type TransactionDetailResponse = {
  total_price: string;
  items: Array<{
    transaction_line_id: string;
    sku: string;
    quantity: number;
    quantity_returned: number;
  }>;
};

type RefundQueueRow = {
  transaction_id: string;
  amount_due: string;
  amount_refunded: string;
  is_open: boolean;
};

type QboJournalLine = {
  qbo_account_id: string;
  qbo_account_name: string;
  debit: string | number;
  credit: string | number;
  memo: string;
  detail?: Array<Record<string, unknown>>;
};

function uniqueSuffix(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function localBusinessDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function taxFor(category: TaxCategory, unitPrice: string) {
  return calculateNysErieTaxStringsForUnit(category, parseMoneyToCents(unitPrice));
}

function totalFor(unitPrice: string, stateTax: string, localTax: string, quantity = 1): string {
  const cents =
    (parseMoneyToCents(unitPrice) +
      parseMoneyToCents(stateTax) +
      parseMoneyToCents(localTax)) *
    quantity;
  return centsToFixed2(cents);
}

async function createTaxCategory(
  request: APIRequestContext,
  actorStaffId: string,
  isClothingFootwear: boolean,
  label: string,
): Promise<string> {
  const res = await request.post(`${apiBase()}/api/categories`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      name: `E2E Tax ${label}`,
      parent_id: null,
      is_clothing_footwear: isClothingFootwear,
      changed_by_staff_id: actorStaffId,
      change_note: "Created for tax audit E2E coverage",
    },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { id: string };
  expect(body.id).toBeTruthy();
  return body.id;
}

async function createTaxProduct(
  request: APIRequestContext,
  actorStaffId: string,
  options: {
    unitPrice: string;
    isClothingFootwear?: boolean;
    label: string;
    stockOnHand?: number;
  },
): Promise<CreatedTaxProduct> {
  const suffix = uniqueSuffix(options.label);
  const categoryId = await createTaxCategory(
    request,
    actorStaffId,
    options.isClothingFootwear ?? true,
    suffix,
  );
  const sku = `TAX-${suffix}`.toUpperCase();
  const unitCost = "40.00";

  const createRes = await request.post(`${apiBase()}/api/products`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      category_id: categoryId,
      name: `E2E Tax Audit Item ${suffix}`,
      brand: "Riverside E2E",
      description: "Deterministic tax audit SKU",
      base_retail_price: options.unitPrice,
      base_cost: unitCost,
      variation_axes: [],
      images: [],
      track_low_stock: false,
      publish_variants_to_web: false,
      variants: [
        {
          sku,
          variation_values: {},
          variation_label: "Standard",
          stock_on_hand: options.stockOnHand ?? 20,
          retail_price_override: null,
          cost_override: null,
          track_low_stock: false,
        },
      ],
    },
    failOnStatusCode: false,
  });
  expect(createRes.status()).toBe(200);
  const created = (await createRes.json()) as { id: string };

  const variantsRes = await request.get(`${apiBase()}/api/products/${created.id}/variants`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  expect(variantsRes.status()).toBe(200);
  const variants = (await variantsRes.json()) as Array<{ id: string; sku: string }>;
  expect(variants[0]?.id).toBeTruthy();

  return {
    categoryId,
    productId: created.id,
    variantId: variants[0]!.id,
    sku,
    unitCost,
  };
}

async function checkoutTaxProduct(
  request: APIRequestContext,
  options: {
    product: CreatedTaxProduct;
    sessionId: string;
    sessionToken: string;
    operatorStaffId: string;
    unitPrice: string;
    stateTax: string;
    localTax: string;
    quantity?: number;
    priceOverrideReason?: string;
  },
) {
  const quantity = options.quantity ?? 1;
  const total = totalFor(options.unitPrice, options.stateTax, options.localTax, quantity);
  return request.post(`${apiBase()}/api/transactions/checkout`, {
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
          quantity,
          unit_price: options.unitPrice,
          unit_cost: options.product.unitCost,
          state_tax: options.stateTax,
          local_tax: options.localTax,
          salesperson_id: options.operatorStaffId,
          price_override_reason: options.priceOverrideReason,
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
}

test.describe("tax audit contract", () => {
  test("checkout enforces NYS/Erie clothing threshold and discount crossing at server boundary", async ({
    request,
  }) => {
    test.setTimeout(90_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);

    const underThreshold = await createTaxProduct(request, operatorStaffId, {
      unitPrice: "109.99",
      label: "under-threshold",
    });
    const underTax = taxFor("clothing", "109.99");
    expect(underTax).toEqual({ stateTax: "0.00", localTax: "5.22" });
    const underRes = await checkoutTaxProduct(request, {
      product: underThreshold,
      sessionId,
      sessionToken,
      operatorStaffId,
      unitPrice: "109.99",
      stateTax: underTax.stateTax,
      localTax: underTax.localTax,
    });
    expect(underRes.status()).toBe(200);

    const atThreshold = await createTaxProduct(request, operatorStaffId, {
      unitPrice: "110.00",
      label: "at-threshold",
    });
    const atTax = taxFor("clothing", "110.00");
    expect(atTax).toEqual({ stateTax: "4.40", localTax: "5.23" });
    const atRes = await checkoutTaxProduct(request, {
      product: atThreshold,
      sessionId,
      sessionToken,
      operatorStaffId,
      unitPrice: "110.00",
      stateTax: atTax.stateTax,
      localTax: atTax.localTax,
    });
    expect(atRes.status()).toBe(200);

    const discountCrossing = await createTaxProduct(request, operatorStaffId, {
      unitPrice: "115.00",
      label: "discount-crossing",
    });
    const discountedTax = taxFor("clothing", "105.00");
    expect(discountedTax).toEqual({ stateTax: "0.00", localTax: "4.99" });
    const discountedRes = await checkoutTaxProduct(request, {
      product: discountCrossing,
      sessionId,
      sessionToken,
      operatorStaffId,
      unitPrice: "105.00",
      stateTax: discountedTax.stateTax,
      localTax: discountedTax.localTax,
      priceOverrideReason: "E2E discount crosses NYS clothing threshold",
    });
    expect(discountedRes.status()).toBe(200);

    const staleClientTax = taxFor("clothing", "115.00");
    const staleRes = await checkoutTaxProduct(request, {
      product: discountCrossing,
      sessionId,
      sessionToken,
      operatorStaffId,
      unitPrice: "105.00",
      stateTax: staleClientTax.stateTax,
      localTax: staleClientTax.localTax,
      priceOverrideReason: "E2E stale client tax should fail",
    });
    expect(staleRes.status()).toBe(400);
    await expect(staleRes.text()).resolves.toMatch(/Tax per unit/i);
  });

  test("returns reverse the original line-level tax into the refund queue", async ({ request }) => {
    test.setTimeout(90_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createTaxProduct(request, operatorStaffId, {
      unitPrice: "110.00",
      label: "return-tax",
    });
    const tax = taxFor("clothing", "110.00");
    const checkoutRes = await checkoutTaxProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
      unitPrice: "110.00",
      stateTax: tax.stateTax,
      localTax: tax.localTax,
      quantity: 2,
    });
    expect(checkoutRes.status()).toBe(200);
    const checkout = (await checkoutRes.json()) as CheckoutResponse;

    const beforeRes = await request.get(
      `${apiBase()}/api/transactions/${checkout.transaction_id}?register_session_id=${encodeURIComponent(sessionId)}`,
      {
        headers: {
          ...staffHeaders(),
          "x-riverside-pos-session-id": sessionId,
          "x-riverside-pos-session-token": sessionToken,
        },
        failOnStatusCode: false,
      },
    );
    expect(beforeRes.status()).toBe(200);
    const before = (await beforeRes.json()) as TransactionDetailResponse;
    const line = before.items.find((item) => item.sku === product.sku);
    expect(line?.transaction_line_id).toBeTruthy();

    const returnRes = await request.post(
      `${apiBase()}/api/transactions/${checkout.transaction_id}/returns?register_session_id=${encodeURIComponent(sessionId)}`,
      {
        headers: {
          ...staffHeaders(),
          "Content-Type": "application/json",
          "x-riverside-pos-session-id": sessionId,
          "x-riverside-pos-session-token": sessionToken,
        },
        data: {
          lines: [
            {
              transaction_line_id: line?.transaction_line_id,
              quantity: 1,
              reason: "tax_audit_return",
            },
          ],
        },
        failOnStatusCode: false,
      },
    );
    expect(returnRes.status()).toBe(200);

    const detailRes = await request.get(
      `${apiBase()}/api/transactions/${checkout.transaction_id}?register_session_id=${encodeURIComponent(sessionId)}`,
      {
        headers: {
          ...staffHeaders(),
          "x-riverside-pos-session-id": sessionId,
          "x-riverside-pos-session-token": sessionToken,
        },
        failOnStatusCode: false,
      },
    );
    expect(detailRes.status()).toBe(200);
    const detail = (await detailRes.json()) as TransactionDetailResponse;
    const returnedLine = detail.items.find((item) => item.sku === product.sku);
    expect(returnedLine?.quantity).toBe(2);
    expect(returnedLine?.quantity_returned).toBe(1);
    expect(detail.total_price).toBe("119.63");

    const refundQueueRes = await request.get(`${apiBase()}/api/transactions/refunds/due`, {
      headers: staffHeaders(),
      failOnStatusCode: false,
    });
    expect(refundQueueRes.status()).toBe(200);
    const refunds = (await refundQueueRes.json()) as RefundQueueRow[];
    const refund = refunds.find((row) => row.transaction_id === checkout.transaction_id);
    expect(refund?.is_open).toBe(true);
    expect(refund?.amount_due).toBe("119.63");
    expect(refund?.amount_refunded).toBe("0");
  });

  test("QBO proposed journal maps collected sales tax to the tax liability account", async ({
    request,
  }) => {
    test.setTimeout(90_000);
    const activityDate = localBusinessDate();
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createTaxProduct(request, operatorStaffId, {
      unitPrice: "110.00",
      label: "qbo-tax",
    });
    const seedMappingRes = await request.post(`${apiBase()}/api/test-support/qbo/seed-tax-mapping`, {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
      },
      data: {
        category_id: product.categoryId,
        activity_date: activityDate,
      },
      failOnStatusCode: false,
    });
    expect(seedMappingRes.status()).toBe(200);

    const tax = taxFor("clothing", "110.00");
    const checkoutRes = await checkoutTaxProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
      unitPrice: "110.00",
      stateTax: tax.stateTax,
      localTax: tax.localTax,
    });
    expect(checkoutRes.status()).toBe(200);

    const proposeRes = await request.post(`${apiBase()}/api/qbo/staging/propose`, {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
      },
      data: {
        activity_date: activityDate,
      },
      failOnStatusCode: false,
    });
    expect(proposeRes.status()).toBe(200);
    const proposed = (await proposeRes.json()) as {
      payload?: {
        lines?: QboJournalLine[];
      };
    };
    const taxLine = proposed.payload?.lines?.find(
      (line) => line.memo === "Sales tax collected" && line.qbo_account_id === "E2E_SALES_TAX",
    );
    expect(taxLine).toBeTruthy();
    expect(taxLine?.qbo_account_name).toBe("E2E Sales Tax Payable");
    expect(String(taxLine?.debit)).toBe("0");
    expect(String(taxLine?.credit)).toBe("9.63");
    expect(taxLine?.detail?.[0]).toMatchObject({
      state: "4.40",
      local: "5.23",
    });
  });
});
