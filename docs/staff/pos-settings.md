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
2. Open **Printers & Scanners** and confirm the Epson TM-m30III station uses the correct **Network address** or **Installed printer on this PC** target.
3. Run **test print** if the UI offers it.
4. On **Tauri**: confirm Windows/macOS printer is **online** and not paused.
5. On browser/PWA: confirm the server can reach the network printer IP.
6. Retry one sale **reprint** from **Orders** if policy allows.

### Open the cash drawer manually

1. POS → **Settings** → **Printers & Scanners**.
2. Confirm you are at the Register #1 station with the Epson-attached drawer.
3. Select **Open drawer**.
4. Enter the reason and the acting staff member's **Access PIN**.
5. Confirm the drawer opens. The manual open is recorded on the Z-report with staff, time, and reason.

Automatic drawer opens happen only for **CASH** and **CHECK** sales when the drawer setting is enabled. Card, gift card, account credit, and receipt reprints should not open the drawer.

### Fix “tags didn’t print”

1. POS or Back Office → **Settings** → **Printers & Scanners**.
2. Confirm the Windows printer queue is named **Zebra LP 2844** on the Main Hub / tag-printing PC.
3. Tag printing uses **EPL** only. Do not choose ZPL or auto-detect modes for Riverside clothing tags.
4. Open **Tag Designer → Print test tag** to send a real sample label before retrying the inventory tag action.
5. If direct dispatch fails, use the tag preview fallback and report the workstation plus SKU to support.

### Reduce beeps or haptics

1. Open **Settings** in POS.
2. Toggle **sound** / **haptic** / **scan feedback** options.
3. Save; confirm with a test scan so the floor stays customer-friendly.

### Wrong receipt format (logo, footer)

Receipt **template**, logo, header, footer, and section controls live under **Settings → Receipt Settings**. Escalate to admin for legal text or store identity changes.

## Helping a coworker

- Ask: **“Are you on browser or desktop app?”** Desktop can use installed receipt/report printers and local hardware checks. Tag printing routes through the Main Hub **Zebra LP 2844** queue; browser/PWA tag success still depends on that Main Hub queue working.
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
