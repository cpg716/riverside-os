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
