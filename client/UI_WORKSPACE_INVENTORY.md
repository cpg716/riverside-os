# UI workspace inventory (baseline)

Canonical conventions and rationale: **[`docs/CLIENT_UI_CONVENTIONS.md`](../docs/CLIENT_UI_CONVENTIONS.md)**. Zero-browser-dialog examples: **[`UI_STANDARDS.md`](../UI_STANDARDS.md)**.

Generated for the phased UI sweep. Source: [`src/App.tsx`](src/App.tsx), [`src/components/layout/Sidebar.tsx`](src/components/layout/Sidebar.tsx), [`src/components/layout/PosShell.tsx`](src/components/layout/PosShell.tsx).

## Back Office shell (`AppMainColumn` in `App.tsx`)

| Sidebar tab | Sub-sections (see `sidebarSections.ts` / `SIDEBAR_SUB_SECTIONS`) | Primary component |
|-------------|-------------------------------------------|-------------------|
| `home` | dashboard, inbox, reviews, register-reports | `OperationalHome` (legacy deep link **`subsection=activity`** → **dashboard**) |
| `register` | register | Back Office **POS** tab → subsection **Register** — launchpad only (**Enter POS** → `PosShell`) |
| `customers` | all, add, rms-charge, duplicate-review | `CustomersWorkspace` (**RMS charge** → **`RmsChargeAdminSection`**, **`customers.rms_charge`**), `CustomerRelationshipHubDrawer` (hub tabs gated by **`customers.*`** / **`orders.view`** — **`docs/CUSTOMER_HUB_AND_RBAC.md`**) |
| `alterations` | queue | `AlterationsWorkspace` |
| `orders` | open, all | `OrdersWorkspace` |
| `inventory` | list, add, receiving, categories, discount_events, import, vendors, physical | `InventoryWorkspace` |
| `weddings` | action-board, parties, calendar | `WeddingManagerApp` |
| `gift-cards` | inventory, issue-purchased, issue-donated | `GiftCardsWorkspace` |
| `loyalty` | eligible, adjust, settings | `LoyaltyWorkspace` |
| `staff` | team, tasks, schedule, roles, discounts, access, pins, commission, audit | `StaffWorkspace` |
| `qbo` | connection, mappings, staging, history | `QboWorkspace` |
| `appointments` | scheduler, conflicts | `SchedulerWorkspace` |
| `reports` | (none) | `ReportsWorkspace` — curated `/api/insights/*` (+ CRM RMS list) library; **`insights.view`** tab; Admin-only margin pivot |
| `dashboard` | (none; Insights opens `InsightsShell` + Metabase iframe) | — |
| `settings` | profile, general, backups, integrations (weather, Podium, **Meilisearch** reindex — **`settings.admin`**), **bug-reports** (**`BugReportsSettingsPanel`**, **`settings.admin`** — **`docs/PLAN_BUG_REPORTS.md`**), **online-store** (**`OnlineStoreSettingsPanel`**, **`online_store.manage`** / **`settings.admin`**; GrapesJS Studio lazy chunk — **`docs/ONLINE_STORE.md`**) | `SettingsWorkspace` |

Shared chrome: `Sidebar`, `Header` (optional **Report a bug** opens **`BugReportFlow`** via `App.tsx`), `GlobalSearchDrawerHost`, `CloseRegisterModal` (when session open).

**`/api/insights/rms-charges`:** register-wide RMS/R2S ledger export (**`record_kind`** charge vs payment) for **insights.view**; consumed by Metabase, NL tooling, etc. **POS → Reports** and **Customers → RMS charge** use other read paths — **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`**.

## POS mode (`PosShell.tsx`)

| POS rail tab | Component |
|--------------|-----------|
| `dashboard` | `RegisterDashboard` (requires open session) |
| `register` / `weddings` | `RegisterOverlay` or `Cart` (search **PAYMENT** → R2S **payment** line; server **Park** via `posParkedSales`; optional **`VITE_POS_OFFLINE_CARD_SIM`** — **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`**) |
| `tasks` | `RegisterTasksPanel` |
| `inventory` | `ProcurementHub` |
| `alterations` | `AlterationsWorkspace` |
| `reports` | `RegisterReports` |
| `gift-cards` / `loyalty` | `RegisterLookupHub` |
| `settings` | `RegisterSettings` |

