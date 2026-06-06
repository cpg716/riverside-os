# ROSIE LLM Experience Audit

**Date:** 2026-06-06  
**Scope:** Repository-local audit of where LLM/ROSIE AI could improve Riverside OS across POS, Back Office, Wedding Manager, Operations, Inventory, QBO, RMS Charge, Counterpoint, Help Center, deployment, and related workflows.  
**Mode:** Strategy and audit only. No production code changes are proposed as completed work in this report.

## 1. Executive Summary

ROSIE already exists as a governed Riverside OS intelligence layer, but today it is still concentrated in a few surfaces: Help Center Q&A, contextual insight summaries, global search shortcut intent, catalog cleanup suggestions, voice/runtime settings, token telemetry, and deployment/runtime health. The most important current strength is the safety posture: approved source groups, no raw SQL, explicit RBAC boundaries, deterministic fact payloads for insight summaries, and visible unavailable states when the model cannot answer.

The biggest product opportunity is to move ROSIE from "assistant available in Help" to "embedded operating layer where work happens." Riverside OS already has rich deterministic read models for customers, weddings, fulfillment, register close, QBO staging, RMS Charge, Counterpoint sync, operations, notifications, inventory, and receiving. ROSIE should use those facts to summarize, explain, draft, and pre-fill reviewed work without becoming the system of record.

The biggest risks are over-trusting generated text in financial/inventory workflows, exposing customer-sensitive context to cloud models, model-produced matches that feel authoritative without evidence, and alert fatigue from ambient cards that repeat obvious facts. These are manageable if AI output is structured, source-linked, permission-aware, cached with visible freshness, and never allowed to autonomously mutate high-risk records.

Important status correction: many of the ideas below are **not greenfield**. Riverside OS already has working foundations for customer/RMS context, Operations summaries, QBO review, Counterpoint status, product cleanup, Help Center ROSIE, and register/close data. The recommended investments are about making those capabilities more complete, consistent, source-linked, ambient, and review-ready across the actual workflow surfaces.

Top 5 recommended AI experience investments:

1. **Customer Things To Know card**: Extend the existing Customer Profile hub and ROSIE insight/RMS sections into one source-linked briefing.
2. **Register Close Explainer**: Add ROSIE plain-English explanation on top of the existing close/reconciliation data.
3. **Wedding Readiness Brief**: Productize existing wedding readiness signals into an ambient, source-linked briefing.
4. **PO/Invoice Import Matching Assistant**: Build the still-missing review-only extraction and line-match workflow for vendor paperwork.
5. **QBO/RMS/Counterpoint Exception Explainers**: Extend existing review workspaces with consistent evidence-linked summaries for staged, unmatched, failed, or stale rows.

Current AI rules are **mostly correct but too binary**. "No autonomous mutations" is the right default for high-risk workflows, but it is too restrictive for low-risk draft-only, pre-fill-with-review, and approval-queue experiences. ROSIE needs a formal action taxonomy so staff understand what it may summarize, draft, pre-fill, queue, and never execute.

## 2. Existing AI/ROSIE Landscape

### Files Inspected

Core governance, architecture, and planning:

- `AGENTS.md`
- `.cursorrules`
- `docs/ROSIE_OPERATING_CONTRACT.md`
- `docs/ROSIE_HOST_STACK.md`
- `docs/ROSIE_IMPROVEMENT_PLAN.md`
- `docs/AI_CONTEXT_FOR_ASSISTANTS.md`
- `docs/AI_REPORTING_DATA_CATALOG.md`
- `docs/AI_INTEGRATION_OUTLOOK.md`
- `docs/PLAN_LOCAL_LLM_HELP.md`
- `docs/PLAN_PO_INVOICE_AI_IMPORT.md`
- `docs/ROS_AI_HELP_CORPUS.md`
- `docs/reviews/ROSIE_AI_AUDIT_2026_05.md`
- `docs/reviews/ONLINE_STORE_ROSIE_AI_AUDIT_2026.md`
- `docs/api-audit/rosie-ai.md`

Backend ROSIE and AI logic:

- `server/src/api/help.rs`
- `server/src/api/ai.rs`
- `server/src/logic/rosie_intelligence.rs`
- `server/src/logic/rosie_insight_summary.rs`
- `server/src/logic/rosie_search_intent.rs`
- `server/src/logic/rosie_provider.rs`
- `server/src/logic/rosie_provider_selection.rs`
- `server/src/logic/rosie_gemini.rs`
- `server/src/logic/rosie_speech.rs`
- `server/src/logic/help_corpus.rs`
- `server/src/logic/help_manual_policy.rs`
- `server/src/logic/inventory_brain.rs`
- `server/src/logic/meilisearch_documents.rs`
- `migrations/060_rosie_token_telemetry.sql`
- `migrations/legacy_prelaunch_history/62_ai_platform.sql`
- `migrations/legacy_prelaunch_history/65_ai_doc_trgm.sql`
- `migrations/legacy_prelaunch_history/78_retire_ros_ai_tables.sql`
- `migrations/legacy_prelaunch_history/157_product_catalog_rosie_audit.sql`

Frontend ROSIE surfaces:

- `client/src/lib/rosie.ts`
- `client/src/components/help/HelpCenterDrawer.tsx`
- `client/src/components/help/RosieInsightSummary.tsx`
- `client/src/components/layout/GlobalTopBar.tsx`
- `client/src/components/layout/GlobalCommandSearch.tsx`
- `client/src/components/settings/RosieSettingsPanel.tsx`
- `client/src/components/settings/HelpCenterSettingsPanel.tsx`
- `client/src/components/inventory/ProductHubDrawer.tsx`
- `client/src/components/inventory/InventoryControlBoard.tsx`
- `client/src/components/inventory/ReceivingBay.tsx`
- `client/src/components/orders/TransactionDetailDrawer.tsx`
- `client/src/components/customers/CustomerRelationshipHubDrawer.tsx`
- `client/src/components/operations/OperationalHome.tsx`
- `client/src/components/settings/CounterpointSyncSettingsPanel.tsx`

Major product/workflow surfaces sampled:

- `client/src/components/pos/RegisterDashboard.tsx`
- `client/src/components/pos/NexoCheckoutDrawer.tsx`
- `client/src/components/pos/CloseRegisterModal.tsx`
- `client/src/components/pos/RegisterRmsPaymentModal.tsx`
- `client/src/components/operations/RosOperationsCenter.tsx`
- `client/src/components/operations/FulfillmentCommandCenter.tsx`
- `client/src/components/operations/NotificationQueueOperationsSection.tsx`
- `client/src/components/customers/RmsChargeAdminSection.tsx`
- `client/src/components/qbo/QboWorkspace.tsx`
- `client/src/components/inventory/UniversalImporter.tsx`
- `client/src/components/inventory/PhysicalInventoryWorkspace.tsx`
- `client/src/components/inventory/PurchaseOrderPanel.tsx`
- `client/src/components/wedding-manager/components/PartyDetail.jsx`
- `client/src/components/wedding-manager/components/WeddingReadinessPanel.tsx`
- `server/src/api/customers.rs`
- `server/src/api/qbo.rs`
- `server/src/api/counterpoint_sync.rs`
- `server/src/api/counterpoint_workbench.rs`
- `server/src/api/purchase_orders.rs`
- `server/src/api/inventory.rs`
- `server/src/api/physical_inventory.rs`
- `server/src/api/transactions.rs`
- `server/src/api/weddings.rs`
- `server/src/api/alterations.rs`
- `server/src/api/customer_notifications.rs`
- `server/src/api/daily_reports.rs`
- `server/src/api/settings.rs`
- `server/src/api/reviews.rs`
- `server/src/api/mailbox.rs`
- `server/src/api/vendors.rs`

Deployment/runtime:

- `deployment/windows/Install-RosieAiStack.ps1`
- `deployment/windows/start-riverside-llama.ps1`
- `deployment/windows/Start-RiversideLlama.cmd`
- `deployment/windows/install-server.ps1`
- `deployment/server-manager-app/src/App.tsx`
- `ros-dev/src/lib/api.ts`
- `scripts/verify_rosie_local_stack.sh`
- `scripts/rosie-e2e-workflows.mjs`
- `scripts/verify_ai_knowledge_drift.py`
- `scripts/ros-ai-reindex-local.sh`

Tests and help docs:

