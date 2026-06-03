# Audit Report: Counterpoint Import Bridge (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-25
**Version Audited:** v0.85.5 (commit `cac08918`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of Counterpoint → ROS data migration — one-way upserts for customers, catalog (products/variants), gift cards, ticket history (transactions/payments), open docs, vendor items, loyalty history; plus Inventory Migration Workbench (6-step gated workflow with SKU gap detection and AI cleanup).

---

## 1. Executive Summary

The Counterpoint Bridge is a **one-time migration system** for transitioning from NCR Counterpoint POS to Riverside OS. It implements one-way upserts from Counterpoint's data model (Windows bridge) into PostgreSQL. The largest module in the codebase at 15,117 lines (`counterpoint_sync.rs`), it handles 8 entity types with strict data integrity guarantees. The Inventory Migration Workbench adds a **6-step gated workflow** for catalog migration with SKU gap detection and verification.

**Overall Status:** Production Ready — 0 blockers, 0 regressions.

---

## 2. Architecture Trace

### 2.1 Sync Entities
| Entity | Source | Target | Key Features |
|:---|:---|:---|:---|
| Customers | `CUST_NO` | `customers.customer_code` | Name split, loyalty points, preferred salesperson |
| Catalog | Products + variants | `products`, `product_variants` | Category/vendor mapping, brand, UPC |
| Gift Cards | Counterpoint GC | `gift_card_accounts` | Balance migration, type mapping |
| Ticket History | `PS_TKT_HIST` | `transactions`, `transaction_line_items`, `payments` | Full line resolution required (no partial) |
| Open Documents | Open tickets | Same as ticket history | Pending/layaway orders |
| Vendor Items | `PO_VEND_ITEM` | Vendor catalog cross-reference | Wholesale pricing |
| Loyalty History | `PS_LOY_PTS_HIST` | `customer_loyalty_events` | Point accrual history |
| Heartbeat | Sync metadata | `counterpoint_sync_status` | Cursor tracking, error recording |

### 2.2 Data Integrity Guards
- **No partial transactions**: Ticket sync only inserts when **every** line resolves to a variant — prevents mismatched totals
- **Historical fallback SKU**: `HIST-CP-FALLBACK` used only when explicitly configured (not silent)
- **Decimal math**: All monetary values use `rust_decimal` with `RoundingStrategy`
- **Cursor-based sync**: `SyncCursorIn` tracks position per entity for resumable ingestion
- **Snapshot source metrics**: `CounterpointSnapshotSourceMetricsPayload` captures count, sum, and checksum for reconciliation

### 2.3 Customer Migration
```
CounterpointCustomerRow → customers table
  → cust_no → customer_code
  → Name: split first_name/last_name or full_name parse
  → loyalty_points → loyalty_points (direct map)
  → sls_rep → preferred_salesperson_id (resolved via staff name map)
  → customer_type → custom_field_1
  → ar_balance → custom_field_2 (string reference)
  → Batch summary: created/updated/skipped counts
```

### 2.4 Inventory Migration Workbench
6-step gated workflow (`counterpoint_workbench.rs`, 1,257 lines):

| Step | Gate | Purpose |
|:---|:---|:---|
| 1. `data_sources` | — | Configure import sources |
| 2. `categories` | Step 1 approved | Map Counterpoint categories to ROS |
| 3. `vendors` | Step 2 approved | Map vendor records |
| 4. `catalog` | Step 3 approved | Product + variant migration |
| 5. `sku_gaps` | Step 4 approved | Detect and resolve SKU mismatches |
| 6. `verification` | Step 5 approved | Final reconciliation |

Each step has: `status`, `approved_at`, `approved_by` tracking. Steps are strictly sequential — cannot advance without prior approval.

### 2.5 Workbench State
```rust
WorkbenchStateResponse {
    current_step: Option<String>,      // Next incomplete step
    steps: BTreeMap<String, StepDetail>,
    inventory_summary: Option<InventorySummary>,
    can_reset: bool,
}
```

---

## 3. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| Entity coverage | Documented (7) | Verified: 8 entities (added vendor items) | ✅ Enhanced |
| No-partial-transaction guard | Documented | Confirmed: all lines must resolve | ✅ No regression |
| Workbench workflow | Not documented | Verified: 6-step gated with approval tracking | ✅ New finding |
| Decimal math | Documented | Confirmed: rust_decimal throughout | ✅ No regression |
| Cursor-based sync | Not documented | Verified: per-entity resumable cursor | ✅ New finding |
| Snapshot reconciliation | Not documented | Verified: count + sum + checksum metrics | ✅ New finding |

---

## 4. Conclusion

**0 blockers, 0 regressions.** The Counterpoint Import Bridge is production-ready with comprehensive entity coverage, strict integrity guards, and a well-structured migration workbench.
