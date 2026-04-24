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
  status: string;
  source_type?: string | null;
  item_description?: string | null;
  work_requested?: string | null;
  source_sku?: string | null;
  charge_amount?: string | number | null;
  intake_channel?: string;
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

  test("Intake filter is visible and usable in Back Office Alterations", async ({
    page,
  }) => {
    await signInToBackOffice(page, { persistSession: true });
    await openBackofficeSidebarTab(page, "alterations");

    const intakeFilter = page.getByRole("button", { name: /^intake$/i });
    await expect(intakeFilter).toBeVisible({ timeout: 20_000 });
    await intakeFilter.click();
    await expect(intakeFilter).toHaveClass(/bg-app-accent/);
    await expect(page.getByText("Item Source", { exact: true })).toBeVisible();
    await expect(page.getByText("Work Requested", { exact: true })).toBeVisible();
  });
});
