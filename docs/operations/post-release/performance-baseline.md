# Section 4 Performance Baseline

## Production Main Hub measurement — 2026-07-20

The repository now contains a production-only read check:
`npm run check:production-performance`. It defaults to `https://ros.riversidemens.com`,
refuses localhost targets unless explicitly overridden, and enforces a 1,000 ms budget for
`/api/live`, `/api/ready`, and `/api/health`. Authenticated read-only search/report paths can be
measured by supplying `RIVERSIDE_PERF_SEARCH_PATH`, `RIVERSIDE_PERF_REPORT_PATH`, and
`RIVERSIDE_PERF_HEADERS_JSON`.

Observed Main Hub baseline during this audit:

| Endpoint | Result | Time | Budget |
| --- | ---: | ---: | ---: |
| `/api/live` | 200 | 369–707 ms | 1,000 ms |
| `/api/ready` | 200 | 181–260 ms | 1,000 ms |
| `/api/health` | 200 | 104–109 ms | 1,000 ms |

These are availability/readiness timings, not authenticated search or report p95s. Those paths
remain opt-in because they require production staff headers and must be run as read-only probes.

Date: 2026-05-12

This baseline inventory records what is currently known for post-release performance and concurrency readiness. The initial audit found no production render-time, API latency, payload-size, or query-duration baseline in the inspected files. Coverage noted here is correctness or workflow evidence only unless a metric is explicitly listed.

| Area | Workflow | Current baseline metric | Missing baseline metric | Suggested future metric | Current coverage evidence | Risk | Manual/store-floor evidence required | Next safe measurement step |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Product Hub | Open product detail, review inventory/value/timeline, edit product context | None found | API latency, payload size, open/render time | Product Hub open p95, `/api/products/{id}/hub` response bytes, aggregate query time | Inventory value semantics and Product Hub inventory truth are covered, not timing | High | Staff verifies Product Hub opens quickly on store hardware | Capture Product Hub API timing and browser open/render time with seeded product sizes |
| Customer Hub | Search/select customer, open customer detail, review balances/Transaction Records | None found | Search latency, drawer/detail payload size, render time | Customer search p95, customer drawer p95, payload bytes | No Section 4 baseline evidence in allowed scope | High | Staff verifies lookup/detail flow during busy counter work | Targeted source audit and baseline capture for customer search/detail routes |
| Orders / Transaction Records | Search open order work, open transaction detail, process refund/reprint/balance due | None found | Search/detail/refund modal latency and payload size | Orders search p95, transaction detail bytes, refund modal open/submit p95 | Operational rollout smoke covers balance due, refund UI, receipt reprint | High | Staff verifies search/detail/refund flow with realistic Transaction Record history | Capture order search/detail timing and payload size before optimizing |
| Receiving | Stage scans, open Receive Stock, post PO/direct invoice receipt | None found | Receive Stock render, receive POST latency, duplicate replay latency | Batch scan p95, receive POST p95, duplicate replay p95 | Strong correctness evidence: exact-once PO/direct invoice receiving and duplicate replay tests | Critical | Receiving staff verifies paper-to-screen flow on store workstation | Measure receive POST and replay latency with normal and large receiving documents |
| Scheduler | Review/edit schedule and store-wide calendar | None found | Schedule payload size and render time | Weekly schedule render p95, schedule payload bytes | No Section 4 baseline evidence in allowed scope | High | Manager verifies schedule view stays usable on store devices | Targeted source audit and measurement of schedule load/render path |
| Counterpoint proof | Review bridge status, proof rows, signoff blockers, staging payloads | Mocked UI data only | Live bridge/proof route latency and payload size | Proof route p95, staging payload bytes, bridge status payload bytes | Counterpoint signoff UI coverage and server result-limit tests exist; mocked UI is not live payload proof | High | Accounting/import owner reviews proof packet on real bridge data | Capture proof/status/staging payload metrics against representative import data |
| QBO proposals | Generate proposal, review lines, approve/sync flow | None found | Proposal generation latency, journal line count, response size | Proposal p95, line count, response bytes, staging list bytes | Strong accounting stability evidence: balanced, deduped pending, attribution, approval gate, revisions | Critical | Accounting verifies proposal review remains usable before approval | Capture proposal generation p95 and payload size by activity date size |
| Reporting routes | Run sales, margin, register-day, and reports workspace routes | None found | Query duration, row count, payload size | Route p95 by report/basis/grouping, response bytes, truncation count | Reporting trust contracts cover semantic correctness for critical reports | High | Manager/accounting verifies reports load and print/review acceptably | Capture key report route timings before adding any optimization |
| Register/session workflows | Open linked lanes, checkout, reconcile, close till group | None found | Open/close/reconciliation latency under multi-lane use | Session open p95, reconciliation p95, close p95, close payload size | Register audit/close contracts cover lane ownership, linked lanes, pending close, closed tokens | Critical | Store verifies multi-cashier close flow during live acceptance | Measure register open/reconcile/close timing with multiple lanes and transactions |

