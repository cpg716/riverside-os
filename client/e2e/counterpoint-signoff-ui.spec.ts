import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { signInToBackOffice } from "./helpers/backofficeSignIn";
import { adminHeaders, apiBase, uniqueSuffix } from "./helpers/inventoryReceiving";

const NOW = "2026-05-01T12:00:00.000Z";
const BRIDGE_STATUS_URLS = [
  "http://127.0.0.1:3002/api/status",
  "http://localhost:3002/api/status",
];

async function openCounterpointSettings(
  page: Page,
  statusSection: "connect" | "details" | "signoff" | "advanced",
) {
  const renderErrors: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (text.includes("APP_RENDER_ERROR")) {
      renderErrors.push(text);
    }
  });
  await page.addInitScript((section) => {
    window.localStorage.setItem("counterpoint.settingsTab", "status");
    window.localStorage.setItem("counterpoint.statusSection", section);
  }, statusSection);

  await signInToBackOffice(page, { persistSession: true });
  await page.goto("/settings/counterpoint", { waitUntil: "domcontentloaded" });

  const panel = page.getByTestId("counterpoint-settings-panel");
  try {
    await expect(panel).toBeVisible({ timeout: 20_000 });
  } catch (error) {
    throw new Error(`${String(error)}\n${renderErrors.join("\n")}`);
  }
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

function stagingBatch(overrides: Record<string, unknown>) {
  return {
    id: 1,
    entity: "catalog",
    row_count: 1,
    status: "pending",
    apply_error: null,
    bridge_version: "test",
    bridge_hostname: "counterpoint-host",
    created_at: NOW,
    applied_at: null,
    applied_by_staff_id: null,
    applied_by_staff_name: null,
    apply_started_at: null,
    apply_claimed_by_staff_id: null,
    apply_claimed_by_staff_name: null,
    replay_count: 0,
    last_replayed_at: null,
    payload_fingerprint: "abc123",
    recovered_at: null,
    recovered_by_staff_id: null,
    recovered_by_staff_name: null,
    recovery_reason: null,
    ...overrides,
  };
}

async function mockCounterpointProofRoutes(page: Page) {
  const snapshotReconciliation = [
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
  ];
  await page.route("**/api/settings/counterpoint-sync/command-center", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generated_at: NOW,
        mode: "import_first",
        required_history_start: "2018-01-01",
        token_configured: true,
        latest_preflight: {
          id: "00000000-0000-0000-0000-000000000001",
          run_kind: "preflight",
          status: "preflight_passed",
          history_start: "2018-01-01",
          bridge_hostname: "counterpoint-host",
          bridge_version: "test",
          ros_base_url: "http://127.0.0.1:3000",
          source_fingerprint: "abc",
          preflight_passed: true,
          preflight_blockers: [],
          totals: {},
          started_at: NOW,
          completed_at: NOW,
          created_at: NOW,
          updated_at: NOW,
        },
        source_counts: [
          {
            entity_key: "customers",
            label: "Counterpoint customers",
            source_count: 100,
            source_sum: null,
            source_checksum: null,
            required: true,
            suspicious_min_count: null,
            status: "ok",
            message: null,
          },
          {
            entity_key: "catalog_products",
            label: "Catalog products",
            source_count: 50,
            source_sum: null,
            source_checksum: null,
            required: true,
            suspicious_min_count: null,
            status: "ok",
            message: null,
          },
        ],
        landing_rows: [],
        snapshot_reconciliation: snapshotReconciliation,
        open_exception_count: 0,
        fallback_landed_exception_count: 0,
        staging_open_count: 0,
        ready_for_import: true,
        ready_for_go_live_review: true,
        recommendation: "GO FOR REHEARSAL IMPORT",
      }),
    });
  });
  await page.route("**/api/settings/counterpoint-sync/exceptions**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ rows: [] }),
    });
  });
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
        snapshot_reconciliation: snapshotReconciliation,
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
          imported_zero_tax_lines: 5,
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
        imported_open_doc_zero_tax_lines: 2,
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

