---
id: settings-remote-access-panel
title: "Remote Access Panel"
order: 1099
summary: "Use this panel on the dedicated Windows host machine to start Shop Host for local satellites and connect Tailscale for separate remote access."
source: client/src/components/settings/RemoteAccessPanel.tsx
last_scanned: 2026-04-22
tags: settings-remote-access-panel, remote-access, tailscale, host-mode
---

# Remote Access Panel

Use **Settings → Remote Access** only on the dedicated Windows host machine. This panel is for:

- starting **Shop Host** so local-network satellite devices can use Riverside
- connecting the host machine to **Tailscale** when off-site remote access is also required

## What this panel shows

- whether Tailscale is connected on this machine
- whether **Shop Host** is stopped, starting, running, or failed
- the host bind address
- the frontend bundle path being served to satellite clients
- the local satellite URL and QR code for same-network secondary devices
- the host machine's detected LAN IPv4 / host name for smoke checks

## Start host mode

1. Confirm you are on the Windows machine that should act as the host.
2. Enter the PostgreSQL URL.
3. Confirm the listen port.
4. Click **Start Shop Host**.

If startup succeeds, Riverside will show the local satellite URL that same-network devices should open. It also shows the host machine's LAN identity so you can smoke-test a second device before store open.

## If startup fails

The panel now shows the failure directly. Common causes:

- the PostgreSQL URL is wrong
- the frontend bundle is missing on the host
- the selected port is already in use

Fix the problem, then try **Start Shop Host** again.

## Satellite devices

Use the URL shown in this panel for iPads and other satellite browsers that are on the same local network as the host machine. If more than one local path is shown, try the detected LAN IPv4 first. Off-site remote access is separate and still depends on Tailscale.

## Important notes

- Do not use this panel to enter Stripe keys or other production secrets.
- Host mode is for the **dedicated Windows host machine**, not for the main register by default and not as a public-web shortcut.
- If you disconnect Tailscale during a remote session, connected off-site devices will lose access.
