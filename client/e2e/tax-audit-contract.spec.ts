import { expect, test, type APIRequestContext } from "@playwright/test";
import { centsToFixed2, parseMoneyToCents } from "../src/lib/money";
import { calculateNysErieTaxStringsForUnit, type TaxCategory } from "../src/lib/tax";
import { calculateCartLineTaxStrings } from "../src/lib/cartTax";
import {
  apiBase,
  ensureSessionAuth,
  staffHeaders,
  verifyStaffId,
} from "./helpers/rmsCharge";
import { createVendor } from "./helpers/inventoryReceiving";

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

type PosLineMeta = {
  product_id: string;
  variant_id: string;
  sku: string;
  name: string;
};

type ShippingQuoteResponse = {
  quote_id: string;
  amount_usd: string | number;
};

type TransactionDetailResponse = {
  total_price: string;
  fulfillment_method?: "pickup" | "ship";
  shipping_amount_usd?: string | null;
  items: Array<{
    transaction_line_id: string;
    sku: string;
    fulfillment?: string;
    is_fulfilled?: boolean;
    quantity: number;
    quantity_returned: number;
    state_tax?: string;
    local_tax?: string;
    tax_category?: string;
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

type NysTaxAuditResponse = {
  from: string;
  to: string;
  gross_sales: string;
  taxable_sales: string;
  nontaxable_sales: string;
  total_state_tax: string;
  total_local_tax: string;
  total_tax_collected: string;
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

function utcAuditDate(): string {
  return new Date().toISOString().slice(0, 10);
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
  parentId: string | null = null,
): Promise<string> {
  const res = await request.post(`${apiBase()}/api/categories`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      name: `E2E Tax ${label}`,
      parent_id: parentId,
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
    categoryId?: string;
    taxCategoryOverride?: "clothing" | "footwear" | "accessory" | "service" | null;
    label: string;
    stockOnHand?: number;
    unitCost?: string;
    employeeMarkupPercent?: string;
  },
): Promise<CreatedTaxProduct> {
  const suffix = uniqueSuffix(options.label);
  const categoryId =
    options.categoryId ??
    (await createTaxCategory(
      request,
      actorStaffId,
      options.isClothingFootwear ?? true,
      suffix,
    ));
  const sku = `TAX-${suffix}`.toUpperCase();
  const unitCost = options.unitCost ?? "40.00";
  const vendor = await createVendor(request, suffix);

  const createRes = await request.post(`${apiBase()}/api/products`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      category_id: categoryId,
      primary_vendor_id: vendor.id,
      name: `E2E Tax Audit Item ${suffix}`,
      brand: "Riverside E2E",
      description: "Deterministic tax audit SKU",
      base_retail_price: options.unitPrice,
      base_cost: unitCost,
      variation_axes: [],
      images: [],
      track_low_stock: false,
      publish_variants_to_web: false,
      tax_category_override: options.taxCategoryOverride ?? null,
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

  if (options.employeeMarkupPercent != null) {
    const patchRes = await request.patch(`${apiBase()}/api/products/${created.id}/model`, {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
        "x-riverside-station-key": "station-e2e",
      },
      data: {
        employee_markup_percent: options.employeeMarkupPercent,
      },
      failOnStatusCode: false,
    });
    const patchText = await patchRes.text();
    expect(patchRes.status(), patchText.slice(0, 1000)).toBe(200);
  }

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

async function createCustomerWithProfileDiscount(
  request: APIRequestContext,
  percent: string,
): Promise<string> {
  const suffix = uniqueSuffix("profile-discount");
  const createRes = await request.post(`${apiBase()}/api/customers`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      first_name: "Profile",
      last_name: `Discount ${suffix}`,
      phone: "7165550101",
      email: `${suffix}@example.com`,
    },
    failOnStatusCode: false,
  });
  const createText = await createRes.text();
  expect(createRes.status(), createText.slice(0, 1000)).toBe(200);
  const customer = JSON.parse(createText) as { id: string };
  expect(customer.id).toBeTruthy();

  const patchRes = await request.patch(`${apiBase()}/api/customers/${customer.id}`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      profile_discount_percent: percent,
    },
    failOnStatusCode: false,
  });
  const patchText = await patchRes.text();
  expect(patchRes.status(), patchText.slice(0, 1000)).toBe(200);
  return customer.id;
}

