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
