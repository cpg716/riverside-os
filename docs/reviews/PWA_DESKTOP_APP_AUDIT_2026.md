# Audit Report: PWA & Desktop App Subsystems
**Date:** 2026-04-08
**Status:** Multi-Platform / Production Ready
**Auditor:** Antigravity

## 1. Executive Summary
Riverside OS utilizes a dual-deployment strategy: a high-performance **PWA** (Progressive Web App) for mobile and remote access, and a **Tauri-based Desktop App** (Register) for the primary cash-wrap terminals. This architecture provides the best of both worlds: broad accessibility on iPads/phones and native hardware access on Windows/macOS.

## 2. PWA Infrastructure (Mobile/Tablets)

### 2.1 Manifest & Branding
- **Config**: `client/public/manifest.json`.
- **Display**: Set to `standalone` to provide a chromeless, native-app experience on iOS and Android.
- **Styling**: `theme_color` is synced with the "Emerald Retail" brand (`#059669`). Supports `maskable` icons for better OS integration.

### 2.2 Service Worker Strategy
- **Engine**: Automated via `vite-plugin-pwa` (Workbox).
- **Update Logic**: Uses `registerType: "prompt"`. Staff are notified of updates via a non-intrusive `PwaUpdatePrompt` component, allowing them to choose when to reload (avoiding interruptions during a sale).
- **Reliability**: JS, CSS, and HTML are cached for offline resilience; the `/api` and `/metabase` routes are explicitly denylisted from the service worker to ensure live data integrity.

## 3. Desktop App Infrastructure (Tauri 2)

### 3.1 Bundle Configuration
- **Product Name**: "Riverside POS".
- **Binary Inclusion**: Correctly bundles dependencies like `llama-server` for the **ROSIE** (Local AI) engine using Tauri's `externalBin` capability.
- **Architecture**: Leverages the Tauri 2 "Plugin" model for Shell and Logging.

### 3.2 Deployment Workflow
- **Checklist**: Detailed in `PWA_AND_REGISTER_DEPLOYMENT_TASKS.md`, covering code signing, version displays, and responsive QA.
- **Environment**: Supports environment-specific `VITE_API_BASE` overrides for LAN vs. Tailscale/Cloud deployments.

## 4. Security Analysis
- **CSP**: The `tauri.conf.json` currently has `csp: null`. **Recommendation**: Hardening the CSP for production to restrict source origins.
- **Network**: The server bind defaults to `0.0.0.0:3000`, allowing LAN communication for mobile iPads without complex DNS.

## 5. Findings & Recommendations
1. **Updater**: The Tauri updater is currently commented out or missing from the config. **Recommendation**: Enable the built-in Tauri 2 updater for seamless desktop deployments.
2. **PWA Strength**: The use of `virtual:pwa-register` handles the browser-side update flow perfectly.

## 6. Conclusion
The App infrastructure is professionally engineered for a split retail environment. The PWA provides excellent mobile flexibility, while Tauri provides the low-latency native hooks required for retail reliability.
