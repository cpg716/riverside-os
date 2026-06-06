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

### `docs/DEPLOYMENT_GUIDE_V0_2_1.md`

| Field | Content |
|-------|---------|
| **Former path** | `docs/DEPLOYMENT_GUIDE_V0_2_1.md` |
| **Date retired** | 2026-05-19 |
| **Why removed** | Obsolete. Superseded by newer store deployment instructions. |
| **Where content lives now** | [`docs/STORE_DEPLOYMENT_GUIDE.md`](STORE_DEPLOYMENT_GUIDE.md), [`docs/WINDOWS_INSTALLER_PACKAGE.md`](WINDOWS_INSTALLER_PACKAGE.md) |
| **Summary** | Described the local register and server installation steps specifically for ROS version `v0.2.1`. Since deployment mechanisms, registry names, and pathing have been modernized, the general guide (`STORE_DEPLOYMENT_GUIDE.md`) is now the canonical source. |

### Bugsquash Reports (`docs/BUGSQUASH_REPORT_V0.1.8.md` and `docs/BUGSQUASH_REPORT_V0.1.9.md`)

| Field | Content |
|-------|---------|
| **Former path** | `docs/BUGSQUASH_REPORT_V0.1.8.md`, `docs/BUGSQUASH_REPORT_V0.1.9.md` |
| **Date retired** | 2026-05-19 |
| **Why removed** | Obsolete historical bug reports. |
| **Where content lives now** | n/a (tracked in git history and issue backlog if needed) |
| **Summary** | Documented specific bugs triaged and resolved during the `v0.1.8` and `v0.1.9` bug-squashing sprints. |

### Retired financing integration phase documents

| Field | Content |
|-------|---------|
| **Former path** | Legacy third-party financing phase docs |
| **Date retired** | 2026-05-19 |
| **Why removed** | Superseded by the current RMS Charge/R2S operational workflow. |
| **Where content lives now** | [`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`](POS_PARKED_SALES_AND_RMS_CHARGES.md) |
| **Summary** | Outlined an older third-party financing integration plan. Current Riverside behavior records RMS Charge activity internally and creates R2S follow-up instead. |

### Legacy AI Endpoints (`docs/API_AI.md`)

| Field | Content |
|-------|---------|
| **Former path** | `docs/API_AI.md` |
| **Date retired** | 2026-05-19 |
| **Why removed** | Legacy AI endpoints/database schemas retired by migration 78. |
| **Where content lives now** | [`ROS_AI_INTEGRATION_PLAN.md`](../ROS_AI_INTEGRATION_PLAN.md), [`docs/PLAN_LOCAL_LLM_HELP.md`](PLAN_LOCAL_LLM_HELP.md) |
| **Summary** | Documented the `/api/ai/*` routing structure, pgvector `ai_doc_chunk` table schema, and custom chat endpoints used by the legacy helper AI engine. In-product AI help is now driven by the browser-compiled local Help Center search and the ROSIE local intelligence assistant specification. |

### Legacy Strategic Roadmap (`docs/PLAN_POST_V0.1.2_EVOLUTION.md`)

| Field | Content |
|-------|---------|
| **Former path** | `docs/PLAN_POST_V0.1.2_EVOLUTION.md` |
| **Date retired** | 2026-05-19 |
| **Why removed** | Highly outdated roadmap from after `v0.1.2`. |
| **Where content lives now** | n/a |
| **Summary** | Early post-v0.1.2 roadmap detailing custom measurement options, layaway adjustments, and alteration forecast tools. All of these features are fully implemented or tracked in modern release checklists. |

### Zero-Touch Help Center Proposal (`docs/PLAN_ZERO_TOUCH_HELP_CENTER.md`)

| Field | Content |
|-------|---------|
| **Former path** | `docs/PLAN_ZERO_TOUCH_HELP_CENTER.md` |
| **Date retired** | 2026-05-19 |
| **Why removed** | Superseded proposal. |
| **Where content lives now** | [`docs/HELP_CENTER_AUTOMATION.md`](HELP_CENTER_AUTOMATION.md) |
| **Summary** | A design proposal outlining an automated pipeline for generating help documents, using Starlight, Stagehand, and Starlight-pagefind. The actual implementation relies on a custom Playwright specs generation and manual search indexing script. |

### Porting New Features Plan (`docs/PORTING_NEW_FEATURES_PLAN.md`)

