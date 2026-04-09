# POS Settings

**Audience:** Leads configuring register-side preferences.

**Where in ROS:** POS mode → left rail **Settings** (gear icon).

**Related permissions:** Varies by control; **store-wide** values remain under Back Office → **Settings** (**settings.admin**).

---

## How to use this screen

POS **Settings** is for **lane preferences** that should be adjustable **without leaving POS mode**: printer targets, scan feedback, or layout options your build exposes. It does **not** replace **Settings → General** for tax, timezone, backups, or integrations.

## Common tasks

### Fix “receipt didn’t print” from POS

1. POS → **Settings**.
2. Confirm **printer IP/port** or **named printer** matches the physical device (desktop/Tauri).
3. Run **test print** if the UI offers it.
4. On **Tauri**: confirm Windows/macOS printer is **online** and not paused.
5. Retry one sale **reprint** from **Orders** if policy allows.

### Reduce beeps or haptics

1. Open **Settings** in POS.
2. Toggle **sound** / **haptic** / **scan feedback** options.
3. Save; confirm with a test scan so the floor stays customer-friendly.

### Wrong receipt format (logo, footer)

Receipt **template** and **timezone** live under Back Office → **Settings** → **General** — not here. Escalate to admin.

## Helping a coworker

- Ask: **“Are you on browser or desktop app?”** Browser cannot reach local LAN printers the same way Tauri can.
- If **two lanes** show different printers, each device may have **local** POS settings — align per SOP.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Setting won’t save | Network; wait for toast | Re-sign-in |
| Option missing on iPad | Web/PWA may hide hardware-only toggles | Use register desktop |
| Prints garbled | Wrong **raw** vs **driver** mode | IT / receipt template |
| Settings reset overnight | Roaming profile or cache clear | Document device id for IT |

## When to get a manager

- Any change to **tax line**, **legal text**, or **store license** on receipts.
- Suspected **wrong store** connected (multi-store rare misconfig).

---

## See also

- [settings-back-office.md](settings-back-office.md)

**Last reviewed:** 2026-04-04