Modals: `CloseRegisterModal`, `RegisterShiftHandoffModal`.

## Density classes (`AppMainColumn`)

`density-compact`: register, customers, alterations, orders (POS-adjacent).  
`density-standard`: all other back-office tabs.

## Code splitting (`App.tsx`)

Lazy-loaded (Suspense): Inventory, QBO, Wedding Manager (Back Office tab), Orders, Alterations (Back Office path + **POS `PosShell` → Alterations tab**), Staff, Gift Cards, Loyalty, Settings, Scheduler. **Insights** uses **`InsightsShell`** (not lazy `InsightsWorkspace`).  
`WeddingManagerApp` remains in the main chunk when pulled in by **`WeddingShell`** unless that path is also code-split.

## Full sweep (round 2) — overlay / drawer a11y

Shared pattern: [`useDialogAccessibility`](src/hooks/useDialogAccessibility.ts) (focus trap, Tab cycle, Escape where appropriate, focus restore on close) plus `role="dialog"` / `aria-modal` / `aria-labelledby` on modal panels.

Applied to: `PriceOverrideModal`, `RegisterCashAdjustModal`, `RegisterXReportModal`, `OrderAttributionModal`, `CustomerProfileCompletionModal`, `PosCustomerMeasurementsDrawer`, `CloseRegisterModal` (all steps), `RegisterOverlay` (including dev bypass states), merge modal in `CustomersWorkspace`, refund modal in `OrdersWorkspace`, edit modal in `StaffWorkspace` (+ `useShellBackdropLayer`), QBO staging drill-down in `QboWorkspace` (+ `useShellBackdropLayer`), [`DetailDrawer`](src/components/layout/DetailDrawer.tsx) (unique `titleId` via hook; duplicate Escape handler removed in favor of trap).

### Wedding Manager (embedded) — wiring only, no visual redesign

- [`context/ModalContext.jsx`](src/components/wedding-manager/context/ModalContext.jsx): salesperson picker Promise now uses a **ref** for `resolve` + boolean `isOpen` state, so **`onClose` / `onSelect` are always wired to the correct pending promise** (avoids stale `salespersonModalConfig` when the shell re-renders during socket updates). Confirm no longer calls `onClose()` after `onSelect` (single settle path).
- [`components/GlobalModal.jsx`](src/components/wedding-manager/components/GlobalModal.jsx): **`type="button"`** on actions, **Escape** (confirm → cancel, alert → OK), minimal `role="dialog"` / `aria-labelledby` (same layout/classes).
- [`components/SelectSalespersonModal.jsx`](src/components/wedding-manager/components/SelectSalespersonModal.jsx): **`type="button"`**, **Escape** closes, close icon **`aria-label`**, confirm only calls `onSelect` (parent settles + closes).
- **All embedded Wedding Manager `*.jsx`:** every `<button>` now has an explicit **`type`** (`button` or `submit` where the control is the form primary). Prevents accidental form submission when styling or layout wraps actions in `<form>`.

## Build / E2E baseline

- `npm run build` (tsc + vite): run from `client/` before releases. **Last verified:** passes locally.
- `E2E_BASE_URL=http://localhost:5173 npm run test:e2e`: requires Vite on `5173` and API (e.g. repo root `npm run dev`). Without a running dev server, Playwright fails with `ERR_CONNECTION_REFUSED`. Full suite: prefer **`npx playwright test --workers=1`** from `client/` when debugging ordering flakes. Register shell + tab stability: **`RegisterSessionBootstrap`** (see **`docs/ROS_UI_CONSISTENCY_PLAN.md`** Phase 5). Snapshot refresh: **`npm run test:e2e:update-snapshots`**.
- **Spec ↔ surface map:** **`docs/E2E_REGRESSION_MATRIX.md`** (maintain when adding **`client/e2e/*.spec.ts`**). Quick link from **`client/e2e/README.md`**.
