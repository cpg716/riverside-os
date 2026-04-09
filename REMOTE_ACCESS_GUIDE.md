# Riverside OS — Remote Access Guide

Riverside OS is designed to be accessible from your iPhone, iPad, or home laptop as a secure Progressive Web App (PWA) using **Tailscale**.

## Prerequisites
1.  **Tailscale Account**: Sign up at [tailscale.com](https://tailscale.com) (free for personal/store use).
2.  **Server PC**: The main computer running Riverside OS in the shop.
3.  **Client Device**: Your personal iPhone, Android phone, or Laptop.

---

## 1. Setting up the Server
1.  Install Tailscale on the main Shop PC.
2.  Log in with your account.
3.  Ensure Riverside OS is running (the terminal should say `Server running on http://0.0.0.0:3000`).
4.  Note the **Tailscale IP** of the Shop PC (e.g., `100.x.y.z`) or its "MagicDNS" name (e.g., `store-pc`).

## 2. Setting up your iPhone / iPad (PWA)
1.  Install the **Tailscale app** from the App Store and log in.
2.  Ensure Tailscale is "Connected" (you will see a VPN icon in your status bar).
3.  Open **Safari** and enter the Shop PC's IP or name followed by `:3000`.
    -   Example: `http://100.64.1.10:3000` or `http://store-pc:3000`
4.  Riverside OS should load instantly.
5.  **Install as an App**:
    -   Tap the **Share** button (Square with up arrow).
    -   Scroll down and tap **"Add to Home Screen"**.
    -   Tap **Add**.
6.  You now have a **Riverside OS** icon on your home screen. When you tap it, it launches in full-screen mode, exactly like a native app.

## 3. Setting up a Home Laptop
1.  Install Tailscale on your laptop and log in.
2.  Open any browser (Chrome/Edge/Safari).
3.  Enter the Shop PC's address: `http://store-pc:3000`.
4.  You now have full access to all insights and back-office tools from home!

---

## Security Note
**Riverside OS is hidden from the public internet.** 
Only devices logged into *your* specific Tailscale account can see the server. If Tailscale is turned off on your phone, the app will not connect. This ensures your store's financial data is never exposed to hackers.

---

## PWA: popup windows (`window.open`)

Some flows open a **new browser tab or window** (labels, Z-reports, backup download URLs, a few CRM shortcuts). Mobile Safari and installed PWAs often **block popups** unless the open call runs directly from a **user gesture** (tap/click).

**Operational guidance**

- Prefer triggering print/export from an explicit button tap (the app already does this in most places).
- If a window fails to open, try again from the same screen using the primary action button, or use the **desktop / Tauri register** for hardware print paths.
- Staff PINs and bearer-style secrets are **not** written to the offline checkout queue: only safe header snapshots are stored; flush merges **live** staff + POS session headers at sync time.

---

## Counterpoint bridge (shop PC → ROS)

If you run the **Counterpoint SQL bridge** on a Windows machine ([`tools/counterpoint-bridge/`](tools/counterpoint-bridge/)), set `ROS_BASE_URL` to the same address you use for browsers:

- **LAN**: `http://<shop-pc-ip>:3000`
- **Tailscale**: `http://<shop-pc-tailscale-ip>:3000` or MagicDNS hostname

The bridge sends `x-ros-sync-token` on every request; keep that token secret. The Counterpoint PC does not need to be the same machine as ROS, but it must be able to reach ROS over the network you choose.
