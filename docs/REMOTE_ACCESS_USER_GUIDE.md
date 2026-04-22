# Remote Access & Network Bridge Guide

This guide explains the **separate** roles of:

- the **HOST machine**
- the **MAIN REGISTER**
- **local-network PWA access**
- **REMOTE ACCESS** over **Tailscale**

These are not interchangeable concepts.

## Source-of-truth model

- **One Windows Tauri machine is the HOST machine**
  - it serves local satellite clients on the local network
- **A different Windows Tauri machine is the MAIN REGISTER**
  - it is the primary cashier/register station
- **Local PWA access** is for devices on the same local network as the host
- **REMOTE ACCESS** is separate
  - it is for PWA use when the device is **not** on the local network
  - it uses **Tailscale**

## What Remote Access means

Remote Access is the off-site path into Riverside.

It is **not**:

- the same as the local host URL used by in-store iPads
- the same as the main register workflow
- a public-web deployment shortcut

## 1. Host machine setup

Use **Settings → Remote Access** on the dedicated Windows host machine.

1. Start **Shop Host** if this machine should serve local-network satellite clients.
2. Link the host machine to **Tailscale** if off-site remote access is also required.
3. Confirm the panel shows:
   - host runtime state
   - bind address
   - frontend bundle path
   - local satellite URL
   - detected LAN IPv4 / host name for same-network smoke checks
   - Tailscale connection status

## 2. Local in-store satellite devices

For iPads or phones that are in the shop on the same network as the host:

1. Open the host URL shown by the host panel, or scan the host QR code.
2. Use that local host-served URL.
3. Add to Home Screen if the device is a shared in-store PWA station.
4. If more than one local path is shown, try the detected LAN IPv4 first during setup.

This is **local access**, not remote access.

## 3. Off-site remote devices

For laptops, phones, or tablets that are **away from the shop**:

1. Install **Tailscale** on the remote device.
2. Sign in to the same private network as the host machine.
3. Use the store's Tailscale remote-access path to reach Riverside.
4. Confirm you are testing from an off-site device or non-store network, not from the same local Wi‑Fi as the host.

This is **remote access**, not the same thing as local host access.

## 4. Main Register clarification

The **MAIN REGISTER** is a different Windows Tauri machine from the host.

- it is the primary cashier station
- it should not be described as the host by default
- it can point at the host just like any other client machine

## 5. Troubleshooting

### In-store iPad cannot load Riverside

- confirm the device is on the same local network as the host
- confirm the host machine is actually running **Shop Host**
- confirm the local satellite URL from the panel is correct
- if the panel shows multiple local paths, try the detected LAN IPv4 first

### Off-site device cannot load Riverside

- confirm **Tailscale** is connected on both the host and the remote device
- confirm the store is using the remote-access path, not just the local host URL
- confirm the host machine is reachable inside the Tailscale network

## 6. Remote-access smoke check

Use this after host setup or after any deployment/update:

1. On the dedicated host machine, confirm **Shop Host** is already running.
2. On an off-site phone, tablet, or laptop, connect to **Tailscale**.
3. Open the store's **remote Tailscale path**.
4. Confirm Riverside reaches the sign-in gate and loads the correct store data.
5. Confirm one low-risk remote workflow such as customer search, order lookup, or shipment lookup.
6. Confirm the operator knows this is a **remote** path and should not be substituted for the local in-store host URL.

### Wrong staff list or missing sign-in options

- confirm the device points at the correct host URL for its current role and location
- in-store device: local host URL
- off-site device: Tailscale remote-access URL

## Security notes

- never share Tailscale join keys casually
- use MFA on the Tailscale account
- remember that disconnecting Tailscale removes off-site remote access but does not redefine the local host/main-register roles

*Version: aligned to the current hardened deployment contract as of April 22, 2026.*
