# Section 4 Optimization Roadmap

Date: 2026-05-12

This roadmap prioritizes measurement before optimization. It intentionally avoids speculative indexes, caching, or behavior changes until baseline evidence proves the bottleneck and accounting freshness can be preserved.

## Phase 1: Measurement And Baseline Capture

| Priority | Item | Why it comes first | Suggested evidence |
| --- | --- | --- | --- |
| 1 | Capture QBO proposal generation p95, journal line count, and response size | Critical accounting workflow; optimization must not change journal math or freshness | Proposal p95, line count, response bytes for representative business dates |
| 2 | Capture Receiving receive POST p95 and duplicate replay latency | Critical inventory mutation path with strong correctness evidence but no timing baseline | Normal receive p95, replay p95, receiving event count, stock delta check |
| 3 | Capture Product Hub API latency, payload size, and open/render time | High-frequency inventory workflow with aggregate reads | Hub route p95, response bytes, browser open/render time |
| 4 | Capture Orders search/detail/refund modal latency | Staff-facing checkout recovery and refund path | Search p95, transaction detail bytes, refund modal open/submit p95 |
| 5 | Capture key reporting route p95 by report, basis, and grouping | Reporting trust work is accounting-sensitive; freshness must remain visible | Sales/margin/register-day p95, response bytes, truncation flag |
| 6 | Capture Counterpoint proof route latency and payload size | Accounting/import review can be blocked by large proof packets | Status/proof/staging route p95, payload bytes, issue count |
| 7 | Capture Scheduler load/render baseline | High-risk plan area with no allowed-scope evidence | Weekly/store-wide schedule p95 and payload bytes |

## Phase 2: Concurrency Contract Coverage

| Priority | Item | Accounting/operational risk | Safe scope |
| --- | --- | --- | --- |
| 1 | Add simultaneous refund API contract | Duplicate refund, liability clearing error, register mismatch | Complete for cash refund queue path; extend only if provider-backed split concurrency becomes in scope |
| 2 | Add concurrent same-PO receive contract | Duplicate stock posting or receiving event | Complete for same-PO single-line receipt; extend to multi-line/partial receipt concurrency if needed |
| 3 | Add register open/close concurrency contract or targeted uniqueness audit | Duplicate lane open or close race can break till truth | Primary open concurrency covered; close-race contract or source audit remains |
| 4 | Add split-refund capacity/retry contract | Split refund capacity errors can over-refund or confuse staff | Capacity/retry covered for cash refund; provider split concurrency remains out of scope without safe provider simulation |

## Phase 3: Targeted Source Audits

| Item | Reason | Expected output |
| --- | --- | --- |
| Inventory edit optimistic/version behavior | Product/cost/stock edits are high-risk and no concurrency coverage was found | Confirm lock/version behavior and smallest contract target |
| Order edit concurrency behavior | Order edits can affect balances, fulfillment, attribution, and QBO dates | Confirm lock/version behavior and smallest contract target |
| Customer Hub performance path | High-risk frontend area with unknown baseline in allowed scope | Identify source routes, payloads, and measurement target |
| Scheduler performance path | High-risk frontend area with unknown baseline in allowed scope | Identify schedule route payloads and render measurement target |
| Counterpoint live proof payload path | Mocked UI coverage is not live payload proof | Identify largest proof/status/staging responses and limits |

## Phase 4: Safe Optimization Candidates

Only consider these after Phase 1 metrics identify a real bottleneck.

| Candidate | Guardrail |
| --- | --- |
| Reduce oversized response payloads for Product Hub, control board, QBO staging, or Counterpoint proof | Preserve fields required for staff recovery, accounting review, and audit evidence |
| Add targeted pagination or caps where routes already support limits | Do not hide accounting exceptions, open liabilities, or signoff blockers |
| Split expensive report views into explicit reviewed summaries and drilldowns | Preserve booked vs fulfilled, return-day contra, and QBO balancing semantics |
| Improve query shape only after measuring the route and reviewing explain output | Do not add speculative indexes or alter accounting math without proof |
| Add UI loading/progress states where store workflows appear blocked | Do not mask errors staff/support need for recovery |

## Phase 5: Store-Floor And Manual Validation

| Item | Evidence needed | Owner |
| --- | --- | --- |
| Product Hub and Orders under real workstation conditions | Staff-observed open/search/detail timing | Store manager |
| Receiving during normal back-room paperwork | Receive Stock timing, duplicate/retry recovery evidence | Inventory lead |
| QBO proposal review | Proposal generation timing, line count, accounting review notes | Accounting |
| Counterpoint proof review | Live proof route timing and signoff packet review | Accounting/import owner |
| Multi-cashier register close | Open/reconcile/close timing with linked lanes | Store manager |
| Report print/review | Printed/readable report evidence and manager initials | Store manager + accounting |

## Non-Negotiable Optimization Rules

- No caching proposal may make accounting, reporting, QBO, register close, refund, or inventory evidence stale.
- Do not optimize away audit fields, exception rows, warnings, or signoff blockers.
- Do not treat Counterpoint imported tax as filing proof.
- Do not change financial, inventory, or QBO behavior as part of measurement-only work.
