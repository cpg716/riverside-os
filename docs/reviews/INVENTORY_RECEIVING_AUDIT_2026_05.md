# Audit Report: Inventory & Receiving Subsystem (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-08
**Version Audited:** v0.85.0 (commit `73cdd56`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of SKU resolution, receiving scan, physical inventory lifecycle (create → count → review → publish), stock reconciliation, and inventory transaction ledger.

---

## 1. Executive Summary

The Inventory & Receiving subsystem remains **robust and production-hardened** since the April audit. The physical inventory module has a well-architected session lifecycle (open → reviewing → published/cancelled) with atomic stock reconciliation using `FOR UPDATE` locks. The SKU resolution engine supports a 4-pass lookup strategy with vendor UPC priority, and the receiving bay correctly handles scan-code resolution across vendor_upc, barcode, and SKU namespaces.

**Overall Status:** Production Ready — 0 blockers, 1 informational observation.

---

## 2. Changes Since Last Audit (April 2026)

### 2.1 Physical Inventory — Full Lifecycle
The physical inventory module (`physical_inventory.rs`) implements a complete session-based stock count workflow:
- **Session creation** enforces single active session (`status IN ('open', 'reviewing')`) — prevents concurrent counts.
- **Snapshot mechanism** captures `stock_on_hand` for all in-scope variants at session start, with `exclude_reserved` and `exclude_layaway` flags to subtract committed stock.
- **Scope filtering** supports `full` (all active variants) and `category` (filtered by `category_ids`) scope types.

### 2.2 SKU Resolution — 4-Pass Strategy
`resolve_sku()` in `inventory.rs` implements a cascading lookup:
1. SKU exact match
2. Barcode exact match
3. `catalog_handle` match (NuORDER/Lightspeed canonical ID)
4. Product name fuzzy match

Each pass returns a `ResolvedSkuItem` with full pricing, tax category, stock, and cost data via the `SKU_JOIN_FROM` lateral join pattern.

### 2.3 Receiving Scan Resolution
`resolve_scan_code()` adds vendor-aware resolution:
1. If vendor has `use_vendor_upc = true`, checks `vendor_upc` first
2. Falls back to barcode, then SKU
3. Returns `ScanResolveResult` with product/variant metadata for the receiving UI

### 2.4 Batch Scan API
`batch_scan()` provides high-performance batch validation for physical inventory — resolves multiple codes in a single request without mutating live stock. Uses the same resolution pipeline as `scan_resolve()`.

---

## 3. Architecture Trace

### 3.1 Physical Inventory Lifecycle
```
create_session(pool, scope, category_ids, exclude_reserved, exclude_layaway)
  → Enforce single active session
  → Snapshot in-scope variants' stock_on_hand into physical_inventory_snapshots
  → Return PhysicalInventorySession { status: 'open' }

upsert_count(pool, session_id, variant_id, counted_qty, staff_id)
  → ON CONFLICT upsert: increments counted_qty if row exists
  → Records audit trail in physical_inventory_audit

transition_to_review(pool, session_id)
  → Updates status to 'reviewing'
  → Prevents further count modifications

publish_session(pool, session_id, approved_by_staff_id)
  → BEGIN transaction
  → FOR UPDATE lock on all variant rows in scope
  → Build review rows: snapshot_qty, counted_qty, sales_since_snapshot
  → Compute reconciled = counted_qty + sales_since_snapshot
  → Atomically UPDATE product_variants SET stock_on_hand = reconciled
  → INSERT inventory_transactions (tx_type='physical_inventory')
  → INSERT per-variant audit entries
  → Update session status to 'published'
  → COMMIT
  → Return PublishResult { variants_reconciled, total_shrinkage, total_surplus }
```

### 3.2 Stock Reconciliation — Sales Deduction
The publish step correctly accounts for sales that occurred between snapshot and publish:
- Queries `inventory_transactions WHERE tx_type = 'sale'` created after the snapshot timestamp
- Deducts these from the variance calculation so legitimate sales aren't counted as shrinkage
- Formula: `reconciled_stock = counted_qty + sales_since_snapshot`

### 3.3 Concurrency Safety
- `FOR UPDATE` locks on variant rows during publish prevent concurrent stock modifications
- Single active session enforcement prevents overlapping physical counts
- Upsert pattern on count rows prevents duplicate count entries

---

## 4. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| SKU resolution | 4-pass lookup documented | Confirmed in source — cascade works as designed | ✅ No regression |
| Physical inventory | "Blind counting" noted | Full lifecycle verified: snapshot → count → review → publish with FOR UPDATE locks | ✅ Enhanced |
| Receiving bay | Scanner/HID integration noted | `resolve_scan_code` verified with vendor UPC priority | ✅ No regression |
| RBAC | `PHYSICAL_INVENTORY_MUTATE/VIEW` gates noted | Confirmed: API routes check permissions via middleware | ✅ No regression |
| Batch operations | Not mentioned | `batch_scan()` API confirmed for non-mutating bulk validation | ✅ New capability |

---

## 5. Findings

### 5.1 Informational: Sales Deduction Window
The sales deduction during publish relies on `inventory_transactions` created after the snapshot timestamp. If a sale's inventory transaction is recorded with a timestamp slightly before the snapshot (clock skew in a distributed scenario), it could be missed. In practice this is a non-issue for a single-server Tauri deployment, but worth noting for future multi-instance deployments.

**Severity:** Informational — no action required for current architecture.

### 5.2 Positive: Atomic Publish
The publish operation is exemplary — acquires row-level locks, computes reconciled values, updates stock, records inventory transactions, and writes audit entries all within a single database transaction. Rollback on any failure is guaranteed.

---

## 6. Conclusion

**0 blockers, 0 regressions, 1 informational observation.** The Inventory & Receiving subsystem is production-ready with strong concurrency controls, comprehensive audit trails, and a well-designed physical inventory lifecycle.
