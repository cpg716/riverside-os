import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

function repoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

const productsApi = repoFile("server/src/api/products.rs");
const reportsPanel = repoFile(
  "client/src/components/inventory/InventoryReportsPanel.tsx",
);
const inventoryManual = repoFile(
  "client/src/assets/docs/inventory-workspace-manual.md",
);
const staffInventoryGuide = repoFile("docs/staff/inventory-back-office.md");

test("inventory reconciliation reports complete counts without a hidden SQL cap", () => {
  const reconciliationQuery = productsApi
    .split('const INVENTORY_RECONCILIATION_CTE: &str = r#"')[1]
    ?.split("async fn get_inventory_reconciliation")[0];

  expect(reconciliationQuery).toBeTruthy();
  expect(reconciliationQuery).not.toContain("LIMIT 100");
  expect(productsApi).toContain("COUNT(*)::bigint FROM all_findings GROUP BY issue_kind");
  expect(productsApi).toContain("filtered_findings");
  expect(productsApi).toContain("issue_counts");
  expect(productsApi).toContain("LIMIT $2 OFFSET $3");
});

test("inventory reconciliation offers filtered paging and a verified complete export", () => {
  expect(reportsPanel).toContain("RECONCILIATION_EXPORT_PAGE_SIZE = 250");
  expect(reportsPanel).toContain("Export Complete Queue");
  expect(reportsPanel).toContain("offset < expected");
  expect(reportsPanel).toContain("Complete export stopped before every finding was received");
  expect(reportsPanel).toContain("Previous");
  expect(reportsPanel).toContain("Next");
  expect(inventoryManual).toContain("complete store-wide counts");
  expect(inventoryManual).toContain("Export Complete Queue");
  expect(staffInventoryGuide).toContain("full store-wide totals");
  expect(staffInventoryGuide).toContain("Export Complete Queue");
});
