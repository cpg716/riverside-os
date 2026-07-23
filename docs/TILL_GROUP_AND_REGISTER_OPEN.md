# Till close group, multi-lane register, and open-register UX

Operational and engineering reference for **migration 66** (register lanes) and **migration 67** (`till_close_group_id`): one **physical cash drawer** (Register **#1**), optional **satellite** lanes (**#2+**), **combined Z-close**, and **Back Office** behaviors.

## Model (short)

- **`register_sessions.register_lane`**: physical terminal label (**1: Main**, **2: iPad**, **3: Back Office**). Range restricted to 1–3. Each open lane is its own row with its own `session_id` and **`pos_api_token`**.
- **`register_sessions.till_close_group_id`**: links all lanes that share one till shift. **Register #1 (Main)** opening **automatically creates** sessions for **#2 (iPad)** and **#3 (Back Office)** with zero float, sharing one `till_close_group_id`. Satellites do not need to be opened separately.
- **Cash drawer math (Z)**: **Opening float**, **paid in/out**, and **expected/actual cash** apply only to **lane 1**. **Cash tenders** on any lane in the group **sum** into that one expected cash figure.
- **Z-close**: Only from **register 1** in the UI. Every Z-report is bound to exactly one store-local **business date**. If an open till group contains activity from multiple unclosed dates, **`close_session`** closes the oldest date first and leaves the till group open until staff completes each later date separately; days are never combined. The final pending date closes every open session in the same **`till_close_group_id`**. Satellite lanes have **no** separate “Close register” button in POS. The three-page close flow (**Cash → Checks → Z-Report**) can be canceled before finalization without closing the drawer. **Parked carts (migration 68):** any **`pos_parked_sale`** rows still **parked** for lanes in that till group are marked **deleted** only when the final business date closes the group — see **[`POS_PARKED_SALES_AND_RMS_CHARGES.md`](./POS_PARKED_SALES_AND_RMS_CHARGES.md)**.
- **Card close review**: Helcim terminal outcomes needing review remain visible in the POS close flow. Recording an outcome creates a **`helcim_terminal_recovery_actions`** audit row; it does not create a payment, refund, or ledger mutation. If an outcome remains unresolved, ordinary authorized close stays available and freezes that warning under **Unresolved Issues at Close** in the immediate and archived Z-Report.
- **Reconciliation / Z payload**: Combined **`tenders`**, **`tenders_by_lane`**, **`transactions`**, **QBO journal preview**, and non-sale **`inventory_activity`** include **`register_lane`** (and optional **`register_session_id`**) for print and audit.

## APIs (pointers)

- **`POST /api/sessions/open`** — lane 1 vs satellite rules; **`primary_session_id`** when opening lane **2+**.
- **`GET /api/sessions/list-open`** — **`register.session_attach`**; used for **pick/join** when multiple lanes are open and for **satellite linking** + **admin primary check**.
- **`GET …/reconciliation`**, **`close`**, **`begin-reconcile`** — group behavior for Z from primary; see **`DEVELOPER.md`** **`/api/sessions`** row.

## Client surfaces

| Area | Behavior |
|------|----------|
| **`RegisterOverlay.tsx`** | Satellite lanes: **`list-open`**, link to open **#1**. **Admin**: if **#1** is not open, **choose** “open #1 myself” vs “another terminal opens #1” (with **Check again**). **Admin** default lane **#3** (Back Office Hub) when **#1** is already open. |
| **`PosShell.tsx`** | **Close Register** only for **lane 1** (or unknown lane). |
| **`CloseRegisterModal.tsx`** | Three-page Cash / Checks / Z-Report close, POS card review actions, combined drawer copy, **by-lane** tenders, transaction table with **Register #**; authenticated fetches (**`mergedPosStaffHeaders`**). |
| **`zReportPrint.ts`** | **Professional Audit Reports**: Decoupled from receipt hardware. Aggregated 3-lane reports use high-fidelity Letter/A4 layout, Inter/JetBrains fonts, explicit "Assigned Printer" metadata, QBO journal preview, and non-sale inventory activity. |
| **`RegisterGateContext`**, **`RegisterRequiredModal`** | **Orders** refund (and similar): **Go to Register** when **`GET /api/sessions/current`** fails. |
| **`App.tsx`** | **`RegisterGateProvider`**; Back Office close modal only when attached lane is **1** (or unknown). |

## Staff / training docs

- **Floor cashiers:** **`docs/staff/register-tab-back-office.md`**, **`docs/staff/EOD-AND-OPEN-CLOSE.md`**, **`docs/staff/pos-reports.md`**, **`docs/staff/pos-register-cart.md`**.
- **Permissions:** **`docs/STAFF_PERMISSIONS.md`** (**`register.session_attach`**, till group paragraph).

## Related files (code)

- `server/src/api/sessions.rs` — `open_session`, `build_reconciliation`, `close_session`, `list_open_sessions`
- `migrations/legacy_prelaunch_history/66_register_session_lanes.sql`, `migrations/legacy_prelaunch_history/67_register_till_close_group.sql`
- `scripts/ros_migration_build_probes.sql` — probes through the **latest** numbered migration (**97** as of this repo; see **`DEVELOPER.md`**)

**Last reviewed:** 2026-05-17
