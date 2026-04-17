# Staff help hub (Riverside OS)

Staff-facing guides for **training**, **floor support**, and future **in-app / AI help** (RAG over this folder plus linked **`docs/*.md`** and root runbooks listed in the manifest). **AI / prompt authors:** see [**`../AI_CONTEXT_FOR_ASSISTANTS.md`**](AI_CONTEXT_FOR_ASSISTANTS.md) for which document to use when (reporting vs procedures vs permissions vs live store SOP).

Each article is structured so you can:

- **Orient** someone quickly (**How to use this screen**).
- **Walk through** real work (**Common tasks** with numbered steps).
- **Troubleshoot** (**Common issues and fixes** tables).
- **Escalate safely** (**When to get a manager**).
- **Coach** peers (**Helping a coworker** or customer sections where relevant).

Use **exact sidebar names** from the app (Back Office and POS rails). For engineers, see **`DEVELOPER.md`** and **`AGENTS.md`**. **Customer hub permissions (routes ↔ keys):** **[`../CUSTOMER_HUB_AND_RBAC.md`](../CUSTOMER_HUB_AND_RBAC.md)**.

**If something is missing or wrong:** update the matching `docs/staff/*.md` when behavior changes, or log a ticket with **symptom**, **what you tried**, and **screenshot of the toast/error**.

**Canonical machine list:** [`CORPUS.manifest.json`](CORPUS.manifest.json) — single source of truth for embed/index jobs (`docs/staff/**` plus cross-linked first-party docs such as **`TILL_GROUP_AND_REGISTER_OPEN`**, **`REGISTER_DASHBOARD`**, runbooks at repo root).

**After you change the manifest or staff Markdown:** run **`npm run verify:ai-docs`** (drift check), then have an admin call **`POST /api/ai/admin/reindex-docs`** or run **`npm run reindex:staff-docs`** from the repo root while the API is up — see **[`../ROS_AI_HELP_CORPUS.md`](../ROS_AI_HELP_CORPUS.md)** (hybrid FTS + trigram + vector embeddings, env **`AI_EMBEDDINGS_ENABLED`**, **`RIVERSIDE_REPO_ROOT`**).

**Completeness:** Every Back Office subsection in `SIDEBAR_SUB_SECTIONS` and every POS rail tab in `PosTabId` maps to exactly one staff article (or a clearly labeled subsection within it). When you add a sidebar item in code, add a row to the checklists below and extend the linked guide the same day.

---

## Guide index

