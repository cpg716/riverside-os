# Receipt Settings and delivery (print, email, text)

Staff manage production receipt content in **Settings → Receipt Settings**. The active register print path is:
- **Standard Epson**: structured ESC/POS output for Epson TM-m30III-compatible 80mm receipt printers, with a ReceiptLine preview using the template's configured character-per-line layout.

The editor exposes the full Riverside Men's Shop logo toggle, store contact fields, editable header lines, editable footer lines, section toggles, a **Print Test** action, and the underlying **ReceiptLine markdown template**. ROS merges transaction data into the template, previews it as SVG, and POS prefers that same merged ReceiptLine document when generating Epson ESC/POS for print. If the client-side ReceiptLine transform fails, POS falls back to the server-generated ESC/POS payload.

Receipt identity and financial fields are protected. The builder will not apply, test-print, or test-deliver a template that omits a required field or repeats a token. Protected fields include the receipt type, Transaction #, date/time, customer, salesperson, staff, Register #, items, order-payment activity, subtotal, separately stated sales tax, total, paid amount, balance, tender, and status. Optional branding and operational sections remain editable.

The builder also exposes **Delivery tests**. A test email sends the current ReceiptLine preview through the configured Store Email mailbox. A test text rasterizes that same preview to PNG and sends it as a Podium MMS attachment. These tests use the unsaved editor state, so staff can verify a layout before applying it.

Persistence lives in **`store_settings.receipt_config`** (`ReceiptConfig`), including **`receiptline_template`**. Legacy Studio fields may still exist for older saved templates, but the active Settings UI no longer exposes the HTML designer.

**Thermal Preview:** `client/src/components/settings/ReceiptBuilderPanel.tsx` using **`receiptline`**. **Standard ESC/POS:** `server/src/logic/receipt_escpos.rs`, `GET /api/transactions/{transaction_id}/receipt.escpos`. **Legacy HTML fallback / email view:** `server/src/logic/receipt_studio_html.rs`. **POS UI:** `client/src/components/pos/ReceiptSummaryModal.tsx`. Hardware management is centralized in the **Printers & Scanners** hub (`client/src/components/settings/PrintersAndScannersPanel.tsx`).

Register #1 uses the Epson TM-m30III receipt station for both customer receipts and the attached cash drawer. The drawer opens automatically only when the completed sale tender summary includes **CASH** or **CHECK** and the workstation drawer setting is enabled. Reprints and gift receipts do not intentionally kick the drawer. Manual drawer opens happen from POS **Printers & Scanners / Register Hardware**, require an **Access PIN** plus reason, and are included in the Z-report.

---

## HTML receipt fallback

**`receipt_studio_layout_available`** on transaction detail is `true` only when a legacy **`receipt_studio_exported_html`** value is non-empty after trim. When it is empty, ROS renders a standard receipt HTML fallback for receipt viewing and email delivery instead of showing "No HTML receipt built."

---

## `receipt_thermal_mode` (POS print)

| Value | Behavior |
|--------|----------|
| **`escpos`** (default) | **`GET /api/transactions/{id}/receipt.escpos`** — Standard Epson ESC/POS bytes; **Tauri** sends raw ESC/POS to the TM-m30III by installed printer or network target, browser/PWA uses the server print bridge for network targets reachable from the API host. |

Email and text flows **do not** use `receipt_thermal_mode`; they use standard HTML/plain text delivery when configured (see below).

---

## Merged HTML

- **`GET /api/transactions/{transaction_id}/receipt.html`** — optional query:
  - **`register_session_id`** — same auth rules as Transaction Record read: BO staff with **`orders.view`**, or open register session with a positive allocation to the transaction.
  - **`gift=1`** / **`true`** / **`yes`** — gift receipt merge (pricing suppressed in template merge).
  - **`transaction_line_ids`** — comma- or space-separated **`transaction_lines.id`** (UUID) values; when present, only those lines appear on the merged receipt (must match at least one line or **400**).
- Server loads **`receipt_studio_exported_html`**. If a legacy template exists, it runs **`merge_receipt_studio_html(tpl, order, cfg, gift)`**; otherwise it runs **`render_standard_receipt_html(order, cfg, gift)`**.
- Empty Studio HTML no longer blocks receipt viewing.

