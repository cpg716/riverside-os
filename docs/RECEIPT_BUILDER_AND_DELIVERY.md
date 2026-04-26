# Receipt Settings and delivery (print, email, text)

Staff manage production receipt content in **Settings → Receipt Settings**. The active register print path is:
- **Standard Epson**: structured ESC/POS output for Epson TM-m30III-compatible 80mm receipt printers, with a ReceiptLine preview using the template's configured character-per-line layout.

The editor exposes the store identifier, receipt logo toggle, editable header lines, editable footer lines, section toggles, and the underlying **ReceiptLine markdown template**. ROS merges transaction data into the template, previews the result as SVG, and POS prefers that same merged ReceiptLine document when generating Epson ESC/POS for print. If the client-side ReceiptLine transform fails, POS falls back to the server-generated ESC/POS payload.

Persistence lives in **`store_settings.receipt_config`** (`ReceiptConfig`), including **`receiptline_template`**. Legacy Studio fields may still exist for older saved templates, but the active Settings UI no longer exposes the HTML designer.

**Thermal Preview:** `client/src/components/settings/ReceiptBuilderPanel.tsx` using **`receiptline`**. **Standard ESC/POS:** `server/src/logic/receipt_escpos.rs`, `GET /api/transactions/{transaction_id}/receipt.escpos`. **Legacy HTML fallback / email view:** `server/src/logic/receipt_studio_html.rs`. **POS UI:** `client/src/components/pos/ReceiptSummaryModal.tsx`. Hardware management is centralized in the **Printers & Scanners** hub (`client/src/components/settings/PrintersAndScannersPanel.tsx`).

---

## HTML receipt fallback

**`receipt_studio_layout_available`** on transaction detail is `true` only when a legacy **`receipt_studio_exported_html`** value is non-empty after trim. When it is empty, ROS renders a standard receipt HTML fallback for receipt viewing and email delivery instead of showing "No HTML receipt built."

---

## `receipt_thermal_mode` (POS print)

| Value | Behavior |
|--------|----------|
| **`escpos`** (default) | **`GET /api/transactions/{id}/receipt.escpos`** — Standard Epson ESC/POS bytes; **Tauri** sends raw ESC/POS to the TM-m30III, browser/PWA uses the server print bridge. |

Email and text flows **do not** use `receipt_thermal_mode`; they use standard HTML/plain text delivery when configured (see below).

---

## Merged HTML

- **`GET /api/orders/{order_id}/receipt.html`** — optional query:
  - **`register_session_id`** — same auth rules as order read: BO staff with **`orders.view`**, or open register session with a positive allocation to the order.
  - **`gift=1`** / **`true`** / **`yes`** — gift receipt merge (pricing suppressed in template merge).
  - **`order_item_ids`** — comma- or space-separated **`order_items.id`** (UUID) values; when present, only those lines appear on the merged receipt (must match at least one line or **400**).
- Server loads **`receipt_studio_exported_html`**. If a legacy template exists, it runs **`merge_receipt_studio_html(tpl, order, cfg, gift)`**; otherwise it runs **`render_standard_receipt_html(order, cfg, gift)`**.
- Empty Studio HTML no longer blocks receipt viewing.

**Settings → Receipt Settings** preview is rendered in the client with **`receiptline`**. The paper target is the 80mm Epson customer receipt; the character-per-line value is the ReceiptLine formatting width for the current template, not the physical paper width.

The top logo uses ReceiptLine's image property (`{image: base64-png}`) through the controlled `{{LOGO_IMAGE}}` token. ROS resizes the Riverside logo for thermal output before it is merged into the printable ReceiptLine document.

**Thermal ZPL:** **`GET /api/orders/{order_id}/receipt.zpl`** supports the same **`gift`** and **`order_item_ids`** query parameters (full order is the default when omitted).

**Customer-facing privacy:**
- **Staff and Customer Privacy**: All participant names on customer receipts use **`receipt_privacy::mask_name_for_receipt`** to return **First Name + Last Initial** (e.g. "Christopher G."). Full names are strictly reserved for internal screens, analytical reports, and authenticated API contexts.
- **Internal Line Suppression**: Items flagged as `is_internal` (e.g., SPIFF rewards, combo incentives) are automatically filtered from all customer-facing receipts. They remain visible in the Back Office for payroll and audit.

---

## Email receipt (Podium, inline HTML)

- **`POST /api/orders/{order_id}/receipt/send-email`** — JSON body optional **`to_email`**; if omitted, uses the customer email on the order. Optional **`gift`** (bool) and **`order_item_ids`** (UUID array; empty = all lines) — same semantics as the HTML route.
- Builds legacy merged HTML when a saved template exists; otherwise builds the standard receipt HTML fallback. The body is wrapped for Podium with **`wrap_receipt_fragment_for_podium_email_inline`** (a single styled **`<div>`**, not a full `<html>` document, so inboxes treat it as normal message HTML rather than a downloadable file).
- Sends via **`send_podium_email_message`** → Podium **`POST /v4/messages`** with **`channel.type`: `email`**, **`subject`**, HTML **`body`**.
- Needs **`RIVERSIDE_PODIUM_*`**, **`podium_sms_config.email_send_enabled`**, and **`location_uid`**. Failures surface as **502** with a Podium hint string.

---

## Text receipt (Podium: MMS image or SMS text)

- **`POST /api/orders/{order_id}/receipt/send-sms`** — JSON optional **`to_phone`**, optional **`png_base64`** (raw base64 PNG, no data-URL prefix), optional **`gift`** and **`order_item_ids`** (gift uses plain-text **`format_pos_gift_receipt_text_message`** when no PNG; MMS raster uses **`receipt.html`** with the same query params as the client).
- **With `png_base64`:** decodes PNG (max **6 MiB** decoded), sends **`POST /v4/messages/attachment`** (multipart: JSON **`data`** + **`attachment`** file `receipt.png`) via **`send_podium_phone_message_with_png_attachment`**. Short caption text accompanies the image (MMS behavior depends on carrier / Podium). Response may include **`"mode": "mms_attachment"`**.
- **Without image:** plain transactional body from **`receipt_plain_text`** (clamped length), **`send_podium_sms_message`**. Response **`"mode": "sms_text"`**.
- **POS:** Text receipts can include a standard plain transactional body. Gift receipts use the selected gift line set when staff opens the gift receipt action.

Podium attachment endpoint is **rate-limited** (see Podium docs, typically **10 rpm**).

---

## Related permissions and ops

- Order read / receipt routes: **`docs/STAFF_PERMISSIONS.md`** (`orders.view` or register-session scoping).
- Podium env and Settings → Integrations: **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`**, **`DEVELOPER.md`**.
- **POS:** **`ReceiptSummaryModal`** — compact sale completion, standard print/send, receipt viewing, and separate **gift receipt** line pick for print/email/text when line items are present — **`docs/PLAN_PODIUM_REVIEWS.md`** for review invite on the same modal.
- Reporting catalog entries for these paths: **`docs/AI_REPORTING_DATA_CATALOG.md`** (`/api/orders/*`, `/api/hardware/*`).