- `client/e2e/help-center.spec.ts`
- `client/e2e/operations-center-ui.spec.ts`
- `client/e2e/inventory-import-confidence.spec.ts`
- `client/e2e/qbo-staging.spec.ts`
- `client/e2e/rms-reconciliation.spec.ts`
- `client/e2e/customers-rms-charge.spec.ts`
- `client/e2e/pos-rms-charge.spec.ts`
- `client/e2e/register-close-reconciliation.spec.ts`
- `client/e2e/counterpoint-signoff-ui.spec.ts`
- `client/src/assets/docs/help-center-drawer-manual.md`
- `client/src/assets/docs/settings-rosie-settings-panel-manual.md`
- `client/src/assets/docs/operations-operational-home-manual.md`
- `client/src/assets/docs/customers-customer-relationship-hub-drawer-manual.md`
- `client/src/assets/docs/customers-rms-charge-admin-section-manual.md`
- `client/src/assets/docs/qbo-workspace-manual.md`
- `client/src/assets/docs/inventory-receiving-bay-manual.md`
- `client/src/assets/docs/inventory-physical-inventory-workspace-manual.md`
- `docs/staff/CORPUS.manifest.json`
- `docs/staff/customers-back-office.md`
- `docs/staff/rms-charge-overview.md`
- `docs/staff/rms-charge-accounts.md`
- `docs/staff/rms-charge-transactions.md`
- `docs/staff/rms-charge-reconciliation.md`
- `docs/staff/qbo-bridge.md`
- `docs/staff/inventory-back-office.md`
- `docs/staff/operations-home.md`
- `docs/staff/payments-operations.md`
- `docs/staff/weddings-back-office.md`
- `docs/staff/appointments.md`
- `docs/staff/fulfillment-manual.md`

### Current ROSIE Features

- **Runtime Help Center assistant**: `HelpCenterDrawer.tsx` calls grounded ROSIE helpers from `client/src/lib/rosie.ts`; server context comes through `/api/help/rosie/v1/tool-context`.
- **Governed source registry**: `rosie_intelligence.rs` restricts source groups to Help manuals, staff docs, policy contracts, generated help outputs, and optional curated redacted traces. It explicitly excludes raw production data and arbitrary SQL as learning sources.
- **Insight summaries**: `RosieInsightSummary.tsx` wraps `/api/help/rosie/v1/insight-summary`. The backend validates structured facts, caps facts and output size, and tells the model to summarize only provided facts.
- **Search shortcut intent**: `GlobalCommandSearch.tsx` calls `requestRosieSearchIntent`; `rosie_search_intent.rs` limits results to an allowlist of shortcuts and validates every returned ID.
- **Product/catalog cleanup**: `ProductHubDrawer.tsx` and the product catalog ROSIE routes support analysis and suggestion flows for catalog normalization, with review-oriented UI.
- **Provider stack**: Local Gemma via `llama-server` is the production default; Gemini is an optional provider with `ROSIE_FORCE_LOCAL_FOR_SENSITIVE` defaulting true.
- **Voice/runtime support**: `rosie_speech.rs`, `client/src/lib/rosie.ts`, and `RosieSettingsPanel.tsx` support STT/TTS status, explicit voice capture, and speech playback.
- **Token telemetry**: `rosie_token_telemetry` records model/provider/input/output token metrics for settings dashboards and cost comparisons.
- **Visual generation path**: `server/src/api/ai.rs` handles authenticated Fal.ai visual generation jobs; this is separate from governed ROSIE operational help.
- **Help maintainer separation**: `ROSIE_OPERATING_CONTRACT.md` separates user-facing ROSIE from Help Center maintenance automation.

### Implemented vs Enhancement Status

| Experience area | Current status in repo | What the audit is recommending |
|---|---|---|
| Help Center ROSIE | Implemented: grounded Help Center assistant, tool context, voice controls, settings, intelligence status. | Keep improving contextual screen awareness, citations, and evaluation coverage. |
| Customer Profile context | Partially implemented: Customer Profile hub has timeline, measurements, weddings, alterations, messaging, open work, RMS status, and ROSIE insight summary usage. | Consolidate into a single "Things to know" briefing with source links, freshness, and permission-aware facts. |
| RMS Charge workspace/customer RMS section | Implemented/partially implemented: RMS workspace has imports, reporting status, unmatched matching, transaction review; Customer Profile has RMS status. | Add consistent ROSIE explanation for stale imports, unmatched accounts, payment/charge reporting, and reconciliation gaps. |
| Operations Home daily context | Partially implemented: Operations Home already composes appointments, weddings, tasks, notifications, register sessions, fulfillment, QBO, and ROSIE insight summary. | Make daily and end-of-day briefs more explicit, cached, source-linked, and dismissible. |
| Register close | Implemented data/workflow; AI explainer not fully productized. | Add read-only ROSIE explanation of variance/blockers without affecting close eligibility. |
| Wedding readiness | Implemented/partially implemented: readiness panels, health signals, appointment/order/receiving context exist. | Add a ROSIE readiness narrative that groups top risks and links member/source records. |
| QBO workspace | Implemented: QBO staging and lifecycle actions exist. | Add row/workspace explainers that summarize why rows need review without suggesting invented mappings. |
| Counterpoint sync/workbench | Implemented/partially implemented: settings, status, workbench, SKU gaps, merge preview, ROSIE product analysis path exist. | Add clearer difference/exception explanation and reviewed mapping assistance. |
| Product cleanup | Implemented/partially implemented: Product Hub and Inventory Control Board already use ROSIE catalog analysis/suggestion paths. | Expand into a consistent review queue with audit of accepted/rejected suggestions. |
| PO/invoice AI import | Mostly planned, not fully implemented as a live workflow. | Build document extraction and match pre-fill with strict review before PO/receiving/QBO effects. |
| Customer messaging drafts | Messaging surfaces are implemented; AI draft workflow is not consistently productized. | Add draft-only ROSIE messages in compose surfaces with opt-in and staff approval. |
| Deployment/ROSIE Host diagnostics | Implemented/partially implemented: host stack docs, scripts, server manager/Dev Center surfaces exist. | Add safer explanation layer over diagnostics and repair guidance, with destructive actions remaining manual. |

### Current Gaps

- ROSIE is not yet a first-class review queue creator; it can suggest and summarize, but there is no general AI action registry with approval states.
- There is no shared citation model for business records across all AI surfaces. Some features cite source fact IDs, but there is no universal record-link contract.
- Ambient summaries exist in Operations and a few drawers, but they are not systematically available across customer, wedding, register close, QBO, RMS, Counterpoint, receiving, and physical inventory workflows.
- Cloud provider selection exists, but the privacy classification of each prompt/context bundle is not yet explicit enough for future richer customer, payment, and document workflows.
- Evaluation is feature-specific. There is no central AI regression harness with fixtures for hallucination, stale data, unsafe recommendations, source citation compliance, and prompt injection from uploaded documents.

## 3. AI Experience Opportunity Map

