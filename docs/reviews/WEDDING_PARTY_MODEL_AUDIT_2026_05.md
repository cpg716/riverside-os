# Audit Report: Wedding Party Model (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-25
**Version Audited:** v0.85.5 (commit `cac08918`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of the Wedding Party data model — party lifecycle, member management, action dashboard with multi-day window, financial context (ledger + disbursements), party display labels, SSE real-time event broadcasting, activity feed, and Meilisearch integration.

---

## 1. Executive Summary

The Wedding Party Model is the **core data structure** of the Wedding Manager shell. It manages the full lifecycle of wedding parties — from creation through member enrollment, measurements, orders, fittings, and final pickup. The system provides a **real-time action dashboard** (SSE-based) that aggregates pending actions across parties, a **financial ledger** for party-level billing, and a **canonical display label** format (`Newell-052226`) used throughout the system.

**Overall Status:** Production Ready — 0 blockers, 0 regressions.

---

## 2. Architecture Trace

### 2.1 Party Model
```
wedding_parties
  → party_name, groom_name, event_date
  → wedding_members (1:many)
    → customer_id (linked to CRM customer)
    → measurements, order_items, fitting status
  → wedding_appointments (1:many)
    → appointment_type, starts_at, salesperson
  → wedding_ledger (financial tracking)
```

### 2.2 Display Label
Canonical format: `{PartyName}-{MMDDYY}` (e.g., `Newell-052226`)
```rust
fn wedding_party_tracking_label(party_name, groom_name, event_date) -> String {
    // Use party_name, fallback to groom_name
    // Strip whitespace, format date as MMDDYY
    // "Party" if both names empty
}
```
SQL equivalent: `SQL_PARTY_TRACKING_LABEL_WP` — used in queries that need the label in SQL context.

### 2.3 API Endpoints (Wedding Manager)
| Route | Method | Purpose |
|:---|:---|:---|
| `/weddings/parties` | GET/POST | List/create parties |
| `/weddings/parties/{id}` | GET/PATCH/DELETE | Party CRUD |
| `/weddings/parties/{id}/bundle` | GET | Full party bundle (members, orders, ledger) |
| `/weddings/members` | POST | Add member to party |
| `/weddings/members/{id}` | PATCH/DELETE | Update/remove member |
| `/weddings/actions` | GET | Action dashboard (multi-day window) |
| `/weddings/activity-feed` | GET | Activity timeline |
| `/weddings/events` | GET (SSE) | Real-time event stream |

### 2.4 Party Bundle
```
build_party_bundle(pool, party_id)
  → Party details
  → All members with customer info
  → Financial context (ledger balance, payments)
  → Appointments
  → Order items per member
  → Measurement status
```

### 2.5 Financial Context
```
try_load_party_financial_context(pool, party_id)
  → Total party balance
  → Per-member breakdown
  → Outstanding deposits
  → Payment history

try_load_party_ledger(pool, party_id)
  → Detailed ledger entries (charges, payments, adjustments)
```

### 2.6 Action Dashboard
```
query_wedding_actions(pool, days)
  → Aggregates pending actions across all parties:
    → Unresolved measurements
    → Pending orders
    → Upcoming fittings
    → Ready for pickup
  → Filterable by date window (configurable days ahead)
```

### 2.7 SSE Real-Time Events
```rust
wedding_events.appointments_updated(client_sender)
wedding_events.party_updated(party_id, client_sender)
wedding_events.member_updated(member_id, client_sender)
```
Events broadcast to all connected clients via Server-Sent Events. The `client_sender` parameter prevents echo back to the originating client.

### 2.8 Meilisearch Integration
```
spawn_meilisearch_wedding_party(state, party_id)
  → upsert_wedding_party_document(client, pool, party_id)
```
Triggered on party create/update for fuzzy search support.

### 2.9 ROSIE AI Integration
```
rosie_wedding_actions(state, headers, days)
  → Calls get_actions() internally
  → Returns JSON value for ROSIE context
```
Allows ROSIE to reason about pending wedding actions.

---

## 3. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| Party model | Documented | Verified: full lifecycle with members + appointments | ✅ No regression |
| Display label | Not documented | Verified: canonical format with SQL equivalent | ✅ New finding |
| Financial context | Documented | Confirmed: ledger + per-member breakdown | ✅ No regression |
| Action dashboard | Documented | Confirmed: multi-day window aggregation | ✅ No regression |
| SSE events | Documented | Confirmed: real-time broadcast with echo prevention | ✅ No regression |
| ROSIE integration | Not documented | Verified: wedding actions bridge for AI context | ✅ New finding |

---

## 4. Conclusion

**0 blockers, 0 regressions.** The Wedding Party Model is production-ready with comprehensive lifecycle management, real-time events, and AI integration.
