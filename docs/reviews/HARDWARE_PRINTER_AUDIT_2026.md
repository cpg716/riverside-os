# Audit Report: Hardware & Printer Integration
**Date:** 2026-04-08
**Status:** Highly Reliable / Tiered Bridge Strategy
**Auditor:** Antigravity

## 1. Executive Summary
Riverside OS uses a mature, tiered approach for hardware communication, specifically thermal receipt and label printing. The system prioritizes native binary performance when available but includes cloud-proxied and browser-based fallbacks to ensure floor staff are never blocked from finishing a sale.

## 2. Technical Architecture: The Tiered Bridge

### 2.1 Tier 1: Native Tauri Bridge
- **Priority**: High (Primary for Registers).
- **Mechanism**: React `invoke` calling Rust `hardware.rs`.
- **Performance**: Near-instantaneous. Bypasses all browser print dialogs.
- **Protocol**: Direct TCP/IP socket communication (`tokio::net::TcpStream`).

### 2.2 Tier 2: Server Hardware Proxy
- **Priority**: Medium (Primary for iPads/PWA).
- **Mechanism**: `POST /api/hardware/print`.
- **Benefit**: Allows mobile devices to "delegate" printing to the central POS server, which has a direct route to the local network printers.
- **Workflow**: PWA sends the ZPL/ESC-POS payload to the server; the server dispatches it over the LAN.

### 2.3 Tier 3: Browser Fallback
- **Priority**: Low (Safety net).
- **Mechanism**: `window.open` with a `<pre>` tag.
- **Limitation**: Requires a user gesture and may be blocked by popup blockers; primarily for non-thermal backup situations.

## 3. Supported Protocols

### 3.1 ESC/POS (Receipts)
- **Vendors**: Epson TM series, Star Micronics.
- **Command Set**: Standard ESC/POS with `ESC @` initialization and `GS V A 0` (Full Cut).
- **Raster Support**: `print_escpos_binary_b64` allows for high-quality PNG-to-Raster conversions for logos and complex layouts.

### 3.2 ZPL (Labels)
- **Vendors**: Zebra, Brother, Godex.
- **Command Set**: Raw ZPL II dispatch. Primarily used for inventory tagging and "Tailor Tags" in the Alterations Workspace.

## 4. Operational Features
- **Diagnostics**: A `check_printer_connection` handshake allows staff to test the printer path from Settings without wasting paper.
- **Auto-Cut**: Standard in the ESC/POS driver with a 4-line feed to clear the tear bar before cutting.
- **MMS Integration**: Part of the Podium plugin, allowing physical receipts to be "printed" as a PNG and sent via SMS directly to the customer.

## 5. Findings & Recommendations
1. **Network Configuration**: Reliable printing depends on static IPs for printers. **Recommendation**: Implement a "Store Hardware Map" documentation guide to assist store owners in setting up their LAN.
2. **Reliability**: Use of `tokio::time::timeout` (5s) prevents UI freezes if a printer goes offline or has a paper jam.
3. **Observation**: The system lacks "Automatic Print on Checkout" for PWA users (due to browser permission constraints). **Recommendation**: Use the "Server hardware proxy" as the default path for all non-desktop PWA installs to avoid popup issues.

## 6. Conclusion
The hardware integration is a professional-grade implementation that values operational reliability above all else. The split-path bridge (Native vs. Proxy) is a clever solution to the problem of browser-based retail software.
