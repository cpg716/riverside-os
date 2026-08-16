import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const source = (path: string) =>
  readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

test("Wedding Party Hub isolates typing and retains the loaded party grid", async () => {
  const dashboard = await source(
    "components/wedding-manager/pages/Dashboard.jsx",
  );
  const api = await source("components/wedding-manager/lib/api.js");

  expect(dashboard).toContain("const PartySearchField");
  expect(dashboard).toContain("loading={loading && parties.length === 0}");
  expect(dashboard).toContain("partiesAbortRef.current?.abort()");
  expect(dashboard).toContain("signal: controller.signal");
  expect(api).toContain("signal: params.signal");
});

test("remote workspace searches debounce and cancel superseded requests", async () => {
  const debouncedSurfaces = [
    "components/staff/ComboEditorModal.tsx",
    "components/inventory/InventoryReportsPanel.tsx",
    "components/inventory/MaintenanceLedgerPanel.tsx",
    "components/orders/AttachOrderToWeddingModal.tsx",
    "components/customers/RmsChargeAdminSection.tsx",
    "components/customers/CustomerRelationshipHubDrawer.tsx",
  ];

  for (const path of debouncedSurfaces) {
    const text = await source(path);
    expect(text, path).toContain("useDebouncedValue");
    expect(text, path).toContain("AbortController");
  }

  for (const path of [
    "components/online-store/OnlineStoreProductsPanel.tsx",
    "components/pos/WeddingDepositWorkspace.tsx",
    "components/ui/CustomerSearchInput.tsx",
    "components/inventory/PhysicalInventoryWorkspace.tsx",
  ]) {
    const text = await source(path);
    expect(text, path).toContain("AbortController");
    expect(text, path).toContain("controller.signal");
  }
});

test("Register product search responds quickly and cancels superseded requests", async () => {
  const registerSearch = await source("hooks/usePosSearch.ts");

  expect(registerSearch).toContain("const POS_SEARCH_DEBOUNCE_MS = 250");
  expect(registerSearch).toContain("searchAbortRef.current?.abort()");
  expect(registerSearch).toContain("signal: abortController.signal");
  expect(registerSearch).toContain("requestId === searchRequestRef.current");
});

test("high-traffic hubs keep first paint bounded and do not reload on every key", async () => {
  const [customers, inventory, posInventory, variantSearch, transactionSearch, weddingSearch, productHub, variations, posShell, rosie] =
    await Promise.all([
      source("components/customers/CustomersWorkspace.tsx"),
      source("components/inventory/InventoryControlBoard.tsx"),
      source("components/pos/ProcurementHub.tsx"),
      source("components/ui/VariantSearchInput.tsx"),
      source("components/ui/TransactionSearchInput.tsx"),
      source("components/ui/WeddingPartySearchInput.tsx"),
      source("components/inventory/ProductHubDrawer.tsx"),
      source("components/inventory/VariationsWorkspace.tsx"),
      source("components/layout/PosShell.tsx"),
      source("lib/rosie.ts"),
    ]);

  expect(customers).toContain("const BROWSE_PAGE_SIZE = 100");
  expect(customers).toContain("void loadFirstPage(false)");
  expect(customers).toContain("Updating customer results");

  expect(inventory).toContain("const BOARD_PAGE_LIMIT = 200");
  expect(inventory).toContain('params.set("include_stats", "false")');
  expect(inventory).toContain("current rows remain visible");

  expect(posInventory).toContain("useDebouncedValue(search.trim(), 300)");
  expect(posInventory).not.toContain("setBoardRows([])");
  expect(posInventory).toContain("Waiting for typing");

  expect(variantSearch).toContain('limit: "80"');
  expect(variantSearch).toContain('include_stats: "false"');
  expect(transactionSearch).toContain("q.trim().length < 2");
  expect(weddingSearch).toContain("q.trim().length < 2");

  expect(productHub).toContain("hubAbortRef.current?.abort()");
  expect(productHub).toContain("cleanupSuggestionAbortRef.current?.abort()");
  expect(productHub).toContain("Analysis runs only when requested");
  expect(rosie).toContain("signal: options?.signal");
  expect(variations).toContain("{ refreshParent: false }");

  expect(posShell.match(/<AlterationsWorkspace\s*\/>/g)).toHaveLength(1);
});

test("row-only inventory searches skip catalog-wide summary work", async () => {
  const serverProducts = await readFile(
    new URL("../../server/src/api/products.rs", import.meta.url),
    "utf8",
  );

  expect(serverProducts).toContain("pub include_stats: Option<bool>");
  expect(serverProducts).toContain("if query.include_stats.unwrap_or(true)");
  expect(serverProducts).toContain('skip_serializing_if = "Option::is_none"');
});

test("universal search keeps concurrent server sources and client cancellation", async () => {
  const globalSearch = await source(
    "components/layout/GlobalCommandSearch.tsx",
  );
  const serverSearch = await readFile(
    new URL("../../server/src/api/search.rs", import.meta.url),
    "utf8",
  );

  expect(globalSearch).toContain("searchAbortRef.current?.abort()");
  expect(globalSearch).toContain("GLOBAL_SEARCH_TIMEOUT_MS");
  expect(serverSearch).toContain("tokio::join!(");
  expect(serverSearch).toContain("UNIVERSAL_SOURCE_TIMEOUT");
});

test("Meilisearch self-repairs and exposes current authority state", async () => {
  const [panel, sync, launcher, health] = await Promise.all([
    source("components/settings/MeilisearchSettingsPanel.tsx"),
    readFile(
      new URL("../../server/src/logic/meilisearch_sync.rs", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../server/src/launcher.rs", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../server/src/api/health.rs", import.meta.url),
      "utf8",
    ),
  ]);

  expect(panel).toContain("Automatic search repair queued");
  expect(panel).toContain("isIndexing ? 3000 : 30000");
  expect(sync).toContain("automatic_reindex_need");
  expect(sync).toContain("FULL_REINDEX_MUTEX");
  expect(sync).toContain("last_verified_at ASC NULLS FIRST");
  expect(sync).toContain("load_help_chunk_docs_with_policies");
  expect(launcher).toContain("Meilisearch automatic repair");
  expect(launcher).toContain(
    "Strict production requires a configured Meilisearch URL and API key",
  );
  expect(health).toContain("automatic_repair_needed");
  expect(health).toContain('failures.push("meilisearch".to_string())');
});
