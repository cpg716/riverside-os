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

## Screenshots

![Remote access panel](../images/help/remote-access/panel-main.png)

![Help Center settings](../images/help/settings-help-center-settings-panel/example.png)

![Operational home](../images/help/operations-operational-home/main.png)

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

## Public callbacks

Use **Public Callback Route** to save the public HTTPS Riverside base URL for outside providers such as Helcim and Podium. Enter only the base URL, for example `https://ros.riversidemens.com`; Riverside appends `/api/webhooks/helcim` and `/api/webhooks/podium` automatically.

If Cloudflare Tunnel is used, save the tunnel hostname plus Cloudflare API token, account ID, zone ID, and optional tunnel name in this card. Riverside stores those values encrypted. Click **Repair Cloudflare Tunnel** to create or reuse the Cloudflare Tunnel, route DNS to the tunnel, install or restart the `cloudflared` service when possible, and point the tunnel origin at the Riverside server on this host. After saving or repairing, use **Run Live Callback Check** to confirm the public URL reaches this Riverside server before relying on Helcim terminal approval or cancel webhooks.

## Restart the Riverside server

Use **Restart Riverside Server** after changing server environment settings, payment callback settings, or Cloudflare Tunnel settings that need the Main Hub API process to reload.

The restart action stops the Windows task named **Riverside OS Server**, closes the running server process if needed, starts the task again, then waits until the API responds. Registers, payment updates, and Back Office screens can lose API access briefly while the restart runs. This does not restart the desktop app window and does not reset the database.

## Important notes

- Do not use this panel to enter Helcim API keys, terminal device codes, webhook signing secrets, or other provider secrets.
- Host mode is for the **dedicated Windows host machine**, not for the main register by default and not as a public-web shortcut.
- If you disconnect Tailscale during a remote session, connected off-site devices will lose access.

## Related workflows

- [Remote Access](manual:remote-access)
- [ROS Dev Center](manual:settings-ros-dev-center-panel)