| Topic | File |
|-------|------|
| Getting started, sign-in, BO vs POS | [00-getting-started.md](00-getting-started.md) |
| Glossary (terms) | [GLOSSARY.md](GLOSSARY.md) |
| FAQ / intent map | [FAQ.md](FAQ.md) |
| Errors, HTTP codes, toasts | [ERROR-AND-TOAST-GUIDE.md](ERROR-AND-TOAST-GUIDE.md) |
| Open, close, EOD narrative | [EOD-AND-OPEN-CLOSE.md](EOD-AND-OPEN-CLOSE.md) |
| PII and customer data | [PII-AND-CUSTOMER-DATA.md](PII-AND-CUSTOMER-DATA.md) |
| Store-specific SOP (fill in) | [STORE-SOP-TEMPLATE.md](STORE-SOP-TEMPLATE.md) |
| Abstract: transactions & stock | [abstracts/transactions-and-stock.md](abstracts/transactions-and-stock.md) |
| Abstract: returns / refunds | [abstracts/returns-refunds-exchanges.md](abstracts/returns-refunds-exchanges.md) |
| Abstract: wedding group pay | [abstracts/wedding-group-pay.md](abstracts/wedding-group-pay.md) |
| Abstract: tax exemption (audit) | [pos-tax-exemption.md](pos-tax-exemption.md) |
| Custom Work Orders (MTM) & Rush Tracking | [custom-work-orders-manual.md](custom-work-orders-manual.md) |
| Permissions (plain language) | [permissions-and-access.md](permissions-and-access.md) |
| RBAC keys & technical detail (also in corpus) | [../STAFF_PERMISSIONS.md](../STAFF_PERMISSIONS.md) |
| Offline summary | [working-offline.md](working-offline.md) |
| Operations Hub (Dashboard, Inbox, Reviews, Register reports) | [operations-home.md](operations-home.md) |
| POS tab → Register (launchpad) | [register-tab-back-office.md](register-tab-back-office.md) |
| Till group, multi-lane Z (reference) | [../TILL_GROUP_AND_REGISTER_OPEN.md](../TILL_GROUP_AND_REGISTER_OPEN.md) |
| Parked cart + RMS / RMS90 ledger (reference) | [../POS_PARKED_SALES_AND_RMS_CHARGES.md](../POS_PARKED_SALES_AND_RMS_CHARGES.md) |
| Customers | [customers-back-office.md](customers-back-office.md) |
| Transactions | [transactions-back-office.md](transactions-back-office.md) |
| Inventory (all BO subsections) | [inventory-back-office.md](inventory-back-office.md) |
| Alterations (BO) | [alterations-back-office.md](alterations-back-office.md) |
| Weddings (BO) | [weddings-back-office.md](weddings-back-office.md) |
| Appointments | [appointments.md](appointments.md) |
| Gift Cards & Loyalty (BO) | [gift-cards-loyalty-back-office.md](gift-cards-loyalty-back-office.md) |
| Staff admin | [staff-administration.md](staff-administration.md) |
| QBO bridge | [qbo-bridge.md](qbo-bridge.md) |
| Insights (Metabase) + commission payouts | [insights-back-office.md](insights-back-office.md) |
| Reports (curated library) | [reports-curated-manual.md](reports-curated-manual.md) (staff); [reports-curated-admin.md](reports-curated-admin.md) (admins / policy) |
| In-app Help: Reports + Insights manuals | [`../../client/src/assets/docs/reports-manual.md`](../../client/src/assets/docs/reports-manual.md), [`../../client/src/assets/docs/insights-manual.md`](../../client/src/assets/docs/insights-manual.md) (Help Center; see [../MANUAL_CREATION.md](../MANUAL_CREATION.md)) |
| Settings (BO) | [settings-back-office.md](settings-back-office.md) |
| Podium integration (staff SOP) | [podium-integration-staff-manual.md](podium-integration-staff-manual.md) |
| Podium integration (full reference) | [Podium_Integration_Manual.md](Podium_Integration_Manual.md) |
| NuORDER integration (wholesale sync) | [../NUORDER_INTEGRATION.md](../NUORDER_INTEGRATION.md) |
| Bug reports — **submit** (any staff) | [bug-reports-submit-manual.md](bug-reports-submit-manual.md) |
| Bug reports — **admin triage** | [bug-reports-admin-manual.md](bug-reports-admin-manual.md) |
| POS Dashboard | [pos-dashboard.md](pos-dashboard.md) |
| POS Register (cart) | [pos-register-cart.md](pos-register-cart.md) |
| POS Tasks | [pos-tasks.md](pos-tasks.md) |
| POS Weddings (Quick Reference) | [pos-weddings.md](pos-weddings.md) |
| POS Wedding Registry Dashboard (Full Manual) | [pos-wedding-registry.md](pos-wedding-registry.md) |
| POS Alterations | [pos-alterations.md](pos-alterations.md) |
| POS Inventory | [pos-inventory.md](pos-inventory.md) |
| POS Reports | [pos-reports.md](pos-reports.md) |
| POS Gift Cards | [pos-gift-cards.md](pos-gift-cards.md) |
| POS Loyalty | [pos-loyalty.md](pos-loyalty.md) |
| POS Settings | [pos-settings.md](pos-settings.md) |

**Authoring template:** [_TEMPLATE.md](_TEMPLATE.md) (not indexed in `CORPUS.manifest.json`).

---

## Coverage checklist (Back Office sidebar)

Source of truth for labels: `client/src/components/layout/sidebarSections.ts` (`SidebarTabId`, `SIDEBAR_SUB_SECTIONS`).

