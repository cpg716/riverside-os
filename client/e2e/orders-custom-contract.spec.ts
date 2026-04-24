import { expect, test } from "@playwright/test";
import { parseMoneyToCents } from "../src/lib/money";
import { calculateNysErieTaxStringsForUnit } from "../src/lib/tax";
import {
  apiBase,
  ensureSessionAuth,
  seedRmsFixture,
  staffHeaders,
  verifyStaffId,
  type SeedFixtureResponse,
} from "./helpers/rmsCharge";
import {
  addPurchaseOrderLine,
  createDraftPurchaseOrder,
  createVendor,
  getPurchaseOrderDetail,
  receivePurchaseOrder,
  submitPurchaseOrder,
} from "./helpers/inventoryReceiving";

type CheckoutResponse = {
  transaction_id: string;
};

type ControlBoardRow = {
  product_id: string;
  variant_id: string;
  sku: string;
  retail_price: string;
  cost_price: string;
  state_tax: string;
  local_tax: string;
  primary_vendor_id?: string | null;
};

type TransactionDetail = {
  status?: string;
  amount_paid?: string;
  balance_due?: string;
  financial_summary?: {
    total_allocated_payments: string;
    total_applied_deposit_amount: string;
  };
  wedding_member_id?: string | null;
  wedding_summary?: {
    wedding_party_id: string;
    wedding_member_id: string;
    party_name?: string | null;
    event_date?: string | null;
    member_role?: string | null;
  } | null;
  items: Array<{
    fulfillment: string;
    sku: string;
    unit_cost: string;
    custom_item_type?: string | null;
    custom_order_details?: {
      subtype_key?: string | null;
      vendor_form_family?: string | null;
      garment_description?: string | null;
      fabric_reference?: string | null;
      style_reference?: string | null;
      reference_number?: string | null;
      hsm_garment_type?: string | null;
      hsm_model_code?: string | null;
      hsm_trim_reference?: string | null;
      hsm_coat_size?: string | null;
      hsm_pant_size?: string | null;
      hsm_left_sleeve?: string | null;
      hsm_right_sleeve?: string | null;
      hsm_lapel_style?: string | null;
      hsm_vent_style?: string | null;
      hsm_fabric_reservation_number?: string | null;
      shirt_collar_style?: string | null;
      shirt_cuff_style?: string | null;
      shirt_previous_order_number?: string | null;
      shirt_try_on_size?: string | null;
      shirt_shaping?: string | null;
      shirt_collar_size?: string | null;
      shirt_tail_length?: string | null;
      shirt_yoke?: string | null;
      shirt_right_sleeve_length?: string | null;
      shirt_left_sleeve_length?: string | null;
      shirt_right_cuff_size?: string | null;
      shirt_left_cuff_size?: string | null;
      shirt_shoulder_line?: string | null;
      shirt_front_style?: string | null;
      shirt_back_style?: string | null;
      shirt_tail_style?: string | null;
      shirt_button_choice?: string | null;
      shirt_pocket_style?: string | null;
      shirt_fit_notes?: string | null;
      custom_notes?: string | null;
    } | null;
  }>;
};

type TransactionItemList = Array<{
  transaction_line_id: string;
  sku: string;
  fulfillment: string;
  is_fulfilled: boolean;
}>;

type TransactionListResponse = {
  items: Array<{
    transaction_id: string;
    order_kind: string;
    party_name?: string | null;
    wedding_member_id?: string | null;
  }>;
};

const CUSTOM_CATALOG_CATEGORY_ID = "90000000-0000-0000-0000-000000000001";

type KnownCustomCatalogSeed = {
  name: string;
  retailPrice: string;
  costPrice: string;
};

const KNOWN_CUSTOM_CATALOG: Record<string, KnownCustomCatalogSeed> = {
  "100": {
    name: "HSM Custom Suit",
    retailPrice: "899.00",
    costPrice: "0.00",
  },
  "105": {
    name: "HSM Custom Sport Coat",
    retailPrice: "699.00",
    costPrice: "0.00",
  },
  "110": {
    name: "HSM Custom Slacks",
    retailPrice: "299.00",
    costPrice: "0.00",
  },
  "200": {
    name: "Individualized Custom Shirt",
    retailPrice: "249.00",
    costPrice: "0.00",
  },
};