**Settings → Receipt Settings** preview is rendered in the client with **`receiptline`**. The paper target is the 80mm Epson customer receipt; the character-per-line value is the ReceiptLine formatting width for the current template, not the physical paper width.

The top logo uses ReceiptLine's image property (`{image: base64-png}`) through the controlled `{{LOGO_IMAGE}}` token. ROS resizes the full Riverside Men's Shop logo lockup for thermal output before it is merged into the printable ReceiptLine document.

**Loyalty tokens:** `{{LOYALTY_EARNED}}` and `{{LOYALTY_BALANCE}}` display the points earned for the transaction and the customer's current balance. They are populated from `transaction_loyalty_accrual` and `customers.loyalty_points` at print time and are gated by the `show_loyalty_earned` and `show_loyalty_balance` receipt settings toggles.

**Financial tokens:** Customer receipts must keep `{{SUBTOTAL_LINE}}`, `{{TAX_LINE}}`, `{{TOTAL_SAVINGS_LINE}}`, and `{{TOTAL_LINE}}` in that order so staff and customers can distinguish item subtotal, taxes, savings from discounts, and final total. `{{TOTAL_SAVINGS_LINE}}` is omitted when no line-level savings are present.

**Customer audit detail:** Every receipt includes its Transaction #, transaction date/time (including picked-up receipts), salesperson, staff member, and physical **Register #** when the Transaction Record came from a register session. Item rows identify SKU, variation, quantity, line amount, regular/sale pricing when discounted, fulfillment context, and the saved state-plus-local tax amount for that line. This compact tax amount is visually smaller than the primary item details in receipt previews and digital HTML; it never uses the redundant “Taxable” or “Exempt” wording. Digital HTML/email receipts use real table headers for item, quantity, and amount; HTML, thermal, and text outputs all state subtotal, sales tax, savings when present, total, payment/balance, and every tender.

These fields support New York's requirement that written receipts separately state sales tax and that POS records retain the item, selling price, tax, invoice/date, payment method, and terminal/transaction identity needed to audit the sale. Card details remain customer-safe: provider summaries may show brand and last four, never a full card number or expiration date, consistent with FACTA and PCI display masking.