| Area | Current user pain or friction | LLM opportunity | Trigger type | AI role | User benefit | Data needed | Existing surfaces/endpoints likely involved | Required AI action level | Permission/review requirement | Risk | Complexity | Priority |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| POS/register | Cashier sees cart, customer, fulfillment, payment, and exception state separately | Compact checkout readiness explanation | Workflow-embedded | Explain, coach | Faster checkout decisions without touching totals | Cart facts, customer flags, balance due, fulfillment type, tender state | `RegisterDashboard.tsx`, `NexoCheckoutDrawer.tsx`, transaction APIs | Read-only | POS session or Staff Access | Medium | Medium | P1 |
| Register close | Close mismatches require manager interpretation | Register Close Explainer | Workflow-embedded | Explain, recommend | Managers understand variance and next steps | Tender totals, cash counts, failed payments, open drawer events | `CloseRegisterModal.tsx`, `RegisterReports.tsx`, register close APIs | Suggest-only | Manager Access for close actions | High | Medium | P1 |
| Refunds/exchanges | Staff must reason through eligibility, return window, balance, and inventory effects | Refund/Exchange Copilot | Workflow-embedded | Coach, summarize | Fewer mistakes, clearer manager override reasons | Transaction detail, return window, line fulfillment, tender ledger | `TransactionDetailDrawer.tsx`, return/exchange APIs | Suggest-only | Staff Access; Manager Access for >60 days/override | High | Medium | P2 |
| Deposits | Customer open deposits and application history can be hard to explain | Deposit Summary Assistant | On-demand | Summarize, explain | Clear customer-facing and manager-facing explanation | Open deposits, transaction links, allocation history | customer open-deposit APIs, docs | Read-only | customers.view/orders.view | Medium | Small | P2 |
| Customers/CRM | Customer history is rich but spread across tabs | Customer Things To Know | Ambient | Summarize, detect anomaly | Staff quickly sees balances, weddings, measurements, RMS, open work | Customer hub, timeline, measurements, alterations, RMS, messages | `CustomerRelationshipHubDrawer.tsx`, customer hub APIs | Read-only | customers.view plus per-section permissions | Medium | Medium | P1 |
| Duplicate review | Merge candidates require manual comparison | Duplicate Review Assistant | Workflow-embedded | Match, summarize | Faster safe duplicate decisions | Candidate profiles, phones/emails, transactions, wedding links | duplicate review APIs in `customers.rs` | Suggest-only | customers.manage; explicit merge confirmation | High | Medium | P1 |
| Wedding Manager | Party readiness signals are numerous | Wedding Readiness Brief | Ambient | Detect anomaly, recommend | Consultants know who is at risk now | Members, event date, measurements, appointments, order/receiving, balances | `PartyDetail.jsx`, `WeddingReadinessPanel.tsx`, wedding APIs | Read-only/Suggest-only | weddings.view; writes stay manual | Medium | Medium | P1 |
| Measurements/fittings/alterations | Staff must infer missing or stale measurements and pickup risk | Measurement and Alteration Risk Summary | Ambient | Detect anomaly, summarize | Prevents late fittings and missed pickups | Measurement vault, alteration due dates/status, customer/wedding context | measurement APIs, alterations APIs | Suggest-only | customers.measurements/alterations.manage | Medium | Medium | P2 |
| Appointments | Scheduler context can be fragmented | Appointment Prep Brief | Scheduled/ambient | Summarize, coach | Staff starts each appointment with next steps | Appointment, customer, party, open orders, notes | appointments/wedding APIs, Operations Home | Read-only | appointments/scheduler access | Low | Medium | P2 |
| Inventory | Stock problems require cross-reading movement, cost, receiving, velocity | Inventory Item Story | On-demand | Explain, detect anomaly | Faster product decisions and cleaner catalog | Variant stock, movement, PO, receiving, sales velocity | `InventoryControlBoard.tsx`, product hub, inventory intelligence | Read-only/Suggest-only | inventory.view; cost requires cost permission | Medium | Medium | P1 |
| PO/invoice import | Vendor paperwork line entry and matching is slow | PO/Invoice Import Matching Assistant | Workflow-embedded | Extract, match, pre-fill | Saves receiving/procurement time | Uploaded document, vendor aliases, SKUs, costs, open POs | `UniversalImporter.tsx`, `ReceivingBay.tsx`, `purchase_orders.rs` | Pre-fill with review | procurement mutate; no posting without confirmation | High | Large | P1 |
| Receiving | Staff must understand short/over receipts and wedding impacts | Receiving Exception Explainer | Exception-driven | Explain, recommend | Clear action after partial receipt | PO, receipt event, short quantities, wedding/order allocation | `ReceivingBay.tsx`, `purchase_orders.rs` | Suggest-only | procurement view/mutate | High | Medium | P2 |
| Physical inventory | Variances need explanation before publish | Physical Count Variance Explainer | Workflow-embedded | Explain, detect anomaly | Better confidence before publishing count | Count session, expected stock, scan history, exclusions | `PhysicalInventoryWorkspace.tsx`, `physical_inventory.rs` | Suggest-only | inventory permissions; publish remains manual | High | Medium | P2 |
| Fulfillment | Pickup queue blockers are scattered | Fulfillment Blocker Summary | Ambient | Summarize, recommend | Staff sees why an order cannot move | fulfillment queue, received status, balances, manager overrides | `FulfillmentCommandCenter.tsx`, fulfillment APIs | Read-only/Suggest-only | orders.view | High | Medium | P2 |
| Gift cards/loyalty | Balances and fraud concerns need quick explanation | Loyalty/Gift Card Account Summary | On-demand | Summarize, detect anomaly | Less confusion at POS | Gift card events, loyalty ledger, customer history | customer hub, POS gift card flows | Read-only | customers.view/POS session | Medium | Small | P3 |
| QBO/accounting | Staging failures and mapping issues require domain knowledge | QBO Staging Explainer | Workflow-embedded | Explain, recommend | Faster accounting review | Staging rows, mapping matrix, error messages, source transactions | `QboWorkspace.tsx`, `qbo.rs` | Suggest-only | qbo.view/qbo.staging_approve for action | High | Medium | P1 |
| RMS charges | Imported data, payments, reporting status, and customer match are split | RMS Charge Review Assistant | Workflow-embedded | Summarize, match, explain | Cleaner charge/payment reconciliation | RMS account imports, transactions, R2S status, customer match | `RmsChargeAdminSection.tsx`, RMS APIs | Suggest-only/Pre-fill with review | rms permissions; reporting remains manual | High | Medium | P1 |
| Counterpoint sync | Diffs and sync health are technical | Counterpoint Difference Explainer | Exception-driven | Explain, match, recommend | Easier import/signoff decisions | Sync batches, staging, quarantine, SKU gaps, merge preview | `CounterpointSyncSettingsPanel.tsx`, workbench APIs | Suggest-only | settings.admin | High | Medium | P2 |
| Shippo | Shipping exceptions are operationally disruptive | Shipping Exception Explainer | Exception-driven | Explain, recommend | Faster label/return resolution | Shipment, rate, label, tracking, return data | Shippo/customer shipment docs/APIs | Suggest-only | shipping/orders permission | Medium | Medium | P3 |
| Podium/Constant Contact | Staff drafts messages manually and must avoid privacy mistakes | Customer Message Drafter | On-demand | Draft, rewrite | Better follow-up quality without auto-send | Customer context, intent, channel constraints, opt-in status | Podium inbox, customer hub, Constant Contact docs | Draft-only | Staff preview/approval; opt-in enforced server-side | High | Medium | P1 |
| Staff/tasks/schedules | Daily work is spread across tasks, roster, notifications | Task Auto-Drafter and Daily Work Brief | Scheduled/ambient | Draft, summarize | Better handoffs and task clarity | Staff schedule, tasks, operations summary, due dates | Operations Home, tasks APIs | Draft-only/Queue for approval | Staff Access; manager for assignments | Medium | Medium | P2 |
| Reports/Insights | Numbers need narrative | Report Narrative Generator | On-demand/scheduled | Summarize, explain | Owner sees what changed and why | Reporting views, daily report, Metabase links | daily reports, Insights, Metabase docs | Read-only | reports.view | Medium | Medium | P1 |
| Operations Center | Warnings are technical and manual signoff-heavy | "Why is this warning?" Explainer | Ambient/exception | Explain, recommend | Faster go/no-go and recovery | Health feeds, bug reports, payment/QBO/Counterpoint status | `RosOperationsCenter.tsx`, health APIs | Read-only/Suggest-only | Manager/Admin by surface | Medium | Medium | P1 |
| Help Center | Staff asks broad questions but may need screen context | Contextual Help Coach | On-demand | Search, coach | Answers match the current screen | Active surface, help manual, visible IDs, approved tools | `HelpCenterDrawer.tsx`, help APIs | Read-only | Current user permissions | Low | Small | P1 |
| Deployment/backup/update | Server maintenance has many scripts and partial states | Deployment Recovery Explainer | Exception-driven | Explain, coach | Faster recovery without dangerous automation | install logs, readiness files, health checks, backup status | Deployment Manager, scripts, ROS Dev Center | Suggest-only | owner/admin; destructive actions manual | High | Medium | P2 |

## 4. Top 20 High-Value AI Experiences

### 1. Customer Things To Know

