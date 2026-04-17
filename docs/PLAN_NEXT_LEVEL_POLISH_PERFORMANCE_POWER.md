# PLAN — Next-Level Polish, Performance, and Power (ROS)

**Document owner:** Product + Engineering  
**System:** Riverside OS (ROS)  
**Date:** 2026-04-11  
**Status:** Draft for execution planning  
**Related docs:**  
- `docs/PRODUCT_ROADMAP_MENS_WEDDING_RETAIL.md`  
- `ThingsBeforeLaunch.md`  
- `docs/ROS_UI_CONSISTENCY_PLAN.md`  
- `docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`  
- `docs/STAFF_PERMISSIONS.md`  
- `docs/SEARCH_AND_PAGINATION.md`  
- `docs/PLAN_NOTIFICATION_CENTER.md`  
- `docs/METABASE_REPORTING.md`  
- `docs/REPORTING_BOOKED_AND_FULFILLED.md`

---

## 1) Purpose

This plan defines how ROS moves from **feature-complete retail platform** to **best-in-class operational system** by targeting three outcomes:

1. **Polish** — smoother workflows, lower training burden, fewer clicks/errors.  
2. **Performance** — faster UI/API response, higher reliability under store-hour load.  
3. **Power** — prescriptive intelligence that recommends what staff should do next.

This is not a rewrite. It is a focused maturity roadmap built on existing ROS strengths.

---

## 2) Current strengths (baseline)

ROS already has strong foundations:

- Robust retail domain coverage: POS, inventory, weddings, customers, sessions, deposits, returns.
- Financial rigor: booked vs fulfilled semantics, fulfillment-based recognition, role-based reporting.
- Security model: staff auth, PIN/RBAC, POS session gates.
- Operational infrastructure: notifications, backups, optional integrations (Stripe, Podium, Shippo, Meilisearch).
- Strong docs/runbooks and clear architectural conventions.

This plan assumes those foundations remain intact and emphasizes **execution quality** and **operator speed**.

---

## 3) Key gaps to close

### A. Operational readiness consistency (highest risk)
From launch and ops checklists, several critical controls are not yet uniformly enforced:
- backup/restore drills,
- SQL query metadata freshness discipline,
- hardware stress validation under multi-lane conditions,
- formal reconciliation audits (tax, store credit, deposits),
- production hardening checks (origins, key rotation, recovery confidence).

### B. Workflow friction for mixed-role staff
ROS has power, but some flows still feel advanced/expert:
- parked sales + RMS flows,
- multi-step exception handling,
- cross-surface navigation context switching,
- uneven “next-step guidance” inside key workspaces.

### C. Descriptive vs prescriptive intelligence gap
Current reporting explains what happened. Next level requires:
- prioritized recommendations,
- risk prediction (especially wedding and fulfillment queues),
- action-oriented alerts tied directly to workflow buttons.

---

## 4) Strategic pillars

## Pillar 1 — Zero-Friction Operations (Polish)
Make everyday tasks obvious, fast, and hard to misuse.

**Goals**
- Reduce cashier/BO click paths by 20–30% for top workflows.
- Reduce training time for new staff by 30%.
- Reduce exception-related support pings.

**Initiatives**
1. **Role-optimized workflow rails**
   - Cashier rail (speed-first)
   - Sales support rail (fulfillment/task-first)
   - Manager rail (exceptions/approvals/health)
2. **Global command palette**
   - Quick jump to customer/order/product/wedding/session actions.
3. **Actionable empty states + undo patterns**
   - No dead-end “No data” surfaces.
4. **Consistency pass**
   - Keyboard-first flows, touch-target parity, standardized completion patterns.
5. **Context persistence**
   - Smarter return-to-last-state behavior across workspaces.

---

## Pillar 2 — Predictable Speed and Reliability (Performance)
Make ROS consistently fast during real store pressure.

**Goals**
- Improve p95 API latency on top 20 endpoints by 30%.
- Keep UI interaction latency below perceptible thresholds on register hardware.
- Eliminate avoidable regressions in peak-hour workflows.

