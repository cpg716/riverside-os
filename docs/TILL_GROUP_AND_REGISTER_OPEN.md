# Till close group, multi-lane register, and open-register UX

Operational and engineering reference for **migration 66** (register lanes) and **migration 67** (`till_close_group_id`): one **physical cash drawer** (Register **#1**), optional **satellite** lanes (**#2+**), **combined Z-close**, and **Back Office** behaviors.

## Model (short)

- **`register_sessions.register_lane`**: physical terminal label (1–99). Each open lane is its own row with its own `session_id` and **`pos_api_token`**.
- **`register_sessions.till_close_group_id`**: links all lanes that share one till shift. **Register #1** opening creates a **new** group id; **#2+** must send **`primary_session_id`** pointing at an **open** session with **`register_lane = 1`** and use **`opening_float = 0`**.
- **Cash drawer math (Z)**: **Opening float**, **paid in/out**, and **expected/actual cash** apply only to **lane 1**. **Cash tenders** on any lane in the group **sum** into that one expected cash figure.
- **Z-close**: Only from **lane 1** in the UI. **`close_session`** closes **every open** session in the same **`till_close_group_id`** in one database transaction with a shared **`z_report_json`**. **Lane 2+** has **no** separate “Close register” button in POS. **Parked carts (migration 68):** any **`pos_parked_sale`** rows still **parked** for lanes in that till group are marked **deleted** when the group Z-closes — see **[`POS_PARKED_SALES_AND_RMS_CHARGES.md`](./POS_PARKED_SALES_AND_RMS_CHARGES.md)**.
- **X-report**: **Per session** (lane-scoped mid-shift read).
- **Reconciliation / Z payload**: Combined **`tenders`**, **`tenders_by_lane`**, and **`transactions`** include **`register_lane`** (and optional **`register_session_id`**) for print and audit.

## APIs (pointers)

- **`POST /api/sessions/open`** — lane 1 vs satellite rules; **`primary_session_id`** when opening lane **2+**.
- **`GET /api/sessions/list-open`** — **`register.session_attach`**; used for **pick/join** when multiple lanes are open and for **satellite linking** + **admin primary check**.
- **`GET …/reconciliation`**, **`close`**, **`begin-reconcile`** — group behavior for Z from primary; see **`DEVELOPER.md`** **`/api/sessions`** row.

## Client surfaces

| Area | Behavior |
|------|----------|
| **`RegisterOverlay.tsx`** | Satellite lanes: **`list-open`**, link to open **#1**. **Admin**: if **#1** is not open, **choose** “open #1 myself” vs “another terminal opens #1” (with **Check again**). **Admin** default lane **#2** when **#1** is already open (user can change dropdown). |
| **`PosShell.tsx`** | **Close Register** only for **lane 1** (or unknown lane). |
| **`CloseRegisterModal.tsx`** | Combined drawer copy, **by-lane** tenders, transaction table with **Register #**; authenticated fetches (**`mergedPosStaffHeaders`**). |
| **`zReportPrint.ts`** | Optional **by-lane** tenders + **payment lines** with register. |
| **`RegisterGateContext`**, **`RegisterRequiredModal`** | **Orders** refund (and similar): **Go to Register** when **`GET /api/sessions/current`** fails. |
| **`App.tsx`** | **`RegisterGateProvider`**; Back Office close modal only when attached lane is **1** (or unknown). |

## Staff / training docs

- **Floor cashiers:** **`docs/staff/register-tab-back-office.md`**, **`docs/staff/EOD-AND-OPEN-CLOSE.md`**, **`docs/staff/pos-reports.md`**, **`docs/staff/pos-register-cart.md`**.
- **Permissions:** **`docs/STAFF_PERMISSIONS.md`** (**`register.session_attach`**, till group paragraph).

## Related files (code)

- `server/src/api/sessions.rs` — `open_session`, `build_reconciliation`, `close_session`, `list_open_sessions`
- `migrations/66_register_session_lanes.sql`, `migrations/67_register_till_close_group.sql`
- `scripts/ros_migration_build_probes.sql` — probes through the **latest** numbered migration (**97** as of this repo; see **`DEVELOPER.md`**)

**Last reviewed:** 2026-04-05
