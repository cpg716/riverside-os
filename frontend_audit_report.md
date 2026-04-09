# Riverside OS — Frontend Audit Report (Full Codebase)

**Date:** 2026-04-04 (note: **2026-04-08** — **`BugReportFlow`** navigation context in **`client_meta`**, Settings **Bug reports** admin UI + triage (**`dismissed`**, **`external_url`**) — **`docs/PLAN_BUG_REPORTS.md`**, migration **103**)  
**Role:** Principal Frontend Engineer & UX Researcher  

## What “full frontend” means in this document

This report treats the **entire shipped frontend tree** as in scope:

1. **Every file** under `client/src/`, `client/e2e/`, and `client/public/` (see **Appendix A** — **159 paths**, including Playwright snapshots and PWA icons).
2. **Root tooling & entry:** `client/index.html`, `client/vite.config.ts`, `client/tailwind.config.js`, `client/postcss.config.js`, `client/playwright.config.ts`, `client/package.json`, `client/package-lock.json`, `client/tsconfig.json`.
3. **Desktop shell (Tauri 2) source** under `client/src-tauri/`, excluding build artifacts (`target/`, `gen/`): Rust entry, `hardware.rs`, `tauri.conf.json`, `capabilities/default.json`, `Cargo.toml`, `build.rs`, `rust-toolchain.toml`.

**Methodology:** For each policy (native dialogs, storage, headers, offline, popups, axios), **ripgrep was run across the full `client/src` tree** including the embedded **Wedding Manager** subtree (`*.tsx`, `*.ts`, `*.jsx`, `*.js`). Playwright specs under `client/e2e` were included for dialog patterns. **No `node_modules/` or `dist/`**.  

**What this is not:** line-by-line manual UX review of every JSX node, visual snapshot review of every screen, or Lighthouse scores. Those remain recommended follow-ups.

---

## Remediation status (verified in repo, post–2026-04-04)

The original findings below were re-checked against the current tree:

| Original theme | Current status |
|-----------------|----------------|
| Staff PIN / secrets in offline queue | **Pass** — `enqueueCheckout` persists headers only after `headersSafeForOfflinePersist()` in `client/src/lib/posRegisterAuth.ts`, which strips **`x-riverside-staff-pin`**, **`Authorization`**, and **`Cookie`** (case-insensitive). Flush merges **live** headers from `getLiveAuthHeaders`. |
| `window.open` / PWA | **Documented** — See **`REMOTE_ACCESS_GUIDE.md`** § *PWA: popup windows*. |
| Design tokens (`slate` / `zinc` / `fuchsia`) | **Improved** — POS, settings, wedding-manager subtree, and related surfaces aligned to **`app.*`** primitives where previously called out. |
| `OrderAttributionModal` headers | **OK** — Uses `mergedPosStaffHeaders` so register **POS session token** is sent for `GET /api/orders/:id` and staff list; matches server **staff or POS session** gates. |
| `ui-touch-target` | **Done** — **POS** sidebar / **Cart** / **Nexo**, **Header** menu + chevron, **Appointments** toolbar (date nav, Today, Print, New Appt, day/week toggles). |
| Wide `min-w-[…]` grids | **Done** — **Customers** / **Insights** / **scheduler** week: **`min-w-0`**, **`overflow-x-auto`**, **`overscroll-x-contain`**, breakpoint inner widths (**`min-w-[720px]`** … **`xl:min-w-[1200px]`** on week grid). |
| `axios` in wedding-manager | **N/A** — `lib/api.js` uses **`fetch`** (`wmJson`, SSE); no axios import. |

---

## Executive summary

