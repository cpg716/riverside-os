---
id: pos-close-register-modal
title: "Closing the Register (Z-Report)"
order: 1020
summary: "Daily reconciliation, cash counting, and professional Z-Audit report generation."
source: client/src/components/pos/CloseRegisterModal.tsx
last_scanned: 2026-04-17
tags: pos, register, closing, Z-report, audit, reconciliation
---

# Open, close, and end-of-day

_Audience: Cashiers and leads._

**Purpose:** Shift-shaped checklist for daily operations.

---

## Before open (Back Office + floor)

1. Sign in to **Back Office**.
2. **Operations → Dashboard:** Check weather, floor team, and **My tasks**.
3. Complete **opening tasks** if assigned.
4. Enter **POS mode** when ready to use the till.

## Open register

1. From Back Office **POS** → **Register**, tap **Enter POS**, then complete the **open till** flow.
2. Confirm the header shows an **active session**.
3. Scan the **POS Dashboard** for session-specific widgets.

## Close register

1. Finish or park all in-progress sales — ensure no abandoned tenders.
2. Run the **close / Z** on **Register #1**. Note: Satellite lanes (#2+) do not have their own Z-close; one **Z** closes the entire till group.
3. **Professional Z-Report**: The closing report will automatically route to your assigned **Report Station** (Full-Page/Audit) rather than the thermal receipt printer.
4. **Cash Reconciliation**: Count and reconcile per dual-control SOP. Discrepancies must be reported to a manager immediately.
5. Finalize the **Close register** action in the software.

## Troubleshooting

| Symptom | Action |
| :--- | :--- |
| **Cash over/short** | Re-count twice; report to manager if beyond tolerance. |
| **Void/Refund needed** | Requires manager PIN if outside standard training. |
| **Repeated 500 errors** | Stop and check server connectivity before proceeding with close. |

**Last reviewed:** 2026-04-17
