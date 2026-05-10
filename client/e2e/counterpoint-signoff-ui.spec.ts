import { expect, test, type Page } from "@playwright/test";

import { signInToBackOffice } from "./helpers/backofficeSignIn";

const NOW = "2026-05-01T12:00:00.000Z";
const BRIDGE_STATUS_URLS = [
  "http://127.0.0.1:3002/api/status",
  "http://localhost:3002/api/status",
];

async function openCounterpointSettings(
  page: Page,
  statusSection: "connect" | "details" | "signoff",
) {
  await page.addInitScript((section) => {
    window.localStorage.setItem("counterpoint.settingsTab", "status");
    window.localStorage.setItem("counterpoint.statusSection", section);
  }, statusSection);

  await signInToBackOffice(page, { persistSession: true });
  await page.goto("/settings/counterpoint", { waitUntil: "domcontentloaded" });

  const panel = page.getByTestId("counterpoint-settings-panel");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  return panel;
}

async function mockBridgeStatus(
  page: Page,
  payload: Record<string, unknown> | "unavailable",
) {
  for (const url of BRIDGE_STATUS_URLS) {
    await page.route(url, async (route) => {
      if (payload === "unavailable") {
        await route.abort("failed");
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(payload),
      });
    });
  }
}

async function mockCounterpointStatus(
  page: Page,
  overrides: Record<string, unknown> = {},
) {
  await page.route("**/api/settings/counterpoint-sync/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        windows_sync_state: "offline",
        offline_reason: "Bridge has not checked in",
        bridge_phase: "idle",
        current_entity: null,
        bridge_version: null,
        bridge_hostname: "counterpoint-host",
        last_seen_at: null,
        entity_runs: [],
        recent_issues: [],
        token_configured: true,
        counterpoint_staging_enabled: true,
        staging_pending_count: 0,
        ...overrides,
      }),
    });
  });
}

async function mockCounterpointProofRoutes(page: Page) {
  await page.route("**/api/settings/counterpoint-sync/landing-verification", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generated_at: NOW,
        disclaimer: "Landing verification checks visible migrated rows only.",
        rows: [
          {
            key: "products",
            label: "Products",
            count: 40,
            confidence: "direct",
            note: "Products landed from the catalog import.",
          },
          {
            key: "staff_records",
            label: "Staff records",
            count: 7,
            confidence: "approximate",
            note: "Staff attribution uses legacy cashier mapping.",
          },
        ],
        snapshot_reconciliation: [
          {
            key: "customers",
            label: "Customers",
            status: "pass",
            passed: true,
            source_count: 100,
            landed_count: 100,
            count_difference: 0,
            source_sum: null,
            landed_sum: "0.00",
            sum_difference: null,
            source_checksum: "customers-source",
            landed_checksum: "customers-source",
            checksum_matched: true,
            note: "Customer proof table matches.",
            source_updated_at: NOW,
          },
          {
            key: "catalog_products",
            label: "Catalog products",
            status: "fail",
            passed: false,
            source_count: 50,
            landed_count: 40,
            count_difference: -10,
            source_sum: null,
            landed_sum: "0.00",
            sum_difference: null,
            source_checksum: "catalog-source",
            landed_checksum: "catalog-landed",
            checksum_matched: false,
            note: "Catalog proof table is lower than the bridge count.",
            source_updated_at: NOW,
          },
        ],
        cutover_visibility: [
          {
            key: "register_products",
            label: "Register products",
            status: "pass",
            passed: true,
            count: 40,
            note: "Catalog items are visible to staff.",
          },
        ],
        fidelity_diagnostics: [],
      }),
    });
  });

  await page.route("**/api/settings/counterpoint-sync/transaction-reconciliation", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generated_at: NOW,
        disclaimer: "Imported tickets only.",
        totals: {
          imported_ticket_transactions: 3,
          transaction_lines: 5,
          payments: 3,
          transaction_total_sum: "1200.00",
          payment_amount_sum: "1199.00",
          difference: "1.00",
        },
        by_date: [],
        by_payment_type: [],
      }),
    });
  });

  await page.route("**/api/settings/counterpoint-sync/open-docs-verification", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generated_at: NOW,
        disclaimer: "Open document verification checks imported open docs only.",
        imported_open_doc_transactions: 2,
        imported_open_doc_lines: 0,
        imported_open_doc_payments: 0,
        open_docs_with_customer_linked: 1,
        open_docs_missing_customer: 1,
        open_docs_with_zero_lines: 1,
        open_docs_with_zero_payments: 1,
        distinct_staff_attribution_count: 1,
      }),
    });
  });

  await page.route("**/api/settings/counterpoint-sync/inventory-catalog-verification", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generated_at: NOW,
        disclaimer: "Catalog verification checks imported item identity fields.",
        counterpoint_products: 40,
        counterpoint_variants: 45,
        products_with_identifier_like_name: 1,
        products_name_equals_counterpoint_key: 0,
        variants_with_sku: 44,
        variants_with_barcode: 40,
        variants_with_cost: 42,
        variants_with_price: 45,
        variants_with_quantity_on_hand: 41,
        variants_missing_sku: 1,
        variants_missing_barcode: 5,
        variants_missing_cost: 3,
        variants_missing_price: 0,
        variants_zero_or_negative_quantity: 2,
        products_missing_category_mapping: 4,
        variants_missing_vendor_supplier_item_link: 6,
        distinct_vendors_linked_to_imported_items: 8,
      }),
    });
  });

  await page.route("**/api/settings/counterpoint-sync/reset-preview", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        confirmation_phrase: "RESET COUNTERPOINT IMPORT",
        pre_go_live_only_warning: "Only before go-live.",
        preserve_always: [],
        reset_scope: [],
        careful_ordering: [],
        excluded_for_now: [],
        bridge_local_state_note: "Reset bridge state separately.",
      }),
    });
  });
}

