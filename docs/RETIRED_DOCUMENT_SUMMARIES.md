# Retired document summaries

When a Markdown file is **removed** from this repository, add an entry here **before** deleting it. This ledger preserves enough context to recover intent without relying on git history alone.

## Entry template

| Field | Content |
|-------|---------|
| **Former path** | |
| **Date retired** | YYYY-MM-DD |
| **Why removed** | Duplicate / superseded / incorrect / merged into … |
| **Where content lives now** | Path(s) or “n/a” |
| **Summary** | 2–5 sentences: what the file covered and any decisions worth remembering. |

---

## Entries

### Native Insights React workspace (`client/src/components/insights/`)

| Field | Content |
|-------|---------|
| **Former path** | `client/src/components/insights/InsightsWorkspace.tsx`, `HistoricalReporting.tsx` (entire directory removed) |
| **Date retired** | 2026-04-06 |
| **Why removed** | Superseded by **Metabase** in same-origin **Insights** (`InsightsShell` + `/metabase/` proxy). Commission finalize UI moved to **Staff → Commission payouts** (`CommissionPayoutsPanel`). |
| **Where content lives now** | [`docs/PLAN_METABASE_INSIGHTS_EMBED.md`](PLAN_METABASE_INSIGHTS_EMBED.md), [`docs/METABASE_REPORTING.md`](METABASE_REPORTING.md), [`DEVELOPER.md`](../DEVELOPER.md) §3c, [`client/src/components/layout/InsightsShell.tsx`](../client/src/components/layout/InsightsShell.tsx), [`client/src/components/staff/CommissionPayoutsPanel.tsx`](../client/src/components/staff/CommissionPayoutsPanel.tsx), in-app [`client/src/assets/docs/insights-manual.md`](../client/src/assets/docs/insights-manual.md) |
| **Summary** | Legacy Back Office **Insights** tab rendered native React pivot/reporting. Replaced with a full **Metabase** embed for exploratory analytics while **`/api/insights/*`** remains for operational flows (e.g. commission ledger APIs). |

### `Final_AI_integration_plan.md` (repository root)

| Field | Content |
|-------|---------|
| **Former path** | `Final_AI_integration_plan.md` |
| **Date retired** | 2026-04-04 |
| **Why removed** | Duplicate of the canonical AI implementation roadmap; same scope and audience as `ROS_AI_INTEGRATION_PLAN.md`. |
| **Where content lives now** | [`ROS_AI_INTEGRATION_PLAN.md`](../ROS_AI_INTEGRATION_PLAN.md) (merged; this file is the single implementation plan). Product intent remains in [`docs/AI_INTEGRATION_OUTLOOK.md`](AI_INTEGRATION_OUTLOOK.md). |
| **Summary** | Cursor-frontmatter roadmap for phased AI: separate **ros-gemma** worker (Gemma 2B Q4_K_M, llama-cpp-2), Axum `/api/ai/*` only, `AiCompletion` adapter, Phase 0 (permissions, env kill switch, health), pillars for doc-grounded help, assistive search, variant draft JSON, whitelisted saved reports, duplicate candidates and merge queue. Stressed Rust-only inference, no silent financial writes, and alignment with `docs/CUSTOMERS_LIGHTSPEED_REFERENCE.md` for merges. |

### POS Mid-Shift Snapshot (X-Report)

| Field | Content |
|-------|---------|
| **Former path** | `client/src/components/pos/XReportModal.tsx`, `XReportPrint.ts` |
| **Date retired** | 2026-04-13 |
| **Why removed** | Deprecated in favor of real-time Register Dashboards and a single, unified Professional Z-Report. Mid-shift balancing is no longer a supported physical workflow. |
| **Where content lives now** | [`docs/TILL_GROUP_AND_REGISTER_OPEN.md`](TILL_GROUP_AND_REGISTER_OPEN.md), [`docs/REGISTER_DASHBOARD.md`](REGISTER_DASHBOARD.md), [`client/src/components/pos/zReportPrint.ts`](../client/src/components/pos/zReportPrint.ts) |
| **Summary** | Legacy "X-Report" (mid-shift snapshot) was removed to ensure financial data is only reconciled at the close of the drawer shift. Real-time stats are now available on the Register Dashboard without requiring a physical printout. |

### `PLAN_ACTION_BOARD_PREDICTIVE.md` (docs/)

| Field | Content |
|-------|---------|
| **Former path** | `docs/PLAN_ACTION_BOARD_PREDICTIVE.md` |
| **Date retired** | 2026-04-17 |
| **Why removed** | Renamed to align with **Registry Dashboard** nomenclature in v0.2.0. |
| **Where content lives now** | [`docs/PLAN_REGISTRY_DASHBOARD_PREDICTIVE.md`](PLAN_REGISTRY_DASHBOARD_PREDICTIVE.md) |
| **Summary** | Strategic plan for the prioritized staff queue (Suggest next). Renamed to Registry Dashboard for consistency with daily retail terminology. |
