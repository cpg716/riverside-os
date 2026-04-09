---
title: ROS UI consistency (full-app pass)
status: phase-5-complete-2026-04-08
source: Mirrors the Cursor plan for implementation tracking. Phases 1–5 are complete; guest `/shop` remains deferred (see table).
---

# ROS brand, typography, and theme consistency (full-app pass)

## Scope: every section and screen

This project is a **complete product sweep**, not only shared primitives. Work proceeds in **two layers**:

1. **Foundation** (once): theme wiring, typography utilities, shared overlays—so every screen follows the same contracts.
2. **Exhaustive surfaces**: every row in [`client/UI_WORKSPACE_INVENTORY.md`](../client/UI_WORKSPACE_INVENTORY.md), **all** POS rail destinations and their modals, and **every** file under [`client/src/components/wedding-manager/`](../client/src/components/wedding-manager/) (token/dark fixes only). **Public guest `/shop`** ([`PublicStorefront.tsx`](../client/src/components/storefront/PublicStorefront.tsx)) is **out of scope for now**—no active consistency pass until product priorities it.

Order of execution: **foundation → Back Office → POS → WM tree → QA** (storefront when needed).

## Implementation status (review — 2026-04-08)

| Area | Status | Notes |
|------|--------|--------|
| Theme + Tailwind `dark:` | **Done** | `darkMode: ["selector", '[data-theme="dark"]']`; [`rosDocumentTheme.ts`](../client/src/lib/rosDocumentTheme.ts). Staff shell is the focus; `/shop` may still read shared theme from storage when someone visits the guest app—**not** maintaining storefront UI right now. |
| Typography utilities + docs | **Done** | `ui-type-chrome` / `ui-type-instruction` / `ui-type-title`; `UI_STANDARDS.md` + `CLIENT_UI_CONVENTIONS.md`. |
| Shared overlays | **Done** | Confirmation/Prompt/DetailDrawer/Toast patterns applied. |
| Layout chrome | **Done** | Header (incl. global search hints), Sidebar badges, register modals (`RegisterRequiredModal`, `RegisterPickModal`), token-based shell. |
| Back Office workspaces | **Done** * | Major surfaces use app tokens; inventory (**`InventoryControlBoard`**, **`MatrixHubGrid`**) got explicit typography + dark fixes. Other tabs were grepped clean for `bg-white` / `text-[7px|8px]` on TSX workspaces. |
| POS (`pos/*`, rails) | **Done** * | Nexo/Cart/WeddingLookup/VariantSelection/ProductIntelligence/Stripe sim/SmartButton + settings Counterpoint pill; **`text-[7px]` / `text-[8px]`** removed repo-wide under `client/src/**/*.{tsx,jsx}`. Intentional **`bg-white/alpha`** on dark POS heroes (e.g. receipt summary) kept. |
| Wedding Manager tree | **Mostly done** | Bulk `bg-white` / `text-navy-*` → app tokens; **`PartyDetail`** top bar and several call sites use neutral/white-opacity + `text-app-*` where Phase 5 optional pass landed. **Residual:** many **`bg-navy-900`** / **`navy-*`** brand blocks elsewhere in WM (dashboard tabs, modals, calendars)—leave unless a screen needs dark-mode legibility. |
| Public `/shop` | **Deferred** | **No active work.** Any existing `--sf-*` / theme wiring in the repo is incidental; do not schedule storefront typography or QA for this initiative until product asks. |
| Status tokens | **Done** | `ui-caution-text`, `ui-info-text`, `ui-positive-text` in `index.css`; migrated at high-traffic call sites during sweeps. |
| Phase 5 QA | **Done** | `npm run build` green; Playwright **`client/e2e/`** full suite (**`E2E_BASE_URL=http://localhost:5173`**, **`E2E_API_BASE`** as needed) with register session + API up; visual snapshots refreshed; shell routing fix in [`RegisterSessionBootstrap.tsx`](../client/src/components/layout/RegisterSessionBootstrap.tsx) (no repeated `applyShellForLoggedInRole` for the same open session). See **Phase 5** section below. |

\*Treat as “implementation complete for the automated/token sweep”; product owners should still spot-check high-value flows (checkout, QBO staging, customer hub) in both themes.