**Initiatives**
1. **Endpoint SLO instrumentation**
   - Route-level p50/p95/p99 and error-rate dashboards.
2. **Heavy-module decomposition**
   - Continue isolating dense backend modules into focused logic/service slices.
3. **Load and soak test suite**
   - Register-hour profile (checkout, search, print, session actions).
4. **Background job health board**
   - Notifications/integrations/backups with lag/failure status.
5. **Search/index operational tuning**
   - Meilisearch hybrid path optimization and reindex visibility.

---

## Pillar 3 — Manager Inventory Overview Layer (Power)
Turn ROS into a daily decision engine, not just a system of record.

**Goals**
- Surface high-risk issues before they become customer-impacting.
- Increase proactive interventions (not just reactive cleanup).
- Improve margin outcomes with earlier detection.

**Initiatives**
1. **Fulfillment Command Center**
   - Unified queue for rush/due-soon/pickup-ready/blocked.
   - SLA timers, assignment, escalation.
2. **Wedding Health Heatmap**
   - Red/yellow/green by payment, measurement status, due-date proximity.
   - “Next best action” shortcuts.
3. **Inventory Brain v2**
   - Reorder guidance from velocity + lead time + on-hand.
   - Dead-stock rescue suggestions.
4. **Commission Trust Center**
   - Explainable payout trace by line/override rule.
5. **Manager Copilot (rules-first)**
   - Prioritized nudges generated from deterministic rules before LLM expansion.

---

## 5) Prioritized roadmap

## Phase 1 (Weeks 1–3): Reliability Gate

**Objective:** close operational risk before adding major net-new features.

**Scope**
- Complete open critical items from `ThingsBeforeLaunch.md`.
- Formalize launch-readiness scorecard (in-app or runbook-backed).
- Execute and record:
  - backup restore drill,
  - hardware concurrency print drill,
  - tax and opening-balance signoff,
  - auth/permissions drift review.

**Deliverables**
- `Launch Readiness` checklist report (signed by ops + engineering).
- Environment hardening verification (origins, secrets, rotation policy).
- Regression validation baseline refreshed.

---

## Phase 2 (Weeks 4–7): Staff Throughput and UX Polish

**Objective:** remove workflow drag on high-frequency tasks.

**Scope**
- Fulfillment Command Center (MVP).
- Role-optimized quick actions in POS/Operations/Customers.
- Command palette MVP.
- Improved empty states and inline error remediation.
- Commission Trust Center (read-only explanation layer first).

**Deliverables**
- Measurable click/time reduction on top 10 tasks.
- Updated staff manuals for any changed workflow.
- E2E coverage expansion for new pathways.

---

## Phase 3 (Weeks 8–12): Inventory Overview and Prescriptive Actions

**Objective:** make ROS proactively guide managers.

**Scope**
- Wedding Health Heatmap.
- Inventory Brain v2 recommendations.
- Rule-based Manager Copilot nudges.
- Risk + recommendation cards in Operations dashboard.

**Deliverables**
- Action recommendation feed with acceptance tracking.
- Risk trend metrics by category (wedding, fulfillment, inventory, margin).
- Admin controls for threshold tuning and false-positive feedback.

---

## 6) Detailed feature briefs

## 6.1 Fulfillment Command Center (MVP)
**Problem:** fulfillment signals are split across tabs and statuses.  
**Core UX:** one queue with filters: `Rush`, `Due <72h`, `Ready`, `Blocked`, `Exception`.  
**Actions:** assign owner, mark progress, trigger message, open order/wedding context.  
**Success metric:** reduced overdue pickups and fewer “where is this order?” escalations.

## 6.2 Wedding Health Heatmap
**Problem:** risk detection is late and manual.  
**Scoring inputs (initial):**
- payment completeness,
- measurements completeness,
- key date proximity,
- unresolved task count.
**Output:** party/member heatmap + one-click remediation actions.  
**Success metric:** fewer late wedding issues and reduced last-week scramble volume.

