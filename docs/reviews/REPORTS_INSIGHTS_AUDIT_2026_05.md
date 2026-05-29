# Audit Report: Reports & Insights (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-08
**Version Audited:** v0.85.0 (commit `73cdd56`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of curated reporting endpoints (sales pivot, margin pivot, commission ledger/lines/trace, best sellers, dead stock, NYS tax audit, staff performance, register day activity, register override mix, RMS charges, negative stock, exception risk, sales by day, sales trend/pace, loyalty velocity, merchant activity), ROSIE AI reporting bridge, Metabase embedding proxy, and weather correlation.

---

## 1. Executive Summary

The Reports & Insights subsystem is a **comprehensive, dual-layer analytics engine** with 20+ curated Rust/SQL endpoints and embedded Metabase for ad-hoc exploration. The reporting basis system (booked vs. recognition/completed) is correctly implemented across all endpoints using a canonical `ORDER_RECOGNITION_TS_SQL` expression. The ROSIE AI reporting bridge enables natural language analytics via 10+ pre-defined spec runners. The commission system has been enhanced with detailed event-based tracking (base, SPIFF, combo) and a trace endpoint for per-line attribution.

**Overall Status:** Production Ready — 0 blockers, 0 regressions. Major enhancements since April audit.

---

## 2. Reporting Infrastructure

### 2.1 Recognition Basis System
All date-aware reports support dual basis:
- **Booked**: Uses `o.booked_at` — when the sale was rung up
- **Completed/Recognition**: Uses `ORDER_RECOGNITION_TS_SQL` — when fulfillment occurred (pickup, ship label purchased, or delivery)

This ensures financial reports can show either "when did we sell it?" or "when did we earn it?" views. The canonical SQL expression is shared across insights, QBO journal, and commission logic.

### 2.2 Effective Quantity Pattern
All revenue-calculating queries use:
```sql
GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0) AS effective_qty
```
This prevents returned items from inflating revenue figures — a critical guard against overstating sales.

### 2.3 Store-Local Timezone
Date grouping uses `AT TIME ZONE reporting.effective_store_timezone()` — a SQL function that reads the store's configured timezone from settings. This ensures "today" means "today in the store's location," not UTC.

---

## 3. Curated Report Endpoints

### 3.1 Sales Pivot (`/api/insights/sales-pivot`)
- **Dimensions**: date, brand, category, salesperson, customer
- **Metrics**: gross_revenue, tax_collected, order_count, line_units
- **Weather integration**: Date-grouped pivots include weather snapshots (Visual Crossing) and register closing comments for environmental context
- **Customer pivot**: Shows customer name + code, grouped by customer_id
- **Limit**: 200 rows with truncation flag
- **RBAC**: `insights.view`

### 3.2 Margin Pivot (`/api/insights/margin-pivot`)
- **Admin-only**: Hard-coded gate — only `Admin` role can access cost data
- **Metrics**: gross_revenue, total_cost (frozen `unit_cost` from checkout), gross_margin, margin_percentage
- **Cost basis**: Uses the `unit_cost` captured at checkout time, not current catalog cost

### 3.3 Commission Ledger (`/api/insights/commission-ledger`)
- **Pipeline**: Unpaid commission from booked, unfulfilled lines
- **Earned**: Recognized commission from `commission_events` table
- **Breakdown**: Separates base commission (rate × revenue) from SPIFF/combo incentive amounts
- **Earned sale count**: Distinct transactions with non-zero commission
- **Staff context**: Current commission rate and effective date for payroll reference
- **Fallback**: If `commission_events` table is empty, falls back to fulfilled `transaction_lines.calculated_commission`

### 3.4 Commission Lines (`/api/insights/commission-lines`)
- Per-line detail with adjustment history
- Tracks sale commission, SPIFF, and combo incentive separately
- Net commission after adjustments
- `LIMIT 500` with truncation flag

### 3.5 Commission Trace (`/api/insights/commission-trace/{line_id}`)
- Full event history for a single transaction line
- Shows each `commission_event` with type, amounts, metadata
- Enables auditing of how a specific commission was calculated

### 3.6 Commission Adjustments (`/api/insights/commission-adjustments`)
- Manual commission correction by admin
- Validates line exists and is fulfilled
- Records adjustment event in `commission_events`
- RBAC: `staff.manage_commission`

### 3.7 Best Sellers (`/api/insights/best-sellers`)
- Ranked by units sold or net sales
- Supports booked/recognition basis
- Includes return deductions (effective quantity)

### 3.8 Dead Stock (`/api/insights/dead-stock`)
- Identifies slow-moving inventory
- Filters by `max_units_sold` threshold
- Shows retail value on hand

### 3.9 NYS Tax Audit (`/api/insights/nys-tax-audit`)
- State + local tax breakdown per transaction
- Tax-exempt orders with exemption reason
- Designed for NYS Publication 718-C compliance review

### 3.10 Additional Reports
| Endpoint | Purpose |
|:---|:---|
| `/staff-performance` | Sales MTD by staff with conversion metrics |
| `/register-day-activity` | Daily register summary (tenders, transactions, cash) |
| `/register-sessions` | Historical session list with Z-report snapshots |
| `/register-override-mix` | Price override analysis (frequency, magnitude, staff) |
| `/rms-charges` | RMS financing charge report |
| `/negative-stock` | Variants with stock_on_hand < 0 |
| `/exception-risk` | Anomaly detection for high-risk patterns |
| `/sales-by-day` | Daily aggregated sales with weather overlay |
| `/sales-trend-pace` | Period-over-period sales velocity |
| `/loyalty-velocity` | Loyalty point accrual/redemption rates |
| `/merchant-activity` | Payment processor activity summary |
| `/appointments-no-show` | No-show rate analysis |
| `/customer-follow-up` | Customers due for follow-up |
| `/wedding-health` | Wedding party readiness summary |

---

## 4. ROSIE AI Reporting Bridge

`rosie_reporting_run()` maps natural language queries to structured report specs:

| Spec ID | Report | Permission |
|:---|:---|:---|
| `sales_pivot` | Sales Pivot | insights.view |
| `best_sellers` | Best Sellers | insights.view |
| `dead_stock` | Dead Stock | insights.view |
| `negative_stock` | Negative Stock | insights.view |
| `wedding_health` | Wedding Health | insights.view |
| `commission_ledger` | Commission Ledger | insights.view |
| `staff_performance` | Staff Performance | insights.view |
| `customer_follow_up` | Customer Follow-Up | insights.view |
| `appointment_no_show` | No-Show Report | insights.view |
| `wedding_event_readiness` | Wedding Readiness | insights.view |
| `schedule_coverage` | Schedule Coverage + Sales | insights.view |

Each spec runner:
1. Parses and normalizes parameters from ROSIE's natural language extraction
2. Constructs the typed query struct
3. Delegates to the existing report handler
4. Returns structured data with route, permission, and normalized params for frontend rendering

---

## 5. Metabase Integration
- JWT SSO proxy creates staff-scoped sessions
- Health endpoint verifies Metabase connectivity
- Embedded dashboards accessible within the same-origin UI
- Custom proxy strips `X-Frame-Options` for iframe embedding

---

## 6. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| Sales Pivot | Documented | Verified with 5 dimensions + weather overlay | ✅ No regression |
| Margin Pivot | Admin-gated | Confirmed: Admin role required | ✅ No regression |
| Commission engine | "Dual-Layer Rates" | Enhanced: event-based with base/SPIFF/combo separation + trace | ✅ Enhanced |
| Best Sellers / Dead Stock | Documented | Verified with effective quantity pattern | ✅ No regression |
| Weather correlation | Documented | Confirmed in date-grouped sales pivot | ✅ No regression |
| Metabase proxy | Documented | Confirmed: JWT SSO + header stripping | ✅ No regression |
| ROSIE AI bridge | Not documented | Verified: 11 spec runners for natural language reporting | ✅ New finding |
| Commission trace | Not documented | Verified: per-line event history for audit | ✅ New finding |
| Exception risk report | Not documented | Verified: anomaly detection endpoint | ✅ New finding |
| Daily financial report | Recommended as enhancement | Resolved May 27: automated post-Z-close email report | ✅ Implemented |
| Dynamic visualizations | Recommended | Not implemented (still tabular) | ℹ️ Same as before |

---

## 7. Findings

### 7.1 Positive: Recognition Basis Consistency
Every revenue-calculating endpoint uses the same `ORDER_RECOGNITION_TS_SQL` canonical expression. This eliminates the risk of different reports showing different revenue numbers for the same period.

### 7.2 Positive: Commission Event Model
The transition from simple `calculated_commission` fields to a full `commission_events` table with event types (sale_commission, spiff, combo_incentive, adjustment, clawback) provides complete audit trail and enables the trace endpoint for per-line debugging.

### 7.3 Positive: ROSIE Integration
The reporting bridge pattern (spec ID → typed query → existing handler → structured response) is well-designed — it reuses all existing report logic without duplication, ensuring ROSIE and the UI always show the same data.

---

## 8. Conclusion

**0 blockers, 0 regressions.** The Reports & Insights subsystem is production-ready with 20+ curated endpoints, consistent recognition basis, comprehensive commission tracking, ROSIE AI integration, and embedded Metabase analytics. The most mature reporting infrastructure reviewed in this audit series.