async function mockEmptyCounterpointProofRoutes(page: Page) {
  await page.route("**/api/settings/counterpoint-sync/command-center", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generated_at: NOW,
        mode: "import_first",
        required_history_start: "2018-01-01",
        token_configured: true,
        latest_preflight: null,
        source_counts: [],
        landing_rows: [],
        snapshot_reconciliation: [],
        open_exception_count: 0,
        fallback_landed_exception_count: 0,
        staging_open_count: 0,
        ready_for_import: false,
        ready_for_go_live_review: false,
        recommendation: "NO-GO: run Bridge source-count preflight first.",
      }),
    });
  });
  await page.route("**/api/settings/counterpoint-sync/exceptions**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ rows: [] }),
    });
  });
  await page.route("**/api/settings/counterpoint-sync/landing-verification", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generated_at: NOW,
        disclaimer: "Landing verification checks visible migrated rows only.",
        rows: [],
        snapshot_reconciliation: [],
        cutover_visibility: [],
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
          imported_ticket_transactions: 0,
          transaction_lines: 0,
          imported_zero_tax_lines: 0,
          payments: 0,
          transaction_total_sum: "0.00",
          payment_amount_sum: "0.00",
          difference: "0.00",
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
        imported_open_doc_transactions: 0,
        imported_open_doc_lines: 0,
        imported_open_doc_zero_tax_lines: 0,
        imported_open_doc_payments: 0,
        open_docs_with_customer_linked: 0,
        open_docs_missing_customer: 0,
        open_docs_with_zero_lines: 0,
        open_docs_with_zero_payments: 0,
        distinct_staff_attribution_count: 0,
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
        counterpoint_products: 0,
        counterpoint_variants: 0,
        products_with_identifier_like_name: 0,
        products_name_equals_counterpoint_key: 0,
        variants_with_sku: 0,
        variants_with_barcode: 0,
        variants_with_cost: 0,
        variants_with_price: 0,
        variants_with_quantity_on_hand: 0,
        variants_missing_sku: 0,
        variants_missing_barcode: 0,
        variants_missing_cost: 0,
        variants_missing_price: 0,
        variants_zero_or_negative_quantity: 0,
        products_missing_category_mapping: 0,
        variants_missing_vendor_supplier_item_link: 0,
        distinct_vendors_linked_to_imported_items: 0,
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

async function mockCounterpointWorkbenchState(page: Page, overrides: Record<string, unknown> = {}) {
  const baseState = {
    current_step: "data_sources",
    steps: {
      data_sources: { status: "pending", approved_at: null },
      categories: { status: "locked", approved_at: null },
      vendors: { status: "locked", approved_at: null },
      catalog: { status: "locked", approved_at: null },
      sku_gaps: { status: "locked", approved_at: null },
      verification: { status: "locked", approved_at: null },
    },
    inventory_summary: {
      products: 0,
      variants: 0,
      categories: 0,
      vendors: 0,
      variants_missing_barcode: 0,
      quarantine_count: 0,
    },
    can_reset: true,
  };
  await page.route("**/api/settings/counterpoint-sync/workbench/state", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...baseState, ...overrides }),
    });
  });
}

function runCounterpointSql(sql: string): string {
  const dbName = process.env.E2E_DB_NAME ?? "riverside_os_e2e";
  return execFileSync(
    "docker",
    ["exec", "riverside-os-db", "psql", "-U", "postgres", "-d", dbName, "-At", "-c", sql],
    { encoding: "utf8" },
  ).trim();
}

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function inventoryStagingPayload(sku: string): Record<string, unknown> {
  return {
    rows: [
      {
        sku,
        stock_on_hand: 3,
        counterpoint_item_key: sku,
        unit_cost: "1.00",
      },
    ],
    sync: {
      entity: "inventory",
      cursor: `e2e-${sku}`,
    },
  };
}

function counterpointSyncHeaders(): Record<string, string> {
  const envToken = process.env.COUNTERPOINT_SYNC_TOKEN?.trim();
  const fileToken =
    envToken ??
    (() => {
      try {
        return readFileSync(new URL("../../server/.env", import.meta.url), "utf8")
          .match(/^COUNTERPOINT_SYNC_TOKEN=(.+)$/m)?.[1]
          ?.trim();
      } catch {
        return undefined;
      }
    })() ??
    "e2e-counterpoint-sync-token";
  expect(fileToken, "COUNTERPOINT_SYNC_TOKEN must be configured for staging replay coverage").toBeTruthy();
  return {
    "x-ros-sync-token": fileToken ?? "",
    "x-bridge-version": "e2e",
    "x-bridge-hostname": "counterpoint-e2e",
  };
}

