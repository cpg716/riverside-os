import { readFile } from "node:fs/promises";

const migrationFileName = "140_search_trigram_read_path_indexes.sql";
const migrationSource = await readFile(
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
  if (!migrationSource.includes(indexName)) {
    throw new Error(`Search index migration source is missing ${indexName}`);
  }
}

const [
  embeddedMigrations,
  universalHandler,
  transactionList,
  weddingQueries,
  meilisearchSearch,
  meilisearchSync,
  customerHandler,
  alterationHandler,
] = await Promise.all([
  readFile(new URL("../server/src/embedded_migrations.rs", import.meta.url), "utf8"),
  readFile(new URL("../server/src/api/search.rs", import.meta.url), "utf8"),
  readFile(new URL("../server/src/logic/transaction_list.rs", import.meta.url), "utf8"),
  readFile(new URL("../server/src/logic/wedding_queries.rs", import.meta.url), "utf8"),
  readFile(new URL("../server/src/logic/meilisearch_search.rs", import.meta.url), "utf8"),
  readFile(new URL("../server/src/logic/meilisearch_sync.rs", import.meta.url), "utf8"),
  readFile(new URL("../server/src/api/customers.rs", import.meta.url), "utf8"),
  readFile(new URL("../server/src/api/alterations.rs", import.meta.url), "utf8"),
]);

const structuralContracts = [
  [embeddedMigrations.includes(migrationFileName), "migration registration in the server binary"],
  [universalHandler.includes('route("/universal", get(universal_search))'), "current universal endpoint route"],
  [universalHandler.includes("within_source_deadline(search_appointments"), "operational-source deadline isolation"],
  [universalHandler.includes("validated_meili_candidate_ids"), "universal Meilisearch authority gate"],
  [universalHandler.includes("ids_hydrate_completely"), "complete Meilisearch hydration validation"],
  [universalHandler.includes("hydrated_candidate_page_is_complete"), "post-predicate candidate page parity"],
  [!universalHandler.includes("take(32)"), "full candidate-array hydration validation"],
  [universalHandler.includes("replace('%', \"\\\\%\")"), "literal SQL wildcard escaping"],
  [transactionList.includes("transaction_search_ids(c, st, open_only)"), "all-Transaction Record Meilisearch index"],
  [transactionList.includes("CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, '')) ILIKE"), "transaction full-name SQL fallback"],
  [transactionList.includes("ORDER BY o.booked_at DESC, o.id DESC"), "stable Transaction Record pagination"],
  [transactionList.includes("index_results_are_authoritative"), "Transaction Record Meilisearch authority gate"],
  [weddingQueries.includes("phone_query_digits"), "strict wedding phone-intent gate"],
  [weddingQueries.includes("index_results_are_authoritative"), "wedding Meilisearch authority gate"],
  [meilisearchSearch.includes("candidate_ids_may_be_truncated"), "candidate-cap fallback signal"],
  [meilisearchSync.includes("finish_incremental_task"), "incremental task completion tracking"],
  [meilisearchSync.match(/delete_document\(/g)?.length === 1, "centralized incremental delete task tracking"],
  [
    meilisearchSync.includes(
      "is_success = meilisearch_sync_status.is_success AND EXCLUDED.is_success",
    ),
    "sticky incremental failure until a full rebuild",
  ],
  [
    meilisearchSync.includes("record_incremental_read_failure") &&
      !meilisearchSync.includes("let Ok(Some(row))"),
    "incremental database read failures preserve existing documents",
  ],
  [!meilisearchSync.includes("if let Ok(row) = res"), "full-rebuild stream error propagation"],
  [customerHandler.includes("fn literal_ilike_pattern"), "literal customer SQL fallback"],
  [alterationHandler.includes("fn literal_ilike_pattern"), "literal alteration SQL fallback"],
];

for (const [present, label] of structuralContracts) {
  if (!present) throw new Error(`Search structural contract is missing ${label}`);
}

if (!migrationSource.includes("CREATE EXTENSION IF NOT EXISTS pg_trgm")) {
  throw new Error("Search index migration must enable pg_trgm");
}

console.log(
  `Structural search contract passed (${requiredIndexes.length} index definitions, ${structuralContracts.length} source checks). This does not prove the migration is applied or that PostgreSQL uses these indexes; verify pg_indexes and EXPLAIN against the live Main Hub database.`,
);
