import { expect, test, type Page } from "@playwright/test";
import { signInToBackOffice } from "./helpers/backofficeSignIn";
import {
  ensurePosRegisterSessionOpen,
  ensurePosSaleCashierSignedIn,
} from "./helpers/openPosRegister";

const quarantineUnstablePosUi =
  process.env.ROS_QUARANTINE_UNSTABLE_POS_E2E === "1";

const CUSTOMER = {
  id: "11111111-1111-4111-8111-111111111111",
  customer_code: "ALT-E2E",
  first_name: "Avery",
  last_name: "Alter",
  company_name: null,
  email: "avery.alter@example.com",
  phone: "716-555-0101",
};

const PRODUCT = {
  product_id: "22222222-2222-4222-8222-222222222222",
  variant_id: "33333333-3333-4333-8333-333333333333",
  sku: "ALT-P2-SUIT",
  name: "Phase 2 Suit Jacket",
  variation_label: "40R",
  standard_retail_price: "199.00",
  unit_cost: "80.00",
  state_tax: "0.00",
  local_tax: "0.00",
  stock_on_hand: 3,
  tax_category: "clothing",
};

const OPEN_ORDER = {
  id: "99999999-9999-4999-8999-999999999999",
  customer_id: CUSTOMER.id,
  display_id: "TXN-ORDER-PAY",
  booked_at: new Date().toISOString(),
  status: "open",
  total_price: "150.00",
  amount_paid: "25.00",
  balance_due: "125.00",
  order_kind: "special_order",
  is_rush: false,
  need_by_date: null,
  wedding_member_id: null,
  party_name: null,
};

async function openPosRegisterSurface(page: Page): Promise<void> {
  await signInToBackOffice(page);

  await page
    .getByRole("navigation", { name: "Main Navigation" })
    .getByRole("button", { name: "POS", exact: true })
    .click();

  const posNav = page.getByRole("navigation", { name: "POS Navigation" });
  await expect(posNav).toBeVisible({ timeout: 20_000 });

  await ensurePosRegisterSessionOpen(page);
  await ensurePosSaleCashierSignedIn(page);
  const registerTab = page.getByTestId("pos-sidebar-tab-register");
  if (await registerTab.isVisible().catch(() => false)) {
    await registerTab.click();
  }
  await expect(page.getByTestId("pos-product-search")).toBeVisible({
    timeout: 25_000,
  });
}

async function mockCustomerSearch(page: Page): Promise<void> {
  await page.route("**/api/customers/search?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([CUSTOMER]),
    });
  });
}

async function mockProductLookup(page: Page): Promise<void> {
  await page.route("**/api/inventory/scan/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(PRODUCT),
    });
  });
  await page.route("**/api/products/control-board?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        rows: [
          {
            product_id: PRODUCT.product_id,
            variant_id: PRODUCT.variant_id,
            sku: PRODUCT.sku,
            product_name: PRODUCT.name,
            variation_label: PRODUCT.variation_label,
            retail_price: PRODUCT.standard_retail_price,
            cost_price: PRODUCT.unit_cost,
            stock_on_hand: PRODUCT.stock_on_hand,
            state_tax: PRODUCT.state_tax,
            local_tax: PRODUCT.local_tax,
            tax_category: PRODUCT.tax_category,
          },
        ],
      }),
    });
  });
}

async function mockPosCashierAuth(page: Page): Promise<void> {
  await page.route("**/api/staff/list-for-pos", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "55555555-5555-4555-8555-555555555555",
          full_name: "Avery Staff",
        },
      ]),
    });
  });
  await page.route("**/api/staff/verify-pin", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        staff_id: "55555555-5555-4555-8555-555555555555",
        full_name: "Avery Staff",
      }),
    });
  });
}

async function selectCustomer(page: Page): Promise<void> {
  await page.getByTestId("pos-customer-search").fill("Avery");
  await page.getByRole("button", { name: /Avery Alter/i }).click();
  await expect(page.getByText(/ALT-E2E/i)).toBeVisible({ timeout: 10_000 });
}

async function selectDefaultSalesperson(page: Page): Promise<void> {
  await page.locator("button").filter({ hasText: /Default \(None\)|Select Salesperson/i }).first().click();
  await page.getByRole("button", { name: /Avery Staff/i }).last().click();
}

async function addProductToCart(page: Page): Promise<void> {
  const search = page.getByTestId("pos-product-search");
  await search.fill(PRODUCT.sku);
  await search.press("Enter");
  await expect(page.getByText(PRODUCT.sku)).toBeVisible({ timeout: 10_000 });
}

