# Audit Report: Alterations System (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-08
**Version Audited:** v0.85.5 (commit `e8edc0f4`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of alteration work order lifecycle (create → items → fitting → complete → pickup), capacity-aware scheduling (jacket/pant units per day), suggested slot finding, alteration order items with capacity buckets, pickup receipt generation, alteration card, and Meilisearch integration.

---

## 1. Executive Summary

The Alterations system is a **capacity-aware tailoring workflow** purpose-built for formalwear retail. It manages garment alteration work orders with per-item tracking (jacket vs. pant capacity buckets), intelligent slot suggestion based on staff availability and existing workload, and automated capacity updates when items are added or removed. The system integrates with the wedding member model, staff schedule, and Meilisearch for search indexing.

**Overall Status:** Production Ready — 0 blockers, 0 regressions.

---

## 2. Architecture Trace

### 2.1 Work Order Model
```
alteration_orders
  ├── customer_id (required)
  ├── wedding_member_id (optional — links to wedding party)
  ├── status: intake → in_progress → ready → picked_up
  ├── due_at, fitting_at (scheduling)
  ├── appointment_id (linked appointment)
  ├── total_units_jacket, total_units_pant (aggregate from items)
  ├── source_type, source_snapshot (originating product/transaction context)
  ├── charge_amount, charge_transaction_line_id (billing link)
  ├── ticket_number (physical ticket reference)
  ├── intake_channel (walk-in, wedding, etc.)
  └── picked_up_at, picked_up_by_staff_id (completion)

alteration_order_items
  ├── label (description: "Hem pants", "Take in jacket", etc.)
  ├── capacity_bucket (enum: jacket | pant)
  ├── units (30-minute blocks consumed)
  └── completed_at (per-item completion tracking)
```

### 2.2 Capacity System
Constants:
- `MAX_JACKET_UNITS_PER_DAY = 28` (14 hours of 30-min blocks)
- `MAX_PANT_UNITS_PER_DAY = 24` (12 hours of 30-min blocks)

`get_capacity_for_range(pool, start, end)`:
1. Query `alteration_orders` for total units used per day (by `fitting_at`)
2. Query `staff_schedule_events` for holidays (closed days)
3. Check `list_working_floor_staff_for_date` for Alterations-role staff
4. For each day: `available = max - used` (0 if no staff or holiday)
5. Thursday flagged as `is_manual_only` (internal scheduling convention)

### 2.3 Suggested Slot Finding
`find_suggested_slots(pool, jacket_units, pant_units, due_date, limit)`:
- Scans from today through `due_date - 1 day`
- Skips: Thursdays (manual-only), holidays, days without alterations staff
- Scores by proximity: earlier dates score higher (`100 - days_from_now`)
- Returns top N suggestions sorted by score descending

### 2.4 Item Management
- Items use `capacity_bucket::alteration_bucket` enum (jacket/pant)
- Adding/removing items triggers `update_order_unit_totals` to recalculate aggregates
- Both add and delete run in transactions to ensure aggregate consistency

### 2.5 Pickup Flow
```
POST /{id}/pickup
  → Validate staff (ALTERATIONS_MANAGE)
  → Set picked_up_at, picked_up_by_staff_id
  → Update status to 'picked_up'
  → Optionally trigger SMS notification via Podium
  → Return updated order
```

### 2.6 Output Generation
- `GET /{id}/pickup-receipt` — Generates ESC/POS pickup receipt
- `GET /{id}/card` — Generates alteration card (work order summary)

---

## 3. API Routes
| Route | Method | Permission | Purpose |
|:---|:---|:---|:---|
| `/` | GET | `alterations.manage` | List orders (filterable by status, customer, search) |
| `/` | POST | `alterations.manage` | Create new work order |
| `/capacity` | GET | `alterations.manage` | Daily capacity for date range |
| `/suggest-slots` | GET | `alterations.manage` | Smart slot suggestions |
| `/{id}` | GET/PATCH | `alterations.manage` | Get/update order |
| `/{id}/pickup` | POST | `alterations.manage` | Record pickup |
| `/{id}/pickup-receipt` | GET | `alterations.manage` | ESC/POS receipt |
| `/{id}/card` | GET | `alterations.manage` | Alteration card |
| `/{id}/items` | GET/POST | `alterations.manage` | List/add items |
| `/{id}/items/{item_id}` | PATCH/DELETE | `alterations.manage` | Update/remove items |

---

## 4. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| Work order lifecycle | Documented | Verified: full CRUD with status transitions | ✅ No regression |
| Capacity system | "per-day unit caps" noted | Verified: 28J/24P with staff/holiday awareness | ✅ No regression |
| Slot suggestions | Not documented | Verified: proximity-scored with exclusion rules | ✅ New finding |
| Item capacity buckets | Not documented | Verified: jacket/pant enum with aggregate sync | ✅ New finding |
| Wedding integration | Noted | Confirmed: `wedding_member_id` links to party | ✅ No regression |
| Meilisearch indexing | Not documented | Confirmed: `upsert_alteration_document` on mutations | ✅ New finding |

---

## 5. Conclusion

**0 blockers, 0 regressions.** The Alterations system is production-ready with capacity-aware scheduling, smart slot suggestions, and proper integration with the wedding and staff schedule subsystems.
