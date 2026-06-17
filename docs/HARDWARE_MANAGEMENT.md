# Hardware Management & Bridging

Riverside OS supports high-velocity hardware bridging for thermal receipt printers, item tag printers, and report destinations. Configuration is managed via the unified **Printers & Scanners** hub.

## High-Level Architecture

Hardware communication in Riverside OS is **platform-aware**. The application detects its environment (Tauri Desktop vs. PWA/Browser) and chooses the most appropriate protocol for dispatch.

- **Tauri Native (Desktop)**: Receipts print from the Register #1 desktop station, reports print through the selected installed Reports printer, and inventory tags route through the Main Hub print hub so the Zebra station is owned by the server PC.
- **PWA / Browser**: Fallback to **Fetch/HTTP** (server-mediated dispatch) or supervised browser print dialogs.

The core logic resides in `client/src/lib/printerBridge.ts` via the `autoRoutePrint` function.

---

## 1. Unified Printer Model

Riverside OS tracks three distinct printer stations per workstation. Receipts, reports, and clothing tags use their configured station targets. Clothing tags should target Riverside's single tag printer: the Windows **Zebra LP 2844** queue using **EPL2**.

| Station Type | Modes | Storage Keys | Description |
|--------------|-------|--------------|-------------|
| **Receipt Station** | Installed Windows printer or ESC/POS TCP | `ros.hardware.printer.receipt.mode`, `.systemName`, `.ip`, `.port` | Primary Epson customer thermal printer. Handles sales records, gift receipts, and the attached Register #1 cash drawer. |
| **Tag Station** | Configured Windows printer queue or non-loopback network target | `Zebra LP 2844` + EPL2 | Riverside's only clothing tag printer. Handles SKU/inventory tags. |
| **Reporting Station** | Installed Windows printer or network target | `ros.hardware.printer.report.mode`, `.systemName`, `.ip`, `.port` | Full-page document printer. Handles audit logs, shift summaries, and manifest reports. |

---

## 2. Configuration & Isolation

### Station Isolation
Hardware configurations are stored in the **local browser cache** (`localStorage`). This ensures that hardware settings are isolated to the specific physical lane or workstation where they are configured. If a staff member moves to a different register, the local settings for that hardware will apply.

### Global Synchronization
The **Printers & Scanners** panel in the Back Office and the **Terminal Overrides** in the POS share the same underlying configuration keys. Adjusting a printer target in one shell immediately updates the behavior for the entire workstation.

**POS Accessibility (v0.2.1+)**: The Printers & Scanners hub remains one of the two allowed Settings subsections in POS mode, ensuring floor staff can troubleshoot or reconfigure local hardware without requiring administrative Back Office access.

In POS, the same panel opens as **Register Hardware**. It shows the active receipt endpoint, cash drawer mode, and tag station at the top, then provides lane-safe actions for **Check connection**, **Print test**, **Open drawer**, and scanner input testing.

### Cash Drawer
Register #1 uses the cash drawer attached to the Epson TM-m30III receipt printer. ROS sends the ESC/POS drawer kick command when the completed sale tender summary contains **CASH** or **CHECK**. Card, gift card, account credit, and other non-cash tenders do not open the drawer. Receipt reprints do not intentionally kick the drawer again. The local toggle is stored as `ros.hardware.cashDrawer.enabled`.

The manual **Open drawer** action in POS Register Hardware requires a reason and the acting staff member's **Access PIN** before ROS sends the drawer kick command. The manual open is recorded against the open register session and appears in the Z-report under **Manual Drawer Opens** with the staff member, time, and reason.

---

## 3. Printer Modes

### Thermal (Receipts)
The production receipt path is **Standard Epson**: ROS generates a merged ReceiptLine document, previews it as SVG in Receipt Settings, and prints Epson ESC/POS through the local printer bridge. On Windows desktop stations, staff can choose either an installed printer by name or a raw network address. Receipt content is controlled by the standard receipt settings: store name, header/footer lines, visibility toggles, receipt sections, and the ReceiptLine template.

**Recommended setup:** use **Network address** for the Register #1 Epson receipt printer and cash drawer when the printer has a stable IP. It is the cleanest path for ESC/POS receipt commands and drawer kick. Use **Installed printer on this PC** for USB printers, Windows-driver-managed label/report printers, or as a fallback when raw network printing is not available.