| Area | Status | Notes |
|------|--------|--------|
| Native **`window.alert` / `confirm` / `prompt`** | **Pass** | Zero matches in `client/src/**/*.{ts,tsx,js,jsx}` and `client/e2e/*.ts`. |
| Wedding Manager “alert/confirm” | **Pass (in-app)** | `ModalContext.jsx` exposes `showAlert` / `showConfirm` as **React `GlobalModal`**, not browser APIs. |
| Staff PIN in durable storage | **Pass** | Offline queue uses **`headersSafeForOfflinePersist`** before IndexedDB write; PIN never stored; see **Remediation status** above. |
| `mergedPosStaffHeaders` | **OK for POS** | BO-only workspaces use `backofficeHeaders()` where appropriate; POS-adjacent flows merge **POS session** headers by design. |
| `ui-touch-target` (44×44) | **Good on critical paths** | **Header**, **PosShell**, **POS** cart / Nexo, plus **Appointments** toolbar (prev/next, Today, Print, day/week). Other surfaces use `ui-btn-*` / explicit mins where needed. |
| `min-w-[…]` / wide tables | **Contained** | Wide grids sit in **`min-w-0` + `overflow-x-auto` + `overscroll-x-contain`** shells (e.g. scheduler week view uses breakpoint **`min-w-[720px]` … `xl:min-w-[1200px]`** inside a horizontal scroller). |
| `window.open` | **Several** | Printing / exports / backup download; mitigated by **user-gesture** patterns + **REMOTE_ACCESS_GUIDE** documentation. |
| `axios` in app source | **None in app** | Wedding Manager **`lib/api.js`** uses **`fetch`** only. |
| PWA | **Configured** | `vite-plugin-pwa` + `public/manifest.json`; `registerType: "prompt"` in `vite.config.ts`. |
| Tauri hardware | **Present** | ZPL + ESC/POS TCP in `hardware.rs`; client `printerBridge.ts` + `invoke`. |

---

## 1. Complete automated sweep (whole `client/src`)

### 1.1 Native browser dialogs

- **Pattern:** `\balert\s*\(`, `\bconfirm\s*\(`, `\bprompt\s*\(`
- **Scope:** `client/src/**/*.{ts,tsx,js,jsx}`
- **Result:** **No matches.**

### 1.2 Playwright tests

- **Scope:** `client/e2e/*.ts`
- **Result:** **No matches** for `alert(`, `confirm(`, `prompt(`.
- **`api-gates.spec.ts`:** asserts **401/403** on anonymous **`GET /api/products`**, **`POST /api/payments/intent`**, **`GET /api/settings/receipt`** when API is reachable; **skips** if server is down (start API + DB for full run).

### 1.3 Durable storage (`localStorage` / `sessionStorage`)

| Mechanism | Files | Keys / purpose |
|-----------|--------|----------------|
| `localStorage` | `App.tsx` | `ros.theme.mode` |
| `localStorage` | `SettingsWorkspace.tsx`, `ReceiptSummaryModal.tsx`, `RegisterSettings.tsx`, `posAudio.ts` | `ros.pos.printerIp`, `ros.pos.printerPort`, `ros.report.printerIp`, `ros.pos.autoPrint`, `ros.pos.soundProfile` |
| `sessionStorage` | `posRegisterAuth.ts` | `ros.posRegisterAuth.v1` (POS session id + token, **not** PIN) |
| `sessionStorage` | `wedding-manager/lib/api.js` | WM client id key (`WM_CLIENT_KEY` constant) |

**Staff PIN:** not stored in `localStorage` / `sessionStorage` by `BackofficeAuthContext`; risk is **offline queue** (below).

### 1.4 `localforage` / offline

| File | Role |
|------|------|
| `lib/offlineQueue.ts` | Checkout queue instance `RiversideOS` / `checkout_queue` |
| `components/pos/Cart.tsx` | `ros_pos_active_sale` local draft (hydrate-before-persist so remount does not wipe lines), cashier gate before ringing, cart hydration + **offline enqueue** |
| `components/inventory/ReceivingBay.tsx` | Comment only (“localforage batching”) — verify implementation if queue is added later |

### 1.5 `mergedPosStaffHeaders` vs `backofficeHeaders()`

**Imports / uses `mergedPosStaffHeaders`:**  
`InventoryControlBoard.tsx`, `ProductIntelligenceDrawer.tsx`, `Cart.tsx`, `GlobalSearchDrawers.tsx`, `RegisterLookupHub.tsx`, `CustomerRelationshipHubDrawer.tsx`, `CustomersWorkspace.tsx`, `Header.tsx`, `AppointmentModal.tsx`, `CustomerSelector.tsx`, `CustomerProfileCompletionModal.tsx`, `ProcurementHub.tsx`, plus definition in `lib/posRegisterAuth.ts`.

**Uses `backofficeHeaders()` only (no merge in file):**  
`StaffWorkspace.tsx`, `OrdersWorkspace.tsx`, `CommissionPayoutsPanel.tsx`, `QboWorkspace.tsx`, `StaffAccessPanels.tsx`, `PhysicalInventoryWorkspace.tsx`, `OrderAttributionModal.tsx`, `BackofficeAuthContext.tsx` (definition / permissions fetch).

