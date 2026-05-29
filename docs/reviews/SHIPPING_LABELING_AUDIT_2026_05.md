# Audit Report: Shipping & Labeling (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-08
**Version Audited:** v0.85.0 (commit `73cdd56`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of unified shipments hub — shipment creation (POS/manual), Shippo rate fetching, rate quote application, label purchase with commission recalculation, label refund, return shipment creation, manifest batch creation, pickup scheduling, event timeline, and health monitoring.

---

## 1. Executive Summary

The Shipping & Labeling subsystem is a **unified shipments hub** integrating POS order shipping with the Shippo carrier API. It manages the full lifecycle from rate shopping through label purchase, tracking, refunds, and batch operations (manifest/pickup). Commission recalculation is triggered after label purchase (since shipping fulfillment marks order recognition). The event timeline provides a complete audit trail.

**Overall Status:** Production Ready — 0 blockers, 0 regressions.

---

## 2. Architecture Trace

### 2.1 Shipment Lifecycle
```
Draft → Quoted → label_purchased → shipped → delivered
                                  → refunded (label refund)
         ← return_created (return shipments)
```

### 2.2 Shipment Sources
- **POS Order**: `insert_from_pos_order_tx()` — created within checkout transaction, linked to `transaction_id`
- **Manual**: `create_manual_shipment()` — staff-created for ad-hoc shipments
- **Return**: `create_return_shipment()` — reverse logistics from existing shipment

### 2.3 Rate Fetching & Quote Application
```
POST /{id}/rates
  → fetch_rates_for_shipment(pool, http, id, parcel, parcels, customs, force_stub, staff_id)
  → Calls Shippo API with from/to addresses + parcel dimensions
  → Returns array of carrier rate quotes

POST /{id}/apply-quote
  → apply_rate_quote(pool, id, rate_quote_id, staff_id)
  → Stores selected rate on shipment
  → Transitions status to 'quoted'
```

### 2.4 Label Purchase (Critical Financial Flow)
```
POST /{id}/purchase-label
  → Guard: label not already purchased (shippo_transaction_object_id empty)
  → Guard: rate quote must exist (stub rates cannot purchase)
  → purchase_transaction_for_rate(http, rate_oid, label_file_type) via Shippo
  → Transaction:
      1. Update shipment: tracking_number, label URL, cost, status='label_purchased'
      2. Update linked transaction: sync tracking/label data
      3. Trigger commission recalculation (fulfillment-based recognition)
      4. Upsert commission events for fulfilled transaction
  → Append 'label_purchased' event with tracking metadata
  → Commit
```

### 2.5 Label Refund
```
POST /{id}/refund-label
  → refund_shipment_label(pool, http, id, staff_id)
  → Calls Shippo refund API
  → Updates shipment status to 'refunded'
  → Appends 'label_refunded' event
```

### 2.6 Batch Operations
| Operation | Purpose |
|:---|:---|
| `create_manifest_batch` | Batch close-out: notifies carrier of day's shipments |
| `create_pickup_batch` | Schedule carrier pickup for multiple shipments |
| `list_batch_candidates` | Shipments eligible for batching (label purchased, not yet manifested) |

### 2.7 Event Timeline
Every shipment mutation appends to `shipment_event`:
- `checkout`, `label_purchased`, `label_refunded`, `rate_quoted`, `note`, `status_changed`
- Staff attribution on all events
- JSONB metadata payload for each event type

---

## 3. API Routes
| Route | Method | Permission | Purpose |
|:---|:---|:---|:---|
| `/` | GET | `shipments.view` | List shipments (filterable) |
| `/{id}` | GET/PATCH | `shipments.view`/`manage` | Detail with events / update |
| `/manual` | POST | `shipments.manage` | Create manual shipment |
| `/{id}/rates` | POST | `shipments.manage` | Fetch live carrier rates |
| `/{id}/apply-quote` | POST | `shipments.manage` | Apply selected rate |
| `/{id}/purchase-label` | POST | `shipments.manage` | Buy shipping label |
| `/{id}/refund-label` | POST | `shipments.manage` | Refund label |
| `/{id}/return` | POST | `shipments.manage` | Create return shipment |
| `/{id}/note` | POST | `shipments.manage` | Add staff note |
| `/batch-candidates` | GET | `shipments.manage` | Eligible for batching |
| `/batches` | GET | `shipments.view` | List batches |
| `/manifest` | POST | `shipments.manage` | Create manifest batch |
| `/pickup` | POST | `shipments.manage` | Schedule pickup |
| `/shippo-health` | GET | `shipments.view` | Shippo API health |

---

## 4. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| Shippo integration | Documented | Verified: rate/label/refund/batch | ✅ No regression |
| Commission on label purchase | Not documented | Verified: recalc triggered after label buy | ✅ New finding |
| Return shipments | Not documented | Verified: reverse logistics from existing shipment | ✅ New finding |
| Batch operations | Not documented | Verified: manifest + pickup batching | ✅ New finding |
| Event timeline | Documented | Confirmed: full audit trail | ✅ No regression |
| Label purchase guard | Not documented | Verified: prevents duplicate label purchase | ✅ New finding |

---

## 5. Conclusion

**0 blockers, 0 regressions.** The Shipping & Labeling subsystem is production-ready with comprehensive Shippo integration, proper commission recalculation on fulfillment, and batch operations for daily carrier workflows.