test.describe("Counterpoint sign-off UI", () => {
  test("shows bridge unavailable status without masking it as ready", async ({ page }) => {
    test.setTimeout(45_000);

    await mockBridgeStatus(page, "unavailable");
    await mockCounterpointStatus(page);
    await mockCounterpointProofRoutes(page);

    const panel = await openCounterpointSettings(page, "connect");

    await expect(
      panel.getByText("Bridge controls are not reachable on this workstation").first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByRole("button", { name: /reconnect to bridge/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(panel.getByText("Server: OFFLINE")).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText("Ready for sign-off review")).toHaveCount(0);
    await expect(panel.getByText("No automatic blockers detected")).toHaveCount(0);
  });

  test("keeps deterministic sign-off proof before optional ROSIE insight", async ({
    page,
  }) => {
    test.setTimeout(60_000);

    const rosieRequests: unknown[] = [];

    await mockBridgeStatus(page, {
      isSyncing: false,
      isContinuous: false,
      currentEntity: null,
      lastRun: NOW,
      lastRunDurationMs: 42_000,
      totalRecordsLastRun: 175,
      abortRequested: false,
      entityStats: {
        customers: { lastSync: NOW, recordCount: 100, durationMs: 9_000 },
        catalog: { lastSync: NOW, recordCount: 50, durationMs: 11_000 },
        inventory: {
          lastSync: NOW,
          recordCount: 25,
          durationMs: 5_000,
          error: "Quantity import stopped",
        },
      },
      syncSummary: {},
      recentEvents: [],
      migrationPreflight: {
        migration_intent: "counterpoint_cutover",
        source_input: "Counterpoint SQL",
        destination_system_of_record: "Riverside OS",
        cp_import_since: "2026-04-01",
        run_once: true,
        bridge_continuous_mode: false,
        staging_enabled: true,
        sync_relaxed_dependencies: false,
        import_scope: {
          cp_import_scope: null,
          enabled_entities: ["customers", "catalog", "inventory", "gift_cards"],
          query_placeholders_use_cp_import_since: ["tickets"],
        },
        non_idempotent_entities: [],
        rerun_warnings: [],
        retirement_checklist: [
          "Stop the bridge after acceptance.",
          "Rotate the sync token.",
        ],
      },
    });
    await mockCounterpointStatus(page, {
      windows_sync_state: "online",
      offline_reason: null,
      bridge_version: "0.3.4",
      last_seen_at: NOW,
      staging_pending_count: 2,
      entity_runs: [
        {
          entity: "customers",
          cursor_value: null,
          last_ok_at: NOW,
          last_error: null,
          records_processed: 100,
          updated_at: NOW,
        },
        {
          entity: "catalog",
          cursor_value: null,
          last_ok_at: NOW,
          last_error: null,
          records_processed: 40,
          updated_at: NOW,
        },
        {
          entity: "gift_cards",
          cursor_value: null,
          last_ok_at: NOW,
          last_error: null,
          records_processed: 4,
          updated_at: NOW,
        },
      ],
      recent_issues: [
        {
          id: 1,
          entity: "inventory",
          external_key: "INV-1",
          severity: "warning",
          message: "Inventory quantity mismatch",
          resolved: false,
          created_at: NOW,
        },
      ],
    });
    await mockCounterpointProofRoutes(page);
    await page.route("**/api/help/rosie/v1/insight-summary", async (route) => {
      rosieRequests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "unavailable", bullets: [] }),
      });
    });

    const panel = await openCounterpointSettings(page, "details");

    await expect(panel.getByText("Post-import verification")).toBeVisible({
      timeout: 20_000,
    });
    await expect(panel.getByText("Sign-off reconciliation")).toBeVisible({
      timeout: 20_000,
    });
    const postImportBeforeSignoff = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll("h4, p, span"));
      const postImport = elements.find(
        (element) => element.textContent?.trim() === "Post-import verification",
      );
      const signoff = elements.find(
        (element) => element.textContent?.trim() === "Sign-off reconciliation",
      );
      return Boolean(
        postImport &&
          signoff &&
          postImport.compareDocumentPosition(signoff) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });
    expect(postImportBeforeSignoff).toBe(true);

    await expect(panel.getByText("Sign-off blockers present")).toBeVisible();
    await expect(
      panel.getByText("2 staging batch(es) are still pending Apply."),
    ).toBeVisible();
    await expect(panel.getByText("1 unresolved sync issue(s) remain.")).toBeVisible();
    await expect(
      panel.getByText("1 entity row(s) have bridge-reported counts without ROS landed proof."),
    ).toBeVisible();
    await expect(
      panel.getByText("At least one bridge entity still shows an error in the latest visible run."),
    ).toBeVisible();
    await expect(panel.getByText("Limits and caveats")).toBeVisible();

    await expect(panel.getByText("Bridge rows sent")).toBeVisible();
    await expect(panel.getByText("ROS rows landed")).toBeVisible();
    await expect(panel.getByText("Missing ROS landed proof")).toBeVisible();
    await expect(panel.getByText("Counts match")).toBeVisible();
    await expect(panel.getByText("ROS count lower")).toBeVisible();
    await expect(panel.getByText("Bridge only")).toBeVisible();

    const rosieInsight = panel.getByTestId("rosie-insight-summary-counterpoint_status");
    await expect(rosieInsight).toBeVisible();
    await expect(panel.getByText("Optional explanation of displayed checks only")).toBeVisible();
    await expect(rosieInsight).not.toContainText(/approve sign-off|declare cutover safe/i);

    const proofBeforeRosie = await page.evaluate(() => {
      const table = Array.from(document.querySelectorAll("table")).find((candidate) =>
        candidate.textContent?.includes("Bridge rows sent"),
      );
      const insight = document.querySelector(
        '[data-testid="rosie-insight-summary-counterpoint_status"]',
      );
      return Boolean(
        table &&
          insight &&
          table.compareDocumentPosition(insight) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });
    expect(proofBeforeRosie).toBe(true);

    expect(rosieRequests).toHaveLength(0);

    await rosieInsight
      .getByRole("button", { name: /counterpoint sign-off rosie insight/i })
      .click();
    expect(rosieRequests).toHaveLength(1);
    expect(rosieRequests[0]).toMatchObject({
      surface: "counterpoint_status",
      mode: "explain",
    });
  });
});
