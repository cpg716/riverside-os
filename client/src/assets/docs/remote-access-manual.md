---
id: remote-access
title: "Remote Access"
summary: "Use Tailscale for off-site access to the dedicated host machine; this is separate from local-network host access and separate from the main register."
order: 50
tags: settings, remote, tailscale, host-mode
---

# Remote Access

Riverside uses **Tailscale** for private remote access when a device is **not** on the same local network as the host machine.

That is a different concept from:

- the **host machine** serving local-network satellite devices
- the **main register** running the Windows Tauri cashier workflow

The host can expose a private Riverside remote path after both of these are true:

1. the machine is connected to Tailscale
2. **Shop Host** is running successfully

## How it works now

- Riverside shows the host runtime state directly in **Settings → Remote Access**
- if host startup fails, the panel shows the failure
- when host startup succeeds, the panel shows the local satellite URL plus detected LAN identity for same-network devices
- off-site devices still need Tailscale to use the separate remote-access path

## Important

- This flow is for **private off-site access**, not public-web deployment
- disconnecting Tailscale will remove private remote access
- starting host mode does not ask for Stripe keys in the UI; those belong in the host environment