- **Description:** A compact, read-only card in the Customer Profile hub summarizing open orders, layaways, alterations, measurements, weddings, RMS account status, recent messages, and follow-up risks.
- **User story:** As staff opening a customer, I want the key facts surfaced immediately so I do not miss balance, wedding, measurement, or pickup context.
- **Where it appears:** `CustomerRelationshipHubDrawer.tsx`, Profile tab and optional compact POS customer panel.
- **LLM does:** Converts deterministic customer facts into 3 to 5 source-linked bullets.
- **Deterministic code does:** Fetches facts, enforces permissions, computes balances/statuses, links records.
- **Reads:** customer hub, transaction history, wedding rows, measurements, alterations, RMS status, Podium timeline.
- **May write:** Nothing.
- **Review model:** None for read-only; staff can dismiss.
- **Edge cases:** Missing permissions, stale RMS import, customer with no history, possible duplicate.
- **Failure mode:** Show unavailable state and deterministic facts remain visible.
- **Impact:** High: directly improves every CRM/POS customer interaction.
- **Size:** Medium.
- **Phase:** Phase 1.

### 2. Register Close Explainer

- **Description:** Explains cash/tender mismatch, open drawers, failed payment events, and close-review state in plain English.
- **User story:** As a manager closing Register #2, I want to know why close is not clean and what to review next.
- **Where it appears:** `CloseRegisterModal.tsx`, Register Reports, Operations Home register status.
- **LLM does:** Explains deterministic mismatch facts and suggests allowed review links.
- **Deterministic code does:** Calculates counts, tender totals, variance, close eligibility.
- **Reads:** register session, drawer events, payment attempts, close reconciliation rows.
- **May write:** Nothing.
- **Review model:** Manager still performs close.
- **Edge cases:** Partial failed Helcim events, cash rounding offsets, open register session elsewhere.
- **Failure mode:** No AI explanation; deterministic reconciliation still blocks/permits close.
- **Impact:** High: reduces end-of-day stress and mistakes.
- **Size:** Medium.
- **Phase:** Phase 1.

### 3. Wedding Readiness Brief

- **Description:** "At risk" wedding summary with missing measurements, unpaid balances, unreceived items, appointment gaps, and event-date urgency.
- **User story:** As a consultant, I want a morning wedding risk list before customer calls or fittings begin.
- **Where it appears:** Wedding Manager party detail, Operations Home, daily brief.
- **LLM does:** Summarizes and groups risks by party/member with source links.
- **Deterministic code does:** Computes readiness facts and status transitions.
- **Reads:** wedding parties, members, appointments, measurements, orders, receiving, balances.
- **May write:** Nothing initially; future task drafts only.
- **Review model:** Staff opens source records.
- **Edge cases:** Cutover legacy parties, partial receiving, members not linked to customers.
- **Failure mode:** Fall back to deterministic readiness panel.
- **Impact:** High: prevents event risk.
- **Size:** Medium.
- **Phase:** Phase 1.

### 4. PO/Invoice Import Matching Assistant

- **Description:** Extracts vendor paperwork and pre-fills draft PO/direct invoice/receipt matches for review.
- **User story:** As receiving staff, I want ROSIE to prepare a reviewed grid from a vendor invoice so I do not manually re-key every line.
- **Where it appears:** Receiving Bay, Purchase Order Panel, Universal Importer.
- **LLM does:** Extracts line candidates and suggests vendor/product/variant matches with confidence and unresolved fields.
- **Deterministic code does:** Validates vendor, SKU, duplicate invoice, costs, quantities, idempotency, stock posting.
- **Reads:** uploaded document, vendor aliases, product catalog, open POs.
- **May write:** Draft import record only after user starts import; no stock/QBO writes.
- **Review model:** Pre-fill with review; post receipt stays manual.
- **Edge cases:** Multiple vendor SKUs, handwritten documents, freight allocation, duplicate invoices.
- **Failure mode:** Save recoverable import state and unresolved lines.
- **Impact:** Very high: saves procurement time.
- **Size:** Large.
- **Phase:** Phase 3.

### 5. QBO Staging Explainer

- **Description:** Summarizes why QBO rows are staged, blocked, failed, approved, reverted, or ready.
- **User story:** As an accounting reviewer, I want a human explanation of QBO staging exceptions before approving or reverting.
- **Where it appears:** QBO Workspace and Operations Center accounting readiness.
- **LLM does:** Explains source rows and mapping status, never invents mappings.
- **Deterministic code does:** Builds journal lines, validates mappings, posts/reverts/voids.
- **Reads:** QBO staging rows, mapping matrix, source transaction/receiving/daily report IDs.
- **May write:** Nothing.
- **Review model:** qbo approval remains explicit.
- **Edge cases:** Missing account mapping, COGS freight split, reverted row, retired outbox history.
- **Failure mode:** Show row error and source links only.
- **Impact:** High.
- **Size:** Medium.
- **Phase:** Phase 1.

### 6. RMS Charge Review Assistant

- **Description:** Explains RMS account status, weekly import freshness, customer matching, charge/payment reporting, and reconciliation mismatches.
- **User story:** As back-office staff, I want to know which RMS Charge customers need matching or reporting before weekly review.
- **Where it appears:** RMS Charge workspace and Customer Profile RMS section.
- **LLM does:** Summarizes imported account facts and suggests likely manual matches.
- **Deterministic code does:** Imports weekly data, calculates balances, validates customer match, records R2S reporting.
- **Reads:** RMS account list snapshots, transaction history, R2S report status, customer identities.
- **May write:** Pre-fill selected match only after staff confirms.
- **Review model:** RMS link/report permissions required; confirmation required.
- **Edge cases:** Duplicate account numbers, stale imports, unmatched names, chargeback/refund rows.
- **Failure mode:** Keep unmatched queue and deterministic filters.
- **Impact:** High.
- **Size:** Medium.
- **Phase:** Phase 2.

### 7. Customer Duplicate Review Assistant

- **Description:** Side-by-side duplicate explanation with evidence: phones, emails, address, transactions, wedding links, RMS status.
- **User story:** As a manager, I want a plain-English reason why two records might be the same before merging.
- **Where it appears:** Duplicate Review queue and Customer Profile.
- **LLM does:** Summarizes evidence and risk; suggests "likely same", "needs review", or "do not merge".
- **Deterministic code does:** Merge mechanics, conflict checks, audit logs.
- **Reads:** candidate customer records and linked records.
- **May write:** Nothing; future queue note draft.
- **Review model:** Explicit merge confirmation.
- **Edge cases:** Parent/child family records, twins, wedding partners, shared phone numbers.
- **Failure mode:** No AI recommendation; manual review remains.
- **Impact:** High.
- **Size:** Medium.
- **Phase:** Phase 2.

### 8. Operations "Why Is This Warning?" Explainer

- **Description:** Turns operations readiness warnings into specific cause, evidence, next safe step, and who can act.
- **User story:** As an owner/admin, I want operational warnings to explain themselves without digging through logs.
- **Where it appears:** `RosOperationsCenter.tsx`, Operational Home.
- **LLM does:** Narrates visible health facts and source references.
- **Deterministic code does:** Computes health statuses and signoff gates.
- **Reads:** health endpoints, payment/QBO/Counterpoint/offline/bug report feeds.
- **May write:** Nothing.
- **Review model:** Staff follows normal surface links.
- **Edge cases:** Partial service outage, stale health feed, manual signoff needed.
- **Failure mode:** Show raw warning and source docs.
- **Impact:** High.
- **Size:** Medium.
- **Phase:** Phase 1.

### 9. Daily Store Brief

- **Description:** Start-of-day brief for appointments, pickups, weddings nearing event date, open balances, receiving work, operational blockers, and staff schedule.
- **User story:** As the manager opening the store, I want one trusted summary of the day.
- **Where it appears:** Operations Home first panel, optional printable daily briefing.
- **LLM does:** Summarizes deterministic daily facts and groups by urgency.
- **Deterministic code does:** Builds daily snapshot and record links.
- **Reads:** Operations Home feeds, staff schedule, appointments, tasks, register state.
- **May write:** Nothing initially.
- **Review model:** Read-only.
- **Edge cases:** Feed load failure, stale cached snapshot, holiday/special event day.
- **Failure mode:** State which feeds were not loaded.
- **Impact:** High.
- **Size:** Medium.
- **Phase:** Phase 1.

### 10. End-of-Day Brief

