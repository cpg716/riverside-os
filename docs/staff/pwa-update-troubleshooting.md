# PWA Update Troubleshooting

**Audience:** Store managers, floor leads, and anyone helping staff with iPads or browser-based Riverside.

**Where in ROS:** Applies to all devices running Riverside as a web app or home-screen PWA.

**Related permissions:** None.

---

## What this guide is for

Sometimes Riverside on an iPad or browser does not appear to pick up a recent update — a new feature is missing, a bug still happens, or the "Reload now" banner keeps returning. This guide walks through safe steps to force a refresh without losing sign-in or register data.

## Before you start

- **Do not clear cache during an active sale.** Finish or park any open transactions first.
- Reloading does **not** close the register session or sign anyone out.
- Clearing site data **does** sign the user out and removes locally stored preferences. Have the staff member's PIN ready.

---

## Quick checks (try these first)

### 1. Look at the banner
If the banner says **"A new version of Riverside is ready,"** tap **Reload now** during a quiet moment. That is the intended path.

### 2. Check which version is running
1. Open **Settings → About** (or any screen that shows the version).
2. Compare the version number to the latest release shown on the server's Back Office status page or your internal announcement.
3. If the version is behind by more than one release, the device is stale.

### 3. Reload the page
- **iPad / iPhone (home-screen app):** Swipe up from the bottom, swipe Riverside away to close it, then tap the icon again.
- **Browser tab:** Press the browser's refresh button.
- **Desktop:** Press **Ctrl+Shift+R** (Windows) or **Cmd+Shift+R** (Mac).

Wait 3–5 seconds after the screen loads. If the banner appears again, the device knows an update is waiting.

---

## Deeper steps (if reload does not help)

### iPad / iPhone — clear site data without deleting the icon

1. Open the **Settings** app on the iPad/iPhone (the iOS Settings app, not Riverside).
2. Scroll down and tap **Safari**.
3. Tap **Advanced → Website Data**.
4. In the search box, type the store's Riverside hostname (e.g., `100.64.1.10` or `ros.riversidemens.com`).
5. Swipe left on the entry and tap **Delete**, or tap **Edit → Delete**.
6. Close Riverside fully (swipe up, swipe away).
7. Reopen Riverside from the home screen icon.
8. Sign in again with the staff member's code and PIN.

> **Note:** This removes cached files but keeps the home-screen icon. The app will download the latest version on next open.

### iPad / iPhone — nuclear option (delete and re-add the icon)

Only use this if clearing website data did not work.

1. Long-press the Riverside icon on the home screen.
2. Tap **Remove App → Delete App**.
3. Open Safari and navigate to the store's Riverside URL.
4. Tap the **Share** button (square with arrow).
5. Scroll down and tap **Add to Home Screen**.
6. Sign in again.

### Desktop Chrome / Edge

1. Open Riverside in the browser.
2. Press **F12** to open DevTools.
3. Click the **Application** tab (or **Application / 应用**).
4. In the left sidebar, click **Service Workers**.
5. Click **Unregister** next to the active Riverside service worker.
6. Close the tab.
7. Reopen Riverside in a new tab and sign in.

### Desktop Safari (Mac)

1. Open Safari → **Settings / Preferences → Privacy**.
2. Click **Manage Website Data**.
3. Search for the Riverside hostname.
4. Select it and click **Remove**.
5. Close and reopen Safari, then navigate to Riverside.

---

## What IT or the store owner should verify

If multiple devices are stuck on an old version, the problem is usually upstream:

| Symptom | Likely cause | Fix |
|---------|-----------|-----|
| Every device shows the old version | The server is still serving an old `client/dist/` | Rebuild and redeploy the frontend assets; restart the server process. |
| Some devices update, others do not | Those devices have cached an old `sw.js` aggressively | Have affected users clear website data (steps above). |
| The banner reappears immediately after reload | The new `sw.js` is not being served; the browser keeps reinstalling the same old one | Verify the server's static file path and `Cache-Control` headers on `/sw.js`. |

## Preventing stale devices

- **Train staff to tap Reload now** when they see the banner, not to tap Later indefinitely.
- **Managers should announce updates** during shift changes so staff know to reload before starting a new session.
- **IT should verify `/sw.js`** is not being cached by a CDN or reverse proxy with a long TTL.

## When to escalate

- Clearing website data and reinstalling the home-screen icon still shows an old version.
- Multiple devices across the store are affected simultaneously.
- You see errors in the browser console mentioning `workbox`, `sw.js`, or `Failed to fetch`.

Escalate to the person who manages the server deployment with the output of:

```
Version shown on the device: _______
Version expected from release notes: _______
Device type (iPad model / browser): _______
Steps already tried: _______
```

---

## See also

- `pwa-updates-manual.md` — what the banner means and when to reload.
- `REMOTE_ACCESS_GUIDE.md` — installing Riverside as a home-screen app.
- `working-offline.md` — offline behavior and cache limits.

**Last reviewed:** 2026-05-27