| Tab | Subsection | Covered in |
|-----|------------|------------|
| Operations | Dashboard | [operations-home.md](operations-home.md) |
| Operations | Inbox | [operations-home.md](operations-home.md) |
| Operations | Reviews | [operations-home.md](operations-home.md) |
| Operations | Register reports | [operations-home.md](operations-home.md) |
| POS | Register | [register-tab-back-office.md](register-tab-back-office.md) |
| Customers | All Customers | [customers-back-office.md](customers-back-office.md) |
| Customers | Add Customer | [customers-back-office.md](customers-back-office.md) |
| Customers | RMS charge | [customers-back-office.md](customers-back-office.md) |
| Alterations | Work queue | [alterations-back-office.md](alterations-back-office.md) |
| Transactions | Open Transactions | [transactions-back-office.md](transactions-back-office.md) |
| Transactions | All Transactions | [transactions-back-office.md](transactions-back-office.md) |
| Inventory | Inventory List | [inventory-back-office.md](inventory-back-office.md) |
| Inventory | Add Inventory | [inventory-back-office.md](inventory-back-office.md) |
| Inventory | Receiving | [inventory-back-office.md](inventory-back-office.md) |
| Inventory | Categories | [inventory-back-office.md](inventory-back-office.md) |
| Inventory | Discount events | [inventory-back-office.md](inventory-back-office.md) |
| Inventory | Import | [inventory-back-office.md](inventory-back-office.md) |
| Inventory | Vendors | [inventory-back-office.md](inventory-back-office.md) |
| Inventory | Physical count | [inventory-back-office.md](inventory-back-office.md) |
| Weddings | Action Board | [weddings-back-office.md](weddings-back-office.md) |
| Weddings | Parties | [weddings-back-office.md](weddings-back-office.md) |
| Weddings | Calendar | [weddings-back-office.md](weddings-back-office.md) |
| Gift Cards | Card Inventory | [gift-cards-loyalty-back-office.md](gift-cards-loyalty-back-office.md) |
| Gift Cards | Issue Purchased | [gift-cards-loyalty-back-office.md](gift-cards-loyalty-back-office.md) |
| Gift Cards | Issue Donated | [gift-cards-loyalty-back-office.md](gift-cards-loyalty-back-office.md) |
| Loyalty | Monthly Eligible | [gift-cards-loyalty-back-office.md](gift-cards-loyalty-back-office.md) |
| Loyalty | Adjust Points | [gift-cards-loyalty-back-office.md](gift-cards-loyalty-back-office.md) |
| Loyalty | Program Settings | [gift-cards-loyalty-back-office.md](gift-cards-loyalty-back-office.md) |
| Staff | Team | [staff-administration.md](staff-administration.md) |
| Staff | Tasks | [staff-administration.md](staff-administration.md) |
| Staff | Schedule | [staff-administration.md](staff-administration.md) |
| Staff | Commission | [staff-administration.md](staff-administration.md) |
| Staff | Audit | [staff-administration.md](staff-administration.md) |
| QBO bridge | Connection | [qbo-bridge.md](qbo-bridge.md) |
| QBO bridge | Mappings | [qbo-bridge.md](qbo-bridge.md) |
| QBO bridge | Staging | [qbo-bridge.md](qbo-bridge.md) |
| QBO bridge | History | [qbo-bridge.md](qbo-bridge.md) |
| Reports | _(no subsections)_ | [reports-curated-manual.md](reports-curated-manual.md), [reports-curated-admin.md](reports-curated-admin.md) |
| Insights | _(no subsections; full-screen Metabase)_ | [insights-back-office.md](insights-back-office.md) |
| Staff | Commission payouts | [insights-back-office.md](insights-back-office.md) |
| Appointments | Scheduler | [appointments.md](appointments.md) |
| Appointments | Conflicts | [appointments.md](appointments.md) |
| Settings | Profile | [settings-back-office.md](settings-back-office.md) |
| Settings | General | [settings-back-office.md](settings-back-office.md) |
| Settings | Data & Backups | [settings-back-office.md](settings-back-office.md) |
| Settings | Printing Hub | [settings-back-office.md](settings-back-office.md) |
| Settings | Receipt Builder | [../RECEIPT_BUILDER_AND_DELIVERY.md](../RECEIPT_BUILDER_AND_DELIVERY.md) (product doc; staff: test receipts after edits) |
| Settings | Integrations | [settings-back-office.md](settings-back-office.md) |
| Settings | Staff access defaults | [settings-back-office.md](settings-back-office.md) |
| Settings | Counterpoint | [../COUNTERPOINT_SYNC_GUIDE.md](../COUNTERPOINT_SYNC_GUIDE.md), [../COUNTERPOINT_BRIDGE_OPERATOR_MANUAL.md](../COUNTERPOINT_BRIDGE_OPERATOR_MANUAL.md) |
| Settings | NuORDER | [../NUORDER_INTEGRATION.md](../NUORDER_INTEGRATION.md) |
| Settings | Online store | [settings-back-office.md](settings-back-office.md), [../ONLINE_STORE.md](../ONLINE_STORE.md) |
| Settings | Help center | [../MANUAL_CREATION.md](../MANUAL_CREATION.md), **Help** drawer in-app |
| Settings | Bug reports | [settings-back-office.md](settings-back-office.md), [bug-reports-submit-manual.md](bug-reports-submit-manual.md), [bug-reports-admin-manual.md](bug-reports-admin-manual.md) |

---

## Coverage checklist (POS mode sidebar)

Source: `client/src/components/pos/PosSidebar.tsx` (`PosTabId`).

| POS rail label (order in `PosSidebar.tsx`) | Covered in |
|----------------|------------|
| Dashboard | [pos-dashboard.md](pos-dashboard.md) |
| Register | [pos-register-cart.md](pos-register-cart.md) |
| Tasks | [pos-tasks.md](pos-tasks.md) |
| Wedding Registry | [pos-weddings.md](pos-weddings.md), [pos-wedding-registry.md](pos-wedding-registry.md) |
| Alterations (shown only with **alterations.manage**) | [pos-alterations.md](pos-alterations.md) |
| Inventory | [pos-inventory.md](pos-inventory.md) |
| Reports | [pos-reports.md](pos-reports.md) |
| Gift Cards | [pos-gift-cards.md](pos-gift-cards.md) |
| Loyalty | [pos-loyalty.md](pos-loyalty.md) |
| Settings | [pos-settings.md](pos-settings.md) |

---

**Last reviewed:** 2026-04-15 (v0.2.0 WowDash Update)
