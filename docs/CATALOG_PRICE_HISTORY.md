# Catalog Price History

Riverside records every change to a parent or SKU **Retail** or **Sale** price in an append-only audit ledger. This history supports staff review in Product Hub and store-wide reporting without treating the current catalog row as historical evidence.

## Audit contract

- PostgreSQL triggers on `products.base_retail_price`, `products.base_sale_price`, `product_variants.retail_price_override`, and `product_variants.sale_price_override` are the enforcement point. Product Hub, bulk edits, imports, Counterpoint/NuORDER syncs, and future write paths cannot change those columns without creating history.
- Staff actions attach the authenticated staff ID and name, a change source, an optional note, exact old/new configured values, and exact old/new effective values in the same database transaction as the price mutation.
- Automated paths that do not supply staff context are retained with `change_source = database`; they are not mislabeled as staff activity.
- Parent records include the number of SKUs inheriting that parent value at change time. SKU records retain the SKU and both the override and effective price values.
- `catalog_price_change_history` rejects updates and deletes. Corrections must be new price changes; history is never rewritten.
- Known parent price entries in `product_catalog_audit_log` are backfilled when the dedicated ledger is installed.

## Staff review

Open the product in **Product Hub → Timeline**. Retail and sale events identify the parent or SKU, staff member or automated source, and exact before/after effective price. An override that changes inheritance without changing the effective dollar amount is labeled as an override-configuration change.

## Reporting

Use `reporting.catalog_price_change_history` for Metabase or governed reporting. It provides one row per parent/SKU retail or sale change with:

- business date and exact timestamp;
- product, SKU, scope, and price kind;
- old/new override and effective prices;
- signed effective price change;
- staff identity, source, note, and metadata.

The `metabase_ro` role receives read-only access when that role exists. Report from the reporting view; do not query or mutate the operational ledger directly.