External references: [New York sales-tax recordkeeping](https://www.tax.ny.gov/pubs_and_bulls/tg_bulletins/st/record-keeping_requirements_for_sales_tax_vendors.htm), [New York taxable receipts](https://www.tax.ny.gov/pubs_and_bulls/tg_bulletins/st/taxable_receipt.htm), [FTC receipt truncation guidance](https://www.ftc.gov/news-events/news/press-releases/2007/05/ftc-reminds-businesses-law-requires-them-truncate-credit-card-data-receipts), [PCI SSC display masking](https://www.pcisecuritystandards.org/faqs/1146/), and [W3C accessible table guidance](https://www.w3.org/WAI/tutorials/tables/).

**Receipt barcode:** When **Order Barcode** is enabled and `{{BARCODE_IMAGE}}` is present, the receipt prints a Code128 barcode containing the Transaction Record display ID such as `TXN-566056`. Scanning that code in the Register opens the correct Transaction Record workflow for returns/exchanges or open-order work. Scanning/typing it in Universal Search opens the Transaction Hub for that receipt.

**ReceiptLine print preference:** The ESC/POS endpoint returns both `receiptline_markdown` (template-based) and `escpos_base64` (legacy structured fallback). The POS client prefers the ReceiptLine path, transforming it client-side for printing. The raw ESC/POS fallback uses a fixed layout and does not honor the operator's template customizations, logo image, or loyalty tokens — it exists solely as a safety net when the client-side ReceiptLine transform fails.

**Thermal ESC/POS:** **`GET /api/transactions/{transaction_id}/receipt.escpos`** supports the same **`gift`** and **`transaction_line_ids`** query parameters (full Transaction Record is the default when omitted).

**Payment receipts:** Daily Sales payment-only activity uses **`GET /api/payments/allocations/{allocation_id}/receipt.escpos`** to print a payment receipt without merchandise lines. It includes customer name, Customer #, phone, applied Transaction Record, method details, amount paid, paid-to-date, and remaining balance.

**Customer-facing privacy:**
- **Staff and Customer Privacy**: All participant names on customer receipts use **`receipt_privacy::mask_name_for_receipt`** to return **First Name + Last Initial** (e.g. "Christopher G."). Full names are strictly reserved for internal screens, analytical reports, and authenticated API contexts.
- **Internal Line Suppression**: Items flagged as `is_internal` (e.g., SPIFF rewards, combo incentives) are automatically filtered from all customer-facing receipts. They remain visible in the Back Office for payroll and audit.

---

## Email receipt (Store Email, inline HTML)

- **`POST /api/transactions/{transaction_id}/receipt/send-email`** — JSON body optional **`to_email`**; if omitted, uses the customer email on the Transaction Record. Optional **`gift`** (bool) and **`transaction_line_ids`** (UUID array; empty = all lines) — same semantics as the HTML route.
- Builds merged HTML when a saved template exists; otherwise builds the standard receipt HTML fallback. The saved-template fragment is wrapped as one email-safe styled **`<div>`**.
- Sends through **`email::send_email`** using the configured Store Email SMTP account and records the outbound mailbox/customer notification evidence.
- The normal and gift-receipt email subjects are editable in **Settings → Integrations → Podium → Receipt Delivery Messages**. Supported subject values are `{store_name}`, `{receipt_ref}`, `{receipt_type}`, `{customer_name}`, and `{customer_code}`. The receipt HTML itself remains controlled by Receipt Settings.
- Needs Store Email enabled plus saved IONOS SMTP credentials. Failures surface as **502** with a Mailbox settings hint.

---

## Text receipt (Podium: ReceiptLine MMS image with SMS fallback)

- **Enablement:** **Settings → Integrations → Podium → Receipt Delivery Messages → Text receipts enabled** controls receipt SMS/MMS independently from staff-authored, pickup, alteration, appointment, and new-sender texts. Review requests retain their own review-policy switch.
- **`POST /api/transactions/{transaction_id}/receipt/send-sms`** — JSON optional **`to_phone`**, optional **`png_base64`** (raw base64 PNG, no data-URL prefix), optional **`gift`** and **`transaction_line_ids`** (gift uses plain-text **`format_pos_gift_receipt_text_message`** when no PNG; MMS raster uses **`receipt.html`** with the same query params as the client).
- **With `png_base64`:** decodes PNG (max **6 MiB** decoded), sends **`POST /v4/messages/attachment`** (multipart: JSON **`data`** + **`attachment`** file `receipt.png`) via **`send_podium_phone_message_with_png_attachment`**. Short caption text accompanies the image (MMS behavior depends on carrier / Podium). Response may include **`"mode": "mms_attachment"`**.
- Normal and gift-receipt MMS captions are editable in **Settings → Integrations → Podium → Receipt Delivery Messages** with `{store_name}`, `{receipt_ref}`, `{receipt_type}`, `{customer_name}`, and `{customer_code}` values.
- **Without image:** plain transactional body from **`receipt_plain_text`** (clamped length), **`send_podium_sms_message`**. Response **`"mode": "sms_text"`**.
- **POS:** The Register rasterizes the same ReceiptLine preview used for Epson printing and sends it as an MMS image. If rasterization is unavailable, ROS sends the financially complete plain-text receipt instead. Gift receipts use only the selected gift lines.

Podium attachment endpoint is **rate-limited** (see Podium docs, typically **10 rpm**).

---

## Related permissions and ops

- Transaction Record receipt routes: **`docs/STAFF_PERMISSIONS.md`** (`orders.view` or register-session scoping).
- Store Email and Podium setup: **`docs/EMAIL_MAILBOX.md`**, **`docs/PLAN_PODIUM_SMS_INTEGRATION.md`**, **`DEVELOPER.md`**.
- **POS:** **`ReceiptSummaryModal`** — compact sale completion, standard print/send, receipt viewing, and separate **gift receipt** line pick for print/email/text when line items are present — **`docs/PLAN_PODIUM_REVIEWS.md`** for review invite on the same modal.
- Reporting catalog entries for these paths: **`docs/AI_REPORTING_DATA_CATALOG.md`** (`/api/transactions/*`, `/api/hardware/*`).