async function createBasicCustomer(
  request: APIRequestContext,
  label: string,
): Promise<string> {
  const suffix = uniqueSuffix(label);
  const createRes = await request.post(`${apiBase()}/api/customers`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      first_name: "Employee",
      last_name: `Discount ${suffix}`,
      phone: "7165550102",
      email: `${suffix}@example.com`,
    },
    failOnStatusCode: false,
  });
  const createText = await createRes.text();
  expect(createRes.status(), createText.slice(0, 1000)).toBe(200);
  const customer = JSON.parse(createText) as { id: string };
  expect(customer.id).toBeTruthy();
  return customer.id;
}

async function setStaffEmployeeCustomer(
  request: APIRequestContext,
  staffId: string,
  customerId: string | null,
) {
  const res = await request.patch(`${apiBase()}/api/staff/admin/${staffId}`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    data: customerId
      ? { employee_customer_id: customerId }
      : { detach_employee_customer: true },
    failOnStatusCode: false,
  });
  const text = await res.text();
  expect(res.status(), text.slice(0, 1000)).toBe(200);
}

async function linkCoupleCustomers(
  request: APIRequestContext,
  primaryCustomerId: string,
  partnerCustomerId: string,
) {
  const res = await request.post(
    `${apiBase()}/api/customers/${primaryCustomerId}/couple-link`,
    {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
        "x-riverside-station-key": "station-e2e",
      },
      data: { partner_id: partnerCustomerId },
      failOnStatusCode: false,
    },
  );
  const text = await res.text();
  expect(res.status(), text.slice(0, 1000)).toBe(200);
}

async function unlinkCoupleCustomer(request: APIRequestContext, customerId: string) {
  const res = await request.delete(`${apiBase()}/api/customers/${customerId}/couple-link`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const text = await res.text();
  expect(res.status(), text.slice(0, 1000)).toBe(200);
}

async function createVariantDiscountEvent(
  request: APIRequestContext,
  product: CreatedTaxProduct,
  percentOff: string,
): Promise<string> {
  const suffix = uniqueSuffix("below-cost-promo");
  const start = new Date(Date.now() - 60_000).toISOString();
  const end = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const createRes = await request.post(`${apiBase()}/api/discount-events`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      name: `E2E Below Cost Promo ${suffix}`,
      receipt_label: "E2E Approved Promo",
      starts_at: start,
      ends_at: end,
      percent_off: percentOff,
      scope_type: "variants",
    },
    failOnStatusCode: false,
  });
  const createText = await createRes.text();
  expect(createRes.status(), createText.slice(0, 1000)).toBe(200);
  const created = JSON.parse(createText) as { id: string };
  expect(created.id).toBeTruthy();

  const attachRes = await request.post(
    `${apiBase()}/api/discount-events/${created.id}/variants`,
    {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
      },
      data: {
        variant_id: product.variantId,
      },
      failOnStatusCode: false,
    },
  );
  const attachText = await attachRes.text();
  expect(attachRes.status(), attachText.slice(0, 1000)).toBe(200);
  return created.id;
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
    originalUnitPrice?: string;
    customerId?: string | null;
    isTaxExempt?: boolean;
    taxExemptReason?: string;
    discountEventId?: string;
    taxCategoryOverride?: "clothing" | "footwear" | "service" | "other";
    belowCostApproval?: {
      approved_by_staff_id: string;
      reason?: string;
      line_signature?: string;
    };
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
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      session_id: options.sessionId,
      operator_staff_id: options.operatorStaffId,
      primary_salesperson_id: options.operatorStaffId,
      customer_id: options.customerId ?? null,
      payment_method: "cash",
      total_price: total,
      amount_paid: total,
      is_tax_exempt: options.isTaxExempt ?? false,
      tax_exempt_reason: options.taxExemptReason,
      checkout_client_id: crypto.randomUUID(),
      below_cost_approval: options.belowCostApproval,
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
          original_unit_price: options.originalUnitPrice,
          price_override_reason: options.priceOverrideReason,
          discount_event_id: options.discountEventId,
          tax_category_override: options.taxCategoryOverride,
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

