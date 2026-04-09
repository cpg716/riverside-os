# Riverside OS — Hardware Support

Riverside Operating System interfaces natively with retail hardware (Receipt Printers, Barcode Scanners, Cash Drawers) bypassing standard generic browser drivers.

## Receipt Printing (TCP Thermal Sockets)
Riverside OS uses the Rust async networking layer (`tokio::net`) compiled via Tauri to dispatch byte arrays directly over the local network to thermal printers.

**Supported Standard:** 
- Epson **ESC/POS** Network Printers (e.g. TM-M30III, TM-T88VI)
- Zebra **ZPL** (via standard ZPL UTF-8 streams)

**Configuration:**
The Rust bridge connects automatically to Port `9100` on the target IP. 
To change the active IP for the receipt printer:
1. Hardcoded default during development is set to `192.168.1.200` directly in `Cart.tsx` -> `printEpsonReceipt`.
2. Connect your Epson TM-M30III to the local WiFi or Ethernet switch.
3. Print a self-test page on the Epson to retrieve its dynamic IP, and configure it as a Static Lease in your network router to permanently map to the bridge.

## Barcode Scanners (HID / Keyboard Emulation)
Riverside OS leverages the **Omni-Search** global listener. You do not need a specific input focused to scan items in many contexts:
- If you are positioned securely inside the POS `Cart` interface, physical USB/Bluetooth laser scanners acting as Keyboard Emulators (adding a `\r\n` suffix) automatically dump their keystrokes into the hidden global scanner buffer, dropping items directly into the cart faster than human-typing.

## Cash Drawers
The cash drawer RJ11 cable must be plugged directly into the back of your primary Epson printer (labeled `DK`). 
The POS driver will automatically fire the `[0x1B, 0x70]` ESC/POS Kick Command when executing a successful `Checkout` that includes physical Cash as the primary tender.
