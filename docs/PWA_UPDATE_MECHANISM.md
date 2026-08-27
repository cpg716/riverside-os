# PWA Update Mechanism — Developer & Deployment Reference

This document explains how Riverside OS Progressive Web App (PWA) updates are built, delivered, and activated. It covers the service worker lifecycle, the role of `vite-plugin-pwa` and Workbox, and the operational steps required to ensure client devices receive new builds.

---

## Overview

Riverside uses `vite-plugin-pwa` with `registerType: "prompt"`. This means:

- A new build generates a new precache manifest inside `sw.js`.
- The browser detects the changed service worker on the next page load.
- The new service worker installs in the background but stays in the **waiting** state until the user confirms.
- `PwaUpdatePrompt.tsx` displays a **"Reload now"** banner. When tapped, it calls `updateServiceWorker(true)`, which triggers `skipWaiting()` and reloads the page.

The optional Workbox banner is separate from the transaction safety gate. Every
Tauri, installed PWA, and browser station also compares the exact client build
SHA with `GET /api/version` before Register becomes interactive, every 30
seconds while Riverside is open, on focus/reconnect, and again before Payment.
If the Main Hub reports a different build, a non-dismissible **Update required**
dialog blocks Register and Payment. Tauri installs through the signed updater;
PWA/browser uses **Resync and reopen** to unregister the service worker, delete
Riverside's Cache Storage entries, and reload from the current Main Hub bundle.
It deliberately preserves local/session storage and IndexedDB so an open Cart,
Staff Access, and offline recovery evidence are not erased.

`POST /api/transactions/checkout` independently rejects a known stale or
unidentified production client build with HTTP 409. Payment-provider dispatch
uses the same guard, so an older client cannot bypass the UI gate to record cash,
check, zero-balance, or card activity.

## Build-time asset generation

When `npm run build` runs in `client/`:

1. Vite bundles the app into hashed chunks in `client/dist/assets/` (e.g., `index-HASH.js`).
2. `vite-plugin-pwa` generates `client/dist/sw.js`, which contains a Workbox precache manifest listing every hashed asset.
3. `workbox` precaches the assets during the service worker's `install` event.

Key config in `client/vite.config.ts`:

```ts
VitePWA({
  registerType: "prompt",
  manifest: pwaManifest,          // public/manifest.json
  manifestFilename: "manifest.json",
  includeAssets: ["icon-192.png", "icon-512.png"],
  workbox: {
    globPatterns: ["**/*.{js,css,html,ico,svg,woff2}"],
    maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
    cleanupOutdatedCaches: true,
    navigateFallback: "/index.html",
    navigateFallbackDenylist: [/^\/api\//],
  },
})
```

**Why the server matters**: The browser checks for a new `sw.js` by fetching it from the web server. If the web server is still serving an old `client/dist/`, no update is detected.

In the private release lane, publishing a candidate to ROS does not replace `client/dist/`. Staff must activate the candidate from **Settings → Updates** on the Main Hub first. Only that guarded Main Hub installation replaces the served PWA files; each PWA/browser station is then reloaded manually.

## Service worker lifecycle

```
Page load → Browser fetches /sw.js → Compares with installed SW
    │
    ├─ Content identical → No update
    │
    └─ Content different → New SW installs (state: INSTALLING)
                              │
                              ▼
                         Precaches new assets (state: INSTALLED / WAITING)
                              │
                              ▼
         PwaUpdatePrompt detects "needRefresh" → shows banner
                              │
              ┌───────────────┴───────────────┐
              │                               │
        User taps "Later"               User taps "Reload now"
              │                               │
        Old SW stays active           messageSkipWaiting() → new SW activates
                                              │
                                              ▼
                                         Page reloads → new app runs
```

## Runtime UI flow

`client/src/components/layout/PwaUpdatePrompt.tsx` uses `useRegisterSW()` from `virtual:pwa-register/react`:

```ts
const {
  needRefresh: [needRefresh, setNeedRefresh],
  updateServiceWorker,
} = useRegisterSW();
```

- `needRefresh` becomes `true` when a new SW has installed and is waiting.
- `updateServiceWorker(true)` sends a `SKIP_WAITING` message to the waiting SW and reloads.
- In Tauri desktop mode, the component renders `DesktopPwaCacheCleanup` instead, which unregisters any stray SWs and clears caches.

## Deployment requirement: serve the new `client/dist/`

The single most common cause of "PWA not updating" is the production server still serving an old `client/dist/`.

**Deployment checklist for any release with frontend changes:**

1. Run `npm run build` in `client/`.
2. Verify `client/dist/sw.js` exists and contains the new version/hashes.
3. Ensure the production server serves `client/dist/` as its static root (or the path configured in your reverse proxy).
4. Confirm the server has the new files (`index.html`, `sw.js`, `assets/*`).
5. Verify with a curl:
   ```bash
   curl -s https://your-server/sw.js | head -5
   ```
   The output should mention Workbox and list current asset hashes.

**Axum static serving** (in `server/src/main.rs` or routing layer):

```rust
// Example: tower-http ServeDir
ServeDir::new("client/dist")
    .fallback(ServeFile::new("client/dist/index.html"))
```

Ensure the server binary is restarted after `client/dist/` changes if files are read at startup rather than on each request.

## Cache invalidation for non-hashed assets

All JS and CSS are hashed by Vite, so `sw.js` naturally busts them. `index.html` is **not** hashed, but Workbox's `navigateFallback` serves the precached copy when offline. The `sw.js` itself is checked on every page load (with standard HTTP cache semantics), so browsers should see the updated manifest quickly.

If aggressive CDN or reverse-proxy caching is in front of the app:

- Set `Cache-Control: no-cache` or a short TTL on `/sw.js`.
- Set `Cache-Control: max-age=31536000, immutable` on hashed assets (`/assets/*`).

## Verifying an update reached a specific device

1. Open the app on the device.
2. Open the browser DevTools (if using a browser tab) or Safari Web Inspector (for iPad/iPhone connected to Mac).
3. Go to **Application → Service Workers** (Chrome) or **Develop → Service Workers** (Safari).
4. Check the active service worker's script URL and its listed assets.
5. Compare a hashed asset filename (e.g., `index-4MTgplhB.js`) against the latest build output.

## Forcing a stale device to update

If a device is stuck on an old version:

1. **In-app**: The user can eventually tap **Reload now**.
   If Riverside has already identified a Main Hub/client mismatch, staff must use
   **Resync and reopen**; that transaction-blocking dialog has no Later action.
2. **Browser settings**: Clear site data / cache for the origin. On next visit, the newest `sw.js` installs immediately.
3. **Programmatic**: The mandatory resync action performs the safe service-worker
   and Cache Storage cleanup. DevTools or remote MDM remain IT-only fallbacks.

## CI/CD implications

The `windows-deployment-package.yml` workflow does **not** build the PWA directly as a separate hosted artifact — it builds the Tauri desktop shell, server binary, and deployment package that contains the web client files served by the Rust server. Ensure your production deployment pipeline copies the freshly built `client/dist/` to the server's static file path before restarting the server.

---

## See also

- `client/vite.config.ts` — build configuration
- `client/src/components/layout/PwaUpdatePrompt.tsx` — runtime prompt UI
- `docs/staff/pwa-updates-manual.md` — staff-facing explanation
- `docs/staff/pwa-update-troubleshooting.md` — operational recovery steps

**Last reviewed:** 2026-08-27
