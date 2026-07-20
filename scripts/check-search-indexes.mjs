import { readFile } from "node:fs/promises";

const migration = await readFile(
  new URL("../migrations/140_search_trigram_read_path_indexes.sql", import.meta.url),
  "utf8",
);

const requiredIndexes = [
  "idx_customers_search_trgm",
  "idx_products_search_trgm",
  "idx_product_variants_search_trgm",
  "idx_transactions_search_trgm",
  "idx_gift_cards_search_trgm",
  "idx_payment_transactions_search_trgm",
  "idx_customers_first_name_trgm",
  "idx_customers_last_name_trgm",
  "idx_customers_code_trgm",
  "idx_customers_email_trgm",
  "idx_customers_phone_trgm",
  "idx_products_name_trgm",
  "idx_product_variants_sku_trgm",
  "idx_product_variants_barcode_trgm",
  "idx_transactions_display_id_trgm",
];

for (const indexName of requiredIndexes) {
  if (!migration.includes(indexName)) {
    throw new Error(`Search index migration is missing ${indexName}`);
  }
}

if (!migration.includes("CREATE EXTENSION IF NOT EXISTS pg_trgm")) {
  throw new Error("Search index migration must enable pg_trgm");
}

console.log(`Search index contract passed (${requiredIndexes.length} trigram indexes).`);