## Implementation todos (checklist)

- [x] Fix Tailwind `darkMode` to follow `data-theme` (selector strategy); document in `docs/CLIENT_UI_CONVENTIONS.md`
- [x] Add `ui-type-chrome` / `ui-type-instruction` (+ title guidance) in `client/src/index.css`; update `UI_STANDARDS.md` / `docs/CLIENT_UI_CONVENTIONS.md`
- [x] Shared overlays: `ConfirmationModal` + `PromptModal` body typography; `PromptModal` `aria-describedby`; `DetailDrawer` subtitle; toast dismiss `aria-label`
- [x] Full pass: Header, Sidebar, `AppMainColumn`, global search host, `RegisterRequiredModal` / `RegisterPickModal`, shell toasts (theme + instructional type)
- [x] Full pass: BO tabs per `UI_WORKSPACE_INVENTORY` (incremental + grep baseline; inventory panels explicitly hardened)
- [x] Full pass: `PosShell` destinations + `pos/*` modals/drawers for typography tokens and `8px` hygiene (see table above)
- [x] Wedding `wedding-manager/**/*.jsx` token sweep (bulk) + targeted legibility; **leave** deliberate navy/gold brand chrome unless spec changes
- [ ] **Deferred:** `/shop` / `PublicStorefront` UI consistency (not a current priority)
- [x] `ui-caution-text` / `ui-info-text` / `ui-positive-text` in `index.css`
- [x] Phase 5: production build + Playwright (`5173` + API); visual baselines + snapshot refresh; E2E stabilization (sign-in, POS cashier dialog, QBO/Staff nav, Podium Settings, **`NumericPinKeypad`** `data-testid`s); **`RegisterSessionBootstrap`** session-id gate for admin shell routing; optional WM `text-navy-*` / PartyDetail hero token pass
- [ ] **Ongoing:** If you add dense typography or surfaces that bypassed the sweep, periodically grep `text-[7px]`, `text-[8px]`, and unjustified `bg-white` under `client/src/components/` (allowlist print, POS glass strips, importer inversion panel per Phase 5 notes below)

## Goals

- **Typographic roles:** “chrome” (dense uppercase labels) vs “reading” (instructions, confirm bodies, compliance, multi-line hints).
- **Theme:** `light | dark | system` with **one** activation story; **`dark:`** utilities and **`--app-*`** variables must agree.
- **Brand:** strengthen consistency **within** ROS **staff** app (guest `/shop` deferred); **Wedding Manager** keeps layout/behavior, **only** light/dark-safe surfaces and mechanical token swaps (except explicit brand ornaments).
- **Method:** extend `client/src/index.css` and docs—**not** a full `ui-shadcn` takeover of the staff app.

## Theme plumbing (resolved)

[`client/src/App.tsx`](../client/src/App.tsx) applies theme via [`client/src/lib/rosDocumentTheme.ts`](../client/src/lib/rosDocumentTheme.ts). [`client/tailwind.config.js`](../client/tailwind.config.js) uses **`darkMode: ["selector", '[data-theme="dark"]']`** so **`dark:`** matches `data-theme` on `<html>`.

**Standard:** Documented in [`docs/CLIENT_UI_CONVENTIONS.md`](CLIENT_UI_CONVENTIONS.md). Do not reintroduce `darkMode: "class"` without also toggling `.dark` on `<html>`.

## Phase 1 — Typography utilities + documentation

| Utility | Role |
|---------|------|
| `ui-type-chrome` | Short labels, chips, table headers, keypad hints |
| `ui-type-instruction` | Paragraphs, tooltips, legal/compliance, long confirm copy |
| `ui-type-title` (optional) | Strong titles; **don’t** force uppercase on proper names |

Update [`docs/CLIENT_UI_CONVENTIONS.md`](CLIENT_UI_CONVENTIONS.md) and [`UI_STANDARDS.md`](../UI_STANDARDS.md): **multi-line or sentence-level content must use instruction utilities**, not chrome.

## Phase 2 — Shared primitives (apply before per-screen edits)

