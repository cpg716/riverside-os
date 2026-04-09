# Getting started with Riverside OS

**Audience:** All staff.

**Where in ROS:** Applies everywhere.

**Related permissions:** Most areas need specific permissions. If a sidebar item is missing, see [permissions-and-access.md](permissions-and-access.md).

---

## What is Riverside OS (ROS)

Riverside OS is your store’s point of sale, inventory, wedding-party workflow, customer records, and back-office tools in one application. You may use it in a web browser (including on a tablet or phone as a PWA) or in the desktop app.

## How to use this guide set

Each file in `docs/staff/` describes **one area** of the app: where to click, what success looks like, **common problems**, and **when to escalate**. Use the hub [README.md](README.md) to find the right page by sidebar name.

## Signing in to Back Office

1. When you see **Sign in to Back Office**, enter your **four-digit staff code**.
2. If your account uses a PIN, enter the same digits as your PIN when prompted.
3. Wait until your **name** appears in the header/sidebar context. If the screen stays on sign-in, read the red or toast error (wrong code, wrong PIN, network).

**After sign-in:** You can open many Back Office tabs **without** opening the cash drawer. Checkout still needs an **open register** where the API requires it.

## Helping someone who “can’t get in”

1. Confirm they are using **their** staff code, not the register login shortcut if your store separates them.
2. Confirm **Caps Lock** is off (codes are numeric, but PIN fields can behave oddly on some keyboards).
3. Have them **refresh once**; if still failing, try another browser or the desktop app to rule out a stuck tab.
4. If others can sign in: reset PIN path is **manager-only** (Staff → PINs or your SOP).

## Back Office vs POS mode

- **Back Office:** main shell — **Operations**, **Inventory**, **Weddings**, **Settings**, etc.
- **POS** in the Back Office sidebar: **launchpad** into **POS mode** (green primary actions). Tap **Enter POS** on the launchpad; the **Register** tab in the POS left rail is where you **ring sales** (cart, scan, pay).
- **Open till** = an active drawer/session. Required for **tender / checkout** and some POS-only reads.

## Till open vs closed (profile line)

| State | What you usually see | What fails |
|-------|----------------------|------------|
| **Till closed** | **Till closed** in the sidebar profile, or **No Active Session** when no drawer | Cart tender, some POS reports |
| **Till open** | Cashier/session name + **Till open** / drawer active | Normal sales flow |

## Sidebar tips (Back Office)

- Small screen: use the **Menu** control to open navigation.
- **Double-click** a main nav icon (or collapsed profile avatar) to expand/collapse the rail.
- Clicking the **main workspace** (including header) collapses an expanded sidebar on desktop.

## POS sidebar

Rail order (code): **Dashboard**, **Register**, **Tasks**, **Weddings**, then **Alterations** only if you have **alterations.manage**, then **Inventory**, **Reports**, **Gift Cards**, **Loyalty**, **Settings**. Tap the workspace body below the top bar to collapse an expanded POS sidebar.

## Toasts, modals, and errors

ROS does **not** use browser **alert** / **confirm**. You get:

- **Toasts** — short success/error at the edge of the screen; read them before tapping away.
- **Confirmation** modals — destructive or financial actions; read the title and body before **Confirm**.
- **Prompt** modals — text entry with OK/Cancel.

**If a toast says “403” or “permission”:** the signed-in staff cannot do that action; switch user or get a manager.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Blank white screen after update | Hard refresh (Ctrl+Shift+R / Cmd+Shift+R) | Clear site data for ROS only, retry; then IT |
| “Network error” on every click | Check Wi‑Fi / ethernet; open another website | Tailscale or server down — manager / IT |
| Signed in but tabs missing | Expected — permissions; see [permissions-and-access.md](permissions-and-access.md) | Manager adjusts **Role access** or **User overrides** |
| POS opens then immediately errors | Note exact toast; do not run sales | Manager checks session / server logs |

## When to get a manager

- Any **cash** discrepancy, **void**, or **refund** outside your training.
- **Customer data** problems: duplicate accounts, wrong merge, import mistakes.
- Repeated **500** or **503** errors after refresh.
- **Security:** suspected unauthorized use of a staff code.

---

## See also

- [FAQ.md](FAQ.md)
- [GLOSSARY.md](GLOSSARY.md)
- [permissions-and-access.md](permissions-and-access.md)
- [working-offline.md](working-offline.md)
- [register-tab-back-office.md](register-tab-back-office.md)

**Last reviewed:** 2026-04-04
