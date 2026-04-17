# Receipt Builder and delivery (print, email, text)

Staff design receipts in **Settings → Receipt Builder** (GrapesJS Studio **document** mode). Persistence lives in **`store_settings.receipt_config`** (`ReceiptConfig`): **`receipt_studio_project_json`**, **`receipt_studio_exported_html`**, and **`receipt_thermal_mode`**.

**Implementation sketch:** `PLAN_GRAPESJS_RECEIPT_BUILDER.md` (repo root). **Tokens / merge:** `server/src/logic/receipt_studio_html.rs`. **ZPL (legacy thermal):** `server/src/logic/receipt_zpl.rs`. **ESC/POS raster:** `server/src/logic/receipt_escpos_raster.rs`, `POST /api/hardware/escpos-from-png`. **POS UI:** `client/src/components/pos/ReceiptSummaryModal.tsx`, receipt builder under `client/src/components/settings/`.

---

## When is “Studio” / HTML available?

**`receipt_studio_layout_available`** on **`GET /api/orders/{id}`** is `true` only when **`receipt_studio_exported_html`** is non-empty after trim.

- If the store never saved exported HTML, there is **no** merged GrapesJS layout for thermal raster, email content, or MMS image—only placeholders or non-studio paths (ZPL, plain SMS).
- Saving from Receipt Builder must persist **both** project data and **exported HTML** (see `ReceiptBuilderPanel` / Studio `onSave`).

---

## `receipt_thermal_mode` (POS print)

| Value | Behavior |
|--------|----------|
| **`zpl`** (default) | **`GET /api/orders/{id}/receipt.zpl`** — legacy Zebra-oriented builder; **Tauri** `printZplReceipt` (does not use GrapesJS HTML). |
| **`escpos_raster`** | Merged HTML → client **`receiptHtmlToPng`** (`html2canvas`) → **`POST /api/hardware/escpos-from-png`** → ESC/POS bytes → printer bridge (Epson TM-class raster path). |
| **`studio_html`** | Merged HTML in a new tab + **`window.print()`** (browser / system print). |

Email and text flows **do not** use `receipt_thermal_mode`; they always use merged HTML + Podium when configured (see below).

---

## Merged HTML

- **`GET /api/orders/{order_id}/receipt.html`** — optional query:
  - **`register_session_id`** — same auth rules as order read: BO staff with **`orders.view`**, or open register session with a positive allocation to the order.
  - **`gift=1`** / **`true`** / **`yes`** — gift receipt merge (pricing suppressed in template merge).
  - **`order_item_ids`** — comma- or space-separated **`order_items.id`** (UUID) values; when present, only those lines appear on the merged receipt (must match at least one line or **400**).
- Server loads **`receipt_studio_exported_html`**, runs **`merge_receipt_studio_html(tpl, order, cfg, gift)`** with the same order snapshot shape as ZPL (`ReceiptOrderForZpl`, filtered when `order_item_ids` is set).
- If the template is empty, the response body is a small placeholder HTML page (not order-specific layout).

**Settings → Receipt Builder** preview: **`GET /api/settings/receipt/preview-html`** (**`settings.admin`**) accepts optional query **`gift`** (same truthy values) so admins can preview gift merge without a live order.

**Thermal ZPL:** **`GET /api/orders/{order_id}/receipt.zpl`** supports the same **`gift`** and **`order_item_ids`** query parameters (full order is the default when omitted).

**Customer-facing privacy:**
- **Staff and Customer Privacy**: All participant names on customer receipts use **`receipt_privacy::mask_name_for_receipt`** to return **First Name + Last Initial** (e.g. "Christopher G."). Full names are strictly reserved for internal screens, analytical reports, and authenticated API contexts.
- **Internal Line Suppression**: Items flagged as `is_internal` (e.g., SPIFF rewards, combo incentives) are automatically filtered from all customer-facing receipts. They remain visible in the Back Office for payroll and audit.

---

## Email receipt (Podium, inline HTML)

- **`POST /api/orders/{order_id}/receipt/send-email`** — JSON body optional **`to_email`**; if omitted, uses the customer email on the order. Optional **`gift`** (bool) and **`order_item_ids`** (UUID array; empty = all lines) — same semantics as the HTML route.
- Requires **non-empty** exported Receipt Builder HTML; returns **400** otherwise.
- Builds merged HTML, wraps it for Podium with **`wrap_receipt_fragment_for_podium_email_inline`** (a single styled **`<div>`**, not a full `<html>` document, so inboxes treat it as normal message HTML rather than a downloadable file).
- Sends via **`send_podium_email_message`** → Podium **`POST /v4/messages`** with **`channel.type`: `email`**, **`subject`**, HTML **`body`**.
- Needs **`RIVERSIDE_PODIUM_*`**, **`podium_sms_config.email_send_enabled`**, and **`location_uid`**. Failures surface as **502** with a Podium hint string.

---

## Text receipt (Podium: MMS image or SMS text)

- **`POST /api/orders/{order_id}/receipt/send-sms`** — JSON optional **`to_phone`**, optional **`png_base64`** (raw base64 PNG, no data-URL prefix), optional **`gift`** and **`order_item_ids`** (gift uses plain-text **`format_pos_gift_receipt_text_message`** when no PNG; MMS raster uses **`receipt.html`** with the same query params as the client).
- **With `png_base64`:** decodes PNG (max **6 MiB** decoded), sends **`POST /v4/messages/attachment`** (multipart: JSON **`data`** + **`attachment`** file `receipt.png`) via **`send_podium_phone_message_with_png_attachment`**. Short caption text accompanies the image (MMS behavior depends on carrier / Podium). Response may include **`"mode": "mms_attachment"`**.
- **Without image:** plain transactional body from **`receipt_plain_text`** (clamped length), **`send_podium_sms_message`**. Response **`"mode": "sms_text"`**.
- **POS:** When **`receipt_studio_layout_available`**, the client fetches **`receipt.html`**, rasterizes with **`receiptHtmlToPngBase64`**, and includes **`png_base64`**. If rasterization fails or there is no studio layout, only the text path is used.

Podium attachment endpoint is **rate-limited** (see Podium docs, typically **10 rpm**).

---

## Related permissions and ops

- Order read / receipt routes: **`docs/STAFF_PERMISSIONS.md`** (`orders.view` or register-session scoping).
- Podium env and Settings → Integrations: **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`**, **`DEVELOPER.md`**.
- **POS:** **`ReceiptSummaryModal`** — standard print/send plus **gift receipt** line pick (checkboxes), **Print gift**, **Email gift receipt**, **Text gift receipt** when line items are present — **`docs/PLAN_PODIUM_REVIEWS.md`** for review invite on the same modal.
- Reporting catalog entries for these paths: **`docs/AI_REPORTING_DATA_CATALOG.md`** (`/api/orders/*`, `/api/hardware/*`).
