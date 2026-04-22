# Unified Engine & Shop Host Mode (v0.2.1+)

Riverside OS v0.2.1 supports a hardened **Shop Host** path inside the Windows Tauri app, but that does **not** mean host mode, main-register mode, local-network access, and remote access are interchangeable.

Use this deployment model as the source of truth:

- **One Windows Tauri machine is the HOST machine**
- **A different Windows Tauri machine is the MAIN REGISTER**
- **Local PWA access** is for devices on the same local network as the host
- **REMOTE ACCESS** is separate and uses **Tailscale** for off-site devices

## What host mode means now

When you start **Shop Host** on the dedicated host machine:

- the app resolves a real frontend bundle path for satellite clients
- the UI does not report the host as running until readiness is confirmed
- startup failures are shown directly in **Settings → Remote Access**
- the panel now shows the detected **LAN IPv4 / host name** used for same-network satellite smoke checks

Host mode serves the Riverside bundle to **local-network satellite clients**. It is not a public-web shortcut, and it is not the same thing as the main register workflow.

## Role separation

### 1. Host machine

This is the one Windows machine in the shop that should act as the host.

- runs PostgreSQL reachability and the Riverside backend path
- can run **Shop Host** to serve local-network PWA satellites
- can also be linked to **Tailscale** so off-site devices have a private remote path

### 2. Main Register machine

This is a different Windows Tauri machine.

- primary cashier/register station
- should be treated as the main selling surface
- is not the same concept as the host machine, even though it runs the same desktop app shell

### 3. Local PWA access

This is for iPads, phones, and other browser devices that are on the **same local network** as the host machine.

- use the host URL shown by **Settings → Remote Access**
- this is the local satellite path
- it does not require the device to be off-site

### 4. Remote access

This is for devices that are **not** on the same local network as the host machine.

- uses **Tailscale**
- remains a separate concept from local host access
- should be described as a private remote path, not as generic “host mode”

## Setup summary

### Host machine

1. Install the Riverside desktop app on the one Windows machine that should act as the host.
2. Open **Settings → Remote Access**.
3. Enter the PostgreSQL URL and listen port.
4. Start **Shop Host**.
5. If off-site remote access is required, connect this host machine to **Tailscale** too.
6. From a second iPad or phone on the same local network, open the **local satellite URL** shown by the panel and confirm the Riverside sign-in gate loads.

### Local satellite devices

1. Put the iPad/phone on the same local network as the host.
2. Open the host URL shown by the host panel, or scan the host QR code.
3. Use the PWA from that local host-served path.
4. If the panel shows more than one local-network path, prefer the detected **LAN IPv4** first for smoke checks.

### Off-site remote devices

1. Install and sign in to **Tailscale** on the remote device.
2. Use the store’s Tailscale remote-access path to reach the same host machine.
3. Treat this as remote access, not as generic local host access.

## Host smoke check

Before store open on the dedicated host machine:

1. Confirm **Shop Host** shows **running**.
2. Confirm the panel shows:
   - bind address
   - frontend bundle path
   - at least one **local satellite URL**
   - detected **LAN IPv4** or host name
3. On a second device on the same local network, open the local satellite URL and confirm the Riverside sign-in screen loads.
4. If off-site access is needed, verify the separate **Tailscale remote path** too.

## Updates

- The **host machine** can use the desktop updater flow from **Settings → General → About this build**.
- Installed PWAs and browser satellites may show the Riverside **PWA update prompt** when a new shell is waiting.
- After an update, confirm the host panel still shows a running host and a valid local satellite URL.

## What this doc does not imply

- It does **not** mean every Windows Tauri station should run host mode.
- It does **not** mean the main register should double as the host by default.
- It does **not** mean local-network PWA access and off-site Tailscale remote access are the same path.
