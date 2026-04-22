---
id: layout-backoffice-sign-in-gate
title: "Backoffice Sign-In Gate"
order: 1028
summary: "Sign in with your staff identity and Access PIN before entering Riverside."
source: client/src/components/layout/BackofficeSignInGate.tsx
last_scanned: 2026-04-22
tags: layout-backoffice-sign-in-gate, signin, access-pin, host-settings
---

# Backoffice Sign-In Gate

The sign-in gate protects Riverside before any shell or navigation appears.

## How to sign in

1. Select your name.
2. Enter your 4-digit **Access PIN**.
3. Tap **Continue**.

## API Host Settings

Use **API Host Settings** only when this device needs to point at a different Riverside host URL, such as:

- the dedicated host machine on your local network
- the store's Tailscale remote-access URL when this device is off-site

Example values:

- `http://ros-host.local:3000`
- `https://ros-host.tailnet.ts.net`

## Notes

- The last selected staff member is remembered on that device.
- If your name does not appear, the device may be pointed at the wrong host URL for its current role or location.
- For lockout recovery, use the in-app **Lockout Recovery Manual** from Help.
