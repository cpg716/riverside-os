# Section 4 Hotspot Report

Date: 2026-05-12

This report lists likely performance and concurrency hotspots found during the Section 4 audit. Findings are conservative and do not claim measured slowness unless a metric exists. Most areas need baseline capture before any optimization work.

## Frontend Hotspots

| Area | Observed evidence | Likely risk | Accounting sensitivity | Current coverage | Classification | Smallest safe next step |
| --- | --- | --- | --- | --- | --- | --- |
| Product Hub | Product Hub inventory/value routes and Product Hub value tests exist | Heavy detail payload and multiple aggregate reads can slow product review | High | Product Hub value semantics covered; no timing baseline | Needs baseline | Capture Product Hub open/render time and API payload size |
| Customer Hub | Listed as high-risk in plan; no allowed-source baseline found | Search/detail drawer may slow or confuse customer lookup | High | Unknown from allowed scope | Unknown from allowed scope | Targeted Customer Hub source audit and baseline capture |
| Orders | Operational smoke covers order search/detail, refunds, receipt reprint, balance due | Search/detail/refund/reprint flows may slow with large transaction history | Critical | Staff-facing smoke coverage exists; no load baseline | Needs baseline | Capture Orders search/detail/refund modal timing |
| Receiving | Guided Receive Stock UI and exact-once receiving coverage exist | Receive flow can block back-room work if posting or staged rows are slow | Critical | UI flow and API idempotency covered | Partially covered | Capture Receive Stock render and receive POST p95 |
| Scheduler | Listed as high-risk in plan; no allowed-source baseline found | Weekly/store-wide schedule can become slow on busy weeks | High | Unknown from allowed scope | Unknown from allowed scope | Targeted Scheduler source audit and baseline capture |
| Counterpoint proof | Signoff UI uses proof/status routes and mocked proof data | Large proof/status/staging payloads can delay accounting review | High | UI proof order/caveats covered with mocks; live payload not measured | Needs baseline | Capture live proof route latency and payload bytes |
| QBO proposals | QBO staging shell and audit contracts cover proposal behavior | Proposal generation or staging payloads can delay accounting review | Critical | Balanced/deduped/approval-gated proposal coverage exists | Needs baseline | Capture proposal generation p95, line count, response bytes |

## Backend, Query, And Payload Hotspots

| Area | Observed evidence | Likely risk | Accounting sensitivity | Current coverage | Classification | Smallest safe next step |
| --- | --- | --- | --- | --- | --- | --- |
| Product control board | SQL route supports large limits, search fallback, joins, lateral vendor/variant data | Large row/payload volume and expensive search fallback | High | No performance baseline; value semantics covered elsewhere | Needs baseline | Measure control board API p95 and payload size before tuning |
| Product Hub detail | Multiple aggregate reads for stock, value, sales, open order units, variants | Detail page can become slow on products with many variants/history | High | Product Hub inventory truth covered | Needs baseline | Capture per-query and total Product Hub route timing |
| Sales/margin pivots | Aggregations join transaction lines, returns, products, categories, staff | Expensive groupings on large transaction history | Critical | Reporting trust contracts cover math/date basis | Needs baseline | Capture p95 by report, basis, and grouping |
| Register-day activity | Dense summary plus activity timeline and item details | Large activity payload can slow manager report review | Critical | Daily Sales/register activity contract exists | Needs baseline | Capture response bytes and p95 for busy business days |
| QBO proposal logic | Many accounting aggregations across tenders, revenue, returns, deposits, liabilities, inventory | Proposal generation can be slow or produce very large staging payloads | Critical | Accounting stability covered, not latency | Needs baseline | Measure proposal p95, line count, and payload bytes |
| QBO staging list/payload | Staging list caps rows but returns payloads; staging payload can be large | Accounting review UI can load too much JSON | Critical | QBO staging UI/audit coverage exists | Needs baseline | Capture staging list/payload bytes for representative dates |
| Counterpoint proof/status/payload | Proof and staging routes expose row counts, payloads, status, issues | Live import evidence can be oversized | High | Mocked UI coverage and result-limit logic tests exist | Needs baseline | Measure live proof and staging payload sizes |

## Concurrency And Race Hotspots

| Area | Observed evidence | Likely risk | Accounting sensitivity | Current coverage | Classification | Smallest safe next step |
| --- | --- | --- | --- | --- | --- | --- |
| Multiple cashiers | Register lane ownership, linked lanes, Register #1 close, closed tokens covered | Duplicate open/close or stale token could mismatch till totals | Critical | Partially covered by register audit/close tests | Needs contract coverage | Add register open/close concurrency contract or uniqueness audit |
| Simultaneous refunds | Refund queue row and transaction paid amount are locked; Helcim idempotency key exists | Double refund or duplicate liability clearing | Critical | Sequential refund/QBO coverage exists; no parallel request proof | Needs contract coverage | Add simultaneous refund API contract |
| Simultaneous receiving | PO and variant rows are locked; receipt request replay is idempotent | Double-posted stock or duplicate receiving event | Critical | Duplicate retry exact-once tests exist; no true parallel proof | Needs contract coverage | Add concurrent same-PO receive contract |
| Inventory edits | Product edits use transactions and validation in allowed source | Last-write-wins or stale edit could corrupt product/cost/stock context | High | No concurrency coverage found | Needs source audit | Audit optimistic/version behavior for inventory edits |
| Order edits | Transaction attribution edit locks the transaction row; QBO date/edit contract exists | Conflicting edits can affect balances, attribution, fulfillment, QBO dates | Critical | Partial source evidence; no concurrent edit contract | Needs source audit | Audit order edit concurrency behavior before tests |
| Split refunds | Source notes multi-card iterative dispatch is deferred to sequential requests | Capacity/retry edge cases can confuse staff or over-refund if not guarded | Critical | Refund capacity/liability coverage exists; no split concurrency proof | Needs contract coverage | Add split-refund capacity/retry contract without provider simulation |

## Manual Store-Floor Hotspots

- Report printing and physical review remain manual evidence.
- QBO proposal review must be timed with representative store activity before signoff.
- Counterpoint proof review must be checked against live bridge data, not mocked UI routes.
- Multi-cashier register close needs store-floor observation even after API contracts.
- Hardware-related delays remain outside automated Section 4 scope.