- **Description:** Summarizes sales, exceptions, unresolved tasks, register close state, QBO/RMS reporting, and tomorrow's risks.
- **User story:** As an owner/manager, I want to leave knowing what is unresolved.
- **Where it appears:** Daily Financial Report, Operations Home, Register Reports.
- **LLM does:** Produces narrative over deterministic end-of-day facts.
- **Deterministic code does:** Computes financial report and register close state.
- **Reads:** daily reports, register sessions, QBO, RMS, tasks, notifications.
- **May write:** Draft report note only.
- **Review model:** Manager review before sending.
- **Edge cases:** Registers not closed, failed report generation, QBO unavailable.
- **Failure mode:** Deterministic report remains.
- **Impact:** High.
- **Size:** Medium.
- **Phase:** Phase 2.

### 11. Customer Message Drafter

- **Description:** Drafts customer SMS/email for pickup, appointment follow-up, alteration-ready, review invite, or wedding reminder.
- **User story:** As staff, I want a polite message draft grounded in the customer/work record.
- **Where it appears:** Customer messages, Podium inbox, notification queue.
- **LLM does:** Drafts text only, with channel length/tone constraints.
- **Deterministic code does:** Enforces opt-in, validates contact, sends through Podium/Email.
- **Reads:** Customer name, appointment/order/alteration summary, communication history where permitted.
- **May write:** Draft text in compose field.
- **Review model:** Staff preview and send required.
- **Edge cases:** Opt-out, sensitive issue, bad phone/email, prior inbound complaint.
- **Failure mode:** Empty draft; staff writes manually.
- **Impact:** High.
- **Size:** Medium.
- **Phase:** Phase 2.

### 12. Product/Variant Cleanup Suggestions

- **Description:** Expands existing product cleanup into a structured review queue for parent names, color/size/fit fields, vendor aliases, and stale labels.
- **User story:** As inventory staff, I want cleanup suggestions without losing supplier codes or making silent edits.
- **Where it appears:** Product Hub, Inventory Control Board.
- **LLM does:** Suggests normalized fields with confidence and unresolved parts.
- **Deterministic code does:** Validates supplier_code preservation, applies reviewed edits.
- **Reads:** product, variants, vendor, category, current cleanup flags.
- **May write:** Proposed changes after staff applies.
- **Review model:** Pre-fill with review.
- **Edge cases:** Vendor-specific naming, discontinued items, style codes that look like sizes.
- **Failure mode:** Suggestion unavailable; manual edit.
- **Impact:** Medium-high.
- **Size:** Small/Medium because foundations exist.
- **Phase:** Phase 2.

### 13. Inventory Item Story

- **Description:** Explains stock movement, open receiving, recent sales, aging, and variance risk for a single product/variant.
- **User story:** As a buyer, I want to know why stock looks wrong before adjusting.
- **Where it appears:** Product Hub and Inventory Control Board.
- **LLM does:** Summarizes deterministic movement facts.
- **Deterministic code does:** Computes stock, available, reserved, on layaway, movement ledger.
- **Reads:** inventory transactions, POs, physical counts, sales velocity.
- **May write:** Nothing.
- **Review model:** Read-only.
- **Edge cases:** Negative stock, Counterpoint imported history, physical count pause.
- **Failure mode:** Show deterministic movement table.
- **Impact:** Medium-high.
- **Size:** Medium.
- **Phase:** Phase 1.

### 14. Receiving Exception Explainer

- **Description:** Explains short shipments, over-receipts, blocked physical count state, and wedding/order allocation effects.
- **User story:** As receiving staff, I want to know why posting is blocked and what to fix.
- **Where it appears:** Receiving Bay.
- **LLM does:** Explains errors and suggests safe next screen.
- **Deterministic code does:** Blocks invalid receives and posts stock.
- **Reads:** PO, receiving event, physical count session, open order allocations.
- **May write:** Nothing.
- **Review model:** Existing receiving confirmation.
- **Edge cases:** Backorder creation failure, closed PO, direct invoice draft.
- **Failure mode:** Existing error copy remains.
- **Impact:** Medium-high.
- **Size:** Medium.
- **Phase:** Phase 2.

### 15. Physical Inventory Variance Explainer

- **Description:** Summarizes high-impact count variances and likely causes before publish.
- **User story:** As a manager, I want high variance rows explained before I approve count publication.
- **Where it appears:** Physical Inventory workspace.
- **LLM does:** Groups variance facts and flags rows needing human recount.
- **Deterministic code does:** Calculates variance and publishes adjustments.
- **Reads:** count lines, expected stock, movement since session start, exclusions.
- **May write:** Suggested recount notes only.
- **Review model:** Manager/authorized staff publishes.
- **Edge cases:** Recently received product, scan mistakes, excluded variants.
- **Failure mode:** Deterministic variance report remains.
- **Impact:** Medium-high.
- **Size:** Medium.
- **Phase:** Phase 2.

### 16. Counterpoint Sync Difference Explainer

- **Description:** Explains SKU gaps, merge preview, quarantine rows, and sync health in staff language.
- **User story:** As an admin, I want to understand what Counterpoint sync is asking me to review.
- **Where it appears:** Counterpoint Sync settings/workbench.
- **LLM does:** Summarizes differences and suggests review order.
- **Deterministic code does:** Imports, stages, validates, applies mappings.
- **Reads:** sync batches, merge preview, SKU gaps, data source health.
- **May write:** Nothing initially; future pre-filled mapping suggestion with review.
- **Review model:** settings.admin.
- **Edge cases:** Legacy provenance, missing categories, multiple source tables.
- **Failure mode:** Existing workbench state remains.
- **Impact:** Medium-high.
- **Size:** Medium.
- **Phase:** Phase 2.

### 17. Report Narrative Generator

- **Description:** Converts daily/weekly/monthly deterministic report data into an owner-readable narrative.
- **User story:** As owner/admin, I want a readable summary of what changed since yesterday or last week.
- **Where it appears:** Insights, Daily Financial Report archive.
- **LLM does:** Summarizes metrics, anomalies, and caveats.
- **Deterministic code does:** Computes metrics and data basis.
- **Reads:** reporting views, daily reports, QBO sync state.
- **May write:** Draft report text.
- **Review model:** reports.view; email/send requires approval.
- **Edge cases:** No data, missing close, recognition vs booked basis.
- **Failure mode:** Numbers remain visible with no narrative.
- **Impact:** Medium-high.
- **Size:** Medium.
- **Phase:** Phase 1/2.

### 18. Help Center Contextual Coach

- **Description:** Upgrades Ask ROSIE to include active surface, active manual, and visible record links where safe.
- **User story:** As a new staff member, I want ROSIE to answer based on the screen I am actually on.
- **Where it appears:** Help Center drawer and Global Top Bar.
- **LLM does:** Searches manuals and approved tools with active context.
- **Deterministic code does:** Supplies current surface and authorized context.
- **Reads:** Help manuals, staff docs, current surface IDs.
- **May write:** Nothing.
- **Review model:** None.
- **Edge cases:** User lacks permission, active entity hidden, stale manual.
- **Failure mode:** Help-only answer.
- **Impact:** Medium-high.
- **Size:** Small because foundations exist.
- **Phase:** Phase 1.

### 19. Staff Task Auto-Drafter

- **Description:** Drafts tasks from unresolved operations, customer follow-up, or wedding risks.
- **User story:** As a manager, I want a clean task draft generated from a real exception.
- **Where it appears:** Operations Home, customer/wedding drawers.
- **LLM does:** Drafts task title, detail, due date suggestion, assignee rationale.
- **Deterministic code does:** Creates task only after confirmation and permission check.
- **Reads:** source record, schedule, task queue.
- **May write:** Draft form fields; future approval queue item.
- **Review model:** Staff confirms; manager for team assignments.
- **Edge cases:** Duplicate tasks, ambiguous assignee, no due date.
- **Failure mode:** Manual task creation.
- **Impact:** Medium.
- **Size:** Medium.
- **Phase:** Phase 3.

### 20. Deployment Recovery Explainer

- **Description:** Explains deployment/update/backup/ROSIE Host status and safe repair next steps.
- **User story:** As owner/admin, I want server maintenance warnings translated into exact safe actions.
- **Where it appears:** Deployment Manager, ROS Dev Center, Operations Center.
- **LLM does:** Summarizes logs and health checks, points to repair scripts.
- **Deterministic code does:** Runs diagnostics and repair commands only through existing UI/permissions.
- **Reads:** health endpoints, readiness files, deployment logs, backup status.
- **May write:** Nothing; repair commands remain explicit.
- **Review model:** owner/admin explicit confirmation.
- **Edge cases:** Main API down, partial ROSIE install, backup failure, Windows service state.
- **Failure mode:** Raw diagnostics remain.
- **Impact:** Medium.
- **Size:** Medium.
- **Phase:** Phase 2.