async function createKnownCustomCatalogSku(
  request: Parameters<typeof test>[0]["request"],
  sku: string,
): Promise<void> {
  const seed = KNOWN_CUSTOM_CATALOG[sku];
  expect(seed, `missing known custom catalog seed for sku ${sku}`).toBeTruthy();

  const createRes = await request.post(`${apiBase()}/api/products`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      category_id: CUSTOM_CATALOG_CATEGORY_ID,
      name: seed.name,
      brand: "Riverside E2E",
      description: `Deterministic custom-order catalog SKU ${sku} for Playwright`,
      base_retail_price: seed.retailPrice,
      base_cost: seed.costPrice,
      variation_axes: [],
      images: [],
      track_low_stock: false,
      publish_variants_to_web: false,
      variants: [
        {
          sku,
          variation_values: {},
          variation_label: "Standard",
          stock_on_hand: 0,
          retail_price_override: null,
          cost_override: null,
          track_low_stock: false,
        },
      ],
    },
    failOnStatusCode: false,
  });

  if (createRes.ok()) {
    return;
  }

  const bodyText = await createRes.text();
  expect(
    createRes.status() === 409 ||
      bodyText.toLowerCase().includes("duplicate") ||
      bodyText.toLowerCase().includes("already exists"),
    `create known custom catalog sku ${sku} failed (${createRes.status()}): ${bodyText.slice(0, 1000)}`,
  ).toBeTruthy();
}

async function fetchCatalogPricing(
  request: Parameters<typeof test>[0]["request"],
  sku: string,
): Promise<ControlBoardRow> {
  const scanRes = await request.get(`${apiBase()}/api/inventory/scan/${encodeURIComponent(sku)}`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  if (scanRes.ok()) {
    const body = (await scanRes.json()) as {
      product_id: string;
      variant_id: string;
      sku: string;
      standard_retail_price: string;
      unit_cost: string;
      state_tax: string;
      local_tax: string;
      primary_vendor_id?: string | null;
    };
    return {
      product_id: body.product_id,
      variant_id: body.variant_id,
      sku: body.sku,
      retail_price: body.standard_retail_price,
      cost_price: body.unit_cost,
      state_tax: body.state_tax,
      local_tax: body.local_tax,
      primary_vendor_id: body.primary_vendor_id ?? null,
    };
  }

  const res = await request.get(
    `${apiBase()}/api/products/control-board?search=${encodeURIComponent(sku)}&limit=5`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { rows?: ControlBoardRow[] };
  const row = (body.rows ?? []).find((candidate) => candidate.sku === sku) ?? body.rows?.[0];
  if (row) {
    return row;
  }

  if (!KNOWN_CUSTOM_CATALOG[sku]) {
    expect(row).toBeTruthy();
    return row as ControlBoardRow;
  }

  await createKnownCustomCatalogSku(request, sku);

  const seededRes = await request.get(
    `${apiBase()}/api/products/control-board?search=${encodeURIComponent(sku)}&limit=5`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  expect(seededRes.status()).toBe(200);
  const seededBody = (await seededRes.json()) as { rows?: ControlBoardRow[] };
  const seededRow =
    (seededBody.rows ?? []).find((candidate) => candidate.sku === sku) ?? seededBody.rows?.[0];
  expect(seededRow).toBeTruthy();
  return seededRow as ControlBoardRow;
}

async function seedOrderFixture(
  request: Parameters<typeof test>[0]["request"],
  fixture: string,
  customerLabel: string,
): Promise<SeedFixtureResponse> {
  return seedRmsFixture(request, fixture, customerLabel);
}

async function checkoutOrder(
  request: Parameters<typeof test>[0]["request"],
  options: {
    sessionId: string;
    sessionToken: string;
    operatorStaffId: string;
    customerId: string;
    sku: string;
    fulfillment: "custom" | "special_order";
    customItemType?: string | null;
    customSalePrice?: string | null;
    customOrderDetails?: Record<string, string | null> | null;
    amountPaid?: string | null;
    appliedDepositAmount?: string | null;
  },
) {
  const pricing = await fetchCatalogPricing(request, options.sku);
  const customSalePrice = options.customSalePrice?.trim() || "899.00";
  const resolvedUnitPrice =
    options.fulfillment === "custom" ? customSalePrice : pricing.retail_price;
  const priceCents = parseMoneyToCents(resolvedUnitPrice);
  const { stateTax, localTax } = calculateNysErieTaxStringsForUnit("clothing", priceCents);
  const total = (
    Number.parseFloat(resolvedUnitPrice) +
    Number.parseFloat(options.fulfillment === "custom" ? stateTax : pricing.state_tax) +
    Number.parseFloat(options.fulfillment === "custom" ? localTax : pricing.local_tax)
  ).toFixed(2);
  const amountPaid = options.amountPaid?.trim() || total;
  const appliedDepositAmount = options.appliedDepositAmount?.trim() || null;
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
      primary_salesperson_id: null,
      customer_id: options.customerId,
      wedding_member_id: null,
      payment_method: "cash",
      total_price: total,
      amount_paid: amountPaid,
      checkout_client_id: crypto.randomUUID(),
      ...(appliedDepositAmount ? { applied_deposit_amount: appliedDepositAmount } : {}),
      items: [
        {
          product_id: pricing.product_id,
          variant_id: pricing.variant_id,
          fulfillment: options.fulfillment,
          quantity: 1,
          unit_price: resolvedUnitPrice,
          unit_cost: options.fulfillment === "custom" ? "0.00" : pricing.cost_price,
          state_tax: options.fulfillment === "custom" ? stateTax : pricing.state_tax,
          local_tax: options.fulfillment === "custom" ? localTax : pricing.local_tax,
          price_override_reason:
            options.fulfillment === "custom" ? "custom_order_booking" : null,
          custom_item_type:
            options.fulfillment === "custom" ? options.customItemType ?? "HSM Suit" : null,
          custom_order_details:
            options.fulfillment === "custom" ? options.customOrderDetails ?? null : null,
        },
      ],
      payment_splits:
        Number.parseFloat(amountPaid) > 0
          ? [
              {
                payment_method: "cash",
                amount: amountPaid,
                ...(appliedDepositAmount
                  ? { applied_deposit_amount: appliedDepositAmount }
                  : {}),
              },
            ]
          : [],
    },
    failOnStatusCode: false,
  });
}

