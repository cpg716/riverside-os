import { expect, test, type APIRequestContext } from "@playwright/test";
import { centsToFixed2, parseMoneyToCents } from "../src/lib/money";
import { calculateNysErieTaxStringsForUnit } from "../src/lib/tax";
import {
  apiBase,
  ensureSessionAuth,
  staffHeaders,
  verifyStaffId,
} from "./helpers/rmsCharge";
import { createVendor } from "./helpers/inventoryReceiving";

type CreatedCommissionProduct = {
  categoryId: string;
  productId: string;
  variantId: string;
  sku: string;
  unitPrice: string;
  unitCost: string;
};

type CheckoutResponse = {
  transaction_id: string;
};

type TransactionDetailResponse = {
  total_price: string;
  items: Array<{
    transaction_line_id: string;
    product_name: string;
    sku: string;
    quantity: number;
    is_fulfilled: boolean;
    is_internal: boolean;
    custom_item_type?: string | null;
  }>;
};

type CommissionLine = {
  event_id: string | null;
  event_type: string;
  transaction_line_id: string | null;
  transaction_id: string | null;
  calculated_commission: string;
  is_fulfilled: boolean;
};

type CommissionLedgerRow = {
  staff_id?: string | null;
  unpaid_commission: string;
  realized_pending_payout: string;
  paid_out_commission: string;
};