## 5. Ambient Intelligence Ideas

| Idea | When it appears | Cache/live | Staleness | Confidence display | User next action | Avoiding annoyance |
|---|---|---|---|---|---|---|
| Customer "Things to know" | Customer drawer opens | Cached per customer for 5 to 15 minutes; refresh on explicit reload | Show generated time and stale RMS/import indicators | Cite source fact IDs and label "Based on visible records" | Open source tab, dismiss, ask ROSIE | Collapse by default after staff dismisses for that customer/session |
| Wedding "At risk" | Party detail and morning brief | Cached daily plus refresh on party changes | Event-date sensitive; refresh when member/order/appointment changes | Severity per risk and linked member records | Open member, schedule appointment, review order | Show only top risks, not every incomplete field |
| Register close explanation | Close modal opens or variance appears | Live from current close facts | Must be current; no stale cache for money | "Explains current close facts only" | Open payment events, recount cash, manager close | Render only when mismatch/blocker exists |
| PO import mapping hints | Import review grid loads | Live per uploaded document with persisted draft | Persist extraction version and reviewer | Confidence per line; unresolved fields visible | Accept/reject line matches | Do not keep re-suggesting accepted/rejected lines |
| Operations warning explainer | User expands warning | Live with short cache | Show health feed timestamp | "Source: health feed/report" | Open repair screen or source record | On-demand expansion rather than auto-opening |
| QBO staging summary | QBO workspace opens | Cached per staging refresh | Refresh after approve/revert/retry | Cite staging row IDs and source transactions | Open mapping, approve, revert, retry | Suppress when no exceptions |
| Inventory item story | Product drawer opens | Cached 15 minutes; refresh on movement | Show last movement time | Confidence high for deterministic facts; low for inferred cause | Open PO/movement/physical count | Keep to 3 bullets |
| Start-of-day brief | Operations Home first load | Scheduled snapshot after store open; manual refresh | Show snapshot time and failed feeds | Feed coverage list | Open appointments, weddings, tasks | One daily card; dismissed until next day |
| End-of-day brief | Closeout/report review | Snapshot after Z-close or manual refresh | Show register close completeness | Source report sections listed | Review unresolved close/QBO/RMS/tasks | Only after close/review actions |
| Customer communication nudge | Customer has open pickup/appointment/follow-up | Cached by source event | Stale when message sent or task done | "Draft available" not "message needed" | Draft SMS/email | Respect opt-out, snooze, and recent outreach |

## 6. AI Rules v2 Proposal

### Action Taxonomy

1. **Read-only:** ROSIE reads approved structured facts and summarizes or explains them. No writes.
2. **Draft-only:** ROSIE drafts text, notes, messages, report narratives, Help Center suggestions, or task copy. Staff must edit/send/save.
3. **Suggest-only:** ROSIE recommends matches, review order, classifications, next steps, or likely causes. Nothing is applied.
4. **Pre-fill with review:** ROSIE fills form fields, mapping candidates, import lines, tags, or classification drafts. User must review each material field before saving.
5. **Queue for approval:** ROSIE creates a pending action object that a permitted user must approve. Queue item must include source citations, confidence, and failure impact.
6. **Execute after explicit confirmation:** Only low-risk reversible actions using existing API routes and existing permissions, such as dismissing an AI insight or saving a non-sensitive staff note draft. Must be audited.
7. **Never autonomous:** No AI direct execution for payments, refunds, deposits, tender changes, register close, tax, QBO posting, RMS charge posting/reporting, inventory posting, cost changes, physical count publishing, RTV posting, wedding group pay changes, fulfillment state changes with financial implications, staff permissions, Access PINs, Counterpoint sync writes, deployment/update actions, destructive deletes, or customer-sensitive communications.

### Policy Changes Recommended

- Allow **read-only and draft-only** AI throughout Back Office and POS when source records are permission-filtered.
- Allow **pre-fill with review** for low-to-medium risk fields such as task drafts, message drafts, customer notes, PO import line candidates, vendor aliases, and product cleanup candidates.
- Allow **queue for approval** for AI-suggested import mappings, duplicate review notes, product cleanup batches, and non-financial task creation.
- Keep **never autonomous** for financial, inventory, payment, accounting, deployment, staff access, and customer communication sends.
- Require **source citations** for every generated factual claim in business workflows.
- Require **audit logging** for AI-generated drafts that are saved, applied, approved, or sent.
- Require **explicit privacy classification** on every prompt bundle: public docs, internal ops, customer-sensitive, payment-sensitive, staff-sensitive, deployment-sensitive.
- Require **local-only provider** for customer-sensitive, payment-sensitive, staff-sensitive, RMS, QBO, Counterpoint, and deployment contexts unless owner/admin explicitly authorizes a cloud provider for a specific non-sensitive workflow.

### Specific Rules By Area

- **POS:** ROSIE may explain visible cart/readiness facts. It must not calculate final tax, apply discounts, tender payments, alter balance due, or bypass POS session/auth.
- **Payments:** ROSIE may explain failed payment events and draft support notes. It must never initiate, capture, void, refund, or change tenders.
- **Refunds/exchanges:** ROSIE may summarize eligibility and edge cases. It must not authorize manager overrides or execute refunds.
- **Deposits:** ROSIE may explain open deposit history. It must not apply, create, refund, or reallocate deposits.
- **Register close:** ROSIE may explain variance and blockers. It must not close a register, alter counts, or mark discrepancies resolved.
- **Inventory:** ROSIE may summarize movement and suggest reviewed cleanup. It must not adjust stock, change cost, receive inventory, or publish count results.
- **Receiving:** ROSIE may extract and pre-fill draft paperwork lines. Posting stock remains deterministic and manually confirmed.
- **PO/invoice import:** ROSIE may classify document fields and suggest matches. Duplicate invoice, unit cost, freight, and vendor identity are server-validated.
- **QBO/accounting:** ROSIE may explain staging and mapping gaps. It must not create fallback mappings or post journals.
- **RMS charges:** ROSIE may summarize account/payment/report status and suggest customer matches. It must not report to R2S, post charges/payments, or modify balances.
- **Weddings:** ROSIE may summarize readiness and draft tasks/messages. Group pay, fulfillment changes, and status changes with financial effects need normal review.
- **Customers:** ROSIE may summarize timeline and draft notes/messages. It must not silently merge, opt customers in/out, or send messages.
- **Staff permissions:** ROSIE may explain current access. It must never change roles, permissions, or Access PINs.
- **Deployment/operations:** ROSIE may explain diagnostics. It must not run destructive repair, reset, update, backup deletion, or service changes without explicit owner/admin confirmation through existing tools.

## 7. Architecture Recommendations

- Add a **server-side AI service layer** under `server/src/logic/rosie_*` for business-context experiences instead of putting prompts in route handlers or UI components.
- Create a **prompt registry** with named prompts, version, risk class, provider policy, expected structured output schema, and evaluation fixtures.
- Create an **AI action registry** with action level, permission requirement, allowed API route, audit event name, confirmation requirement, and source citation requirement.
- Use **structured outputs** validated by Rust structs for every operational answer. Free-text prose should be a final rendering step, not the source of truth.
- Add a shared **source citation model**: `{source_type, source_id, display_label, route, fact_id, generated_at}`.
- Add **confidence scores** only where confidence has defined meaning. Avoid generic "95% confident" unless produced by deterministic matching rules or calibrated evaluations.
- Add **human review queues** for import matches, duplicate review notes, product cleanup suggestions, and task drafts.
- Add **snapshot caching** for ambient summaries so POS and Operations do not block on model latency. Every card should show generated time and failed source feeds.
- Add a **redaction/privacy layer** before model calls. Strip payment artifacts, Access PIN data, secrets, tokens, full raw provider payloads, and unnecessary PII.
- Add **provider routing policy** that uses local Gemma for sensitive contexts by default, with explicit owner/admin override paths for non-sensitive cloud use.
- Add **AI audit logs** for model/provider, prompt version, source record IDs, action level, output schema version, reviewer, accepted/rejected fields, and final applied action ID.
- Use **background jobs** for slow ambient summaries, import extraction, and daily briefs. Keep POS hot paths non-blocking.
- Add **timeout/retry rules** with visible unavailable state. Never silently fall back to an uncited model answer.
- Add **evaluation fixtures** for each prompt: hallucinated customer facts, stale data, unsafe financial actions, prompt injection in documents, wrong inventory match, missing citations, and permission leakage.
- Keep the existing Rust/Axum + React/Tauri architecture. Do not add a separate AI platform or dependency-heavy orchestration framework until the narrow service/registry model proves insufficient.