*Interpretation:* BO workspaces generally do not need POS session tokens; POS-facing flows use merge. **`OrderAttributionModal`** is the main candidate to confirm against backend expectations when opened from the register.

### 1.6 `window.open` / `document.execCommand`

| File | Use |
|------|-----|
| `lib/printerBridge.ts` | Fallback print window |
| `components/inventory/labelPrint.ts` | Label window |
| `components/inventory/MatrixHubGrid.tsx` | Small window |
| `components/pos/zReportPrint.ts` | Report window |
| `components/loyalty/LoyaltyWorkspace.tsx` | Window for external view |
| `components/customers/CustomerRelationshipHubDrawer.tsx` | Blank window |
| `components/settings/SettingsWorkspace.tsx` | Backup download URL |
| `components/wedding-manager/components/OrderChecklistModal.jsx` | Blank window |

### 1.7 `axios`

- **No** `axios` import under `client/src` (Wedding Manager **`lib/api.js`** uses **`fetch`**). Rest of app uses `fetch` per project rules.

### 1.8 `ui-touch-target` usage

- **`client/src/index.css`** — class definition  
- **`Header.tsx`** — mobile menu  
- **`PosShell.tsx`** — collapsed sidebar chevron  
- **`PosSidebar.tsx`**, **`Cart.tsx`**, **`NexoCheckoutDrawer.tsx`** — register flows  
- **`SchedulerWorkspace.tsx`** — appointments toolbar (date nav, Today, Print)  

Day/week mode toggles use explicit **`min-h-[44px] min-w-[44px]`** + **`touch-manipulation`**. Other surfaces use **`ui-btn-*`** / **`min-h-11`**.

### 1.9 `min-w-[` (horizontal layout pressure)

Files with at least one `min-w-[` utility (TSX/JSX):  
`InventoryControlBoard.tsx`, `Cart.tsx`, `MatrixHubGrid.tsx`, `VendorFilterChip.tsx`, `OrdersWorkspace.tsx`, `CommissionPayoutsPanel.tsx`, `VendorHub.tsx`, `CustomerRelationshipHubDrawer.tsx`, `CustomersWorkspace.tsx`, `ProcurementHub.tsx`, `StaffAccessPanels.tsx`, `PhysicalInventoryWorkspace.tsx`, `SchedulerWorkspace.tsx`, `AppointmentScheduler.jsx`, `OrderDashboard.jsx`, `OrderReviewTab.jsx`, `PartyNotesModal.jsx`, `ReportsDashboard.jsx`, `CategoryManager.tsx`, `OperationalHome.tsx`, `QuickKeys.tsx`, `QboMappingMatrix.tsx`, `SmartButton.tsx`.

**Highest-impact:** `SchedulerWorkspace.tsx` week grid (**responsive** `min-w-[720px]` … `xl:min-w-[1200px]` inside **`overflow-x-auto`**), CRM/insights tables (**scroll shells**).

### 1.10 `@tauri-apps/api` usage

- `lib/printerBridge.ts` — `invoke`, `isTauri`  
- `components/pos/ReceiptSummaryModal.tsx` — `isTauri`  
- `components/settings/SettingsWorkspace.tsx` — dynamic `getVersion`  

---

## 2. Configuration & PWA (`client/` root)

| File | Relevance |
|------|-----------|
| `index.html` | Viewport `viewport-fit=cover`, theme-color meta, apple web-app caps, `#root` + `#drawer-root` |
| `vite.config.ts` | React plugin, PWA (`VitePWA`, `registerType: "prompt"`, Workbox `navigateFallback`, denylist `/api/`), dev manifest injection |
| `tailwind.config.js` | `app.*` semantic colors, density tokens |
| `postcss.config.js` | Tailwind pipeline |
| `playwright.config.ts` | E2E runner config |
| `package.json` / `package-lock.json` | Dependencies (e.g. `localforage`, `@tauri-apps/api`) |
| `tsconfig.json` | TS compile options |

---

## 3. Tauri shell (`client/src-tauri/`, sources only)

| File | Role |
|------|------|
| `src/main.rs` | Entry |
| `src/lib.rs` | Tauri builder, command registration |
| `src/hardware.rs` | `print_zpl_receipt`, `print_escpos_receipt`, `check_printer_connection` |
| `tauri.conf.json` / `capabilities/default.json` | Capabilities |
| `Cargo.toml` / `build.rs` / `rust-toolchain.toml` | Build |