function uniqueSuffix(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function utcDate(offsetDays = 0): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function totalFor(unitPrice: string, quantity = 1): string {
  const taxes = calculateNysErieTaxStringsForUnit("other", parseMoneyToCents(unitPrice));
  const cents =
    (parseMoneyToCents(unitPrice) +
      parseMoneyToCents(taxes.stateTax) +
      parseMoneyToCents(taxes.localTax)) *
    quantity;
  return centsToFixed2(cents);
}

function expectMoney(actual: string | undefined, expected: string) {
  expect(Number.parseFloat(actual ?? "NaN")).toBeCloseTo(Number.parseFloat(expected), 2);
}

async function createCommissionStaff(
  request: APIRequestContext,
  label: string,
  baseCommissionRate: string,
): Promise<string> {
  const res = await request.post(`${apiBase()}/api/staff/admin`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      full_name: `E2E Commission ${label} ${uniqueSuffix("staff")}`,
      role: "salesperson",
      is_active: true,
      base_commission_rate: baseCommissionRate,
      max_discount_percent: "30",
    },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { id: string };
  expect(body.id).toBeTruthy();
  return body.id;
}

async function patchStaffRate(
  request: APIRequestContext,
  staffId: string,
  rate: string,
  recalculate: boolean,
) {
  const res = await request.patch(`${apiBase()}/api/staff/admin/${staffId}`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      base_commission_rate: rate,
      commission_effective_start_date: utcDate(),
      recalculate_commissions_from_effective_date: recalculate,
      commission_change_note: "E2E commission audit rate change",
    },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  return res;
}

async function createCommissionCategory(
  request: APIRequestContext,
  actorStaffId: string,
  label: string,
): Promise<string> {
  const res = await request.post(`${apiBase()}/api/categories`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      name: `E2E Commission ${label}`,
      parent_id: null,
      is_clothing_footwear: false,
      changed_by_staff_id: actorStaffId,
      change_note: "Created for commission audit E2E coverage",
    },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { id: string };
  expect(body.id).toBeTruthy();
  return body.id;
}

async function createCommissionProduct(
  request: APIRequestContext,
  actorStaffId: string,
  options: {
    label: string;
    unitPrice?: string;
    categoryId?: string;
    stockOnHand?: number;
  },
): Promise<CreatedCommissionProduct> {
  const suffix = uniqueSuffix(options.label);
  const categoryId =
    options.categoryId ?? (await createCommissionCategory(request, actorStaffId, suffix));
  const sku = `COMM-${suffix}`.toUpperCase();
  const unitPrice = options.unitPrice ?? "100.00";
  const unitCost = "40.00";
  const vendor = await createVendor(request, suffix);
  const createRes = await request.post(`${apiBase()}/api/products`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      category_id: categoryId,
      primary_vendor_id: vendor.id,
      name: `E2E Commission Item ${suffix}`,
      brand: "Riverside E2E",
      description: "Deterministic commission audit SKU",
      base_retail_price: unitPrice,
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
    unitPrice,
    unitCost,
  };
}

async function upsertCommissionRule(
  request: APIRequestContext,
  matchType: "category" | "product" | "variant",
  matchId: string,
  overrideRate: string,
  label: string,
) {
  const res = await request.post(`${apiBase()}/api/staff/commissions/rules`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      match_type: matchType,
      match_id: matchId,
      override_rate: overrideRate,
      fixed_spiff_amount: "0.00",
      label,
      is_active: true,
    },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
}

async function setCategoryDefaultCommission(
  request: APIRequestContext,
  categoryId: string,
  rate: string,
) {
  const res = await request.patch(`${apiBase()}/api/staff/admin/category-commissions/${categoryId}`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      commission_rate: rate,
    },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
}

async function checkoutProducts(
  request: APIRequestContext,
  options: {
    sessionId: string;
    sessionToken: string;
    operatorStaffId: string;
    salespersonId: string;
    products: CreatedCommissionProduct[];
    fulfillment: "takeaway" | "special_order";
  },
) {
  const totalCents = options.products.reduce(
    (sum, product) => sum + parseMoneyToCents(totalFor(product.unitPrice)),
    0,
  );
  const total = centsToFixed2(totalCents);
  const items = options.products.map((product) => {
    const tax = calculateNysErieTaxStringsForUnit("other", parseMoneyToCents(product.unitPrice));
    return {
      product_id: product.productId,
      variant_id: product.variantId,
      fulfillment: options.fulfillment,
      quantity: 1,
      unit_price: product.unitPrice,
      unit_cost: product.unitCost,
      state_tax: tax.stateTax,
      local_tax: tax.localTax,
      salesperson_id: options.salespersonId,
    };
  });
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
      primary_salesperson_id: options.salespersonId,
      customer_id: null,
      payment_method: "cash",
      total_price: total,
      amount_paid: total,
      checkout_client_id: crypto.randomUUID(),
      items,
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

async function fetchCommissionLines(
  request: APIRequestContext,
  staffId: string,
): Promise<CommissionLine[]> {
  const res = await request.get(
    `${apiBase()}/api/insights/commission-lines?staff_id=${encodeURIComponent(staffId)}&from=${utcDate()}&to=${utcDate()}`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as CommissionLine[];
}

async function fetchCommissionLine(
  request: APIRequestContext,
  staffId: string,
  transactionId: string,
  transactionLineId?: string,
): Promise<CommissionLine> {
  const rows = await fetchCommissionLines(request, staffId);
  const row = rows.find(
    (candidate) =>
      candidate.transaction_id === transactionId &&
      (!transactionLineId || candidate.transaction_line_id === transactionLineId),
  );
  expect(row, `missing commission line for transaction ${transactionId}`).toBeTruthy();
  return row!;
}

async function fetchCommissionLedgerRow(
  request: APIRequestContext,
  staffId: string,
): Promise<CommissionLedgerRow | undefined> {
  const res = await request.get(
    `${apiBase()}/api/insights/commission-ledger?from=${utcDate()}&to=${utcDate()}`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  expect(res.status()).toBe(200);
  const rows = (await res.json()) as CommissionLedgerRow[];
  return rows.find((row) => row.staff_id === staffId);
}

async function fetchTransactionDetail(
  request: APIRequestContext,
  transactionId: string,
): Promise<TransactionDetailResponse> {
  const res = await request.get(`${apiBase()}/api/transactions/${transactionId}`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as TransactionDetailResponse;
}

async function addManualAdjustment(
  request: APIRequestContext,
  staffId: string,
  amount: string,
  note: string,
) {
  return request.post(`${apiBase()}/api/insights/commission-adjustments`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      staff_id: staffId,
      reporting_date: utcDate(),
      amount,
      note,
    },
    failOnStatusCode: false,
  });
}

test.describe("commission audit contract", () => {
  test("fulfillment timing uses recognition date and staff rate snapshots report immutably", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const salespersonA = await createCommissionStaff(request, "Timing A", "0.1000");
    const salespersonB = await createCommissionStaff(request, "Timing B", "0.0500");
    const product = await createCommissionProduct(request, operatorStaffId, {
      label: "timing",
      unitPrice: "100.00",
    });

    const checkoutRes = await checkoutProducts(request, {
      sessionId,
      sessionToken,
      operatorStaffId,
      salespersonId: salespersonA,
      products: [product],
      fulfillment: "special_order",
    });
    expect(checkoutRes.status()).toBe(200);
    const checkout = (await checkoutRes.json()) as CheckoutResponse;
    const detail = await fetchTransactionDetail(request, checkout.transaction_id);
    const line = detail.items.find((item) => item.sku === product.sku);
    expect(line?.transaction_line_id).toBeTruthy();

    let commissionLine = await fetchCommissionLine(
      request,
      salespersonA,
      checkout.transaction_id,
      line?.transaction_line_id,
    );
    expect(commissionLine.is_fulfilled).toBe(false);
    expect(commissionLine.calculated_commission).toBe("10.00");
    let ledger = await fetchCommissionLedgerRow(request, salespersonA);
    expectMoney(ledger?.unpaid_commission, "10.00");
    expectMoney(ledger?.realized_pending_payout, "0.00");

    await patchStaffRate(request, salespersonA, "0.2000", false);
    commissionLine = await fetchCommissionLine(
      request,
      salespersonA,
      checkout.transaction_id,
      line?.transaction_line_id,
    );
    expect(commissionLine.calculated_commission).toBe("10.00");

    const pickupRes = await request.post(`${apiBase()}/api/transactions/${checkout.transaction_id}/pickup`, {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
      },
      data: {
        actor: "E2E Commission Timing",
      },
      failOnStatusCode: false,
    });
    expect(pickupRes.status()).toBe(200);

    commissionLine = await fetchCommissionLine(
      request,
      salespersonA,
      checkout.transaction_id,
      line?.transaction_line_id,
    );
    expect(commissionLine.is_fulfilled).toBe(true);
    expect(commissionLine.calculated_commission).toBe("20.00");
    ledger = await fetchCommissionLedgerRow(request, salespersonA);
    expectMoney(ledger?.unpaid_commission, "0.00");
    expectMoney(ledger?.realized_pending_payout, "20.00");

    await patchStaffRate(request, salespersonA, "0.5000", true);
    commissionLine = await fetchCommissionLine(
      request,
      salespersonA,
      checkout.transaction_id,
      line?.transaction_line_id,
    );
    expect(commissionLine.calculated_commission).toBe("20.00");

    const adjustmentRes = await addManualAdjustment(
      request,
      salespersonB,
      "-3.50",
      "E2E current-period adjustment",
    );
    expect(adjustmentRes.status()).toBe(200);
    const adjustedLedger = await fetchCommissionLedgerRow(request, salespersonB);
    expectMoney(adjustedLedger?.realized_pending_payout, "-3.50");
  });

  test("percentage overrides are ignored; staff base rate and fixed SPIFFs drive commission", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const salespersonId = await createCommissionStaff(request, "Specificity", "0.0100");

    const variantCategory = await createCommissionCategory(request, operatorStaffId, uniqueSuffix("variant-cat"));
    const productCategory = await createCommissionCategory(request, operatorStaffId, uniqueSuffix("product-cat"));
    const ruleCategory = await createCommissionCategory(request, operatorStaffId, uniqueSuffix("category-rule"));
    const defaultCategory = await createCommissionCategory(request, operatorStaffId, uniqueSuffix("category-default"));
    const staffBaseCategory = await createCommissionCategory(request, operatorStaffId, uniqueSuffix("staff-base"));

    const variantProduct = await createCommissionProduct(request, operatorStaffId, {
      label: "variant-specific",
      categoryId: variantCategory,
    });
    const productProduct = await createCommissionProduct(request, operatorStaffId, {
      label: "product-specific",
      categoryId: productCategory,
    });
    const categoryProduct = await createCommissionProduct(request, operatorStaffId, {
      label: "category-specific",
      categoryId: ruleCategory,
    });
    const defaultProduct = await createCommissionProduct(request, operatorStaffId, {
      label: "category-default",
      categoryId: defaultCategory,
    });
    const staffBaseProduct = await createCommissionProduct(request, operatorStaffId, {
      label: "staff-base",
      categoryId: staffBaseCategory,
    });

    await setCategoryDefaultCommission(request, variantCategory, "0.0300");
    await setCategoryDefaultCommission(request, productCategory, "0.0300");
    await setCategoryDefaultCommission(request, ruleCategory, "0.0300");
    await setCategoryDefaultCommission(request, defaultCategory, "0.0300");

    await upsertCommissionRule(request, "category", variantCategory, "0.0400", "E2E category under variant");
    await upsertCommissionRule(request, "product", variantProduct.productId, "0.0500", "E2E product under variant");
    await upsertCommissionRule(request, "variant", variantProduct.variantId, "0.0600", "E2E variant wins");
    await upsertCommissionRule(request, "category", productCategory, "0.0400", "E2E category under product");
    await upsertCommissionRule(request, "product", productProduct.productId, "0.0500", "E2E product wins");
    await upsertCommissionRule(request, "category", ruleCategory, "0.0400", "E2E category wins");

    const checkoutRes = await checkoutProducts(request, {
      sessionId,
      sessionToken,
      operatorStaffId,
      salespersonId,
      products: [
        variantProduct,
        productProduct,
        categoryProduct,
        defaultProduct,
        staffBaseProduct,
      ],
      fulfillment: "takeaway",
    });
    expect(checkoutRes.status()).toBe(200);
    const checkout = (await checkoutRes.json()) as CheckoutResponse;
    const detail = await fetchTransactionDetail(request, checkout.transaction_id);

    const expectedBySku = new Map([
      [variantProduct.sku, "1.00"],
      [productProduct.sku, "1.00"],
      [categoryProduct.sku, "1.00"],
      [defaultProduct.sku, "1.00"],
      [staffBaseProduct.sku, "1.00"],
    ]);
    for (const [sku, expectedCommission] of expectedBySku) {
      const line = detail.items.find((item) => item.sku === sku);
      expect(line?.transaction_line_id).toBeTruthy();
      const commissionLine = await fetchCommissionLine(
        request,
        salespersonId,
        checkout.transaction_id,
        line?.transaction_line_id,
      );
      expect(commissionLine.is_fulfilled).toBe(true);
      expect(commissionLine.calculated_commission).toBe(expectedCommission);
    }
  });

  test("combo SPIFF rewards are internal and excluded from customer receipt output", async ({
    request,
  }) => {
    test.setTimeout(90_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const salespersonId = await createCommissionStaff(request, "Combo", "0.0100");
    const product = await createCommissionProduct(request, operatorStaffId, {
      label: "combo-spiff",
      unitPrice: "100.00",
    });

    const comboRes = await request.post(`${apiBase()}/api/staff/commissions/combos`, {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
      },
      data: {
        label: `E2E Combo SPIFF ${uniqueSuffix("combo")}`,
        reward_amount: "12.34",
        is_active: true,
        items: [
          {
            match_type: "product",
            match_id: product.productId,
            qty_required: 1,
          },
        ],
      },
      failOnStatusCode: false,
    });
    expect(comboRes.status()).toBe(200);

    const checkoutRes = await checkoutProducts(request, {
      sessionId,
      sessionToken,
      operatorStaffId,
      salespersonId,
      products: [product],
      fulfillment: "takeaway",
    });
    const checkoutText = await checkoutRes.text();
    expect(checkoutRes.status(), checkoutText.slice(0, 1000)).toBe(200);
    const checkout = JSON.parse(checkoutText) as CheckoutResponse;
    const detail = await fetchTransactionDetail(request, checkout.transaction_id);
    const internalLines = detail.items.filter((item) => item.is_internal);
    expect(internalLines.length).toBeGreaterThanOrEqual(1);
    expect(internalLines.some((item) => item.custom_item_type === "spiff_reward")).toBe(true);

    const receiptRes = await request.get(
      `${apiBase()}/api/transactions/${checkout.transaction_id}/receipt.escpos?register_session_id=${encodeURIComponent(sessionId)}`,
      {
        headers: {
          ...staffHeaders(),
          "x-riverside-pos-session-id": sessionId,
          "x-riverside-pos-session-token": sessionToken,
        },
        failOnStatusCode: false,
      },
    );
    expect(receiptRes.status()).toBe(200);
    const receiptBody = await receiptRes.text();
    const receipt = (JSON.parse(receiptBody) as { receiptline_markdown?: string }).receiptline_markdown ?? "";
    expect(receipt).toContain(`SKU ${product.sku}`);
    expect(receipt).not.toContain("spiff_reward");
    expect(receipt).not.toContain("12.34");
  });
});