- [`client/src/components/ui/ConfirmationModal.tsx`](../client/src/components/ui/ConfirmationModal.tsx) — reading body.
- [`client/src/components/ui/PromptModal.tsx`](../client/src/components/ui/PromptModal.tsx) — reading body + `aria-describedby`.
- [`client/src/components/layout/DetailDrawer.tsx`](../client/src/components/layout/DetailDrawer.tsx) — subtitle size/case floor.
- [`client/src/components/ui/ToastProvider.tsx`](../client/src/components/ui/ToastProvider.tsx) — dismiss `aria-label`.

## Phase 3 — Full workspace checklist (mandatory)

For **each** primary component below: (a) fix misclassified instructional copy (`7px`/`8px` uppercase paragraphs, confirm-adjacent hints); (b) replace **hardcoded** `bg-white` / `text-navy-*` (non-WM) / raw neutrals where they break dark mode—prefer `bg-app-surface`, `text-app-text`, existing `ui-*`; (c) ensure status callouts use shared helpers where `ui-caution-text` / `ui-info-text` apply.

### Layout / global chrome

- [`Header.tsx`](../client/src/components/layout/Header.tsx), [`Sidebar.tsx`](../client/src/components/layout/Sidebar.tsx), `AppMainColumn` in `App.tsx`, global search / `GlobalSearchDrawer`, [`RegisterRequiredModal.tsx`](../client/src/components/layout/RegisterRequiredModal.tsx), [`RegisterPickModal.tsx`](../client/src/components/layout/RegisterPickModal.tsx), notification drawer shell, [`HelpCenterDrawer.tsx`](../client/src/components/help/HelpCenterDrawer.tsx).

### Back Office (by sidebar tab)

| Tab | Primary surfaces to open and pass |
|-----|-----------------------------------|
| `home` | `OperationalHome` and nested dashboards/cards |
| `register` | BO launchpad only (Enter POS)—`RegisterOverlay` / launch UI as wired in App |
| `customers` | `CustomersWorkspace`, `CustomerRelationshipHubDrawer`, `RmsChargeAdminSection`, `DuplicateReviewQueueSection`, `ShipmentsHubSection`, merge/drawer flows |
| `alterations` | `AlterationsWorkspace` (BO path) |
| `orders` | `OrdersWorkspace`, refund/void modals, detail panels |
| `inventory` | `InventoryWorkspace`, `InventoryControlBoard`, `ProductHubDrawer`, `ReceivingBay`, `UniversalImporter`, vendor/physical subflows |
| `weddings` | BO `WeddingManagerApp` host frame (chrome); **embedded subtree** in WM section below |
| `gift-cards` | `GiftCardsWorkspace` |
| `loyalty` | `LoyaltyWorkspace` |
| `staff` | `StaffWorkspace`, schedule, tasks, commission, PIN/access modals |
| `qbo` | `QboWorkspace`, staging drill-down modals |
| `appointments` | `SchedulerWorkspace`, [`AppointmentModal.tsx`](../client/src/components/scheduler/AppointmentModal.tsx) |
| `dashboard` | `InsightsShell` / Metabase embed chrome |
| `settings` | `SettingsWorkspace` and **all** nested panels (profile, general, backups, integrations: weather, Podium, Meilisearch, Counterpoint, online store, help center, insights integration, etc.) |

### POS mode (`PosShell`)

Pass **every** rail tab from [`client/UI_WORKSPACE_INVENTORY.md`](../client/UI_WORKSPACE_INVENTORY.md): `RegisterDashboard`, `Cart` / `RegisterOverlay`, `RegisterTasksPanel`, `ProcurementHub`, `AlterationsWorkspace` (POS path), `RegisterReports`, `RegisterLookupHub`, `RegisterSettings`.

Pass **all** POS modals/drawers (glob `client/src/components/pos/*Modal*.tsx` and `*Drawer*.tsx`): e.g. `NexoCheckoutDrawer`, `CloseRegisterModal`, `RegisterShiftHandoffModal`, `ReceiptSummaryModal`, `VariantSelectionModal`, `PriceOverrideModal`, `RegisterCashAdjustModal`, `RegisterGiftCardLoadModal`, `PosShippingModal`, `CustomerProfileCompletionModal`, `OrderAttributionModal`, `RegisterXReportModal`, `PosCustomerMeasurementsDrawer`, `WeddingLookupDrawer`, etc.