Browser/PWA network printing is allowlisted by the saved station configuration. `/api/hardware/print` only dispatches to receipt, tag, or report network targets that appear in `pos_station_config.printer_config`. A valid POS register session can sync printer settings for its own active register lane; Back Office admins can still manage any lane.

The previous HTML receipt designer is no longer exposed in the active Settings UI. Receipt view, email, and text delivery use the standard receipt renderer when no saved HTML template exists.

### Item Tags
Inventory tag actions generate raw **EPL2** tag commands for the configured Tag Station target, normally the **Zebra LP 2844** Windows queue. Riverside does not support choosing other Zebra label-printer languages for clothing tags.

The Tag Builder is the active tag layout system. Staff start from one default regular tag arrangement and one default sale tag arrangement, then move, resize, rotate, and size each field on the live canvas. The saved builder positions are used by both test tags and real inventory tag printing; old preset layouts are not a separate print path. Promotional tags expose regular price, sale price, and savings as separate movable fields without changing the regular tag layout. Price size is controlled by selecting the Price field and changing its Text size; there is no separate global large/standard price toggle. The price field supports larger-than-XL text sizes for clear shelf pricing; EPL2 output still fits the selected price string inside the saved price box so it does not print through the barcode.

In the desktop app and Main Hub print path, tag printing dispatches raw EPL2 bytes to the saved Tag Station target. The old `127.0.0.1` tag address path is not accepted as a production target. Browser/PWA sessions depend on the Main Hub print hub reaching that same saved target. If the Zebra queue cannot accept the job, ROS reports the printer error and leaves shelf-label status unchanged.

### Document Auto-Routing
The `printerBridge.ts` module includes an intelligent dispatcher that resolves the correct station based on document metadata:

```typescript
await printRawEscPosBase64(escposBase64);
await autoRoutePrint("tag", thermalPayload, "epl");
```

`autoRoutePrint("tag", ...)` sends the EPL2 payload to the configured Tag Station target through the desktop/Main Hub print bridge.

### Pre-Build Print Route Gate

Every app print route is classified in `docs/print-routing-manifest.json`. Run `npm run check:print-routing` before release packaging or hardware-sensitive changes. The gate fails when a new print call appears without a route classification, when a known route's source occurrence count changes, or when a direct receipt, cash drawer, tag, or report route uses the wrong bridge.

This source gate proves route coverage and prevents browser-print drift. It does not replace the final real-device check for the Epson receipt printer/cash drawer, Zebra tag printer, and Reports printer on the target workstation.

---

## 4. Barcode Scanners

Riverside OS treats barcode scanners as standard **HID (Human Interface Device)** inputs. 

- **Configuration**: USB scanners on the host PC and Bluetooth scanners on iPad/phone should be configured in "HID Keyboard Mode" with a carriage return suffix (`\n`).
- **Input Tracking**: The application detects high-velocity input strings and automatically focuses global search or the POS cart to process the scanned SKU.
- **Validation**: The **Printers & Scanners** hub includes a live testing area to verify that scanner events are being captured correctly by the system.

---

## 5. Deployment Checklist
When setting up a new lane:
1. For Register #1 receipts, prefer **Network address** if the Epson receipt printer has a stable IP.
2. Install the Windows printer driver when using **Installed printer on this PC**, or reserve a static IP when using **Network address**.
3. Open **Printers & Scanners** and choose the printer setup mode for receipt, tag, and report stations.
4. For installed printers, choose the printer from the local Windows printer list.
5. For network printers, enter the printer address and port.
6. Save or sync the lane printer settings so browser/PWA print dispatch is allowlisted.
7. Run **Check connection** for the receipt printer from the desktop app, or confirm the saved target from browser/POS mode.
8. In POS Register Hardware, run **Print test** for the Epson receipt station and use **Open drawer** with an Access PIN and reason to verify the audited drawer path.
9. Print a sample inventory tag and confirm the success message names the **Zebra LP 2844** target and EPL2. Tag Designer test prints should report an error instead of opening preview when direct dispatch fails.
10. In the POS, verify that **Auto-Print** toggles are set according to staff preference.
