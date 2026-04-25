import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  apiBase,
  seedRmsFixture,
  staffHeaders,
  type SeedFixtureResponse,
} from "./helpers/rmsCharge";
import {
  openBackofficeSidebarTab,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";

const isCi = process.env.CI === "true" || process.env.CI === "1";

function requireOrSkip(condition: boolean, message: string): void {
  if (condition) return;
  if (isCi) {
    expect(condition, message).toBeTruthy();
    return;
  }
  test.skip(true, message);
}

type AlterationRow = {
  id: string;
  customer_id: string;
  customer_first_name?: string | null;
  customer_last_name?: string | null;
  customer_code?: string | null;
  status: string;
  due_at?: string | null;
  notes?: string | null;
  linked_transaction_id?: string | null;
  linked_transaction_display_id?: string | null;
  source_type?: string | null;
  item_description?: string | null;
  work_requested?: string | null;
  source_transaction_id?: string | null;
  source_transaction_line_id?: string | null;
  source_sku?: string | null;
  charge_amount?: string | number | null;
  intake_channel?: string;
  source_snapshot?: Record<string, unknown> | null;
  created_at?: string;
};

type AlterationActivityRow = {
  action: string;
  staff_id?: string | null;
  detail: Record<string, unknown>;
};

async function seedCustomerOrSkip(
  request: APIRequestContext,
  label: string,
): Promise<SeedFixtureResponse | null> {
  try {
    return await seedRmsFixture(request, "standard_only", label);
  } catch (error) {
    requireOrSkip(
      false,
      `E2E alteration fixture unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

test.describe("Alterations safety", () => {
  test("create writes an alteration activity audit row", async ({ request }) => {
    const fixture = await seedCustomerOrSkip(request, "Alteration Create Audit");
    if (!fixture) return;

    const createRes = await request.post(`${apiBase()}/api/alterations`, {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
      },
      data: {
        customer_id: fixture.customer.id,
        due_at: "2026-05-01T15:00:00.000Z",
        notes: "E2E standalone alteration audit check",
      },
      failOnStatusCode: false,
    });
    expect(createRes.status()).toBe(200);
    const created = (await createRes.json()) as AlterationRow;
    expect(created.status).toBe("intake");

    const activityRes = await request.get(
      `${apiBase()}/api/test-support/alterations/${created.id}/activity`,
      {
        headers: staffHeaders(),
        failOnStatusCode: false,
      },
    );
    requireOrSkip(
      activityRes.status() !== 403,
      "RIVERSIDE_ENABLE_E2E_TEST_SUPPORT must be enabled for alteration activity assertions",
    );
    expect(activityRes.status()).toBe(200);
    const activity = (await activityRes.json()) as AlterationActivityRow[];
    const createActivity = activity.find((row) => row.action === "create");
    expect(createActivity).toBeTruthy();
    expect(createActivity?.staff_id).toBeTruthy();
    expect(createActivity?.detail.customer_id).toBe(fixture.customer.id);
    expect(createActivity?.detail.notes_set).toBe(true);
  });

  test("create returns standalone source, work, and charge fields in the list", async ({
    request,
  }) => {
    const fixture = await seedCustomerOrSkip(request, "Alteration Source Fields");
    if (!fixture) return;

    const createRes = await request.post(`${apiBase()}/api/alterations`, {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
      },
      data: {
        customer_id: fixture.customer.id,
        source_type: "custom_item",
        item_description: "Customer-owned navy jacket",
        work_requested: "Shorten sleeves",
        source_sku: "MANUAL-JACKET",
        charge_amount: "25.00",
        intake_channel: "standalone",
        notes: "E2E custom item source/work check",
      },
      failOnStatusCode: false,
    });
    expect(createRes.status()).toBe(200);
    const created = (await createRes.json()) as AlterationRow;
    expect(created.source_type).toBe("custom_item");
    expect(created.item_description).toBe("Customer-owned navy jacket");
    expect(created.work_requested).toBe("Shorten sleeves");
    expect(created.source_sku).toBe("MANUAL-JACKET");
    expect(Number(created.charge_amount)).toBe(25);
    expect(created.intake_channel).toBe("standalone");

    const listRes = await request.get(
      `${apiBase()}/api/alterations?customer_id=${encodeURIComponent(fixture.customer.id)}`,
      {
        headers: staffHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(listRes.status()).toBe(200);
    const rows = (await listRes.json()) as AlterationRow[];
    const listed = rows.find((row) => row.id === created.id);
    expect(listed?.source_type).toBe("custom_item");
    expect(listed?.item_description).toBe("Customer-owned navy jacket");
    expect(listed?.work_requested).toBe("Shorten sleeves");
    expect(Number(listed?.charge_amount)).toBe(25);
  });

  test("invalid source combination returns 400", async ({ request }) => {
    const fixture = await seedCustomerOrSkip(request, "Alteration Invalid Source");
    if (!fixture) return;

    const createRes = await request.post(`${apiBase()}/api/alterations`, {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
      },
      data: {
        customer_id: fixture.customer.id,
        source_type: "custom_item",
        work_requested: "Hem pants",
      },
      failOnStatusCode: false,
    });
    expect(createRes.status()).toBe(400);
    const body = (await createRes.json()) as { error?: string };
    expect(body.error).toContain("item_description");
  });

  test("negative charge amount returns 400", async ({ request }) => {
    const fixture = await seedCustomerOrSkip(request, "Alteration Invalid Charge");
    if (!fixture) return;

    const createRes = await request.post(`${apiBase()}/api/alterations`, {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
      },
      data: {
        customer_id: fixture.customer.id,
        source_type: "catalog_item",
        source_sku: "TEST-SKU",
        charge_amount: "-1.00",
      },
      failOnStatusCode: false,
    });
    expect(createRes.status()).toBe(400);
    const body = (await createRes.json()) as { error?: string };
    expect(body.error).toContain("non-negative");
  });

  test("invalid status returns 400 instead of a database error", async ({
    request,
  }) => {
    const fixture = await seedCustomerOrSkip(request, "Alteration Invalid Status");
    if (!fixture) return;

    const createRes = await request.post(`${apiBase()}/api/alterations`, {
      headers: {
        ...staffHeaders(),
        "Content-Type": "application/json",
      },
      data: {
        customer_id: fixture.customer.id,
        notes: "E2E invalid status check",
      },
      failOnStatusCode: false,
    });
    expect(createRes.status()).toBe(200);
    const created = (await createRes.json()) as AlterationRow;

    const patchRes = await request.patch(
      `${apiBase()}/api/alterations/${created.id}`,
      {
        headers: {
          ...staffHeaders(),
          "Content-Type": "application/json",
        },
        data: { status: "finished" },
        failOnStatusCode: false,
      },
    );
    expect(patchRes.status()).toBe(400);
    const body = (await patchRes.json()) as { error?: string };
    expect(body.error).toContain("invalid status");
    expect(body.error).toContain("intake");
  });

  test("status filter is visible and usable in Back Office Alterations", async ({
    page,
  }) => {
    await signInToBackOffice(page, { persistSession: true });
    await openBackofficeSidebarTab(page, "alterations");

    const statusFilter = page.getByTestId("alterations-status-filter");
    await expect(statusFilter).toBeVisible({ timeout: 20_000 });
    await statusFilter.selectOption("intake");
    await expect(statusFilter).toHaveValue("intake");
    await expect(page.getByTestId("alteration-workbench-section-intake")).toBeVisible();
    await expect(page.getByText("Intake / Not Started", { exact: true })).toBeVisible();
  });

  test("garment workbench groups by due status and labels source garments", async ({
    page,
  }) => {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const future = new Date(today);
    future.setDate(today.getDate() + 3);
    const isoAtNoon = (date: Date) =>
      new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0).toISOString();
    const base = {
      customer_id: "11111111-1111-4111-8111-111111111111",
      customer_first_name: "Avery",
      customer_last_name: "Tailor",
      customer_code: "ALT-WB",
      notes: null,
      linked_transaction_id: null,
      linked_transaction_display_id: null,
      source_transaction_id: null,
      source_transaction_line_id: null,
      charge_amount: null,
      intake_channel: "standalone",
      source_snapshot: null,
      created_at: today.toISOString(),
    };
    const rows: AlterationRow[] = [
      {
        ...base,
        id: "11111111-1111-4111-8111-111111111101",
        status: "in_work",
        due_at: isoAtNoon(yesterday),
        source_type: "past_transaction_line",
        item_description: "Charcoal tuxedo pants",
        work_requested: "Hem pants",
        source_sku: "PAST-PANTS",
        source_transaction_id: "22222222-2222-4222-8222-222222222222",
        source_transaction_line_id: "33333333-3333-4333-8333-333333333333",
        linked_transaction_display_id: "TXN-PAST",
      },
      {
        ...base,
        id: "11111111-1111-4111-8111-111111111102",
        status: "intake",
        due_at: isoAtNoon(today),
        source_type: "current_cart_item",
        item_description: "Current sale suit jacket",
        work_requested: "Shorten sleeves",
        source_sku: "CURR-JACKET",
      },
      {
        ...base,
        id: "11111111-1111-4111-8111-111111111103",
        status: "ready",
        due_at: isoAtNoon(future),
        source_type: "catalog_item",
        item_description: "Stock navy blazer",
        work_requested: "Press and tag",
        source_sku: "STOCK-BLAZER",
        charge_amount: "15.00",
      },
      {
        ...base,
        id: "11111111-1111-4111-8111-111111111104",
        status: "intake",
        due_at: null,
        source_type: "custom_item",
        item_description: "Customer-owned gown",
        work_requested: "Take in sides",
      },
      {
        ...base,
        id: "11111111-1111-4111-8111-111111111105",
        status: "in_work",
        due_at: isoAtNoon(future),
        source_type: "past_transaction_line",
        item_description: "Open order vest",
        work_requested: "Let out back",
        source_sku: "ORDER-VEST",
        source_transaction_id: "44444444-4444-4444-8444-444444444444",
        source_transaction_line_id: "55555555-5555-4555-8555-555555555555",
        linked_transaction_display_id: "TXN-ORDER",
        source_snapshot: { fulfillment: "special_order" },
      },
    ];

    await page.route("**/api/alterations", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(rows),
      });
    });

    await signInToBackOffice(page, { persistSession: true });
    await openBackofficeSidebarTab(page, "home");
    await expect(page.getByTestId("operations-alterations-section")).toContainText("Overdue");
    await expect(page.getByTestId("operations-alterations-section")).toContainText(
      "Charcoal tuxedo pants",
    );

    await openBackofficeSidebarTab(page, "alterations");

    await expect(page.getByTestId("alterations-summary-overdue")).toContainText("1");
    await expect(page.getByTestId("alterations-summary-due_today")).toContainText("1");
    await expect(page.getByTestId("alterations-summary-ready")).toContainText("1");
    await expect(page.getByTestId("alterations-summary-open")).toContainText("5");

    await expect(page.getByTestId("alteration-workbench-section-overdue")).toContainText(
      "Charcoal tuxedo pants",
    );
    await expect(page.getByTestId("alteration-workbench-section-due_today")).toContainText(
      "Current sale suit jacket",
    );
    await expect(page.getByTestId("alteration-workbench-section-ready")).toContainText(
      "Stock navy blazer",
    );
    await expect(page.getByTestId("alteration-workbench-section-intake")).toContainText(
      "Customer-owned gown",
    );
    await expect(page.getByTestId("alteration-workbench-section-in_work")).toContainText(
      "Open order vest",
    );

    const cards = page.getByTestId("alteration-workbench-card");
    await expect(cards.filter({ hasText: "Current sale suit jacket" })).toContainText(
      "Current sale",
    );
    await expect(cards.filter({ hasText: "Stock navy blazer" })).toContainText(
      "Stock/catalog item",
    );
    await expect(cards.filter({ hasText: "Open order vest" })).toContainText("Existing order");
    await expect(cards.filter({ hasText: "Charcoal tuxedo pants" })).toContainText(
      "Past purchase",
    );
    await expect(cards.filter({ hasText: "Customer-owned gown" })).toContainText(
      "Custom/manual item",
    );
    await expect(page.getByText(/Source TXN-ORDER \/ garment line/i)).toBeVisible();
    await expect(page.getByText("Charge noted: $15.00")).toBeVisible();

    await page.getByTestId("alterations-due-filter-ready").click();
    await expect(page.getByTestId("alteration-workbench-card")).toHaveCount(1);
    await expect(page.getByTestId("alteration-workbench-section-ready")).toContainText(
      "Stock navy blazer",
    );

    await page.getByTestId("alterations-due-filter-all").click();
    await page.getByTestId("alterations-source-filter").selectOption("current_cart_item");
    await expect(page.getByTestId("alteration-workbench-card")).toHaveCount(1);
    await expect(page.getByTestId("alteration-workbench-section-due_today")).toContainText(
      "Current sale suit jacket",
    );

    await page.getByTestId("alterations-source-filter").selectOption("all");
    await page.getByTestId("alterations-search").fill("vest");
    await expect(page.getByTestId("alteration-workbench-card")).toHaveCount(1);
    await expect(page.getByTestId("alteration-workbench-section-in_work")).toContainText(
      "Open order vest",
    );
  });
});