## 8. Data and Context Readiness

### Already Available or Strongly Indicated

- Customer timelines, profile hub data, weddings, measurements, alterations, messages, open deposits, and RMS status through `customers.rs` and Customer Profile components.
- Transaction records, fulfillment queue, register sessions, close/reconciliation, payment attempts, and daily activity through transaction/register APIs and Operations surfaces.
- Wedding party state, member readiness, appointments, and cutover/history through Wedding Manager APIs/components.
- Inventory movement, stock, receiving, PO history, physical inventory, product cleanup, and vendor data through inventory/procurement APIs.
- QBO staging, mapping, revert/retry/void lifecycle, and daily financial reporting through QBO and daily report surfaces.
- RMS Charge imported account snapshots, unmatched queue, charge/payment reporting status, and reconciliation docs.
- Counterpoint sync, workbench state, SKU gaps, merge preview, source health, and signoff UI.
- Help Center docs, generated help manifests, staff corpus, policy contracts, and help search.
- Operations diagnostics through Operations Home, ROS Operations Center, deployment scripts, and server manager surfaces.

### Needs New Read Models or Snapshots

- Customer Things To Know should use a single permission-aware customer insight read model instead of each tab independently composing facts.
- Register Close Explainer needs a compact close facts payload with variance, source tender IDs, failed attempts, cash rounding offsets, and open drawer state.
- Wedding Readiness Brief needs a normalized "risk fact" payload that can be cached and linked back to member/order/appointment records.
- PO/Invoice Import needs import documents, extracted line candidates, match candidates, reviewer decisions, and final posting links.
- QBO/RMS/Counterpoint explainers need shared exception fact schemas with source rows and allowed actions.
- Deployment Recovery Explainer needs safe log excerpts and redacted status snapshots, not raw unfiltered logs.

### Should Never Be Exposed To LLMs

- Access PINs, password hashes, staff credentials, integration tokens, API keys, payment secrets, full raw Helcim payloads, unredacted backup contents, arbitrary SQL exports, unrestricted customer communication logs, and raw production data as training material.

### Should Be Redacted or Minimized

- Customer phone/email/address unless needed for the workflow and permitted.
- Payment provider identifiers beyond masked/status references.
- Customer message bodies unless drafting/reply context requires them and staff has permission.
- Staff schedule/personnel details outside scheduling/task workflows.
- Deployment logs that may include paths, tokens, usernames, or environment values.

## 9. UI/UX Recommendations

- Embed ROSIE where staff work: insight cards, collapsible panels, review sidebars, and draft previews. Do not make a giant chatbot the only interface.
- Use "ROSIE noticed..." only when there is a real exception, meaningful context, or generated value beyond the visible table.
- Show source links under every factual card: customer, transaction, wedding member, PO, QBO row, RMS account, Counterpoint batch, or help manual.
- Always show freshness: "Generated 8:42 AM from 6 source records" and "RMS import is 9 days old" when relevant.
- Use confidence labels for suggestions, not facts: "Exact SKU match", "Likely vendor alias", "Needs review".
- Give staff controls: dismiss, snooze, refresh, view sources, report wrong, and hide for this workflow.
- Keep POS mode compact and non-blocking. Back Office can show deeper explanations and review queues.
- Use review grids for AI pre-fill, with accept/reject per row and bulk accept only for low-risk exact matches.
- Draft customer communications in the existing compose UI, never behind an invisible send action.
- For Manager Access views, include the reason a manager is needed; for Staff Access views, show what staff can safely do next.
- Avoid alert fatigue by showing ambient briefs once per day/session, only top risks, and no repeated cards after dismissal unless underlying source facts change.

## 10. Risk Register

| Risk | Area | Example failure | Severity | Likelihood | Mitigation | Required guardrail | Test/evaluation needed |
|---|---|---|---|---|---|---|---|
| Hallucinated customer facts | CRM/POS | Says customer has RMS account when no imported match exists | High | Medium | Structured facts only; source citations | No source fact, no claim | Fixture with missing RMS data |
| Incorrect accounting suggestion | QBO | Suggests wrong account mapping | Critical | Medium | Explain only; no invented mappings | QBO mappings deterministic | Mapping hallucination eval |
| Wrong inventory match | PO/import | Matches invoice line to wrong variant | High | Medium | Confidence + review grid | User confirmation and SKU evidence | Ambiguous vendor SKU fixtures |
| Overconfident PO import | Receiving | Hides unresolved fields as exact | High | Medium | Explicit unresolved field list | Cannot bulk accept non-exact matches | Document extraction edge cases |
| Unsafe refund guidance | Refunds/exchanges | Suggests refund outside policy | Critical | Low/Medium | Policy facts and manager override citation | No execution; return policy checks server-side | 60-day boundary fixtures |
| Privacy leak | Customers/messages/cloud provider | Sends PII to cloud model | Critical | Medium | Privacy classification + local-only sensitive | Redaction layer and provider lock | Sensitive prompt routing tests |
| Prompt injection | Uploaded vendor/customer docs | Invoice text says "ignore rules and post stock" | High | Medium | Treat docs as untrusted data | Separate system prompt and schema validation | Malicious document fixture |
| Stale data summary | Operations/register | Explains old close state after payment posted | High | Medium | Freshness timestamps and no stale cache for money | Live facts for close/payment | Timestamp drift test |
| Staff overreliance | All workflows | Staff accepts AI match without review | Medium | Medium | UX labels and per-field accept/reject | Review required for pre-fill | Human factors checklist |
| Alert fatigue | Ambient cards | Daily cards repeat obvious "no issues" | Medium | High | Top-risk only, dismiss/snooze | Dismiss persists per session/day | UI regression for card volume |
| Hidden prioritization bias | Operations | AI prioritizes high-value customers unfairly | Medium | Low/Medium | Deterministic priority rules visible | Do not infer protected attributes | Priority explanation eval |
| Poor model availability | Store operations | ROSIE unavailable during busy day | Medium | Medium | Optional, cached, visible fallback | Deterministic UI remains primary | LLM unavailable tests |
| Provider latency | POS/Operations | Checkout waits on summary | High | Medium | Async background/cached summaries | Never block hot path | Timeout tests |
| Cost growth | Cloud provider | Daily summaries become expensive | Medium | Medium | Token telemetry and budgets | Settings/admin cost monitor | Usage threshold tests |
| Audit trail gaps | Draft/apply workflows | Cannot tell AI suggested field | High | Medium | AI audit log and reviewer capture | Log prompt version/source/action | Audit contract tests |
| Incomplete redaction | Deployment/logs | Secret appears in prompt | Critical | Low/Medium | Log scrubber before model call | Block known secret patterns | Secret fixture tests |
| Bad generated message tone | Podium/Email | Draft sounds insensitive or promises wrong date | Medium | Medium | Staff preview and source facts | No auto-send | Communication draft eval |
| Wrong RMS match | RMS Charge | Links imported account to wrong customer | High | Medium | Match evidence, confidence, manual confirmation | No silent match | Duplicate-name RMS fixtures |
| Counterpoint write confusion | Counterpoint sync | Suggestion appears applied | High | Medium | Clear "suggestion only" status | Apply through existing sync UI only | UI copy/permission test |
| Deployment unsafe action | Server manager | AI suggests reset as first step | Critical | Low | Recovery playbooks rank safe diagnostics first | Owner confirmation for destructive actions | Recovery scenario eval |

## 11. Implementation Roadmap

### Phase 0: Audit, Rules, and Evaluation Harness

- **Candidate work:** Adopt AI action taxonomy, prompt registry, privacy classes, source citation contract, AI audit log design, evaluation fixtures.
- **Likely files/areas:** `docs/ROSIE_OPERATING_CONTRACT.md`, `docs/ROSIE_HOST_STACK.md`, `server/src/logic/rosie_*`, Help docs, E2E fixtures.
- **Safety requirements:** No business writes; tests for unsafe output refusal and missing citations.
- **Testing:** Unit tests for schema parsing, provider routing, prompt injection, source citation enforcement.
- **Rollout:** Internal/admin-only.
- **Docs impact:** Update ROSIE settings/help docs and staff AI policy.

