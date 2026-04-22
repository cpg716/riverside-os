---
id: layout-pwa-update-prompt
title: "PWA Update Prompt"
order: 1034
summary: "This prompt appears when a newer Riverside web shell is ready and waiting to be loaded."
source: client/src/components/layout/PwaUpdatePrompt.tsx
last_scanned: 2026-04-22
tags: layout-pwa-update-prompt, pwa, updates
---

# PWA Update Prompt

Riverside uses this surface for both parts of the installed PWA contract:

- **Install prompt** when the device is still running Riverside in a normal browser tab
- **Update prompt** when a newer web shell has already downloaded and is waiting

## Install guidance

- On Windows laptops and supported mobile browsers, use **Install app** when Riverside offers it.
- On iPad or iPhone, use **Share → Add to Home Screen**, then launch Riverside from the icon instead of a browser tab.
- On phones, the prompt stacks its buttons and stays above the system bottom edge so the install/update actions remain easy to tap.
- Use **Later** only if you need to finish current work first.

## Update guidance

- Use **Reload now** when staff can afford a quick refresh.
- Use **Later** if you are in the middle of active work and need to finish first.

## Offline note

- The PWA shell may stay open offline, but only **completed POS checkouts** can queue for later sync.
- Inventory lookups, most settings changes, and most back-office mutations still need connectivity.

## If the app still looks stale

- reload the PWA again when practical
- close and reopen the installed app icon
- if needed, clear site data or reinstall the home-screen icon