## Local Baseline Observations - May 2026

These observations were captured against the local E2E/dev stack only. They are not production p95s, store-floor benchmarks, browser render timings, or database query timings.

- API base: `http://127.0.0.1:43300`
- Business date used by route probes: `2026-05-12`
- Store timezone context: `America/New_York`
- Three-run route probes are local observations, not p95.
- E2E timings are workflow/spec durations, not pure API latency.

| Area | Route/workflow | Runs | Latency observed | Payload | Count | Source | Risk |
| --- | --- | ---: | --- | ---: | --- | --- | --- |
| Product inventory | `/api/products/control-board?limit=10` | 3 | 266.8-277.1 ms | 9,513 B | 10 rows | read-only API probe | High |
| Product Hub | `/api/products/{id}/hub` | 3 | 500.5-509.1 ms | 2,039 B | 1 variant | read-only API probe | High |
| Product timeline | `/api/products/{id}/timeline` | 3 | 252.3-259.2 ms | 13 B | not exposed | read-only API probe | High |
| Orders | `/api/transactions?limit=10` | 3 | 260.2-277.6 ms | 7,161 B | 10/149 | read-only API probe | High |
| Transaction detail | `/api/transactions/{id}` | 3 | 268.4-276.4 ms | 2,067 B | 1 item | read-only API probe | High |
| Receiving | PO receipt + duplicate replay | 1 spec | 4.1s workflow | not captured | exact-once passed | E2E | Critical |
| Receiving | Direct invoice + replay | 1 spec | 3.8s workflow | not captured | exact-once passed | E2E | Critical |
| Register activity | `/api/insights/register-day-activity?...` | 3 | 566.9-576.0 ms | 60,664 B | 75 activities | read-only API probe | Critical |
| Sales pivot | `/api/insights/sales-pivot?...` | 3 | 268.7-270.9 ms | 327 B | 1 row | read-only API probe | High |
| Margin pivot | `/api/insights/margin-pivot?...` | 3 | 345.5-621.6 ms | 399 B | 1 row | read-only API probe | High |
| QBO staging | `/api/qbo/staging?...` | 3 | 251.2-259.9 ms | 25,218 B | 1 row | read-only API probe | Critical |
| QBO proposal | proposal generation contract | 1 spec | 4.5s workflow | not captured | >=3 postable lines, balanced | E2E | Critical |
| Counterpoint | `/api/settings/counterpoint-sync/status` | 3 | 249.8-264.1 ms | 285 B | n/a | read-only API probe | High |
| Counterpoint | transaction reconciliation settings | 3 | 251.9-253.2 ms | 426 B | n/a | read-only API probe | High |
| Counterpoint UI | signoff proof UI | 1 spec | 7.3s / 3.0s | mocked | mocked | E2E | High |

## Measured Hotspots

- `register-day-activity` is the clearest measured payload hotspot: about 60 KB for 75 activities and about 570 ms locally.
- Product Hub detail is a measured latency hotspot: about 500 ms locally for one product.
- QBO staging list is a measured payload hotspot: about 25 KB for one row.
- Margin pivot had a slower first local run at 621.6 ms, then about 350 ms.

## Still Unmeasured

- True receive POST and duplicate replay API latency/payload.
- Direct QBO `/staging/propose` latency/payload because it is a write path.
- Browser open/render timings for Product Hub, Orders, Scheduler.
- Live Counterpoint bridge/proof latency.
- Query duration and p95 metrics.

## Baseline Rules

- Do not infer performance from test pass/fail duration; Playwright timeout success is not a baseline.
- Do not propose caching for accounting, QBO, register, refund, or reporting routes until freshness and auditability are proven.
- Mocked UI coverage is workflow evidence only, not live payload or latency proof.
- Counterpoint imported tax remains non-authoritative and is not filing proof.