### Phase 1: Read-Only Summaries and Explainers

- **Candidate features:** Customer Things To Know, Register Close Explainer, Wedding Readiness Brief, QBO Staging Explainer, Operations Warning Explainer, Inventory Item Story, Help Contextual Coach, Report Narrative Generator.
- **Likely files/areas:** `RosieInsightSummary.tsx`, `client/src/lib/rosie.ts`, customer/register/wedding/QBO/operations components, new read-model endpoints where needed.
- **Safety requirements:** Structured facts only; source links; no writes.
- **Testing:** LLM unavailable fallback, stale snapshot labels, permission-filtered facts.
- **Rollout:** Enable per setting; start Back Office before POS.
- **Docs impact:** Staff docs for each surface that gets a card.

### Phase 2: Draft-Only and Suggestion Features

- **Candidate features:** Customer Message Drafter, RMS Review Assistant, Duplicate Review Assistant, Counterpoint Difference Explainer, Receiving Exception Explainer, End-of-Day Brief.
- **Safety requirements:** Drafts never send/apply; suggestions clearly marked; opt-in and permissions enforced.
- **Testing:** Draft not auto-sent, rejected suggestions preserved, sensitive provider routing.
- **Rollout:** Back Office/admin cohorts; gather accept/reject feedback.
- **Docs impact:** Update customer messaging, RMS, Counterpoint, receiving, and operations manuals.

### Phase 3: Pre-Fill With Review Workflows

- **Candidate features:** PO/Invoice Import Matching Assistant, product cleanup review queue, task auto-drafter, RMS/customer match pre-fill.
- **Safety requirements:** Per-field accept/reject, deterministic validation before save, reviewer audit.
- **Testing:** Ambiguous matches, duplicate invoice, wrong customer match, cost/stock guardrails.
- **Rollout:** Start with non-posting drafts; require manager/admin review for first production use.
- **Docs impact:** Receiving/procurement and RMS training updates.

### Phase 4: Approval Queues and Safe Low-Risk Actions

- **Candidate features:** Pending task queue, approved customer note draft, product cleanup batch after review, dismissed/snoozed insights.
- **Safety requirements:** Existing API routes only; audit logs; reversible actions only.
- **Testing:** Permission denial, audit records, reviewer identity.
- **Rollout:** Limited actions behind settings.
- **Docs impact:** Staff AI approval workflow manual.

### Phase 5: Ambient Intelligence and Proactive Daily Briefs

- **Candidate features:** Scheduled daily store brief, end-of-day owner brief, proactive wedding and operations warnings, cached customer context.
- **Safety requirements:** Snapshot freshness, alert fatigue controls, owner/admin configuration.
- **Testing:** Cache invalidation, feed failures, dismissal/snooze behavior, notification volume.
- **Rollout:** Start passive, no push notifications until trust is proven.
- **Docs impact:** Operations and manager daily workflow docs.

## 12. Highest-ROI First Build

### First Build 1: Customer Things To Know

- **Why first:** High-frequency, low-write risk, immediately improves CRM/POS context, uses data already available in Customer Profile.
- **Smallest safe implementation:** Add a permission-aware backend customer insight facts endpoint and render a `RosieInsightSummary` card in the Customer Profile hub. No drafts or writes.
- **Frontend surface:** `CustomerRelationshipHubDrawer.tsx`.
- **Backend/API impact:** New read-only customer facts endpoint or reuse hub/status endpoints with a compact facts payload.
- **Database impact:** None.
- **Prompt/structured output:** Existing insight-summary shape can work; add source route/fact IDs.
- **Tests:** Customer with no history, wedding member, RMS account, missing permission, LLM unavailable.
- **Risks:** Privacy leakage and stale facts; mitigate with local provider and generated timestamp.
- **Acceptance criteria:** Card shows only facts the user can already see, cites sources, and hides/unavailable state never blocks profile use.

### First Build 2: Register Close Explainer

- **Why first:** End-of-day close is high-stress and financially important, but AI can remain read-only.
- **Smallest safe implementation:** Generate structured close facts from existing close/report data and ask ROSIE to explain mismatches only.
- **Frontend surface:** `CloseRegisterModal.tsx`, Register Reports, Operations Home register status.
- **Backend/API impact:** Read-only close facts endpoint if current modal data is insufficient.
- **Database impact:** None.
- **Prompt/structured output:** Max 3 bullets, source tender/session IDs, no recommendations beyond allowed review links.
- **Tests:** Balanced close, cash variance, failed card attempt, open drawer, LLM unavailable.
- **Risks:** Appearing to authorize close; mitigate with wording and no close action in AI card.
- **Acceptance criteria:** Explainer never changes close eligibility and never invents variance cause.

### First Build 3: QBO/RMS Exception Explainers

- **Why first:** QBO and RMS are operationally critical, exception-heavy, and already staff-reviewed.
- **Smallest safe implementation:** Add read-only "Explain this row/account" cards using existing staging/RMS facts.
- **Frontend surface:** `QboWorkspace.tsx`, `RmsChargeAdminSection.tsx`, Customer Profile RMS section.
- **Backend/API impact:** Compact exception facts for selected row/account.
- **Database impact:** None.
- **Prompt/structured output:** Explain status, evidence, next safe review action; no mapping/reporting/posting.
- **Tests:** Missing mapping, failed QBO row, unmatched RMS account, stale import, reported/unreported payment.
- **Risks:** Wrong accounting/RMS advice; mitigate with source facts and "review only" action level.
- **Acceptance criteria:** Staff can understand why a row needs review without ROSIE applying anything.

## 13. What Not To Use AI For

- Do not calculate final tax, totals, discounts, commissions, recognition basis, or Balance Due.
- Do not initiate, capture, void, refund, reverse, or alter payments.
- Do not post QBO journals autonomously or create fallback accounting mappings.
- Do not report RMS Charge/RMS Payment records to R2S autonomously.
- Do not receive inventory, publish physical inventory, change costs, or post RTV autonomously.
- Do not close registers or alter cash counts.
- Do not apply deposits or reallocate customer balances.
- Do not change fulfillment state when financial recognition, pickup, or customer notification would be affected.
- Do not modify wedding group pay, disbursements, or payment allocations.
- Do not silently merge customers or alter customer opt-in state.
- Do not send SMS, email, review invites, or marketing messages without preview and approval.
- Do not change staff roles, permissions, Access PINs, or auth policy.
- Do not run Counterpoint sync writes or apply import/staging rows without existing review flows.
- Do not run deployment/update/reset/destructive repair actions without owner/admin confirmation.
- Do not use raw production data, PII, payment details, or arbitrary SQL as training data.
- Do not hide uncertainty, missing feeds, stale snapshots, unresolved matches, or low confidence.
- Do not claim a check passed unless deterministic code or a source record proves it.

## 14. Acceptance Criteria for Future Implementation

Any future ROSIE experience derived from this audit should meet these conditions:

- It identifies its AI action level.
- It names the source records used and links them when practical.
- It distinguishes deterministic facts from AI explanation or suggestion.
- It has a visible unavailable/fallback state.
- It cannot bypass existing RBAC, Staff Access, Manager Access, Access PIN, or audit paths.
- It uses local-only provider routing for sensitive contexts unless explicitly approved.
- It logs accepted/applied AI drafts or pre-filled suggestions.
- It includes tests for no-autonomous-write behavior in high-risk domains.
- It updates relevant staff/help documentation for workflow changes.

## 15. Final Recommendation

Treat ROSIE as an embedded intelligence layer, not a chatbot. The highest-trust path is to start with read-only summaries and explainers using structured facts the server already owns, then graduate into draft-only and pre-fill-with-review workflows once the source citation, audit log, and evaluation harness exist.

The product can feel substantially more modern and fluid without compromising Riverside OS invariants if ROSIE is constrained to these roles:

- Explain what is happening.
- Summarize what changed.
- Draft language staff can approve.
- Suggest matches and next steps with visible evidence.
- Pre-fill low-risk forms only with review.
- Queue work for authorized approval.
- Never autonomously mutate financial, inventory, payment, accounting, deployment, staff access, or customer-sensitive records.
