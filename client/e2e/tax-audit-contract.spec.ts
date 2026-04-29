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
  parentId: string | null = null,
): Promise<string> {
  const res = await request.post(`${apiBase()}/api/categories`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
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
      customer_id: options.customerId ?? null,
      payment_method: "cash",
      total_price: total,
      amount_paid: total,
      is_tax_exempt: options.isTaxExempt ?? false,
      tax_exempt_reason: options.taxExemptReason,
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
          original_unit_price: options.originalUnitPrice,
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

test.describe("tax audit contract", () => {
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