---

## 4. Embedded Wedding Manager (`client/src/components/wedding-manager/`)

- **48+ UI/logic files** (JSX/JS/TSX/CSS) — all listed in Appendix A.
- **Dialogs:** `ModalContext.jsx` + `GlobalModal.jsx` implement confirm/alert **in React** (naming uses “alert”/“confirm” types — **not** `window.*`).
- **Network:** `lib/api.js` uses **`fetch`** (`wmJson`, streaming events) against the ROS API base URL.
- **Storage:** `sessionStorage` for WM client id in `lib/api.js`.
- **Responsive:** separate `MemberListMobile.jsx` vs `MemberListDesktop.jsx`; additional `min-w-[` in several WM components (see §1.9).

---

## 5. Cross-cutting UX themes (unchanged substance, full-tree basis)

### 5.1 Responsiveness

- Tailwind + `index.css` shell primitives support multi-breakpoint layouts; **wide week grids** (scheduler, CRM, insights) rely on **horizontal scroll** wrappers rather than forcing viewport width.

### 5.2 Touch targets

- **`ui-touch-target`** and explicit **`min-h-[44px]`** / **`touch-manipulation`** cover **shell**, **register**, and **appointments** primary controls; remaining surfaces follow **`ui-btn-*`** sizing.

### 5.3 Theme / primitives

- `ui-input`, `ui-card`, `ui-btn-*` are used heavily in modern TSX surfaces; **legacy** areas (insights inputs, vendor hub, much of wedding-manager) use **slate/white**-style classes — dark-mode and token consistency vary by folder.

### 5.4 Offline queue security

`Cart.tsx` passes `apiAuth()` into `enqueueCheckout`. **`enqueueCheckout`** stores only **`headersSafeForOfflinePersist(authHeaders)`**, which omits **`x-riverside-staff-pin`**, **`Authorization`**, and **`Cookie`**. **`flushCheckoutQueue`** merges **live** headers from the callback so PIN/token can be supplied at sync time without durable storage of secrets.

---

## 6. Prioritized recommendations

1. ~~**Remove PIN from offline queue snapshots**~~ — **Done** (`headersSafeForOfflinePersist` + live merge on flush).  
2. ~~**Reduce or breakpoint-gate** wide grids~~ — **Done** for **scheduler week** (scroll shell + responsive `min-w-[720px]` … `xl:min-w-[1200px]`); CRM/insights use scroll shells from prior pass.  
3. ~~**Expand** `ui-touch-target`~~ — **Done** for **Appointments** header actions (nav, Today, Print, New Appt, day/week) plus earlier POS/header work.  
4. ~~**Align** `OrderAttributionModal` headers~~ — **Verified** (merged headers for register order reads).  
5. ~~**Document** `window.open` flows for PWA~~ — **Done** (`REMOTE_ACCESS_GUIDE.md`).  
6. ~~**Optional:** migrate `wedding-manager/lib/api.js` from axios to `fetch`~~ — **N/A**: `api.js` already uses **`fetch`** via `wmJson` / SSE; axios is not imported in app source (only transitive deps).

---

## Appendix A — Complete file manifest (`client/src`, `client/e2e`, `client/public`)

**159 paths** (repo-relative). *Generated via `find` on 2026-04-04; includes binaries (PNG/JPG) and Playwright snapshot PNGs.*