function enableCounterpointStaging(): void {
  runCounterpointSql(`
    UPDATE store_settings
    SET counterpoint_config = counterpoint_config || '{"staging_enabled": true}'::jsonb
    WHERE id = 1;
  `);
}

function seedInventoryStagingBatch(sku: string): number {
  const payload = JSON.stringify(inventoryStagingPayload(sku));
  const output = runCounterpointSql(`
    INSERT INTO counterpoint_staging_batch
      (entity, payload, row_count, bridge_version, bridge_hostname, payload_fingerprint)
    VALUES
      ('inventory', ${sqlText(payload)}::jsonb, 1, 'e2e', 'counterpoint-e2e', md5(${sqlText(payload)}::jsonb::text))
    RETURNING id
  `);
  const id = output.split(/\s+/).find((value) => /^\d+$/.test(value)) ?? "";
  expect(id).toMatch(/^\d+$/);
  return Number(id);
}

function counterpointBatchCountForPayload(entity: string, payload: Record<string, unknown>): number {
  const output = runCounterpointSql(`
    SELECT COUNT(*)::int
    FROM counterpoint_staging_batch
    WHERE entity = ${sqlText(entity)}
      AND payload = ${sqlText(JSON.stringify(payload))}::jsonb
      AND status IN ('pending', 'applying', 'applied');
  `);
  return Number(output);
}

function counterpointRecordsProcessed(entity: string): string {
  return runCounterpointSql(`
    SELECT COALESCE(records_processed::text, '')
    FROM counterpoint_sync_runs
    WHERE entity = ${sqlText(entity)};
  `);
}

function counterpointBatchStatus(batchId: number): string {
  return runCounterpointSql(
    `SELECT status FROM counterpoint_staging_batch WHERE id = ${batchId}`,
  );
}

function markCounterpointBatchApplying(batchId: number, startedAtSql: string): void {
  runCounterpointSql(`
    UPDATE counterpoint_staging_batch
    SET status = 'applying',
        apply_error = NULL,
        apply_started_at = ${startedAtSql},
        apply_claimed_by_staff_id = NULL
    WHERE id = ${batchId};
  `);
}

function counterpointBatchApplyError(batchId: number): string {
  return runCounterpointSql(
    `SELECT COALESCE(apply_error, '') FROM counterpoint_staging_batch WHERE id = ${batchId}`,
  );
}

function counterpointBatchRecoveryReason(batchId: number): string {
  return runCounterpointSql(
    `SELECT COALESCE(recovery_reason, '') FROM counterpoint_staging_batch WHERE id = ${batchId}`,
  );
}

function cleanupCounterpointStagingBatch(batchId: number, sku: string): void {
  runCounterpointSql(`
    DELETE FROM counterpoint_sync_issue
    WHERE entity = 'inventory'
      AND external_key = ${sqlText(sku)};
    DELETE FROM counterpoint_staging_batch
    WHERE id = ${batchId};
  `);
}

