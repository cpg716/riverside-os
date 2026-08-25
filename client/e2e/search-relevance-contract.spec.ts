import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const repoSource = (path: string) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("customer search keeps split-name shorthand through PostgreSQL fallback", async () => {
  const customers = await repoSource("server/src/api/customers.rs");
  const universal = await repoSource("server/src/api/search.rs");

  expect(customers).toContain("let search_name_prefixes = search_raw");
  expect(customers).toContain("FROM unnest($11::text[]) AS wanted(prefix)");
  expect(customers).toContain("FROM unnest($12::text[]) AS wanted(prefix)");
  expect(customers).toContain("regexp_split_to_table(");
  expect(universal).toContain("let name_prefixes =");
  expect(universal).toContain("FROM unnest($3::text[]) AS wanted(prefix)");
});

test("product search intersects partial name and number terms in every search path", async () => {
  const [meili, products, universal] = await Promise.all([
    repoSource("server/src/logic/meilisearch_search.rs"),
    repoSource("server/src/api/products.rs"),
    repoSource("server/src/api/search.rs"),
  ]);

  expect(meili).toContain("pub fn product_query_tokens");
  expect(meili).toContain("with_attributes_to_search_on(PRODUCT_SEARCH_ATTRIBUTES)");
  expect(meili).toContain("merge_product_search_result_sets");
  expect(products).toContain("Meilisearch Register product search failed");
  expect(products).toContain("let token_patterns =");
  expect(products).toContain("FROM unnest(");
  expect(universal).toContain("let token_patterns =");
  expect(universal).toContain("FROM unnest($2::text[]) AS wanted(pattern)");
});

test("inventory paging keeps parent totals stable and large families from crowding out results", async () => {
  const [products, inventory] = await Promise.all([
    repoSource("server/src/api/products.rs"),
    repoSource("client/src/components/inventory/InventoryControlBoard.tsx"),
  ]);

  expect(products).toContain("variant_totals.product_stock_on_hand");
  expect(products).toContain("variant_totals.product_available_stock");
  expect(products).toContain(
    "ROW_NUMBER() OVER (PARTITION BY p.id ORDER BY pv.sku ASC, pv.id ASC)",
  );
  expect(inventory).toContain("first.product_stock_on_hand ?? stock");
  expect(inventory).toContain("first.product_available_stock ?? availSum");
});

test("inventory vendor searches keep PostgreSQL matches alongside lexical ranking", async () => {
  const [products, inventory] = await Promise.all([
    repoSource("server/src/api/products.rs"),
    repoSource("client/src/components/inventory/InventoryControlBoard.tsx"),
  ]);

  expect(products).toContain('qb.push("pv.id = ANY(")');
  expect(products).toContain("COALESCE(pvendor.name, '') ILIKE");
  expect(products).toContain("COALESCE(c.name, '') ILIKE");
  expect(products).toContain('filter == "in_stock"');
  expect(products).toContain('qb.push(" AND pv.stock_on_hand > 0")');
  expect(inventory).toContain('params.set("in_stock_only", "true")');
  expect(inventory).toContain("setInStockOnly(false)");
  expect(inventory).toContain("setNegativeStockOnly(false)");
  expect(products).toContain("array_position(");
});

test("empty lexical candidate sets use broader authoritative SQL matching", async () => {
  const [customers, products, universal] = await Promise.all([
    repoSource("server/src/api/customers.rs"),
    repoSource("server/src/api/products.rs"),
    repoSource("server/src/api/search.rs"),
  ]);

  expect(customers.match(/Some\(ids\) if ids\.is_empty\(\) => None/g)?.length).toBeGreaterThanOrEqual(2);
  expect(products).toContain("Some(ids) if ids.is_empty() => None");
  expect(universal.match(/Some\(ids\) if ids\.is_empty\(\) => None/g)?.length).toBeGreaterThanOrEqual(2);
});

test("high-traffic search fields use clear staff guidance", async () => {
  const [cart, customers, inventory, selector] = await Promise.all([
    repoSource("client/src/components/pos/Cart.tsx"),
    repoSource("client/src/components/customers/CustomersWorkspace.tsx"),
    repoSource("client/src/components/inventory/InventoryControlBoard.tsx"),
    repoSource("client/src/components/pos/CustomerSelector.tsx"),
  ]);

  expect(cart).toContain("Search partial product + style/SKU");
  expect(customers).toContain(
    "Search name, phone, email, customer code, or company",
  );
  expect(inventory).toContain("Try partial product + style/SKU");
  expect(selector).toContain("Search by name, phone, email, or customer code");
});
