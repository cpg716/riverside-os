# Working Remotely with Tailscale

**Audience:** Any staff member who needs to access Riverside from outside the store — from home, on the road, or on a mobile device not connected to the store Wi-Fi.

**Related permissions:** Same as in-store. Tailscale is a transport layer only — your role and access level are unchanged.

---

## How it works (plain language)

Riverside runs on the Windows **Main Hub** at the store. When you're in the store, your device connects directly over the store Wi-Fi. When you're off-site, **Tailscale** creates a secure private tunnel between your device and that same Main Hub — so Riverside works the same way, just through the internet.

You do not need to do anything special inside Riverside. You just need:

1. **Tailscale installed and connected** on your device
2. **The store's Tailscale address** saved in Riverside's sign-in gate

That's it. Everything else — sign-in, Back Office, customer lookup, orders — works exactly the same as in-store.

---

## One-time setup (do this once per device)

### Step 1 — Install Tailscale

| Device | Where to get it |
|---|---|
| iPhone / iPad | App Store → search **Tailscale** |
| Android phone / tablet | Google Play Store → search **Tailscale** |
| Windows laptop | [tailscale.com/download/windows](https://tailscale.com/download/windows) |
| Mac laptop | Mac App Store → search **Tailscale**, or [tailscale.com/download/mac](https://tailscale.com/download/mac) |

### Step 2 — Sign in to Tailscale

Open the Tailscale app and sign in with the **store's Tailscale account** (get the login from your manager — it is the store owner's account, not your personal one).

On iPhone/iPad: approve the VPN profile when prompted — this is normal and safe.

### Step 3 — Save the store's Tailscale address in Riverside

Ask your manager for the **store's Tailscale address**. It looks like one of these:

- `http://100.x.x.x:3000` (an IP address starting with 100.)
- `https://riverside-server.ts.net` (a name ending in .ts.net)

Then:

1. Open Riverside on your device.
2. At the sign-in screen, tap **Change** next to the server address (bottom of the screen).
3. In the panel that opens, find **Tailscale / Remote Address** at the bottom.
4. Tap **Set**, type or paste the address your manager gave you, and tap **Save**.
5. You will now see **"Store server (Tailscale / remote)"** as a quick-pick option whenever you open the server connection panel.

> You only need to do this once. The address is saved on your device permanently.

---

## Connecting off-site (every time)

1. Open **Tailscale** on your device and confirm it shows **Connected**.
2. Open Riverside (tap the home screen icon, or open your browser and go to the Riverside URL).
3. At the sign-in screen, tap **Change** → select **"Store server (Tailscale / remote)"**.
4. Tap **Save & Connect**.
5. The staff list loads → select your name → enter your PIN → you're in.

> **If the gate shows a purple "Cannot reach server over Tailscale" warning:** Tailscale is not connected on this device. Open the Tailscale app and connect, then try again.

---

## Switching back to in-store

When you return to the store and are on the store Wi-Fi:

1. Tap **Change** next to the server address.
2. Select **"Current saved host"** or the local IP (e.g. `http://192.168.1.x:3000`).
3. Tap **Save & Connect**.

You do not need to disconnect Tailscale — it can stay on in the background and does not interfere with local Wi-Fi access.

---

## What works remotely

Everything in Riverside works the same remotely as in-store:

- Back Office — customers, orders, wedding, inventory, reports
- Alterations and scheduling
- ROSIE AI assistant
- Notifications and tasks

**POS checkout** works remotely too, but is not the typical off-site use case. If you need to ring a sale remotely, make sure you have an open register session.

---

## What does NOT work remotely (not a Tailscale issue)

- **Receipt printing to the store's Epson printer** — the printer is on the store LAN. You can see transaction records but cannot trigger a physical print remotely.
- **Cash drawer** — only works at the physical register.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Purple "Cannot reach server" banner | Open Tailscale → tap connect → try again |
| Staff list loads but sign-in fails | Wrong PIN or server is correct — try again |
| Riverside stuck on spinner | Server may be offline at the store — check with manager |
| Tailscale shows "Connected" but server still unreachable | Manager needs to check that Tailscale is running on the Main Hub |
| "CORS" error in browser console | IT needs to add your Tailscale origin to `RIVERSIDE_CORS_ORIGINS` |

---

## For managers — sharing the Tailscale address with staff

The store's Tailscale address is:

1. Log in at [login.tailscale.com/admin/machines](https://login.tailscale.com/admin/machines).
2. Find the Main Hub in the list.
3. The **Tailscale IP** (`100.x.x.x`) is shown next to it. The **MagicDNS name** (e.g. `ros-server.ts.net`) is shown if MagicDNS is enabled.
4. Share the full address with staff: `http://100.x.x.x:3000` or `https://ros-server.ts.net` (if HTTPS/Tailscale Serve is configured).

Full IT setup instructions: [`REMOTE_ACCESS_GUIDE.md`](../REMOTE_ACCESS_GUIDE.md).

---

**Last reviewed:** 2026-05-28