**Nexo checkout:** keep tender grid / numpad / **Complete Sale** chrome; **reading-class** content uses instruction utilities (Pub 718-C note, deposit instructions, wedding linked banner).

### Wedding Manager (embedded) — full file tree

- Mechanical **`bg-white` → `bg-app-surface`** (or `app-surface-2`), **`text-navy-*` → `text-app-text` / muted** where text is **semantic body**, not a **fixed brand** block.
- **Brand ornaments** (navy header bands, gold accents, gradient hero): **in scope only** if they break contrast in dark mode; otherwise leave per “no layout redesign.”
- **Phase 5 optional pass (done for listed files):** `OrderChecklistModal`, `OrderReviewTab`, `Dashboard.jsx` (icon), `ActionDashboard`, `ManageSalespeopleModal`, `PartyDetail.jsx` (header strip + chips), `utils.js` highlight—remaining `navy-*` elsewhere still **brand-by-design** until a screen needs contrast work.

### Public storefront (`/shop`) — **deferred**

Not part of this plan until product prioritizes it. Re-open this section when `/shop` needs a typography or theme pass; until then, avoid churn under `client/src/components/storefront/`.

## Phase 4 — Semantic status helpers

Shared classes `ui-caution-text`, `ui-info-text`, `ui-positive-text` in `index.css`; migrate repeated light+dark pairs **as each workspace is touched**.

## Phase 5 — QA (per screen, not spot-check) — **completed 2026-04-08**

### Product / shell

- **`RegisterSessionBootstrap`:** With an **open till**, `applyShellForLoggedInRole` (admin → Operations home) runs only when the **register `session_id` changes** (new attach or pick), not on every `runBootstrap` re-run—fixes flaky QBO/Staff E2E when a till stayed open. With **no till**, the same shell step is **deduped** by staff credentials + role so navigating to **Reports** (or other tabs) is not undone by the next poll. Transient fetch errors do not clear routing via the bootstrap `catch` path (toast in prod only).

### Build + automated tests

- **`cd client && npm run build`** (tsc + Vite) — required gate.
- Playwright [`client/e2e/`](../client/e2e/): **`E2E_BASE_URL=http://localhost:5173`** (prefer **`localhost`** over `127.0.0.1` for browser); **`E2E_API_BASE=http://127.0.0.1:3000`** when the API is separate. Full suite: **`npx playwright test --workers=1`** for stable ordering under load. Snapshot refresh: **`npm run test:e2e:update-snapshots`**. Visual specs use small **`maxDiffPixelRatio`** where live data (operations/inventory) shifts pixels between runs. **Spec/workspace inventory:** [`docs/E2E_REGRESSION_MATRIX.md`](E2E_REGRESSION_MATRIX.md).
- **Notable E2E touchpoints:** `backofficeSignIn.ts` (`effective-permissions` waits); `openPosRegister.ts` (cashier overlay = `getByRole("dialog", { name: /cashier for this sale/i })`); `NumericPinKeypad` **`pin-key-0`…`pin-key-del`**; `qbo-staging` poll until “Financial bridge panel”; `podium-settings` Settings + breadcrumb poll; `staff-tasks` timeouts; `visual-baselines` nav-scoped clicks + headings before screenshots.

### Manual (still recommended for releases)

- With theme in **light**, **dark**, and **system** (forced OS dark): spot-check high-value flows from Phase 3 (checkout, QBO staging, customer hub, register open/close).

### Repo hygiene (ongoing)

- Periodically grep `text-[7px]`, `text-[8px]`, and unjustified `bg-white` under `client/src/components/` (allowlisted: print layouts, dark-glass POS strips, UniversalImporter “review” inversion panel). Phase 5 grep showed remaining **`7px`/`8px`** mostly in shadows/min-heights, not illegal label tiers.

## What we are not doing

- **Guest storefront** (`/shop`, `PublicStorefront`) for this initiative—explicitly **deferred**.
- Full **shadcn** migration of staff/POS.
- **Visual redesign** of Wedding Manager (layout, gold/navy brand blocks, component structure)—token fixes only where readability requires it.
- Flattening POS density globally—only **reclassify** instructional/legal text.