async function fetchTransactionDetail(
  request: Parameters<typeof test>[0]["request"],
  transactionId: string,
): Promise<TransactionDetail> {
  const res = await request.get(`${apiBase()}/api/transactions/${transactionId}`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as TransactionDetail;
}

async function fetchOrders(
  request: Parameters<typeof test>[0]["request"],
  customerId: string,
  kindFilter: "custom" | "special_order" | "wedding_order",
): Promise<TransactionListResponse> {
  const res = await request.get(
    `${apiBase()}/api/transactions?customer_id=${encodeURIComponent(customerId)}&kind_filter=${kindFilter}&limit=25`,
    {
      headers: staffHeaders(),
      failOnStatusCode: false,
    },
  );
  expect(res.status()).toBe(200);
  return (await res.json()) as TransactionListResponse;
}

async function fetchTransactionItems(
  request: Parameters<typeof test>[0]["request"],
  transactionId: string,
): Promise<TransactionItemList> {
  const res = await request.get(`${apiBase()}/api/transactions/${transactionId}/items`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as TransactionItemList;
}

async function attachOrderToWedding(
  request: Parameters<typeof test>[0]["request"],
  transactionId: string,
  role: string,
) {
  const res = await request.post(`${apiBase()}/api/weddings/attach-order`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      transaction_id: transactionId,
      role,
      new_party_info: {
        party_name: "E2E Wedding Contract Party",
        groom_name: "E2E Groom",
        event_date: "2026-12-12",
        party_type: "Wedding",
      },
      actor_name: "E2E Wedding Contract",
    },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as { id: string };
}

test.describe("Orders custom vs special contract", () => {
  test("known custom SKU canonicalizes subtype and persists as custom", async ({
    request,
  }) => {
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const customFixture = await seedOrderFixture(
      request,
      "single_valid",
      "Orders Custom Subtype Contract",
    );

    const customCheckout = await checkoutOrder(request, {
      sessionId,
      sessionToken,
      operatorStaffId,
      customerId: customFixture.customer.id,
      sku: "100",
      fulfillment: "custom",
      customItemType: "Other",
      customSalePrice: "899.00",
      customOrderDetails: {
        garment_description: "Navy peak-lapel suit",
        fabric_reference: "6318N2448",
        style_reference: "302L0140",
        reference_number: "FAB-123",
        hsm_garment_type: "CP",
        hsm_model_code: "302L0140",
        hsm_trim_reference: "PL14",
        hsm_coat_size: "40R",
        hsm_pant_size: "34",
        hsm_left_sleeve: "16 3/4",
        hsm_right_sleeve: "16 3/4",
        hsm_lapel_style: "Peak",
        hsm_vent_style: "Side Tabs",
        hsm_fabric_reservation_number: "683N2448",
        custom_notes: "Peak lapel with side tabs",
      },
    });
    expect(customCheckout.status()).toBe(200);
    const customBody = (await customCheckout.json()) as CheckoutResponse;

    const customDetail = await fetchTransactionDetail(request, customBody.transaction_id);
    const customLine = customDetail.items.find(
      (item) => item.fulfillment === "custom" && item.sku === "100",
    );
    expect(customLine).toBeTruthy();
    expect(customLine?.custom_item_type).toBe("HSM Suit");
    expect(Number.parseFloat(customLine?.unit_cost ?? "0")).toBe(0);
    expect(customLine?.custom_order_details?.vendor_form_family).toBe("hart_schaffner_marx");
    expect(customLine?.custom_order_details?.hsm_model_code).toBe("302L0140");
    expect(customLine?.custom_order_details?.fabric_reference).toBe("6318N2448");
    expect(customLine?.custom_order_details?.hsm_coat_size).toBe("40R");
    expect(customLine?.custom_order_details?.hsm_lapel_style).toBe("Peak");
    expect(customLine?.custom_order_details?.hsm_fabric_reservation_number).toBe("683N2448");
  });

  test("individualized shirt details persist with measurement anchors", async ({
    request,
  }) => {
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const shirtFixture = await seedOrderFixture(
      request,
      "single_valid",
      "Orders Individualized Detail Contract",
    );

    const shirtCheckout = await checkoutOrder(request, {
      sessionId,
      sessionToken,
      operatorStaffId,
      customerId: shirtFixture.customer.id,
      sku: "200",
      fulfillment: "custom",
      customItemType: "Individualized Shirt",
      customSalePrice: "249.00",
      customOrderDetails: {
        shirt_description: "Contest winner shirt",
        fabric_reference: "M32PBCM",
        style_reference: "BD",
        reference_number: "171835",
        shirt_previous_order_number: "182835",
        shirt_try_on_size: "40",
        shirt_shaping: "-6",
        shirt_collar_style: "BD",
        shirt_cuff_style: "P",
        shirt_collar_size: "16 1/2",
        shirt_tail_length: "30",
        shirt_yoke: "18 1/2",
        shirt_right_sleeve_length: "34 3/4",
        shirt_left_sleeve_length: "34 3/4",
        shirt_right_cuff_size: "10 1/2",
        shirt_left_cuff_size: "10 1/2",
        shirt_shoulder_line: "Regular Shoulder",
        shirt_front_style: "Plain Front",
        shirt_back_style: "Plain",
        shirt_tail_style: "Square",
        shirt_button_choice: "BH4 C260",
        shirt_pocket_style: "No",
        shirt_fit_notes: "Contest winner fit",
        custom_notes: "Sent to David",
      },
    });
    expect(shirtCheckout.status()).toBe(200);
    const shirtBody = (await shirtCheckout.json()) as CheckoutResponse;

    const shirtDetail = await fetchTransactionDetail(request, shirtBody.transaction_id);
    const shirtLine = shirtDetail.items.find(
      (item) => item.fulfillment === "custom" && item.sku === "200",
    );
    expect(shirtLine).toBeTruthy();
    expect(shirtLine?.custom_item_type).toBe("Individualized Shirt");
    expect(shirtLine?.custom_order_details?.vendor_form_family).toBe("individualized_shirts");
    expect(shirtLine?.custom_order_details?.shirt_previous_order_number).toBe("182835");
    expect(shirtLine?.custom_order_details?.shirt_try_on_size).toBe("40");
    expect(shirtLine?.custom_order_details?.shirt_collar_size).toBe("16 1/2");
    expect(shirtLine?.custom_order_details?.shirt_right_sleeve_length).toBe("34 3/4");
    expect(shirtLine?.custom_order_details?.shirt_button_choice).toBe("BH4 C260");
    expect(shirtLine?.custom_order_details?.shirt_pocket_style).toBe("No");
  });

  test("custom orders persist as custom and filter separately from special orders", async ({
    request,
  }) => {
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const customFixture = await seedOrderFixture(
      request,
      "single_valid",
      "Orders Custom Contract",
    );
    const specialFixture = await seedOrderFixture(
      request,
      "single_valid",
      "Orders Special Contract",
    );

    const customCheckout = await checkoutOrder(request, {
      sessionId,
      sessionToken,
      operatorStaffId,
      customerId: customFixture.customer.id,
      sku: "100",
      fulfillment: "custom",
      customSalePrice: "899.00",
    });
    expect(customCheckout.status()).toBe(200);
    const customBody = (await customCheckout.json()) as CheckoutResponse;

    const specialCheckout = await checkoutOrder(request, {
      sessionId,
      sessionToken,
      operatorStaffId,
      customerId: specialFixture.customer.id,
      sku: specialFixture.product.sku,
      fulfillment: "special_order",
    });
    expect(specialCheckout.status()).toBe(200);
    const specialBody = (await specialCheckout.json()) as CheckoutResponse;

    const customDetail = await fetchTransactionDetail(request, customBody.transaction_id);
    expect(customDetail.items.some((item) => item.fulfillment === "custom")).toBeTruthy();

    const specialDetail = await fetchTransactionDetail(request, specialBody.transaction_id);
    expect(
      specialDetail.items.some((item) => item.fulfillment === "special_order"),
    ).toBeTruthy();

    const customOrders = await fetchOrders(request, customFixture.customer.id, "custom");
    expect(
      customOrders.items.some(
        (row) => row.transaction_id === customBody.transaction_id && row.order_kind === "custom",
      ),
    ).toBeTruthy();

    const specialOrders = await fetchOrders(request, specialFixture.customer.id, "special_order");
    expect(
      specialOrders.items.some(
        (row) =>
          row.transaction_id === specialBody.transaction_id &&
          row.order_kind === "special_order",
      ),
    ).toBeTruthy();
    expect(
      specialOrders.items.some((row) => row.transaction_id === customBody.transaction_id),
    ).toBeFalsy();
  });

  test("custom orders defer cost until receipt", async ({ request }) => {
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const customFixture = await seedOrderFixture(
      request,
      "single_valid",
      "Orders Deferred Cost Contract",
    );

    const customCheckout = await checkoutOrder(request, {
      sessionId,
      sessionToken,
      operatorStaffId,
      customerId: customFixture.customer.id,
      sku: "100",
      fulfillment: "custom",
      customSalePrice: "899.00",
    });
    expect(customCheckout.status()).toBe(200);
    const customBody = (await customCheckout.json()) as CheckoutResponse;

    const customBeforeReceipt = await fetchTransactionDetail(request, customBody.transaction_id);
    const customLineBeforeReceipt = customBeforeReceipt.items.find(
      (item) => item.fulfillment === "custom" && item.sku === "100",
    );
    expect(customLineBeforeReceipt).toBeTruthy();
    expect(Number.parseFloat(customLineBeforeReceipt?.unit_cost ?? "0")).toBe(0);

    const pricing = await fetchCatalogPricing(request, "100");
    const vendor =
      pricing.primary_vendor_id != null
        ? { id: pricing.primary_vendor_id, name: "Existing Vendor" }
        : await createVendor(request, "custom-order-contract");
    const purchaseOrder = await createDraftPurchaseOrder(request, vendor.id);
    await addPurchaseOrderLine(request, purchaseOrder.id, pricing.variant_id, 100, "85.00");
    await submitPurchaseOrder(request, purchaseOrder.id);
    const purchaseOrderDetail = await getPurchaseOrderDetail(request, purchaseOrder.id);
    await receivePurchaseOrder(request, purchaseOrder.id, {
      invoice_number: "E2E-CUSTOM-RECEIPT",
      lines: purchaseOrderDetail.lines.map((line) => ({
        po_line_id: line.line_id,
        quantity_received_now: 100,
      })),
    });

    const customAfterReceipt = await fetchTransactionDetail(request, customBody.transaction_id);
    const customLineAfterReceipt = customAfterReceipt.items.find(
      (item) => item.fulfillment === "custom" && item.sku === "100",
    );
    expect(customLineAfterReceipt).toBeTruthy();
    expect(customLineAfterReceipt?.unit_cost).toBe("85.00");

    const customOrders = await fetchOrders(request, customFixture.customer.id, "custom");
    expect(
      customOrders.items.some(
        (row) => row.transaction_id === customBody.transaction_id && row.order_kind === "custom",
      ),
    ).toBeTruthy();
  });

  test("individualized shirts keep their own structured detail family", async ({ request }) => {
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const customFixture = await seedOrderFixture(
      request,
      "single_valid",
      "Orders Individualized Structured Details",
    );

    const customCheckout = await checkoutOrder(request, {
      sessionId,
      sessionToken,
      operatorStaffId,
      customerId: customFixture.customer.id,
      sku: "200",
      fulfillment: "custom",
      customSalePrice: "249.00",
      customOrderDetails: {
        shirt_description: "White contest winner shirt",
        fabric_reference: "M32PBCM",
        style_reference: "BD",
        reference_number: "171835",
        shirt_collar_style: "BD",
        shirt_cuff_style: "P",
        shirt_fit_notes: "Shaping minus 6",
        custom_notes: "Contest winner",
      },
    });
    expect(customCheckout.status()).toBe(200);
    const customBody = (await customCheckout.json()) as CheckoutResponse;

    const customDetail = await fetchTransactionDetail(request, customBody.transaction_id);
    const customLine = customDetail.items.find(
      (item) => item.fulfillment === "custom" && item.sku === "200",
    );
    expect(customLine).toBeTruthy();
    expect(customLine?.custom_item_type).toBe("Individualized Shirt");
    expect(customLine?.custom_order_details?.vendor_form_family).toBe("individualized_shirts");
    expect(customLine?.custom_order_details?.shirt_collar_style).toBe("BD");
    expect(customLine?.custom_order_details?.shirt_cuff_style).toBe("P");
    expect(customLine?.custom_order_details?.reference_number).toBe("171835");
  });

  test("wedding attachment keeps deposit visibility and follow-up distinct in detail and list reads", async ({ request }) => {
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const fixture = await seedOrderFixture(
      request,
      "single_valid",
      "Orders Wedding Contract",
    );

    const orderCheckout = await checkoutOrder(request, {
      sessionId,
      sessionToken,
      operatorStaffId,
      customerId: fixture.customer.id,
      sku: fixture.product.sku,
      fulfillment: "special_order",
      amountPaid: "75.00",
      appliedDepositAmount: "75.00",
    });
    expect(orderCheckout.status()).toBe(200);
    const orderBody = (await orderCheckout.json()) as CheckoutResponse;

    await attachOrderToWedding(request, orderBody.transaction_id, "Groomsman");

    const detail = await fetchTransactionDetail(request, orderBody.transaction_id);
    expect(detail.wedding_member_id).toBeTruthy();
    expect(detail.wedding_summary?.party_name).toBe("E2E Wedding Contract Party");
    expect(detail.wedding_summary?.member_role).toBe("Groomsman");
    expect(detail.financial_summary?.total_applied_deposit_amount).toBe("75.00");
    expect(Number.parseFloat(detail.balance_due ?? "0")).toBeGreaterThan(0);
    expect(detail.items.some((item) => item.fulfillment === "wedding_order")).toBeTruthy();

    const weddingItems = await fetchTransactionItems(request, orderBody.transaction_id);
    expect(
      weddingItems.some(
        (item) => item.fulfillment === "wedding_order" && item.is_fulfilled === false,
      ),
    ).toBeTruthy();

    const weddingOrders = await fetchOrders(request, fixture.customer.id, "wedding_order");
    expect(
      weddingOrders.items.some(
        (row) =>
          row.transaction_id === orderBody.transaction_id &&
          row.order_kind === "wedding_order" &&
          !!row.party_name &&
          !!row.wedding_member_id,
      ),
    ).toBeTruthy();

    const specialOrders = await fetchOrders(request, fixture.customer.id, "special_order");
    expect(
      specialOrders.items.some((row) => row.transaction_id === orderBody.transaction_id),
    ).toBeFalsy();
  });

  test("special orders keep deposit balance and pickup status distinct", async ({
    request,
  }) => {
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const fixture = await seedOrderFixture(
      request,
      "single_valid",
      "Orders Deposit Lifecycle",
    );

    const depositCheckout = await checkoutOrder(request, {
      sessionId,
      sessionToken,
      operatorStaffId,
      customerId: fixture.customer.id,
      sku: fixture.product.sku,
      fulfillment: "special_order",
      amountPaid: "50.00",
      appliedDepositAmount: "50.00",
    });
    expect(depositCheckout.status()).toBe(200);
    const depositBody = (await depositCheckout.json()) as CheckoutResponse;

    const depositDetail = await fetchTransactionDetail(request, depositBody.transaction_id);
    expect(String(depositDetail.status).toLowerCase()).toBe("open");
    expect(depositDetail.amount_paid).toBe("50.00");
    expect(depositDetail.balance_due).not.toBe("0.00");
    expect(depositDetail.financial_summary?.total_applied_deposit_amount).toBe("50.00");
  });

  test("odd-cent special orders accept a partial deposit without false overage drift", async ({
    request,
  }) => {
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const fixture = await seedOrderFixture(
      request,
      "single_valid",
      "Orders Odd Cent Deposit",
    );

    const checkoutRes = await request.post(`${apiBase()}/api/transactions/checkout`, {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
        "x-riverside-pos-session-id": sessionId,
        "x-riverside-pos-session-token": sessionToken,
      },
      data: {
        session_id: sessionId,
        operator_staff_id: operatorStaffId,
        primary_salesperson_id: null,
        customer_id: fixture.customer.id,
        wedding_member_id: null,
        payment_method: "cash",
        total_price: "87.99",
        amount_paid: "44.00",
        checkout_client_id: crypto.randomUUID(),
        items: [
          {
            product_id: fixture.product.product_id,
            variant_id: fixture.product.variant_id,
            fulfillment: "special_order",
            quantity: 1,
            unit_price: "80.45",
            unit_cost: fixture.product.cost_price,
            state_tax: "5.63",
            local_tax: "1.91",
            price_override_reason: "deposit_rounding_regression_guard",
          },
        ],
        payment_splits: [
          {
            payment_method: "cash",
            amount: "44.00",
            applied_deposit_amount: "44.00",
          },
        ],
      },
      failOnStatusCode: false,
    });

    expect(checkoutRes.status()).toBe(200);
    const checkout = (await checkoutRes.json()) as CheckoutResponse;
    const detail = await fetchTransactionDetail(request, checkout.transaction_id);

    expect(String(detail.status).toLowerCase()).toBe("open");
    expect(detail.amount_paid).toBe("44.00");
    expect(detail.financial_summary?.total_applied_deposit_amount).toBe("44.00");
    expect(Number.parseFloat(detail.balance_due ?? "0")).toBeCloseTo(43.99, 2);
  });

  test("transaction items endpoint supports review before and after pickup", async ({
    request,
  }) => {
    const { sessionId, sessionToken } = await ensureSessionAuth(request);
    const operatorStaffId = await verifyStaffId(request);
    const fixture = await seedOrderFixture(
      request,
      "single_valid",
      "Orders Pickup Lifecycle",
    );

    const checkout = await checkoutOrder(request, {
      sessionId,
      sessionToken,
      operatorStaffId,
      customerId: fixture.customer.id,
      sku: fixture.product.sku,
      fulfillment: "special_order",
    });
    expect(checkout.status()).toBe(200);
    const body = (await checkout.json()) as CheckoutResponse;

    const beforePickup = await fetchTransactionItems(request, body.transaction_id);
    expect(beforePickup.some((item) => item.fulfillment === "special_order")).toBeTruthy();
    expect(beforePickup.every((item) => item.is_fulfilled === false)).toBeTruthy();

    const pickupRes = await request.post(`${apiBase()}/api/transactions/${body.transaction_id}/pickup`, {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
      },
      data: {
        actor: "E2E Pickup Lifecycle",
      },
      failOnStatusCode: false,
    });
    expect(pickupRes.status()).toBe(200);

    const afterPickup = await fetchTransactionItems(request, body.transaction_id);
    expect(afterPickup.every((item) => item.is_fulfilled === true)).toBeTruthy();

    const finalDetail = await fetchTransactionDetail(request, body.transaction_id);
    expect(String(finalDetail.status).toLowerCase()).toBe("fulfilled");
  });
});