test.describe("POS alteration intake", () => {
  test.skip(
    quarantineUnstablePosUi,
    "Temporarily quarantined in CI due to shared POS register-ready / cashier-overlay instability.",
  );

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await mockPosCashierAuth(page);
    await mockCustomerSearch(page);
    await mockProductLookup(page);
    await openPosRegisterSurface(page);
  });

  test("toolbar exposes alteration action and separates exchange from layaway", async ({
    page,
  }) => {
    const alteration = page.getByTestId("pos-alteration-intake-trigger");
    const exchange = page.getByTestId("pos-exchange-wizard-trigger");
    const layaway = page.getByRole("button", { name: /^Layaway$/i });

    await expect(alteration).toBeVisible();
    await expect(exchange).toBeVisible();
    await expect(layaway).toBeVisible();
    await expect(exchange).toHaveCount(1);
    await expect(layaway).toHaveCount(1);
    const boxes = await Promise.all([exchange.boundingBox(), layaway.boundingBox()]);
    expect(boxes[0]).toBeTruthy();
    expect(boxes[1]).toBeTruthy();
    expect(boxes[0]?.width).toBeGreaterThan(0);
    expect(boxes[1]?.width).toBeGreaterThan(0);
  });

  test("modal requires customer before opening", async ({ page }) => {
    await page.getByTestId("pos-alteration-intake-trigger").click();
    await expect(
      page.getByText(/select or create a customer before starting an alteration/i),
    ).toBeVisible();
    await expect(page.getByTestId("pos-alteration-intake-dialog")).toHaveCount(0);
  });

  test("lookup-only source selection does not add item to cart", async ({ page }) => {
    await selectCustomer(page);

    await page.getByTestId("pos-alteration-intake-trigger").click();
    const dialog = page.getByTestId("pos-alteration-intake-dialog");
    await expect(dialog).toBeVisible();

    await dialog.getByTestId("pos-alteration-source-catalog_item").click();
    await dialog.getByTestId("pos-alteration-lookup-input").fill(PRODUCT.sku);
    await dialog.getByTestId("pos-alteration-lookup-button").click();
    await dialog.getByTestId("pos-alteration-catalog-source-option").click();

    await expect(dialog.getByText(/will not be added to the sale/i)).toBeVisible();
    await expect(page.getByText(/Cart is Empty/i)).toBeVisible();
    await expect(page.getByText(/Sale lines/i)).toHaveCount(0);
  });

  test("current cart intake creates a free alteration cart line without API create", async ({
    page,
  }) => {
    await selectCustomer(page);
    await addProductToCart(page);

    let alterationCreateCalls = 0;
    await page.route("**/api/alterations", async (route) => {
      alterationCreateCalls += 1;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "current cart intake should not post" }),
      });
    });

    await page.getByTestId("pos-alteration-intake-trigger").click();
    const dialog = page.getByTestId("pos-alteration-intake-dialog");
    await dialog.getByTestId("pos-alteration-cart-source-option").click();
    await dialog.getByTestId("pos-alteration-work-requested").fill("Hem sleeves");
    await dialog.getByTestId("pos-alteration-save").click();

    await expect(page.getByText(/Alteration: Hem sleeves/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Amount $0.00", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("pos-pending-alterations-summary")).toContainText(
      /1 alteration intake/i,
    );
    await expect(page.getByTestId("pos-pending-alterations-summary")).toContainText(
      /will link to checkout/i,
    );
    expect(alterationCreateCalls).toBe(0);
  });

  test("charged alteration creates a paid cart line and edit updates it", async ({ page }) => {
    await selectCustomer(page);
    await addProductToCart(page);

    await page.getByTestId("pos-alteration-intake-trigger").click();
    const dialog = page.getByTestId("pos-alteration-intake-dialog");
    await dialog.getByTestId("pos-alteration-cart-source-option").click();
    await dialog.getByTestId("pos-alteration-work-requested").fill("Hem pants");
    await dialog.getByTestId("pos-alteration-charge-toggle").check();
    await dialog.getByTestId("pos-alteration-charge-amount").fill("18.00");
    await dialog.getByTestId("pos-alteration-save").click();

    await expect(page.getByText(/Alteration: Hem pants/i)).toBeVisible();
    await expect(page.getByText(/\$18\.00/)).toBeVisible();

    await page.getByTestId("pos-alteration-line-edit").click();
    const editDialog = page.getByTestId("pos-alteration-intake-dialog");
    await editDialog.getByTestId("pos-alteration-work-requested").fill("Hem pants and taper");
    await editDialog.getByTestId("pos-alteration-charge-amount").fill("24.00");
    await editDialog.getByTestId("pos-alteration-save").click();

    await expect(page.getByText(/Alteration: Hem pants and taper/i)).toBeVisible();
    await expect(page.getByText(/\$24\.00/)).toBeVisible();
  });

  test("current cart alteration is sent at checkout and appears in alterations queue", async ({
    page,
  }) => {
    await selectCustomer(page);
    await addProductToCart(page);
    await selectDefaultSalesperson(page);

    await page.getByTestId("pos-alteration-intake-trigger").click();
    const dialog = page.getByTestId("pos-alteration-intake-dialog");
    await dialog.getByTestId("pos-alteration-cart-source-option").click();
    await dialog.getByTestId("pos-alteration-work-requested").fill("Hem sleeves");
    await dialog.getByTestId("pos-alteration-save").click();

    let checkoutBody: Record<string, unknown> | null = null;
    await page.route("**/api/transactions/checkout", async (route) => {
      checkoutBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          transaction_id: "66666666-6666-4666-8666-666666666666",
          transaction_display_id: "TXN-ALT-P3",
          status: "paid",
          loyalty_points_earned: 0,
          loyalty_points_balance: null,
        }),
      });
    });
    await page.route("**/api/alterations**", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "77777777-7777-4777-8777-777777777777",
            customer_id: CUSTOMER.id,
            customer_first_name: CUSTOMER.first_name,
            customer_last_name: CUSTOMER.last_name,
            customer_code: CUSTOMER.customer_code,
            wedding_member_id: null,
            status: "intake",
            due_at: null,
            notes: null,
            linked_transaction_id: "66666666-6666-4666-8666-666666666666",
            linked_transaction_display_id: "TXN-ALT-P3",
            source_type: "current_cart_item",
            item_description: "Phase 2 Suit Jacket - 40R",
            work_requested: "Hem sleeves",
            source_product_id: PRODUCT.product_id,
            source_variant_id: PRODUCT.variant_id,
            source_sku: PRODUCT.sku,
            source_transaction_id: "66666666-6666-4666-8666-666666666666",
            source_transaction_line_id: "88888888-8888-4888-8888-888888888888",
            charge_amount: null,
            charge_transaction_line_id: null,
            intake_channel: "pos_register",
            source_snapshot: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ]),
      });
    });

    await page.getByTestId("pos-pay-button").click();
    const drawer = page.getByRole("dialog", { name: /checkout/i });
    await expect(drawer).toBeVisible({ timeout: 20_000 });
    await drawer.getByRole("button", { name: /^Cash$/i }).click();
    await drawer.getByRole("button", { name: /full balance/i }).click();
    await drawer.getByRole("button", { name: /add payment/i }).click();
    await drawer.getByTestId("pos-finalize-checkout").click();
    await expect(page.getByText(/sale complete/i)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /begin new sale/i }).click();
    await expect(page.getByText(/sale complete/i)).toBeHidden({ timeout: 10_000 });

    expect(checkoutBody).toMatchObject({
      customer_id: CUSTOMER.id,
      alteration_intakes: [
        {
          intake_id: expect.any(String),
          alteration_line_client_id: expect.any(String),
          source_client_line_id: expect.any(String),
          source_type: "current_cart_item",
          item_description: "Phase 2 Suit Jacket - 40R",
          work_requested: "Hem sleeves",
          source_product_id: PRODUCT.product_id,
          source_variant_id: PRODUCT.variant_id,
          source_sku: PRODUCT.sku,
          charge_amount: null,
        },
      ],
    });
    const checkoutItems = (checkoutBody?.items ?? []) as Array<Record<string, unknown>>;
    const alterationIntakes = (checkoutBody?.alteration_intakes ?? []) as Array<
      Record<string, unknown>
    >;
    const sourceLine = checkoutItems.find((item) => item.product_id === PRODUCT.product_id);
    const alterationLine = checkoutItems.find((item) => item.line_type === "alteration_service");
    expect(alterationIntakes[0]?.source_client_line_id).toBe(sourceLine?.client_line_id);
    expect(alterationIntakes[0]?.alteration_line_client_id).toBe(alterationLine?.client_line_id);
    expect(alterationLine).toMatchObject({
      line_type: "alteration_service",
      unit_price: "0.00",
    });

    await page.getByRole("button", { name: "Alterations" }).click();
    const intakeSection = page.getByTestId("alteration-workbench-section-intake");
    await expect(intakeSection.getByText("Hem sleeves").first()).toBeVisible({ timeout: 20_000 });
    await expect(intakeSection.getByText("TXN-ALT-P3")).toBeVisible();
  });

  test("existing order payment can be added, edited, removed, and sent at checkout", async ({
    page,
  }) => {
    await selectCustomer(page);
    await addProductToCart(page);
    await selectDefaultSalesperson(page);

    await page.route("**/api/transactions?customer_id=*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [OPEN_ORDER] }),
      });
    });

    await page.getByTitle("View previous orders for this customer").click();
    await page.getByTestId(`pos-order-make-payment-${OPEN_ORDER.display_id}`).click();
    const paymentModal = page.getByTestId("pos-order-payment-entry-modal");
    await expect(paymentModal).toBeVisible();
    await expect(paymentModal.getByTestId("pos-order-payment-amount")).toHaveValue("125.00");
    await paymentModal.getByTestId("pos-order-payment-amount").fill("40.00");
    await paymentModal.getByTestId("pos-order-payment-add-to-cart").click();

    const orderPaymentLine = page.getByTestId("pos-order-payment-cart-line");
    await expect(orderPaymentLine).toContainText(OPEN_ORDER.display_id);
    await expect(orderPaymentLine).toContainText("$40.00");
    await expect(orderPaymentLine).toContainText("85.00");

    await orderPaymentLine.getByTestId("pos-order-payment-edit").click();
    const editModal = page.getByTestId("pos-order-payment-edit-modal");
    await editModal.getByTestId("pos-order-payment-edit-amount").fill("60.00");
    await editModal.getByTestId("pos-order-payment-edit-save").click();
    await expect(orderPaymentLine).toContainText("$60.00");
    await expect(orderPaymentLine).toContainText("65.00");

    await orderPaymentLine.getByTestId("pos-order-payment-remove").click();
    await expect(page.getByTestId("pos-order-payment-cart-line")).toHaveCount(0);

    await page.getByTitle("View previous orders for this customer").click();
    await page.getByTestId(`pos-order-make-payment-${OPEN_ORDER.display_id}`).click();
    await page.getByTestId("pos-order-payment-amount").fill("40.00");
    await page.getByTestId("pos-order-payment-add-to-cart").click();

    let checkoutBody: Record<string, unknown> | null = null;
    await page.route("**/api/transactions/checkout", async (route) => {
      checkoutBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          transaction_id: "66666666-6666-4666-8666-666666666666",
          transaction_display_id: "TXN-ORDER-PAY-CHECKOUT",
          status: "paid",
        }),
      });
    });

    await page.getByTestId("pos-pay-button").click();
    const drawer = page.getByRole("dialog", { name: /checkout/i });
    await expect(drawer).toBeVisible({ timeout: 20_000 });
    await drawer.getByRole("button", { name: /^Cash$/i }).click();
    await drawer.getByRole("button", { name: /full balance/i }).click();
    await drawer.getByRole("button", { name: /add payment/i }).click();
    await drawer.getByTestId("pos-finalize-checkout").click();
    await expect(page.getByText(/sale complete/i)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /begin new sale/i }).click();
    await expect(page.getByText(/sale complete/i)).toBeHidden({ timeout: 10_000 });

    expect(checkoutBody).toMatchObject({
      customer_id: CUSTOMER.id,
      order_payments: [
        {
          client_line_id: expect.any(String),
          target_transaction_id: OPEN_ORDER.id,
          target_display_id: OPEN_ORDER.display_id,
          customer_id: CUSTOMER.id,
          amount: "40.00",
          balance_before: "125.00",
          projected_balance_after: "85.00",
        },
      ],
    });
    const checkoutItems = (checkoutBody?.items ?? []) as Array<Record<string, unknown>>;
    expect(checkoutItems.some((item) => item.line_type === "order_payment")).toBe(false);
  });

  test("custom item intake creates an alteration cart line without selling a garment", async ({ page }) => {
    await selectCustomer(page);

    let postedBody: Record<string, unknown> | null = null;
    await page.route("**/api/alterations", async (route) => {
      postedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "44444444-4444-4444-8444-444444444444",
          customer_id: CUSTOMER.id,
          status: "intake",
          source_type: "custom_item",
          item_description: "Outside tuxedo jacket",
          work_requested: "Take in sides",
          intake_channel: "pos_register",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      });
    });

    await page.getByTestId("pos-alteration-intake-trigger").click();
    const dialog = page.getByTestId("pos-alteration-intake-dialog");
    await dialog.getByTestId("pos-alteration-source-custom_item").click();
    await dialog
      .getByTestId("pos-alteration-custom-description")
      .fill("Outside tuxedo jacket");
    await dialog.getByTestId("pos-alteration-work-requested").fill("Take in sides");
    await dialog.getByTestId("pos-alteration-save").click();

    await expect(dialog).toBeHidden({ timeout: 10_000 });
    expect(postedBody).toBeNull();
    await expect(page.getByText(/Alteration: Take in sides/i)).toBeVisible();
    await expect(page.getByText(/Outside tuxedo jacket/i)).toBeVisible();
  });
});
