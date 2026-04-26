# Riverside OS Documentation

Status: **Canonical documentation index** for first-party Riverside OS Markdown. Use this file when you are not sure which domain guide, integration guide, staff manual, or historical reference to open first.

For repo setup and quick start, use [../README.md](../README.md). For engineering architecture, API maps, and migration references, use [../DEVELOPER.md](../DEVELOPER.md). For agent-specific invariants, use [../AGENTS.md](../AGENTS.md).

## Start Here

| Area | Start |
|---|---|
| Transactions, fulfillment, pickup, returns, deposits, layaway | [TRANSACTIONS.md](TRANSACTIONS.md) |
| Reporting, recognition basis, Reports, Insights, Metabase, commissions | [REPORTING.md](REPORTING.md) |
| Counterpoint bridge, one-time import, staging, sync operations | [COUNTERPOINT.md](COUNTERPOINT.md) |
| RMS Charge, CoreCard, R2S payment collection | [RMS_CHARGE.md](RMS_CHARGE.md) |
| Podium, reviews, storefront widget, notification center | [CUSTOMER_MESSAGING_AND_NOTIFICATIONS.md](CUSTOMER_MESSAGING_AND_NOTIFICATIONS.md) |
| AI, ROSIE, assistant routing, retired ROS-AI history | [AI.md](AI.md) |
| Shipping, Shippo, Shipments Hub | [SHIPPING_AND_SHIPMENTS_HUB.md](SHIPPING_AND_SHIPMENTS_HUB.md) |
| Search, pagination, Meilisearch | [SEARCH_AND_PAGINATION.md](SEARCH_AND_PAGINATION.md) |
| Staff permissions and RBAC | [STAFF_PERMISSIONS.md](STAFF_PERMISSIONS.md) |
| Customer Hub and RBAC | [CUSTOMER_HUB_AND_RBAC.md](CUSTOMER_HUB_AND_RBAC.md) |
| UI conventions | [CLIENT_UI_CONVENTIONS.md](CLIENT_UI_CONVENTIONS.md) |
| ROS Dev Center | [ROS_DEV_CENTER.md](ROS_DEV_CENTER.md) |
| In-app Help authoring | [MANUAL_CREATION.md](MANUAL_CREATION.md) |
| Staff manuals | [staff/README.md](staff/README.md) |

## Documentation Authority

All Riverside docs may be generated or agent-assisted. **Authority is based on the document's role, not authorship.**

| Lane | Location | Authority |
|---|---|---|
| Canonical domain / integration / operations docs | `docs/*.md`, root runbooks | Source of truth for project behavior, architecture, and maintenance rules. |
| Staff procedure docs | [staff/](staff/) | Source of truth for staff-facing workflows and training language. |
| In-app Help artifacts | `client/src/assets/docs/*-manual.md` | Source of truth for what the app serves in the Help Center. These should mirror canonical docs and staff procedures, but they do not override them when there is a conflict. |
| Component stubs and draft Help manuals | `client/src/assets/docs/*-manual.md` with `status: draft` or `auto-scaffold` | Lower-authority Help scaffolds. Promote or rewrite before treating them as policy/training references. |
| Historical / planning / review docs | `docs/PLAN_*.md`, [reviews/README.md](reviews/README.md), retired references | Context and evidence. Check status banners before using as current truth. |

## Operational Guides

| Area | Start |
|---|---|
| Backup and restore | [../BACKUP_RESTORE_GUIDE.md](../BACKUP_RESTORE_GUIDE.md) |
| Local update protocol | [LOCAL_UPDATE_PROTOCOL.md](LOCAL_UPDATE_PROTOCOL.md) |
| Store deployment | [STORE_DEPLOYMENT_GUIDE.md](STORE_DEPLOYMENT_GUIDE.md) |
| Observability and tracing | [OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md](OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md) |
| CI/CD and code hygiene | [CI_CD_AND_CODE_HYGIENE_STANDARDS.md](CI_CD_AND_CODE_HYGIENE_STANDARDS.md) |
| Maintenance and lifecycle | [MAINTENANCE_AND_LIFECYCLE_GUIDE.md](MAINTENANCE_AND_LIFECYCLE_GUIDE.md) |

## Historical And Planning Docs

Planning docs may describe shipped work, deferred work, or historical implementation decisions. Prefer the canonical front doors above first; use planning docs for context after checking their status banner.

| Area | Examples |
|---|---|
| Shipped / active plans | [PLAN_LOCAL_LLM_HELP.md](PLAN_LOCAL_LLM_HELP.md), [PLAN_NOTIFICATION_CENTER.md](PLAN_NOTIFICATION_CENTER.md) |
| Deferred roadmap notes | [PLAN_SHIPPO_SHIPPING.md](PLAN_SHIPPO_SHIPPING.md), [PLAN_PODIUM_REVIEWS.md](PLAN_PODIUM_REVIEWS.md) |
| Retired implementation references | [API_AI.md](API_AI.md), [ROS_AI_HELP_CORPUS.md](ROS_AI_HELP_CORPUS.md), [ROS_GEMMA_WORKER.md](ROS_GEMMA_WORKER.md) |
| Audit and review evidence | [DOCUMENTATION_AUDIT_2026.md](DOCUMENTATION_AUDIT_2026.md), [reviews/README.md](reviews/README.md) |

## Maintenance Notes

- When adding a new domain or integration guide, add it here and to the catalog in [../README.md](../README.md) when it should be visible from the repo root.
- When changing a staff-facing workflow, update the relevant [staff manual](staff/README.md) in the same change when practical.
- When adding a public reporting/read route, update [AI_REPORTING_DATA_CATALOG.md](AI_REPORTING_DATA_CATALOG.md).
- When changing Help Center manuals, run `npm run generate:help` and rebuild the optional Meilisearch `ros_help` index if configured.
- When changing staff Markdown, run `python3 scripts/verify_ai_knowledge_drift.py` from the repo root.
- Before merging broad documentation changes, run `npm run docs:check` from the repo root. It checks relative Markdown links, known stale renamed paths, and staff corpus drift.