test.describe("Counterpoint sign-off UI", () => {
  test("duplicate staging POST replay reuses one pending batch", async ({ request }) => {
    enableCounterpointStaging();
    const sku = uniqueSuffix("CP-INGEST").toUpperCase();
    const payload = inventoryStagingPayload(sku);
    const beforeRecordsProcessed = counterpointRecordsProcessed("inventory");
    const stagingUrl = `${apiBase()}/api/sync/counterpoint/staging`;
    const requestBody = {
      entity: "inventory",
      payload,
    };

    const responses = await Promise.all([
      request.post(stagingUrl, {
        headers: counterpointSyncHeaders(),
        data: requestBody,
        failOnStatusCode: false,
      }),
      request.post(stagingUrl, {
        headers: counterpointSyncHeaders(),
        data: requestBody,
        failOnStatusCode: false,
      }),
    ]);
      const bodies = await Promise.all(
      responses.map(async (response) => ({
        status: response.status(),
        json: (await response.json()) as {
          ok?: boolean;
          staging_batch_id?: number;
          replayed?: boolean;
          error?: string;
        },
      })),
    );
      const batchId = bodies[0].json.staging_batch_id;

    try {
      expect(bodies, JSON.stringify(bodies)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 200,
            json: expect.objectContaining({ ok: true, replayed: false }),
          }),
          expect.objectContaining({
            status: 200,
            json: expect.objectContaining({ ok: true, replayed: true }),
          }),
        ]),
      );
      expect(batchId).toBeTruthy();
      expect(bodies[1].json.staging_batch_id).toBe(batchId);
      expect(counterpointBatchCountForPayload("inventory", payload)).toBe(1);
      expect(counterpointRecordsProcessed("inventory")).toBe(beforeRecordsProcessed);
      const listRes = await request.get(
        `${apiBase()}/api/settings/counterpoint-sync/staging/batches?limit=10`,
        { headers: adminHeaders() },
      );
      expect(listRes.ok(), await listRes.text()).toBeTruthy();
      const rows = (await listRes.json()) as Array<{
        id: number;
        replay_count: number;
        last_replayed_at: string | null;
        payload_fingerprint: string | null;
      }>;
      const batchRow = rows.find((row) => row.id === batchId);
      expect(batchRow).toMatchObject({
        id: batchId,
        replay_count: 1,
      });
      expect(batchRow?.last_replayed_at).toBeTruthy();
      expect(batchRow?.payload_fingerprint).toMatch(/^[0-9a-f]{32}$/);

      const applyRes = await request.post(
        `${apiBase()}/api/settings/counterpoint-sync/staging/batches/${batchId}/apply`,
        { headers: adminHeaders(), failOnStatusCode: false },
      );
      expect(applyRes.status(), await applyRes.text()).toBe(200);
      expect(await applyRes.json()).toMatchObject({ applied: true });
      expect(counterpointBatchStatus(batchId ?? 0)).toBe("applied");
    } finally {
      if (batchId) {
        cleanupCounterpointStagingBatch(batchId, sku);
      }
    }
  });

  test("staged batch apply is single-claim under concurrent requests", async ({ request }) => {
    const sku = uniqueSuffix("CP-RACE").toUpperCase();
    const batchId = seedInventoryStagingBatch(sku);

    try {
      const applyUrl = `${apiBase()}/api/settings/counterpoint-sync/staging/batches/${batchId}/apply`;
      const responses = await Promise.all([
        request.post(applyUrl, { headers: adminHeaders(), failOnStatusCode: false }),
        request.post(applyUrl, { headers: adminHeaders(), failOnStatusCode: false }),
      ]);
      const responseBodies = await Promise.all(
        responses.map(async (response) => ({
          status: response.status(),
          body: await response.text(),
        })),
      );

      const successes = responseBodies.filter((response) => response.status === 200);
      const duplicates = responseBodies.filter((response) => response.status !== 200);
      expect(responseBodies.map((response) => response.status).sort()).toEqual([200, 400]);
      expect(successes).toHaveLength(1);
      expect(JSON.parse(successes[0].body)).toMatchObject({ applied: true });
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0].body).toMatch(/batch status is (applying|applied), expected pending/i);
      expect(counterpointBatchStatus(batchId)).toBe("applied");
    } finally {
      cleanupCounterpointStagingBatch(batchId, sku);
    }
  });

  test("stale applying batch recovery marks failed without replay", async ({ request }) => {
    const sku = uniqueSuffix("CP-STALE").toUpperCase();
    const batchId = seedInventoryStagingBatch(sku);

    try {
      markCounterpointBatchApplying(batchId, "NOW() - INTERVAL '30 minutes'");

      const listRes = await request.get(
        `${apiBase()}/api/settings/counterpoint-sync/staging/batches?status=applying`,
        { headers: adminHeaders() },
      );
      expect(listRes.ok(), await listRes.text()).toBeTruthy();
      const applyingRows = (await listRes.json()) as Array<{
        id: number;
        status: string;
        apply_started_at?: string | null;
        apply_claimed_by_staff_id?: string | null;
        recovered_at?: string | null;
        recovered_by_staff_id?: string | null;
        recovery_reason?: string | null;
      }>;
      const applyingRow = applyingRows.find((row) => row.id === batchId);
      expect(applyingRow).toMatchObject({
        id: batchId,
        status: "applying",
      });
      expect(applyingRow?.apply_started_at).toBeTruthy();
      expect(applyingRow).toHaveProperty("apply_claimed_by_staff_id");

      const statusRes = await request.get(`${apiBase()}/api/settings/counterpoint-sync/status`, {
        headers: adminHeaders(),
      });
      expect(statusRes.ok(), await statusRes.text()).toBeTruthy();
      const statusJson = (await statusRes.json()) as {
        staging_pending_count: number;
        staging_applying_count?: number;
        staging_open_count?: number;
      };
      expect(statusJson.staging_applying_count ?? 0).toBeGreaterThanOrEqual(1);
      expect(statusJson.staging_open_count ?? 0).toBeGreaterThanOrEqual(1);

      const recoverRes = await request.post(
        `${apiBase()}/api/settings/counterpoint-sync/staging/batches/${batchId}/recover-stale`,
        { headers: adminHeaders(), failOnStatusCode: false },
      );
      expect(recoverRes.status(), await recoverRes.text()).toBe(200);
      expect(await recoverRes.json()).toMatchObject({ recovered: true, status: "failed" });
      expect(counterpointBatchStatus(batchId)).toBe("failed");
      expect(counterpointBatchApplyError(batchId)).toMatch(/payload was not replayed/i);
      expect(counterpointBatchRecoveryReason(batchId)).toMatch(/payload was not replayed/i);

      const recoveredListRes = await request.get(
        `${apiBase()}/api/settings/counterpoint-sync/staging/batches?status=failed`,
        { headers: adminHeaders() },
      );
      expect(recoveredListRes.ok(), await recoveredListRes.text()).toBeTruthy();
      const recoveredRows = (await recoveredListRes.json()) as Array<{
        id: number;
        recovered_at?: string | null;
        recovered_by_staff_id?: string | null;
        recovered_by_staff_name?: string | null;
        recovery_reason?: string | null;
      }>;
      const recoveredRow = recoveredRows.find((row) => row.id === batchId);
      expect(recoveredRow?.recovered_at).toBeTruthy();
      expect(recoveredRow?.recovered_by_staff_id).toBeTruthy();
      expect(recoveredRow?.recovered_by_staff_name).toBeTruthy();
      expect(recoveredRow?.recovery_reason).toMatch(/payload was not replayed/i);
    } finally {
      cleanupCounterpointStagingBatch(batchId, sku);
    }
  });

  test("non-stale applying batch recovery is rejected", async ({ request }) => {
    const sku = uniqueSuffix("CP-FRESH").toUpperCase();
    const batchId = seedInventoryStagingBatch(sku);

    try {
      markCounterpointBatchApplying(batchId, "NOW()");

      const recoverRes = await request.post(
        `${apiBase()}/api/settings/counterpoint-sync/staging/batches/${batchId}/recover-stale`,
        { headers: adminHeaders(), failOnStatusCode: false },
      );
      expect(recoverRes.status(), await recoverRes.text()).toBe(409);
      expect(await recoverRes.json()).toMatchObject({
        error: "batch is not a stale applying claim",
      });
      expect(counterpointBatchStatus(batchId)).toBe("applying");
    } finally {
      cleanupCounterpointStagingBatch(batchId, sku);
    }
  });

  test("staging UI surfaces replay and stale apply recovery metadata", async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    enableCounterpointStaging();
    const replaySku = uniqueSuffix("CP-UI-REPLAY").toUpperCase();
    const staleSku = uniqueSuffix("CP-UI-STALE").toUpperCase();
    const replayPayload = inventoryStagingPayload(replaySku);
    const stagingUrl = `${apiBase()}/api/sync/counterpoint/staging`;
    const replayBody = { entity: "inventory", payload: replayPayload };
    const firstReplayRes = await request.post(stagingUrl, {
      headers: counterpointSyncHeaders(),
      data: replayBody,
      failOnStatusCode: false,
    });
    expect(firstReplayRes.status(), await firstReplayRes.text()).toBe(200);
    const replayJson = (await firstReplayRes.json()) as { staging_batch_id: number };
    const replayBatchId = replayJson.staging_batch_id;
    const secondReplayRes = await request.post(stagingUrl, {
      headers: counterpointSyncHeaders(),
      data: replayBody,
      failOnStatusCode: false,
    });
    expect(secondReplayRes.status(), await secondReplayRes.text()).toBe(200);
    const staleBatchId = seedInventoryStagingBatch(staleSku);

    try {
      markCounterpointBatchApplying(staleBatchId, "NOW() - INTERVAL '30 minutes'");
      await mockBridgeStatus(page, "unavailable");
      await mockCounterpointStatus(page);
      await mockCounterpointProofRoutes(page);
      const panel = await openCounterpointSettings(page, "connect");
      await panel.getByRole("button", { name: /inbound queue/i }).click();
      await expect(panel.getByText("Staging diagnostics")).toBeVisible();
      await expect(panel.getByText("Batches", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await panel.getByRole("button", { name: /^reload$/i }).click();
      await expect(panel.getByRole("cell", { name: String(replayBatchId), exact: true })).toBeVisible();
      await expect(panel.getByText("Replay suppressed x1")).toBeVisible();
      await expect(panel.getByRole("cell", { name: String(staleBatchId), exact: true })).toBeVisible();
      await expect(panel.getByRole("table").getByText("Stale applying")).toBeVisible();

      await panel.getByRole("cell", { name: String(staleBatchId), exact: true }).click();
      await expect(panel.getByText("Apply claimed", { exact: true })).toBeVisible();
      await expect(panel.getByText(/Safe recovery is available/i)).toBeVisible();
      await expect(panel.getByText(/Next safe action: Recovery review/i)).toBeVisible();
      await expect(panel.getByText("Operational decision guide")).toBeVisible();
      await expect(panel.getByText("What changed")).toBeVisible();
      await expect(panel.getByText("Replay visibility")).toBeVisible();
      await expect(panel.getByText("Recovery guidance")).toBeVisible();
      await expect(panel.getByText("Live write result")).toBeVisible();
      await expect(panel.getByText(/Apply is active; wait before taking recovery action/i).first()).toBeVisible();
      await expect(panel.getByText(/Only stale recovery is available for this batch/i)).toBeVisible();
      await expect(panel.getByText(/Payload fingerprint:/i)).toBeVisible();
      await expect(panel.getByRole("button", { name: /mark stale apply failed/i })).toBeEnabled();
      await panel.getByRole("button", { name: /mark stale apply failed/i }).click();
      await expect(page.getByText("Mark stale apply failed?")).toBeVisible();
      await expect(page.getByText(/does not replay the payload/i)).toBeVisible();
      await page.getByRole("button", { name: "Mark failed" }).click();
      await expect(panel.getByRole("table").getByText("Recovered stale apply")).toBeVisible({
        timeout: 15_000,
      });
      await expect(panel.getByText("Recovered by Chris G")).toBeVisible();
      await expect(panel.getByText(/Recovery note: .*payload was not replayed/i)).toBeVisible({
        timeout: 15_000,
      });
      expect(counterpointBatchStatus(staleBatchId)).toBe("failed");
    } finally {
      cleanupCounterpointStagingBatch(replayBatchId, replaySku);
      cleanupCounterpointStagingBatch(staleBatchId, staleSku);
    }
  });

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

  test("defaults to one-time import overview and keeps AI review optional", async ({ page }) => {
    test.setTimeout(60_000);
    const rows = [
      stagingBatch({ id: 12, entity: "receiving_history", row_count: 2 }),
      stagingBatch({ id: 10, entity: "catalog", row_count: 50 }),
      stagingBatch({ id: 11, entity: "inventory", row_count: 75 }),
    ];
    await page.route("**/api/settings/counterpoint-sync/staging/batches**", async (route) => {
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
    await mockBridgeStatus(page, "unavailable");
    await mockCounterpointStatus(page, {
      entity_runs: [
        {
          entity: "catalog",
          cursor_value: null,
          last_ok_at: NOW,
          last_error: null,
          records_processed: 50,
          updated_at: NOW,
        },
        {
          entity: "inventory",
          cursor_value: null,
          last_ok_at: NOW,
          last_error: null,
          records_processed: 75,
          updated_at: NOW,
        },
        {
          entity: "receiving_history",
          cursor_value: null,
          last_ok_at: NOW,
          last_error: null,
          records_processed: 2,
          updated_at: NOW,
        },
      ],
      staging_entity_counts: [
        {
          entity: "catalog",
          pending_batches: 1,
          applying_batches: 0,
          applied_batches: 0,
          pending_rows: 50,
          applying_rows: 0,
          applied_rows: 0,
          latest_at: NOW,
        },
        {
          entity: "inventory",
          pending_batches: 1,
          applying_batches: 0,
          applied_batches: 0,
          pending_rows: 75,
          applying_rows: 0,
          applied_rows: 0,
          latest_at: NOW,
        },
        {
          entity: "receiving_history",
          pending_batches: 1,
          applying_batches: 0,
          applied_batches: 0,
          pending_rows: 2,
          applying_rows: 0,
          applied_rows: 0,
          latest_at: NOW,
        },
      ],
      staging_pending_count: 3,
      staging_applying_count: 0,
    });
    await mockEmptyCounterpointProofRoutes(page);
    await mockCounterpointWorkbenchState(page);

    const panel = await openCounterpointSettings(page, "connect");

    await expect(panel.getByText("Counterpoint Import-First Go-Live")).toBeVisible();
    await expect(panel.getByText("Counterpoint Import Command Center")).toBeVisible();
    await expect(panel.getByText("Import proof and advanced controls")).toBeVisible();
    await expect(panel.getByText("Inventory, catalog, and quantities")).toBeVisible();
    await expect(panel.getByText("Sales and movement history")).toBeVisible();
    await expect(panel.getByRole("button", { name: /run full import/i })).toBeDisabled();
    await expect(
      panel.getByRole("heading", { name: "Counterpoint Transition Review Packs" }),
    ).toHaveCount(0);

    await panel.getByRole("button", { name: /ai review packs/i }).click();
    await expect(panel.getByText("Counterpoint Transition Review Packs")).toBeVisible();
  });

  test("blocks wizard advancement when bridge rows lack ROS proof", async ({ page }) => {
    test.setTimeout(60_000);
    await mockBridgeStatus(page, "unavailable");
    await mockCounterpointStatus(page, {
      entity_runs: [
        {
          entity: "customers",
          cursor_value: null,
          last_ok_at: NOW,
          last_error: null,
          records_processed: 25,
          updated_at: NOW,
        },
      ],
      staging_entity_counts: [],
      staging_pending_count: 0,
      staging_applying_count: 0,
    });
    await mockEmptyCounterpointProofRoutes(page);
    await mockCounterpointWorkbenchState(page);

    const panel = await openCounterpointSettings(page, "connect");
    await panel.getByRole("button", { name: /legacy diagnostics/i }).click({ force: true });

    await expect(panel.getByText("Counterpoint review advancement blocked")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      panel.getByText(
        "Bridge runs reported 25 row(s), but no downstream review surface or landed proof is available.",
      ),
    ).toBeVisible();
    await expect(panel.getByRole("button", { name: /advance to inventory mapping/i })).toBeDisabled();
  });

  test("marks stale catalog approval blocked when staged import has not landed", async ({ page }) => {
    test.setTimeout(60_000);
    let requestedFullQueue = false;
    await page.route("**/api/settings/counterpoint-sync/staging/batches**", async (route) => {
      const url = new URL(route.request().url());
      requestedFullQueue = url.searchParams.get("limit") === "5000";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: 9001,
            entity: "catalog",
            row_count: 503498,
            status: "pending",
            apply_error: null,
            bridge_version: "test",
            bridge_hostname: "counterpoint-host",
            created_at: NOW,
            applied_at: null,
            applied_by_staff_id: null,
            applied_by_staff_name: null,
            apply_started_at: null,
            apply_claimed_by_staff_id: null,
            apply_claimed_by_staff_name: null,
            replay_count: 0,
            last_replayed_at: null,
            payload_fingerprint: "abc123",
            recovered_at: null,
            recovered_by_staff_id: null,
            recovered_by_staff_name: null,
            recovery_reason: null,
          },
        ]),
      });
    });
    await mockBridgeStatus(page, "unavailable");
    await mockCounterpointStatus(page, {
      entity_runs: [
        {
          entity: "catalog",
          cursor_value: null,
          last_ok_at: NOW,
          last_error: null,
          records_processed: 503498,
          updated_at: NOW,
        },
      ],
      staging_entity_counts: [
        {
          entity: "catalog",
          pending_batches: 1,
          applying_batches: 0,
          applied_batches: 0,
          pending_rows: 503498,
          applying_rows: 0,
          applied_rows: 0,
          latest_at: NOW,
        },
      ],
      staging_pending_count: 1136,
      staging_applying_count: 0,
    });
    await mockEmptyCounterpointProofRoutes(page);
    await mockCounterpointWorkbenchState(page, {
      steps: {
        data_sources: { status: "complete", approved_at: NOW },
        categories: { status: "complete", approved_at: NOW },
        vendors: { status: "complete", approved_at: NOW },
        catalog: { status: "complete", approved_at: NOW },
        sku_gaps: { status: "complete", approved_at: NOW },
        verification: { status: "complete", approved_at: NOW },
      },
      inventory_summary: {
        products: 0,
        variants: 0,
        categories: 0,
        vendors: 0,
        variants_missing_barcode: 0,
        quarantine_count: 737996,
      },
    });

    const panel = await openCounterpointSettings(page, "connect");
    await panel.getByRole("button", { name: /legacy diagnostics/i }).click({ force: true });
    await expect(panel.getByRole("button", { name: /advance to inventory mapping/i })).toBeEnabled();
    await panel.getByRole("button", { name: /advance to inventory mapping/i }).click();

    await expect(panel.getByText("One-time import is still waiting in staging")).toBeVisible();
    await expect(panel.getByText("Nothing has been loaded into ROS catalog tables yet.")).toBeVisible();
    await expect(panel.getByText(/Previous catalog approval is stale/i)).toBeVisible();
    await expect(panel.getByText(/Previous inventory approval is stale/i)).toBeVisible();
    await expect(panel.getByText("Inventory step verified and approved.")).toHaveCount(0);
    expect(requestedFullQueue).toBe(true);
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

    await expect(panel.getByText("Support diagnostics center")).toBeVisible({
      timeout: 20_000,
    });
    await expect(panel.getByText("Deployment visibility")).toBeVisible();
    await expect(panel.getByText("Recovery and replay posture")).toBeVisible();
    await expect(panel.getByRole("button", { name: /copy support report/i })).toBeVisible();
    await expect(panel.getByText("Counterpoint Support Diagnostics")).toBeVisible();
    await expect(panel.getByText("Direct controls reachable", { exact: true }).first()).toBeVisible();
    await expect(panel.getByText("Pending apply", { exact: true }).first()).toBeVisible();
    await expect(panel.getByText("Support review needed", { exact: true }).first()).toBeVisible();

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
    await expect(panel.getByText("2 staging batch(es) are pending review.")).toBeVisible();
    await expect(panel.getByText("1 unresolved sync issue(s) remain.")).toBeVisible();
    await expect(
      panel.getByText("1 entity row(s) have bridge-reported counts without ROS landed proof."),
    ).toBeVisible();
    await expect(
      panel.getByText("At least one bridge entity still shows an error in the latest visible run."),
    ).toBeVisible();
    await expect(panel.getByText("Limits and caveats")).toBeVisible();
    await expect(
      panel.getByText(
        "Imported Counterpoint ticket and open-doc rows preserve gross historical totals; imported line tax is non-authoritative and should not be treated as tax filing proof.",
      ),
    ).toBeVisible();

    await expect(panel.getByText("Bridge rows sent")).toBeVisible();
    await expect(panel.getByText("ROS rows landed")).toBeVisible();
    await expect(panel.getByText("Missing ROS landed proof")).toBeVisible();
    await expect(panel.getByText("Counts match")).toBeVisible();
    await expect(panel.getByText("ROS count lower")).toBeVisible();
    await expect(panel.getByText("Bridge only")).toBeVisible();

    const rosieInsight = panel.getByTestId("rosie-insight-summary-counterpoint_status");
    await expect(rosieInsight).toBeVisible();
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
      facts: expect.objectContaining({
        disclaimers: expect.arrayContaining([
          expect.stringContaining("Do not approve sign-off"),
        ]),
      }),
    });
  });
});