```
client/e2e/api-gates.spec.ts
client/e2e/pos-golden.spec.ts
client/e2e/pwa-responsive.spec.ts
client/e2e/qbo-staging.spec.ts
client/e2e/visual-baselines.spec.ts
client/e2e/visual-baselines.spec.ts-snapshots/customers-workspace-chromium-darwin.png
client/e2e/visual-baselines.spec.ts-snapshots/inventory-dark-chromium-darwin.png
client/e2e/visual-baselines.spec.ts-snapshots/operations-command-center-chromium-darwin.png
client/e2e/visual-baselines.spec.ts-snapshots/qbo-workspace-chromium-darwin.png
client/e2e/visual-baselines.spec.ts-snapshots/register-closed-chromium-darwin.png
client/public/icon-192.png
client/public/icon-512.png
client/public/manifest.json
client/src/App.tsx
client/src/clientBuildMeta.ts
client/src/components/customers/CustomerRelationshipHubDrawer.tsx
client/src/components/customers/CustomersWorkspace.tsx
client/src/components/gift-cards/GiftCardsWorkspace.tsx
client/src/components/inventory/CameraScanner.tsx
client/src/components/inventory/CategoryManager.tsx
client/src/components/inventory/InventoryBulkBar.tsx
client/src/components/inventory/InventoryControlBoard.tsx
client/src/components/inventory/InventoryWorkspace.tsx
client/src/components/inventory/MatrixBuilder.tsx
client/src/components/inventory/MatrixHubGrid.tsx
client/src/components/inventory/PhysicalInventoryWorkspace.tsx
client/src/components/inventory/ProductHubDrawer.tsx
client/src/components/inventory/ProductMasterForm.tsx
client/src/components/inventory/PurchaseOrderPanel.tsx
client/src/components/inventory/ReceivingBay.tsx
client/src/components/inventory/UniversalImporter.tsx
client/src/components/inventory/VendorFilterChip.tsx
client/src/components/inventory/VendorHub.tsx
client/src/components/inventory/labelPrint.ts
client/src/components/layout/DetailDrawer.tsx
client/src/components/layout/GlobalSearchDrawers.tsx
client/src/components/layout/Header.tsx
client/src/components/layout/InsightsShell.tsx
client/src/components/layout/PosShell.tsx
client/src/components/layout/PwaUpdatePrompt.tsx
client/src/components/layout/ShellBackdropContext.tsx
client/src/components/layout/Sidebar.tsx
client/src/components/layout/WeddingShell.tsx
client/src/components/loyalty/LoyaltyWorkspace.tsx
client/src/components/operations/CompassMemberDetailDrawer.tsx
client/src/components/operations/OperationalHome.tsx
client/src/components/orders/OrdersWorkspace.tsx
client/src/components/pos/Cart.tsx
client/src/components/pos/CloseRegisterModal.tsx
client/src/components/pos/CustomerProfileCompletionModal.tsx
client/src/components/pos/CustomerSelector.tsx
client/src/components/pos/LoyaltyRewardModal.tsx
client/src/components/pos/NexoCheckoutDrawer.tsx
client/src/components/pos/OrderAttributionModal.tsx
client/src/components/pos/PosSidebar.tsx
client/src/components/pos/PriceOverrideModal.tsx
client/src/components/pos/ProcurementHub.tsx
client/src/components/pos/ProductIntelligenceDrawer.tsx
client/src/components/pos/QuickKeys.tsx
client/src/components/pos/ReceiptSummaryModal.tsx
client/src/components/pos/RegisterCashAdjustModal.tsx
client/src/components/pos/RegisterLookupHub.tsx
client/src/components/pos/RegisterOverlay.tsx
client/src/components/pos/RegisterReports.tsx
client/src/components/pos/RegisterSettings.tsx
client/src/components/pos/RegisterXReportModal.tsx
client/src/components/pos/StripeReaderSimulation.tsx
client/src/components/pos/VariantSelectionModal.tsx
client/src/components/pos/WeddingLookupDrawer.tsx
client/src/components/pos/customerProfileTypes.ts
client/src/components/pos/zReportPrint.ts
client/src/components/qbo/QboMappingMatrix.tsx
client/src/components/qbo/QboWorkspace.tsx
client/src/components/scheduler/AppointmentModal.tsx
client/src/components/scheduler/SchedulerWorkspace.tsx
client/src/components/settings/QBOMapping.tsx
client/src/components/settings/SettingsWorkspace.tsx
client/src/components/staff/StaffAccessPanels.tsx
client/src/components/staff/CommissionPayoutsPanel.tsx
client/src/components/staff/StaffWorkspace.tsx
client/src/components/ui/ConfirmationModal.tsx
client/src/components/ui/FloatingBulkBar.tsx
client/src/components/ui/PromptModal.tsx
client/src/components/ui/SidebarRailTooltip.tsx
client/src/components/ui/SmartButton.tsx
client/src/components/ui/ToastProvider.tsx
client/src/components/wedding-manager/App.test.jsx
client/src/components/wedding-manager/WeddingManagerApp.tsx
client/src/components/wedding-manager/assets/riverside_logo.jpg
client/src/components/wedding-manager/components/ActionCard.jsx
client/src/components/wedding-manager/components/ActionDashboard.jsx
client/src/components/wedding-manager/components/AddPartyModal.jsx
client/src/components/wedding-manager/components/AppointmentModal.jsx
client/src/components/wedding-manager/components/AppointmentScheduler.jsx
client/src/components/wedding-manager/components/CalendarView.jsx
client/src/components/wedding-manager/components/ChangeSalespersonModal.jsx
client/src/components/wedding-manager/components/ContactEditModal.jsx
client/src/components/wedding-manager/components/ErrorBoundary.jsx
client/src/components/wedding-manager/components/GlobalModal.jsx
client/src/components/wedding-manager/components/Icon.jsx
client/src/components/wedding-manager/components/ImportDataModal.jsx
client/src/components/wedding-manager/components/LightspeedPanel.jsx
client/src/components/wedding-manager/components/ManageSalespeopleModal.jsx
client/src/components/wedding-manager/components/MeasurementInfoModal.jsx
client/src/components/wedding-manager/components/MemberAppointmentsModal.jsx
client/src/components/wedding-manager/components/MemberDetailModal.jsx
client/src/components/wedding-manager/components/MemberListDesktop.jsx
client/src/components/wedding-manager/components/MemberListMobile.jsx
client/src/components/wedding-manager/components/OrderChecklistModal.jsx
client/src/components/wedding-manager/components/OrderDashboard.jsx
client/src/components/wedding-manager/components/OrderInfoModal.jsx
client/src/components/wedding-manager/components/OrderReviewTab.jsx
client/src/components/wedding-manager/components/PartyDetail.jsx
client/src/components/wedding-manager/components/PartyHistoryModal.jsx
client/src/components/wedding-manager/components/PartyList.jsx
client/src/components/wedding-manager/components/PartyNotesModal.jsx
client/src/components/wedding-manager/components/PickupModal.jsx
client/src/components/wedding-manager/components/PrintPartyView.jsx
client/src/components/wedding-manager/components/ReportsDashboard.jsx
client/src/components/wedding-manager/components/ReportsTab.jsx
client/src/components/wedding-manager/components/SchedulerModal.jsx
client/src/components/wedding-manager/components/SelectSalespersonModal.jsx
client/src/components/wedding-manager/components/SettingsModal.jsx
client/src/components/wedding-manager/components/Skeleton.jsx
client/src/components/wedding-manager/components/StockStatusModal.jsx
client/src/components/wedding-manager/components/StyleEditModal.jsx
client/src/components/wedding-manager/components/UserGuideTab.jsx
client/src/components/wedding-manager/context/ModalContext.jsx
client/src/components/wedding-manager/hooks/useDashboardActions.js
client/src/components/wedding-manager/hooks/useModal.js
client/src/components/wedding-manager/index.css
client/src/components/wedding-manager/lib/api.js
client/src/components/wedding-manager/lib/dataUtils.js
client/src/components/wedding-manager/lib/partyLegacy.js
client/src/components/wedding-manager/lib/utils.js
client/src/components/wedding-manager/main.jsx
client/src/components/wedding-manager/pages/Dashboard.jsx
client/src/components/wedding-manager/pages/PrintPage.jsx
client/src/components/wedding-manager/setupTests.js
client/src/context/BackofficeAuthContext.tsx
client/src/hooks/useScanner.ts
client/src/index.css
client/src/lib/apiUrl.ts
client/src/lib/money.ts
client/src/lib/offlineQueue.ts
client/src/lib/parseCsv.ts
client/src/lib/posAudio.ts
client/src/lib/posRegisterAuth.ts
client/src/lib/printerBridge.ts
client/src/lib/scanSounds.ts
client/src/lib/staffPermissions.ts
client/src/lib/utils.ts
client/src/lib/weddingApi.ts
client/src/lib/weddingPartyApiShape.ts
client/src/lib/weddingPartyDisplay.ts
client/src/lib/weddingPosBridge.ts
client/src/main.tsx
client/src/types/weddings.ts
client/src/vite-env.d.ts
```

---

## Appendix B — Root + Tauri source files (not duplicated above)

```
client/index.html
client/vite.config.ts
client/tailwind.config.js
client/postcss.config.js
client/playwright.config.ts
client/package.json
client/package-lock.json
client/tsconfig.json
client/src-tauri/Cargo.toml
client/src-tauri/build.rs
client/src-tauri/capabilities/default.json
client/src-tauri/rust-toolchain.toml
client/src-tauri/src/hardware.rs
client/src-tauri/src/lib.rs
client/src-tauri/src/main.rs
client/src-tauri/tauri.conf.json
```

---

*End of report.*