## 6.3 Inventory Brain v2
**Problem:** replenishment and dead-stock actions are reactive.  
**Recommendations:**
- reorder suggestions with confidence level,
- markdown/bundle candidate suggestions,
- vendor lead-time-aware urgency.
**Success metric:** improved in-stock rate for top sellers and lower stagnant inventory.

## 6.4 Commission Trust Center
**Problem:** payout trust decreases when calculations are opaque.  
**Capabilities:**
- “why this amount” breakdown per line,
- override/specificity chain display,
- pre-finalization anomaly warnings.
**Success metric:** fewer payout disputes and faster finalize cycles.

## 6.5 Manager Copilot (Rules Engine)
**Problem:** managers need prioritized next actions, not raw data.  
**Approach:** deterministic rule engine first (auditable and safe).  
**Examples:**
- “Party X is 10 days out, measurements incomplete, 2 members unpaid.”
- “High-velocity SKU Y projected stockout in 6 days.”
- “Order Z marked ready, no outreach sent in 24h.”
**Success metric:** improved response times and higher completion before due dates.

---

## 7) Non-functional standards for this program

1. **Financial correctness first**  
   - No changes that weaken booked/fulfilled recognition rules.
2. **RBAC and auth parity**  
   - New surfaces honor existing permission model.
3. **No browser-native dialogs**  
   - Continue modal/toast architecture consistency.
4. **Performance budgets**  
   - New features must define expected query/UI budgets.
5. **Observability required**  
   - Every major feature includes structured telemetry and failure visibility.
6. **Docs + training in same cycle**  
   - Any user-visible workflow change updates `docs/staff/*` in same PR when practical.

---

## 8) Metrics and KPIs

## Adoption / UX
- Median task completion time (checkout-adjacent, order lookup, status update).
- Click count for top workflows.
- New staff ramp-to-competence time.

## Reliability / Performance
- API p95/p99 by critical endpoint group.
- Frontend error rate and failed action retries.
- Background job success/failure and lag.

## Business / Operations
- Overdue fulfillment count.
- Wedding risk backlog trend.
- Stockout incidence for top 100 SKUs.
- Commission dispute rate.
- Time-to-resolution for operational exceptions.

---

## 9) Risks and mitigations

1. **Scope sprawl**
   - Mitigation: strict phase gates and MVP definitions.
2. **Feature overlap with existing modules**
   - Mitigation: integration-first design, avoid duplicate surfaces.
3. **False-positive recommendation fatigue**
   - Mitigation: threshold tuning, feedback capture, staged rollout.
4. **Documentation drift**
   - Mitigation: release checklist includes staff manual sync review.
5. **Performance regression from richer dashboards**
   - Mitigation: lazy loading, pagination, query caps, SLO tracking.

---

## 10) Proposed execution model

- **Cadence:** weekly demo + KPI review.
- **Team split (recommended):**
  - Track A: Reliability + observability
  - Track B: Workflow polish
  - Track C: Inventory Overview layer
- **Release approach:** incremental behind feature flags where needed.
- **Validation:** enforce lint/typecheck/build + targeted E2E + regression matrix updates.

---

## 11) Backlog starter (ranked)

## Tier 1 — Must-do now
1. Launch Reliability Gate completion pack  
2. Fulfillment Command Center MVP  
3. Command Palette MVP  
4. Wedding Heatmap MVP (read-only scoring first)

## Tier 2 — High-value follow-up
5. Commission Trust Center explainability  
6. Inventory Brain recommendations  
7. Manager Copilot rules feed

## Tier 3 — Optimization
8. Advanced threshold personalization  
9. Predictive demand model enhancements  
10. Deep workflow automation and escalation policies

---

## 12) Decision requests

1. Approve this as the primary “next-level” execution plan for Q2.  
2. Confirm Phase 1 as mandatory gate before large net-new expansion.  
3. Assign product owner and engineering owner for each pillar.  
4. Decide whether Fulfillment Command Center or Wedding Heatmap ships first in Phase 2/3 boundary.

---

## 13) Staff-manual alignment prompt (required)

**Should we draft an update for the staff manual based on this new feature?**

For every shipped workflow in this plan, answer this in the implementation PR and update `docs/staff/*` as needed.