| Field | Content |
|-------|---------|
| **Former path** | `docs/PORTING_NEW_FEATURES_PLAN.md` |
| **Date retired** | 2026-05-19 |
| **Why removed** | Completed temporary implementation plan. |
| **Where content lives now** | `client/src/components/...` |
| **Summary** | A task list and coordination plan from April 2026 detailing the port of modern component features (like the Command Palette, fulfillment command center, and wedding health heatmap) into the unified UI style. |

### Placeholder Layout Docs (`docs/developer-guide.md`, `overview.md`, `technical.md`, `user-guide.md`)

| Field | Content |
|-------|---------|
| **Former path** | `docs/developer-guide.md`, `docs/overview.md`, `docs/technical.md`, `docs/user-guide.md` |
| **Date retired** | 2026-05-19 |
| **Why removed** | Obsolete auto-generated placeholders from initial scaffolding. |
| **Where content lives now** | [`README.md`](../README.md), [`DEVELOPER.md`](../DEVELOPER.md), [`docs/CLIENT_UI_CONVENTIONS.md`](CLIENT_UI_CONVENTIONS.md) |
| **Summary** | Generic placeholders generated during scaffolding that contained invalid paths (`MainShell.js` instead of typescript/client workspace), placeholder Git clone URLs, and default CLI commands. Modern developer guidance is kept in `README.md` and `DEVELOPER.md`. |

### Outdated PR Descriptions (`docs/releases/v0.3.0/3.1/4.0/4.5-pr-description.md`)

| Field | Content |
|-------|---------|
| **Former path** | `docs/releases/v0.3.0-pr-description.md`, `docs/releases/v0.3.1-pr-description.md`, `docs/releases/v0.4.0-pr-description.md`, `docs/releases/v0.4.5-pr-description.md` |
| **Date retired** | 2026-05-19 |
| **Why removed** | Outdated pull request description text. |
| **Where content lives now** | GitHub Pull Requests (preserved online) |
| **Summary** | Local logs of standard PR text. |

### Deprecated Binary PDFs (`docs/releases/v0.60.0/0.60.1-printable-deployment-guide.pdf`)

| Field | Content |
|-------|---------|
| **Former path** | `docs/releases/v0.60.0-printable-deployment-guide.pdf`, `docs/releases/v0.60.1-printable-deployment-guide.pdf` |
| **Date retired** | 2026-05-19 |
| **Why removed** | Old compiled binary PDFs. MD version is kept for text searchability. |
| **Where content lives now** | `docs/releases/v0.70.0-printable-deployment-guide.md` (or equivalent markdown versions) |
| **Summary** | Binary PDF outputs compiled for historical releases. Deleting them keeps the git repository clean of large unsearchable binary blobs, as the markdown text equivalent is fully preserved. |

### Obsolete Windows 11 Smoke Checklist (`docs/WINDOWS11_TAURI_SMOKE_CHECKLIST_V021.md`)

| Field | Content |
|-------|---------|
| **Former path** | `docs/WINDOWS11_TAURI_SMOKE_CHECKLIST_V021.md` |
| **Date retired** | 2026-05-19 |
| **Why removed** | Obsolete smoke checklist specific to `v0.2.1` auth/identity features. |
| **Where content lives now** | [`docs/releases/v0.70.0-release-notes.md`](releases/v0.70.0-release-notes.md) (release checks are managed in the release QA documents now) |
| **Summary** | Outlined the manual QA testing checklist to verify identity and auth features introduced in version `v0.2.1`. Release-specific testing checklists are now managed under general QA checklists or release-specific certification artifacts. |

### Deprecated Release Deployment Guides (`docs/releases/v0.60.0-printable-deployment-guide.md` and `docs/releases/v0.60.1-printable-deployment-guide.md`)

| Field | Content |
|-------|---------|
| **Former path** | `docs/releases/v0.60.0-printable-deployment-guide.md`, `docs/releases/v0.60.1-printable-deployment-guide.md` |
| **Date retired** | 2026-05-19 |
| **Why removed** | Outdated version-specific deployment guides. |
| **Where content lives now** | [`docs/releases/v0.70.0-printable-deployment-guide.md`](releases/v0.70.0-printable-deployment-guide.md) |
| **Summary** | Printable markdown deployment guides for earlier `v0.60` release series updates. Superseded by the `v0.70.0` guide. |