async function fetchGiftCardLoadMeta(request: APIRequestContext): Promise<PosLineMeta> {
  const res = await request.get(`${apiBase()}/api/pos/gift-card-load-line-meta`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  const meta = (await res.json()) as PosLineMeta | null;
  expect(meta?.product_id).toBeTruthy();
  expect(meta?.variant_id).toBeTruthy();
  return meta!;
}

async function seedShippingQuote(request: APIRequestContext, amountUsd: string): Promise<string> {
  const res = await request.post(`${apiBase()}/api/test-support/shipping/seed-quote`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
      "x-riverside-station-key": "station-e2e",
    },
    data: {
      amount_usd: amountUsd,
    },
    failOnStatusCode: false,
  });
  const text = await res.text();
  expect(res.status(), text.slice(0, 1000)).toBe(200);
  const body = JSON.parse(text) as ShippingQuoteResponse;
  expect(body.quote_id).toBeTruthy();
  return body.quote_id;
}

async function fetchNysTaxAudit(
  request: APIRequestContext,
  day: string,
): Promise<NysTaxAuditResponse> {
  const res = await request.get(`${apiBase()}/api/insights/nys-tax-audit?from=${day}&to=${day}`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const text = await res.text();
  expect(res.status(), text.slice(0, 1000)).toBe(200);
  return JSON.parse(text) as NysTaxAuditResponse;
}

test.describe("tax audit contract", () => {
  test("cart preserves zero tax for shipping SKU and alteration labor", () => {
    expect(
      calculateCartLineTaxStrings(
        { sku: " shipping ", tax_category: "other" },
        parseMoneyToCents("25.00"),
      ),
    ).toEqual({ stateTax: "0.00", localTax: "0.00" });
    expect(
      calculateCartLineTaxStrings(
        {
          sku: "ALTERATION-SERVICE",
          line_type: "alteration_service",
          tax_category: "other",
        },
        parseMoneyToCents("25.00"),
      ),
    ).toEqual({ stateTax: "0.00", localTax: "0.00" });
  });

  test("line No Tax override survives checkout and sale persistence", async ({ request }) => {
    test.setTimeout(90_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createTaxProduct(request, operatorStaffId, {
      unitPrice: "25.00",
      isClothingFootwear: false,
      label: "line-no-tax",
    });
    const checkoutRes = await checkoutTaxProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
      unitPrice: "25.00",
      stateTax: "0.00",
      localTax: "0.00",
      taxCategoryOverride: "service",
    });
    const checkoutText = await checkoutRes.text();
    expect(checkoutRes.status(), checkoutText.slice(0, 1000)).toBe(200);
    const checkout = JSON.parse(checkoutText) as CheckoutResponse;

    const detailRes = await request.get(
      `${apiBase()}/api/transactions/${checkout.transaction_id}?register_session_id=${encodeURIComponent(sessionId)}`,
      {
        headers: {
          ...staffHeaders(),
          "x-riverside-pos-session-id": sessionId,
          "x-riverside-pos-session-token": sessionToken,
          "x-riverside-station-key": "station-e2e",
        },
        failOnStatusCode: false,
      },
    );
    expect(detailRes.status()).toBe(200);
    const detail = (await detailRes.json()) as TransactionDetailResponse;
    expect(parseMoneyToCents(detail.items[0]?.state_tax ?? "")).toBe(0);
    expect(parseMoneyToCents(detail.items[0]?.local_tax ?? "")).toBe(0);
    expect(detail.items[0]?.tax_category).toBe("service");
  });

  test("category inheritance and parent-product override drive server tax rules", async ({
    request,
  }) => {
    test.setTimeout(90_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);

    const parentCategoryId = await createTaxCategory(
      request,
      operatorStaffId,
      true,
      uniqueSuffix("parent-clothing"),
    );
    const childCategoryId = await createTaxCategory(
      request,
      operatorStaffId,
      false,
      uniqueSuffix("child-inherits"),
      parentCategoryId,
    );
    const inherited = await createTaxProduct(request, operatorStaffId, {
      unitPrice: "109.99",
      categoryId: childCategoryId,
      label: "child-inherits",
    });
    const inheritedTax = taxFor("clothing", "109.99");
    const inheritedRes = await checkoutTaxProduct(request, {
      product: inherited,
      sessionId,
      sessionToken,
      operatorStaffId,
      unitPrice: "109.99",
      stateTax: inheritedTax.stateTax,
      localTax: inheritedTax.localTax,
    });
    expect(inheritedRes.status()).toBe(200);

    const overrideService = await createTaxProduct(request, operatorStaffId, {
      unitPrice: "109.99",
      categoryId: parentCategoryId,
      taxCategoryOverride: "service",
      label: "product-service-override",
    });
    const serviceTax = taxFor("service", "109.99");
    expect(serviceTax).toEqual({ stateTax: "0.00", localTax: "0.00" });
    const serviceRes = await checkoutTaxProduct(request, {
      product: overrideService,
      sessionId,
      sessionToken,
      operatorStaffId,
      unitPrice: "109.99",
      stateTax: serviceTax.stateTax,
      localTax: serviceTax.localTax,
    });
    expect(serviceRes.status()).toBe(200);

    const staleInheritedTaxRes = await checkoutTaxProduct(request, {
      product: overrideService,
      sessionId,
      sessionToken,
      operatorStaffId,
      unitPrice: "109.99",
      stateTax: inheritedTax.stateTax,
      localTax: inheritedTax.localTax,
    });
    expect(staleInheritedTaxRes.status()).toBe(400);
    await expect(staleInheritedTaxRes.text()).resolves.toMatch(/Tax per unit/i);
  });

  test("NYS tax audit reports checkout tax categories and per-item threshold", async ({
    request,
  }) => {
    test.setTimeout(90_000);
    const day = utcAuditDate();
    const before = await fetchNysTaxAudit(request, day);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);

    const parentCategoryId = await createTaxCategory(
      request,
      operatorStaffId,
      true,
      uniqueSuffix("audit-parent-clothing"),
    );
    const childCategoryId = await createTaxCategory(
      request,
      operatorStaffId,
      false,
      uniqueSuffix("audit-child-inherits"),
      parentCategoryId,
    );
    const twoUnitClothing = await createTaxProduct(request, operatorStaffId, {
      unitPrice: "60.00",
      categoryId: childCategoryId,
      label: "audit-two-under-threshold",
    });
    const underTax = taxFor("clothing", "60.00");
    expect(underTax).toEqual({ stateTax: "0.00", localTax: "2.85" });
    const clothingRes = await checkoutTaxProduct(request, {
      product: twoUnitClothing,
      sessionId,
      sessionToken,
      operatorStaffId,
      unitPrice: "60.00",
      stateTax: underTax.stateTax,
      localTax: underTax.localTax,
      quantity: 2,
    });
    expect(clothingRes.status()).toBe(200);

    const serviceOverride = await createTaxProduct(request, operatorStaffId, {
      unitPrice: "60.00",
      categoryId: parentCategoryId,
      taxCategoryOverride: "service",
      label: "audit-service-override",
    });
    const serviceRes = await checkoutTaxProduct(request, {
      product: serviceOverride,
      sessionId,
      sessionToken,
      operatorStaffId,
      unitPrice: "60.00",
      stateTax: "0.00",
      localTax: "0.00",
    });
    expect(serviceRes.status()).toBe(200);

    const after = await fetchNysTaxAudit(request, day);
    expect(
      parseMoneyToCents(after.gross_sales) - parseMoneyToCents(before.gross_sales)
    ).toBe(18000); // $120.00 clothing + $60.00 service
    expect(
      parseMoneyToCents(after.taxable_sales) - parseMoneyToCents(before.taxable_sales)
    ).toBe(0);
    expect(
      parseMoneyToCents(after.nontaxable_sales) - parseMoneyToCents(before.nontaxable_sales)
    ).toBe(18000); // $120.00 clothing under threshold + $60.00 non-taxable service
    expect(
      parseMoneyToCents(after.total_state_tax) - parseMoneyToCents(before.total_state_tax)
    ).toBe(0);
    expect(
      parseMoneyToCents(after.total_local_tax) - parseMoneyToCents(before.total_local_tax)
    ).toBe(570); // Local tax on clothing ($2.85 * 2)
    expect(
      parseMoneyToCents(after.total_tax_collected) - parseMoneyToCents(before.total_tax_collected)
    ).toBe(570);
  });

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
      originalUnitPrice: "115.00",
    });
    expect(discountedRes.status()).toBe(200);
    const discountedCheckout = (await discountedRes.json()) as CheckoutResponse;
    const discountedReceiptRes = await request.get(
      `${apiBase()}/api/transactions/${discountedCheckout.transaction_id}/receipt.escpos?register_session_id=${encodeURIComponent(sessionId)}`,
      {
        headers: {
          ...staffHeaders(),
          "x-riverside-pos-session-id": sessionId,
          "x-riverside-pos-session-token": sessionToken,
      "x-riverside-station-key": "station-e2e",
        },
        failOnStatusCode: false,
      },
    );
    expect(discountedReceiptRes.status()).toBe(200);
    const discountedReceiptBody = await discountedReceiptRes.text();
    const discountedReceipt =
      (JSON.parse(discountedReceiptBody) as { receiptline_markdown?: string })
        .receiptline_markdown ?? "";
    expect(discountedReceipt).toContain("Subtotal | $105.00");
    expect(discountedReceipt).toContain("Taxes | $4.99");
    expect(discountedReceipt).toContain("Total Savings | $10.00");
    expect(discountedReceipt).toContain("Total | ^^$109.99");
    expect(discountedReceipt).toContain("Status | Complete");

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

  test("customer profile discounts are accepted only for the linked customer rate", async ({
    request,
  }) => {
    test.setTimeout(90_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const customerId = await createCustomerWithProfileDiscount(request, "15.00");
    const product = await createTaxProduct(request, operatorStaffId, {
      unitPrice: "100.00",
      label: "customer-profile-discount",
    });
    const discountedTax = taxFor("clothing", "85.00");

    const validRes = await checkoutTaxProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
      customerId,
      unitPrice: "85.00",
      originalUnitPrice: "100.00",
      stateTax: discountedTax.stateTax,
      localTax: discountedTax.localTax,
      priceOverrideReason: "Customer profile discount",
    });
    const validText = await validRes.text();
    expect(validRes.status(), validText.slice(0, 1000)).toBe(200);

    const missingCustomerRes = await checkoutTaxProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
      unitPrice: "85.00",
      originalUnitPrice: "100.00",
      stateTax: discountedTax.stateTax,
      localTax: discountedTax.localTax,
      priceOverrideReason: "Customer profile discount",
    });
    expect(missingCustomerRes.status()).toBe(400);
    await expect(missingCustomerRes.text()).resolves.toMatch(/requires a linked customer/i);

    const wrongPriceTax = taxFor("clothing", "80.00");
    const wrongPriceRes = await checkoutTaxProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
      customerId,
      unitPrice: "80.00",
      originalUnitPrice: "100.00",
      stateTax: wrongPriceTax.stateTax,
      localTax: wrongPriceTax.localTax,
      priceOverrideReason: "Customer profile discount",
    });
    expect(wrongPriceRes.status()).toBe(400);
    await expect(wrongPriceRes.text()).resolves.toMatch(/customer profile discount/i);
  });

  test("customer profile discounts follow the selected profile before couple financial redirection", async ({
    request,
  }) => {
    test.setTimeout(90_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const primaryCustomerId = await createBasicCustomer(request, "couple-primary-no-discount");
    const partnerCustomerId = await createCustomerWithProfileDiscount(request, "15.00");
    const product = await createTaxProduct(request, operatorStaffId, {
      unitPrice: "100.00",
      label: "couple-profile-discount",
    });
    const discountedTax = taxFor("clothing", "85.00");

    try {
      await linkCoupleCustomers(request, primaryCustomerId, partnerCustomerId);

      const validRes = await checkoutTaxProduct(request, {
        product,
        sessionId,
        sessionToken,
        operatorStaffId,
        customerId: partnerCustomerId,
        unitPrice: "85.00",
        originalUnitPrice: "100.00",
        stateTax: discountedTax.stateTax,
        localTax: discountedTax.localTax,
        priceOverrideReason: "Customer profile discount",
      });
      const validText = await validRes.text();
      expect(validRes.status(), validText.slice(0, 1000)).toBe(200);
    } finally {
      await unlinkCoupleCustomer(request, primaryCustomerId);
    }
  });

  test("employee discounts require linked employee customer and exact employee price", async ({
    request,
  }) => {
    test.setTimeout(90_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const employeeCustomerId = await createBasicCustomer(request, "employee-discount");
    const product = await createTaxProduct(request, operatorStaffId, {
      unitPrice: "150.00",
      unitCost: "80.00",
      employeeMarkupPercent: "25.00",
      label: "employee-discount",
    });
    const employeeTax = taxFor("clothing", "100.00");

    try {
      await setStaffEmployeeCustomer(request, operatorStaffId, employeeCustomerId);

      const customerRes = await request.get(`${apiBase()}/api/customers/${employeeCustomerId}`, {
        headers: staffHeaders(),
        failOnStatusCode: false,
      });
      const customerText = await customerRes.text();
      expect(customerRes.status(), customerText.slice(0, 1000)).toBe(200);
      expect(JSON.parse(customerText).employee_discount_eligible).toBe(true);

      const validRes = await checkoutTaxProduct(request, {
        product,
        sessionId,
        sessionToken,
        operatorStaffId,
        customerId: employeeCustomerId,
        unitPrice: "100.00",
        originalUnitPrice: "150.00",
        stateTax: employeeTax.stateTax,
        localTax: employeeTax.localTax,
        priceOverrideReason: "Employee Discount",
      });
      const validText = await validRes.text();
      expect(validRes.status(), validText.slice(0, 1000)).toBe(200);

      const wrongPriceTax = taxFor("clothing", "95.00");
      const wrongPriceRes = await checkoutTaxProduct(request, {
        product,
        sessionId,
        sessionToken,
        operatorStaffId,
        customerId: employeeCustomerId,
        unitPrice: "95.00",
        originalUnitPrice: "150.00",
        stateTax: wrongPriceTax.stateTax,
        localTax: wrongPriceTax.localTax,
        priceOverrideReason: "Employee Discount",
      });
      expect(wrongPriceRes.status()).toBe(400);
      await expect(wrongPriceRes.text()).resolves.toMatch(/employee price/i);

      const missingCustomerRes = await checkoutTaxProduct(request, {
        product,
        sessionId,
        sessionToken,
        operatorStaffId,
        unitPrice: "100.00",
        originalUnitPrice: "150.00",
        stateTax: employeeTax.stateTax,
        localTax: employeeTax.localTax,
        priceOverrideReason: "Employee Discount",
      });
      expect(missingCustomerRes.status()).toBe(400);
      await expect(missingCustomerRes.text()).resolves.toMatch(/linked employee customer/i);
    } finally {
      await setStaffEmployeeCustomer(request, operatorStaffId, null);
    }
  });

  test("manual below-cost discounts require manager approval unless promotion-backed", async ({
    request,
  }) => {
    test.setTimeout(90_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createTaxProduct(request, operatorStaffId, {
      unitPrice: "100.00",
      unitCost: "80.00",
      label: "below-cost-manual",
    });
    const belowCostTax = taxFor("clothing", "70.00");

    const blockedRes = await checkoutTaxProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
      unitPrice: "70.00",
      originalUnitPrice: "100.00",
      stateTax: belowCostTax.stateTax,
      localTax: belowCostTax.localTax,
      priceOverrideReason: "E2E manual below cost",
    });
    const blockedText = await blockedRes.text();
    expect(blockedRes.status(), blockedText.slice(0, 1000)).toBe(400);
    expect(blockedText).toMatch(/below cost.*manager/i);

    const approvedRes = await checkoutTaxProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
      unitPrice: "70.00",
      originalUnitPrice: "100.00",
      stateTax: belowCostTax.stateTax,
      localTax: belowCostTax.localTax,
      priceOverrideReason: "E2E manual below cost",
      belowCostApproval: {
        approved_by_staff_id: operatorStaffId,
        reason: "E2E manager approved below-cost discount",
        line_signature: "e2e-manual-below-cost",
      },
    });
    const approvedText = await approvedRes.text();
    expect(approvedRes.status(), approvedText.slice(0, 1000)).toBe(200);

    const promoProduct = await createTaxProduct(request, operatorStaffId, {
      unitPrice: "100.00",
      unitCost: "80.00",
      label: "below-cost-promo",
    });
    const discountEventId = await createVariantDiscountEvent(
      request,
      promoProduct,
      "35.00",
    );
    const promoTax = taxFor("clothing", "65.00");
    const promoRes = await checkoutTaxProduct(request, {
      product: promoProduct,
      sessionId,
      sessionToken,
      operatorStaffId,
      unitPrice: "65.00",
      originalUnitPrice: "100.00",
      stateTax: promoTax.stateTax,
      localTax: promoTax.localTax,
      discountEventId,
    });
    const promoText = await promoRes.text();
    expect(promoRes.status(), promoText.slice(0, 1000)).toBe(200);
  });

  test("tax-exempt checkout requires a reason and preserves zero tax at server boundary", async ({
    request,
  }) => {
    test.setTimeout(90_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createTaxProduct(request, operatorStaffId, {
      unitPrice: "110.00",
      label: "tax-exempt-reason",
    });

    const missingReasonRes = await checkoutTaxProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
      unitPrice: "110.00",
      stateTax: "0.00",
      localTax: "0.00",
      isTaxExempt: true,
    });
    expect(missingReasonRes.status()).toBe(400);
    await expect(missingReasonRes.text()).resolves.toMatch(/tax_exempt_reason/i);

    const exemptRes = await checkoutTaxProduct(request, {
      product,
      sessionId,
      sessionToken,
      operatorStaffId,
      unitPrice: "110.00",
      stateTax: "0.00",
      localTax: "0.00",
      isTaxExempt: true,
      taxExemptReason: "E2E resale certificate",
    });
    expect(exemptRes.status()).toBe(200);
    const checkout = (await exemptRes.json()) as CheckoutResponse;
    const detailRes = await request.get(
      `${apiBase()}/api/transactions/${checkout.transaction_id}?register_session_id=${encodeURIComponent(sessionId)}`,
      {
        headers: {
          ...staffHeaders(),
          "x-riverside-pos-session-id": sessionId,
          "x-riverside-pos-session-token": sessionToken,
      "x-riverside-station-key": "station-e2e",
        },
        failOnStatusCode: false,
      },
    );
    expect(detailRes.status()).toBe(200);
    const detail = (await detailRes.json()) as TransactionDetailResponse;
    expect(detail.total_price).toBe("110.00");
  });

  test("gift card load lines remain non-taxable even when amount is taxable-sized", async ({
    request,
  }) => {
    test.setTimeout(90_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const meta = await fetchGiftCardLoadMeta(request);
    const giftCardCode = `TAXGC${Date.now()}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
    const amount = "150.00";
    const res = await request.post(`${apiBase()}/api/transactions/checkout`, {
      headers: {
        ...staffHeaders(),
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
        total_price: amount,
        amount_paid: amount,
        checkout_client_id: crypto.randomUUID(),
        items: [
          {
            product_id: meta.product_id,
            variant_id: meta.variant_id,
            fulfillment: "takeaway",
            quantity: 1,
            unit_price: amount,
            unit_cost: "0.00",
            state_tax: "0.00",
            local_tax: "0.00",
            salesperson_id: operatorStaffId,
            price_override_reason: "pos_gift_card_load",
            original_unit_price: "0.00",
            gift_card_load_code: giftCardCode,
          },
        ],
        payment_splits: [{ payment_method: "cash", amount }],
      },
      failOnStatusCode: false,
    });
    const text = await res.text();
    expect(res.status(), text.slice(0, 1000)).toBe(200);
    const checkout = JSON.parse(text) as CheckoutResponse;
    const detailRes = await request.get(
      `${apiBase()}/api/transactions/${checkout.transaction_id}?register_session_id=${encodeURIComponent(sessionId)}`,
      {
        headers: {
          ...staffHeaders(),
          "x-riverside-pos-session-id": sessionId,
          "x-riverside-pos-session-token": sessionToken,
      "x-riverside-station-key": "station-e2e",
        },
        failOnStatusCode: false,
      },
    );
    expect(detailRes.status()).toBe(200);
    const detail = (await detailRes.json()) as TransactionDetailResponse;
    expect(detail.total_price).toBe(amount);
  });

  test("ship current sale records shipping without requiring an order line", async ({ request }) => {
    test.setTimeout(90_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createTaxProduct(request, operatorStaffId, {
      unitPrice: "110.00",
      label: "shipping-tax",
    });
    const tax = taxFor("clothing", "110.00");
    const shippingQuoteId = await seedShippingQuote(request, "12.00");
    const total = centsToFixed2(
      parseMoneyToCents("110.00") +
        parseMoneyToCents(tax.stateTax) +
        parseMoneyToCents(tax.localTax) +
        parseMoneyToCents("12.00"),
    );
    expect(total).toBe("131.63");

    const res = await request.post(`${apiBase()}/api/transactions/checkout`, {
      headers: {
        ...staffHeaders(),
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
        total_price: total,
        amount_paid: total,
        checkout_client_id: crypto.randomUUID(),
        shipping_rate_quote_id: shippingQuoteId,
        items: [
          {
            product_id: product.productId,
            variant_id: product.variantId,
            fulfillment: "takeaway",
            quantity: 1,
            unit_price: "110.00",
            unit_cost: product.unitCost,
            state_tax: tax.stateTax,
            local_tax: tax.localTax,
            salesperson_id: operatorStaffId,
          },
        ],
        payment_splits: [{ payment_method: "cash", amount: total }],
      },
      failOnStatusCode: false,
    });
    const text = await res.text();
    expect(res.status(), text.slice(0, 1000)).toBe(200);
    const checkout = JSON.parse(text) as CheckoutResponse;
    const detailRes = await request.get(
      `${apiBase()}/api/transactions/${checkout.transaction_id}?register_session_id=${encodeURIComponent(sessionId)}`,
      {
        headers: {
          ...staffHeaders(),
          "x-riverside-pos-session-id": sessionId,
          "x-riverside-pos-session-token": sessionToken,
      "x-riverside-station-key": "station-e2e",
        },
        failOnStatusCode: false,
      },
    );
    expect(detailRes.status()).toBe(200);
    const detail = (await detailRes.json()) as TransactionDetailResponse;
    expect(detail.total_price).toBe(total);
    expect(detail.fulfillment_method).toBe("ship");
    expect(detail.shipping_amount_usd).toBe("12.00");
    expect(detail.items[0]?.fulfillment).toBe("takeaway");
    expect(detail.items[0]?.is_fulfilled).toBe(true);
  });

  test("ship fulfillment mode requires Register shipping quote", async ({ request }) => {
    test.setTimeout(90_000);
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const product = await createTaxProduct(request, operatorStaffId, {
      unitPrice: "110.00",
      label: "ship-mode-no-quote",
    });
    const tax = taxFor("clothing", "110.00");
    const total = totalFor("110.00", tax.stateTax, tax.localTax);

    const res = await request.post(`${apiBase()}/api/transactions/checkout`, {
      headers: {
        ...staffHeaders(),
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
        total_price: total,
        amount_paid: total,
        checkout_client_id: crypto.randomUUID(),
        fulfillment_mode: "ship",
        ship_to: {
          name: "Quote Missing Customer",
          street1: "1 Main St",
          city: "Buffalo",
          state: "NY",
          zip: "14202",
          country: "US",
        },
        items: [
          {
            product_id: product.productId,
            variant_id: product.variantId,
            fulfillment: "takeaway",
            quantity: 1,
            unit_price: "110.00",
            unit_cost: product.unitCost,
            state_tax: tax.stateTax,
            local_tax: tax.localTax,
            salesperson_id: operatorStaffId,
          },
        ],
        payment_splits: [{ payment_method: "cash", amount: total }],
      },
      failOnStatusCode: false,
    });
    const text = await res.text();
    expect(res.status(), text.slice(0, 1000)).toBe(400);
    expect(text).toContain("Ship current sale requires the Register Shipping action");
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
      "x-riverside-station-key": "station-e2e",
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
      "x-riverside-station-key": "station-e2e",
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
      "x-riverside-station-key": "station-e2e",
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
      "x-riverside-station-key": "station-e2e",
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
      "x-riverside-station-key": "station-e2e",
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
      (line) =>
        line.memo === "Sales tax collected" &&
        line.qbo_account_id === "E2E_SALES_TAX" &&
        line.detail?.some(
          (detail) => String(detail.state) === "4.40" && String(detail.local) === "5.23",
        ),
    );
    expect(taxLine).toBeTruthy();
    expect(taxLine?.qbo_account_name).toBe("E2E Sales Tax Payable");
    expect(String(taxLine?.debit)).toBe("0");
    expect(String(taxLine?.credit)).toBe("9.63");
    expect(taxLine?.detail).toContainEqual(expect.objectContaining({ state: "4.40", local: "5.23" }));
  });
});
