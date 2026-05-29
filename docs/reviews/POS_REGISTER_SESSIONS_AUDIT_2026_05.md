# Audit Report: POS Register Sessions (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-08
**Version Audited:** v0.85.0 (commit `73cdd56`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of register session lifecycle (open → attach → reconcile → close), Z-close reconciliation, cash management (paid in/out), Helcim close review, till group model, parked sale purge, and post-close asynchronous operations (EOD snapshot, QBO journal staging, daily financial report).

---

## 1. Executive Summary

The POS Register Sessions subsystem is a **mature, production-hardened** register lifecycle manager. The Z-close flow is exceptionally comprehensive — it aggregates multi-lane tenders, computes expected cash with adjustments, enforces mandatory closing notes for discrepancies > $5.00, blocks close when unresolved Helcim card attempts exist, purges parked sales within the close transaction, and fires asynchronous post-close operations (EOD snapshot, QBO journal staging, daily financial report). The till group model correctly supports multi-register shifts with a single cash drawer.

**Overall Status:** Production Ready — 0 blockers, 0 regressions.

---

## 2. Architecture Trace

### 2.1 Session Lifecycle
```
open_session(pool, cashier_code, opening_float, register_lane)
  → Authenticate staff via cashier_code
  → Enforce no existing open session on this lane
  → Generate till_close_group_id (shared across lanes in same shift)
  → Generate session_ordinal for register numbering
  → Issue POS API token for the session
  → INSERT register_sessions (is_open=true, lifecycle_status='open')

attach(session_id, cashier_code)
  → Authenticate staff
  → Link additional staff to existing session

shift_primary(session_id, staff_id)
  → Requires REGISTER_SHIFT_HANDOFF permission
  → Update shift_primary_staff_id for sales attribution handoff

begin_reconcile(session_id, cashier_code, active)
  → Must be lane 1 (cash drawer)
  → If active=true: transition all sessions in till group to 'reconciling'
  → If active=false: revert all back to 'open'
  → Requires valid cashier_code authentication

close_session(session_id, actual_cash, closing_notes, closing_comments)
  → Must be lane 1 — closes ALL linked lanes in the till group
  → FOR UPDATE lock on all sessions in the group
  → Block if unresolved Helcim card attempts exist
  → Build full reconciliation report
  → Compute discrepancy = actual_cash - expected_cash
  → Enforce closing_notes if |discrepancy| > $5.00
  → Purge parked sales within the transaction
  → Atomically close all sessions (is_open=false, lifecycle_status='closed')
  → Store Z-report JSON snapshot
  → Async: EOD snapshot, QBO journal staging, daily financial report
```

### 2.2 Till Group Model
Multiple register lanes can operate in a single shift:
- Lane 1 is the **primary** — holds the physical cash drawer
- Lane 2+ are satellite lanes (card-only, no cash adjustments)
- All lanes share a `till_close_group_id`
- Cash adjustments (paid in/out) restricted to lane 1
- Z-close from lane 1 atomically closes all linked lanes
- Reconciliation aggregates tenders across ALL lanes in the group

### 2.3 Reconciliation Report
`build_reconciliation()` produces a comprehensive Z-report:

| Component | Source |
|:---|:---|
| Opening float | `register_sessions.opening_float` (lane 1) |
| Net cash adjustments | `register_cash_adjustments` (paid_in - paid_out) |
| Cash tender total | `payment_transactions WHERE payment_method = 'cash'` |
| Swedish rounding | `payment_transactions WHERE payment_method = 'rounding_adjustment'` |
| Expected cash | `opening_float + cash_tenders + rounding + net_adjustments` |
| Tender breakdown | All payment methods aggregated across till group |
| Per-lane tenders | Tender totals broken down by register lane |
| Transaction audit | All transactions with line items, overrides, salesperson |
| Helcim review items | Unresolved card attempts requiring manager action |
| Inventory activity | Non-sale inventory transactions for the business date |
| QBO journal preview | Real-time daily journal proposal for accounting review |

### 2.4 Cash Management
```
post_cash_adjustment(session_id, direction, amount, reason, category)
  → Requires POS session or REGISTER_OPEN_DRAWER permission
  → Must be lane 1 (cash drawer)
  → FOR UPDATE lock on session
  → direction: paid_in | paid_out
  → amount must be positive, reason required
  → Records in register_cash_adjustments

post_manual_drawer_open(session_id, cashier_code, pin, reason)
  → Authenticates staff via cashier_code + PIN
  → FOR UPDATE lock on session, lane 1 only
  → Records in register_drawer_open_events
  → log_staff_access audit trail
```

### 2.5 Helcim Close Review
During Z-close, any unresolved Helcim card attempts block closure:
- Manager reviews each attempt (reviewed/written_off/linked/refunded)
- Non-"reviewed" actions require a note
- Validated against till_close_group_id (attempt must belong to an open session in the same group)
- Records action in `helcim_terminal_recovery_actions` with actor attribution

### 2.6 Post-Close Asynchronous Operations
After the close transaction commits, a `tokio::spawn` fires three operations:
1. **EOD Snapshot**: Builds and saves a register day summary for historical reporting
2. **QBO Journal Staging**: Ensures a pending daily journal entry exists for the business date
3. **Daily Financial Report**: Auto-sends if configured in store settings

All three operations broadcast system alerts to admin staff if they fail — failures do not block the register close.

---

## 3. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| Offline queue integration | Noted | Not in scope (see Offline Ops audit) | ℹ️ |
| Idempotency via checkout_client_id | Noted | Confirmed in checkout flow, not in session logic | ✅ No regression |
| Till group model | Not documented | Verified: multi-lane with shared group ID | ✅ Enhanced documentation |
| Cash drawer restriction | Not documented | Confirmed: adjustments/close restricted to lane 1 | ✅ Enhanced |
| Helcim close review | Not documented | Verified: blocks close until all attempts resolved | ✅ New finding |
| Parked sale purge in close TX | P2-002 remediated | Confirmed: `purge_open_parked_for_sessions_in_tx` inside close TX | ✅ Verified fix |
| Post-close QBO staging | Not documented | Verified: auto-propose journal after Z-close | ✅ New finding |
| Discrepancy note threshold | Not documented | Confirmed: $5.00 threshold for mandatory closing notes | ✅ New finding |
| Weather snapshot | Not documented | Verified: captured at close time for sales correlation | ✅ New finding |

---

## 4. Findings

### 4.1 Positive: Atomic Multi-Lane Close
The close operation uses `FOR UPDATE` locks on all sessions in the till group and closes them atomically in a single transaction. This prevents a race condition where one lane could remain open while others close.

### 4.2 Positive: Helcim Attempt Gate
The requirement to resolve all unresolved Helcim card attempts before close ensures financial completeness — no pending card transactions are left in limbo after the register closes.

### 4.3 Positive: Failure Resilience in Post-Close
The post-close async operations (EOD snapshot, QBO staging, daily report) use `broadcast_system_alert` to notify admin staff of failures. This is the correct pattern — a failure in reporting should never block the register from closing, but it must be visible to operators.

---

## 5. Conclusion

**0 blockers, 0 regressions.** The POS Register Sessions subsystem is production-ready with a comprehensive Z-close workflow, multi-lane till group support, strict cash management controls, and resilient post-close operations.
