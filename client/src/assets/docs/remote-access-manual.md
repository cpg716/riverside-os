---
id: remote-access
title: "Remote Access"
summary: "Use Tailscale for off-site access to the dedicated host machine; this is separate from local-network host access and separate from the main register."
order: 50
tags: settings, remote, tailscale, host-mode
---

# Remote Access

## Screenshots

![Remote access panel](../images/help/remote-access/panel-main.png)

![Help Center settings](../images/help/settings-help-center-settings-panel/example.png)

![Operational home](../images/help/operations-operational-home/main.png)

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

## How to use it

1. Confirm this PC is the intended host machine.
2. Open **Settings → Remote Access** on that machine.
3. Verify **Tailscale** is connected if the goal is off-site access.
4. Start host mode and wait for Riverside to report a healthy host state.
5. Share the correct LAN or Tailscale address based on where the satellite device is connecting from.

## Important

- This flow is for **private off-site access**, not public-web deployment
- disconnecting Tailscale will remove private remote access
- starting host mode does not ask for Helcim keys in the UI; those belong in the host environment

## Recovery and escalation

Remote access is for approved support and operational recovery. Do not leave a support session open after the work is complete. If the store is using remote help during a payment, register close, or customer-data issue, keep the manager informed and avoid reading card numbers or Access PINs aloud.


## Related workflows

- [ROS Dev Center](manual:settings-ros-dev-center-panel)
- [Help Center Drawer](manual:help-center-drawer)
