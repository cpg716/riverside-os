import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

function repoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

const productHub = repoFile(
  "client/src/components/inventory/ProductHubDrawer.tsx",
);
const variationsWorkspace = repoFile(
  "client/src/components/inventory/VariationsWorkspace.tsx",
);
const variationGridCell = repoFile(
  "client/src/components/inventory/VariationGridCell.tsx",
);
const variationsList = repoFile(
  "client/src/components/inventory/VariationsList.tsx",
);
const productsApi = repoFile("server/src/api/products.rs");

test("parent retail edits require an explicit apply-all scope", () => {
  expect(productHub).toContain("Apply to all variations");
  expect(productHub).toContain(
    "apply_base_retail_to_all_variants: applyToAllVariations",
  );
  expect(productHub).toContain("Apply Parent Price to All Variations?");
  expect(productHub).toContain("retail_overrides_cleared");
});

test("every variation editor exposes parent-price inheritance", () => {
  expect(variationsWorkspace).toContain("Use parent retail price");
  expect(variationGridCell).toContain("Use parent price");
  expect(variationsList).toContain("Parent price");

  expect(variationsWorkspace).toContain("clear_retail_override");
  expect(variationGridCell).toContain("onUpdatePrice(null)");
  expect(variationsList).toContain("clear_retail_override");
});

test("parent and variation names use audited catalog mutation paths", () => {
  expect(productHub).toContain("Save name");
  expect(productHub).toContain("audit_note");
  expect(variationsWorkspace).toContain("variation_values");
  expect(variationsWorkspace).toContain("Save name");
  expect(productsApi).toContain("product_catalog_audit_log");
  expect(productsApi).toContain("Updated variation {}: {} -> {}");
});
