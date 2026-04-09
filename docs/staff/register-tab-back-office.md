# POS tab (Back Office launchpad)

**Audience:** All staff who run the till.

**Where in ROS:** Back Office → sidebar **POS** → subsection **Register** (launchpad into POS mode).

**Related permissions:** Tab is broadly visible; **checkout** still needs an **open till** session + POS auth.

---

## How to use this tab

The Back Office **POS** item is the **door** into **POS mode** (touch-first layout, emerald **Complete Sale** actions). It does **not** embed the full cart in Back Office. The **Register** subsection is the default entry: tap **Enter POS** (or **Return to POS** if a session is already open).

Inside POS mode, the left rail **Register** tab is the **live selling screen** (cart, scan, tender).

## Entering POS mode

1. Back Office → **POS** → **Register**.
2. Tap **Enter POS** / **Return to POS** on the launchpad.
3. Complete **open till** / keypad flow per SOP. If several terminals can be open, you may **pick a lane** or see **Register #1** vs **#2** options — **#2** only works after **#1** is open (one drawer). **Admin** users: if **#1** is not open yet, the app asks whether **you** open **#1** or **another station** opens it first (**Check again**). With **#1** already open, **admin** defaults to **Register #2** (no opening float) for Back Office–style POS use; you can change the dropdown to **#1** if you are opening the drawer.
4. Confirm the **profile** shows **till open** / **drawer active** (not **Till closed** / **No Active Session** as appropriate).
5. You should see the POS rail: **Dashboard**, **Register** (cart), **Tasks**, **Weddings**, etc.

## Leaving POS mode

1. Finish or **park** sales — **never** abandon an open tender.
2. Use **Exit POS** / **Exit POS mode** in the POS top bar.
3. **Close till** (Z-close) follows end-of-day SOP on **Register #1** when your store uses a till group — may differ from simply switching back to Back Office.

## Default tab in POS

When the drawer opens, ROS often lands on **Dashboard** unless you are resuming **cart**, **customer**, **order**, **SKU**, or **wedding** deep link — see [REGISTER_DASHBOARD.md](../REGISTER_DASHBOARD.md).

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| **Enter POS** does nothing | Popup blocker | Allow ROS origin |
| Bounce back to BO | Session invalid | Re-open till from POS |
| Wrong cashier shown | **Shift handoff** | [STAFF_TASKS_AND_REGISTER_SHIFT.md](../STAFF_TASKS_AND_REGISTER_SHIFT.md) |
| Blank POS | Hard refresh once | Cache / IT |

## When to get a manager

- **Drawer** totals mismatch after retries.
- Uncertainty **training** vs **live** mode.

---

## See also

- [00-getting-started.md](00-getting-started.md)
- [pos-register-cart.md](pos-register-cart.md)
- [../REGISTER_DASHBOARD.md](../REGISTER_DASHBOARD.md)
- [../TILL_GROUP_AND_REGISTER_OPEN.md](../TILL_GROUP_AND_REGISTER_OPEN.md)

**Last reviewed:** 2026-04-06
