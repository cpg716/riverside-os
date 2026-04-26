# Reporting Documentation Index

**Status:** Canonical reporting front door. Start here when changing reporting, Insights, Metabase, commission reporting, or booked-vs-fulfilled behavior.

Riverside OS reporting has two surfaces and one shared timing rule:

- **Back Office -> Reports** uses curated `/api/insights/*` routes for operational reporting.
- **Back Office -> Insights** embeds Metabase and should use curated `reporting.*` views for exploration.
- **Booked vs fulfilled** is the core timing distinction. Booked activity shows what was rung; fulfilled activity drives recognized revenue, tax audit, and realized commission.

## Where To Go

| Need | Canonical doc | Notes |
| --- | --- | --- |
| Reporting basis and revenue timing | [`REPORTING_BOOKED_AND_FULFILLED.md`](REPORTING_BOOKED_AND_FULFILLED.md) | Technical source for API basis parameters, reporting views, and fulfillment recognition clock. |
| Financial explanation of booked vs fulfilled | [`BOOKED_VS_FULFILLED.md`](BOOKED_VS_FULFILLED.md) | Conceptual explainer for operators and reviewers. Keep technical implementation details in `REPORTING_BOOKED_AND_FULFILLED.md`. |
| Curated Reports / NL reporting route catalog | [`AI_REPORTING_DATA_CATALOG.md`](AI_REPORTING_DATA_CATALOG.md) | Route-level permissions, parameters, and safe reporting executor allowlist. Update this when adding read-shaped reporting APIs. |
| Metabase architecture and access model | [`METABASE_REPORTING.md`](METABASE_REPORTING.md) | Reporting schema, Metabase role model, readable field contract, and OSS access posture. |
| Metabase admin setup | [`METABASE_ADMIN_SETUP_STEPS.md`](METABASE_ADMIN_SETUP_STEPS.md) | Literal click-path for syncing, modeling, hiding fields, and validating staff/admin views. |
| Metabase field modeling | [`METABASE_FIELD_MODELING_CHECKLIST.md`](METABASE_FIELD_MODELING_CHECKLIST.md) | Checklist for labels, hidden UUIDs, semantic types, and dashboard-ready fields. |
| Starter dashboards | [`METABASE_DASHBOARD_STARTER_PLAN.md`](METABASE_DASHBOARD_STARTER_PLAN.md) | Recommended first dashboard set. |
| Daily register reports | [`DAILY_SALES_REPORTS.md`](DAILY_SALES_REPORTS.md) | Back Office Operations / POS register report behavior. |
| Commission reporting | [`COMMISSION_AND_SPIFF_OPERATIONS.md`](COMMISSION_AND_SPIFF_OPERATIONS.md) | Operator-facing commission, SPIFF, incentive, return, and adjustment behavior. |
| Commission event ledger design | [`COMMISSION_REPORTING_LEDGER_PLAN.md`](COMMISSION_REPORTING_LEDGER_PLAN.md) | Historical/design trace for immutable commission events. |
| Metabase shell implementation plan | [`PLAN_METABASE_INSIGHTS_EMBED.md`](PLAN_METABASE_INSIGHTS_EMBED.md) | Shipped architecture runbook and future incremental work. |

## Maintenance Rules

- New reporting read APIs must update [`AI_REPORTING_DATA_CATALOG.md`](AI_REPORTING_DATA_CATALOG.md).
- Changes to booked / fulfilled semantics must update [`REPORTING_BOOKED_AND_FULFILLED.md`](REPORTING_BOOKED_AND_FULFILLED.md) and verify Metabase view implications.
- Metabase view changes should update [`METABASE_REPORTING.md`](METABASE_REPORTING.md) and the admin/modeling checklists when staff-facing fields change.
- Commission timing changes must preserve fulfillment recognition and update [`COMMISSION_AND_SPIFF_OPERATIONS.md`](COMMISSION_AND_SPIFF_OPERATIONS.md).
