# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepashangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Direct Register Camera and Parked-Sale Access**: Register now exposes camera scanning beside product search through the existing authoritative scan endpoint, and keeps **Parked Sales** plus its live count visible even when no sale is currently parked. Staff can scan repeatedly, close back to product search, or recall/remove unfinished server-backed sales without first opening Customer search.
- **Mandatory Exact-Build Transaction Updates**: Tauri, installed PWA, and browser stations now compare their exact build with the Main Hub before Register becomes interactive, while signed in, on focus/reconnect, and before Payment. A non-dismissible update dialog installs the signed desktop update or safely resyncs PWA web caches while preserving Cart/auth/recovery storage. Checkout and provider-payment APIs independently reject stale or unidentified production clients with HTTP 409, while a genuinely unreachable Main Hub continues through the existing strict offline-sale eligibility rather than being mislabeled as an update mismatch.
- **Unified Customer Communications and Call History**: Customer Relationship Hub now presents Podium text messages and customer-linked calls in one Inbox-style dated conversation view, keeps Email as a separate channel, and records Podium call direction, outcome, voicemail state, and duration in Customer History. A permission-checked customer call endpoint supplies the same deduplicated provider lifecycle used by the Podium Inbox.
- **Slim, Component-Aware Main Hub Updates**: Every tagged Windows release now publishes both the complete installation/recovery package and an exact-build Main Hub update package. Existing Main Hubs automatically prefer the smaller package, verify its GitHub and per-file checksums, and compare deterministic ROSIE, Meilisearch, and Cube Core fingerprints with the last successful install. Unchanged, healthy auxiliary components remain running while changed, unhealthy, or previously untracked components use their complete verified setup; database backup, migration checks, rollback, exact-build proof, and `/api/ready` remain mandatory. The updater now performs one server cutover instead of immediately stopping and restarting the newly verified server a second time.
- **Flexible Loyalty Reward Card Allocation**: Staff can choose how many configured $50 reward blocks to load onto each scanned Loyalty Gift Card, split a customer's available reward across as many or as few cards as needed, and intentionally leave unused blocks for later. Both POS and Back Office show the selected load, points used, and reward left before issuance, while card entry stays locked during an active load so a fast second scan cannot be cleared by the first request.
- **ROS-to-QBO GL Number Crosswalk**: QuickBooks Mapping now pairs a selectable Riverside GL# from the full approved account catalog with the live QBO GL# returned by Intuit. Existing mappings receive exact-number and high-confidence ROS suggestions, mapping controls show match/review status, inline staging fixes preserve the ROS reference, and QBO remains the authoritative posting destination.
- **Podium Conversation Ownership, Calls, and Published Reviews**: Podium Inbox can assign or unassign a conversation to any active Riverside staff member linked to a Podium user without sending a reply. The **Replying as** list uses that same linked-staff roster, refuses unlinked identities on the server, and remembers the PIN-verified selection per conversation. Signed call and review lifecycle webhooks add missed calls, voicemail indicators, published reviews, response status, and linked activity to Inbox and Operations → Reviews.
- **Operations Today and Calmer Diagnostics**: ROS Operations now opens to one prioritized staff list with **Do Now**, **Needs Follow-Up**, and collapsed **Healthy systems** proof. Live Main Hub readiness, verified backups, workstation heartbeats, and open Register sessions replace manual daily guesses; a secondary offline workstation no longer blocks the store while an active workstation remains online. Certification, station history, raw alerts, integrations, performance, and bug/error evidence remain available under **Advanced Diagnostics**. Automated diagnostics group repeated events and separate actionable failures from recurring connectivity and expected validation/setup background.
- **Review Request Outbox Controls**: Reviews now shows pending scheduled invitations in a staff-visible outbox with an explicit Cancel action before delivery. Authorized staff can also send an immediate test Review Request to a selected Customer through ROS using the normal Podium review-link and tracked-delivery path, without opening Podium directly or bypassing Riverside audit and consent rules.
- **Streamlined Staff Mailbox and Safe Email Viewer**: Operations Mailbox now uses a compact folder, conversation, and viewer workspace with an on-demand composer. Opening inbound mail marks its conversation read; individual and multi-select Read/Unread, Archive, recoverable Trash, Restore, Reply, Forward, Important, Follow-up, and folder actions remain available together. Stored HTML email renders in a contained sandbox with unsafe scripts, forms, embedded frames, and URLs removed, while multipart mail can switch to plain text.
- **Staff-Friendly Podium Inbox and Conversation Triage**: Podium Inbox now uses a compact text-message workspace, opens Podium notifications directly to the exact conversation, identifies the sender in notification previews, and resolves provider assignees through each staff profile's linked Podium identity. Staff can reply to an unmatched conversation before creating or linking a Customer, use check-in and pickup drafts, add common emoji, and attach a PNG to an SMS. Customer Relationship Hub keeps one clear Text or Email history instead of repeating the same activity in a second timeline. Opening a thread marks it read with visible failure handling; individual and multi-select Read/Unread actions are available, while confirmed Close/Reopen actions use Podium's native closed state with partial-batch reporting and a Closed filter.
- **Focused Podium Setup and Provider-Managed Webhooks**: Settings now reads active locations and webhook subscriptions from Podium, requires a selected provider location and public HTTPS callback, and explicitly creates or updates Riverside's message/contact/review-link subscription after admin confirmation. The Podium page shows the pinned API version and no longer asks staff to maintain a raw location UID.
- **Printable Parent Stock & Sales Report**: Product Hub now includes a Stock Report for the open parent item and every variation. The report shows current on-hand quantity, authoritative last-sold date, complete-history monthly sales average, annualized yearly sales pace, parent trailing-12-month sales ranking, and parent last-30-day unit sales, with professional report-printer output that does not change inventory. On-screen and printed variation rows stay grouped by color/style and sort from the smallest apparel or numeric size to the largest.
- **Privacy-Safe Register Performance Telemetry**: Register now measures product search, barcode-to-Cart, Payment opening, tender confirmation, receipt readiness, and Register close without collecting customer, search, receipt, Access PIN, or card content. A strict active-session endpoint stores allowlisted samples in the existing 30-day operational metrics ledger, and **ROS Operations & Support Center → Register Performance** shows the last 24 hours of sample counts, median, p95, maximum duration, and failures by workflow stage.
- **Register Email Collection and Reporting**: Loading a customer without an email into Register now opens a focused prompt to save an email, skip for the current load, or record that the customer declined. A decline permanently suppresses future prompts for that customer. Every email saved through the prompt records the customer account, signed-in staff member, and store-local collection date for the new curated **Email Collection Report**, including daily and staff collection totals. New-customer intake now prechecks Email, SMS, operational SMS, and operational email approvals while keeping each choice visible and editable before save.

### Fixed
- **Customer Hub Quick Look and Grouped History**: Customer Profile now places balances, loyalty, open work, wedding status, recent context, and completeness cards directly beneath contact details instead of leaving that workspace blank while the longer settings column continues. Customer History groups purchase, payment, pickup, call, appointment, shipment, wedding, and note activity recorded in the same second into one readable dated card while retaining every labeled event, record link, and underlying receipt row.
- **Truthful Podium History Sync Status**: Podium Inbox now treats **Pulling history** as neutral progress instead of continuing to display the generic **Podium needs attention** warning. If message history remains incomplete after the pull stops, the warning returns; webhook processing and missing call-delivery problems continue to raise attention independently.
- **Fast, Recoverable Search and Exact Register Scans**: Customer, product, inventory, procurement, online-store, wedding, and Transaction search paths retain current results while replacements run, cancel superseded requests, reject stale responses, and expose actionable Meilisearch health/reindex recovery. Register now prioritizes the authoritative direct result so exact SKUs, product barcodes, and active barcode aliases add immediately; name-only or ambiguous matches still require staff review.
- **Compact Register Checkout and Dialog Accessibility**: Below 1024 px, Register now provides full-width Cart and **Customer & Pay** views instead of making the customer, totals, keypad, and Pay controls unreachable. Camera teardown covers close, retry, unmount, and start/close races; the camera plus five Cart-owned dialogs contain keyboard focus, support safe Escape close, and restore focus. Pointer movement is throttled without weakening meaningful idle-lock activity.
- **Normal Customer Phone Formatting on Receipts**: Customer-facing sale, payment, alteration, preview, digital, and historical reprint receipts now display valid US phone numbers as `(XXX) XXX-XXXX` even when Riverside stores the contact in provider-safe E.164 form. International and otherwise unrecognized numbers remain unchanged.
- **Truthful Customer Notification Failures**: Customer Notifications now filters and totals rows by their effective delivery outcome, so SMS messages accepted by Podium and later rejected by a carrier appear under **Failed** instead of **Sent**. Status filtering no longer zeroes the page summary, pending carrier confirmations use pending styling, and opaque Podium `P0005` failures explain the delivery problem while retaining the provider code.
- **Complete Podium Open-Inbox Parity**: Podium Inbox now cursor-pulls the complete current provider conversation set, preserves completed history for unchanged conversations to avoid redundant provider calls, lists every open conversation instead of filtering a mixed 80-row window, and clears false **History incomplete** attention after a successful full pull.
- **ROS-Only Podium Review Eligibility**: Historical Counterpoint Transaction imports can no longer enter the Podium review-request schedule through fulfillment triggers, customer/Transaction scheduling actions, delivery claims, or failed-invite retries. Existing unsent imported invitations are suppressed in place with retained audit evidence and stay out of the Reviews workspace; only native Riverside fulfilled pickup/takeaway Transactions remain eligible.
- **Visible Podium Calls and Clear Inbox Identity**: Podium Inbox now recognizes nested provider call payloads, identifies a conversation's latest call activity in the shared list, and reports the stored-call count and latest received call in Status so a missing provider call subscription is immediately visible. Unmatched conversations use their phone number as the primary label, while selected conversations, primary actions, and Riverside outbound messages use the Inbox's blue visual identity instead of purple.
- **Windows Cube Runtime Download Retry**: Windows packaging now retries the pinned Cube runtime dependency installation up to three times with bounded backoff when GitHub or npm closes a download connection transiently. A final failed attempt still blocks publication instead of producing an incomplete Main Hub package.
- **Background Podium Contact Reconciliation**: Full customer reconciliation now starts asynchronously, keeps Podium's 100-contact page size on every cursor request, exposes persisted progress and sync-state counts in Settings, avoids re-sending successful mappings, and skips unnecessary search indexing for unchanged customers. Missing and failed Riverside contacts are queued while ambiguous identities remain blocked for review.
- **Recoverable Unresolved Card Not Present Attempts**: When Helcim recovery cannot prove an approval, decline, or cancellation, authorized staff can explicitly release the unresolved hosted attempt from the active sale without erasing its provider evidence. A later exact approval supersedes older unresolved sale locks while Payments Health retains every attempt for reconciliation and late signed callbacks.
- **Accurate Notification Badge, QuickBooks Handoff, and Station Identity**: Completed notifications no longer remain in the unread bell count after leaving the active inbox. QuickBooks authorization now uses the desktop-safe external-browser bridge with a same-tab web fallback when popups are blocked. Workstations without an installer label receive a stable key-suffixed Riverside Workstation name instead of every device reporting the same generic label.
- **Exchange Refund Completion and Same-Day Card Safety**: Register cannot reach Sale Complete while an exchange still owes the customer money. Cash, the linked Original Card, Gift Card, or Store Credit must resolve the exact refund first; pending receipts and Transaction Records remain visibly **Refund pending** instead of printing a false settlement. Original-card exchange remainders now receive a read-only Helcim batch and capacity preflight before the replacement Transaction is recorded, followed by authoritative revalidation during settlement. Open-batch reversal eligibility uses the full provider charge rather than a member allocation, preventing an oversized reversal of wedding or deposit-funded payments.
- **Counterpoint Historical Sales Classification and Period Accuracy**: Active and archived Counterpoint order/layaway audit events now provide source-dated booking deltas for new, edited, cancelled, and reinstated documents. Ticket History imports only `S`/`A`/`R` rows as financial and inventory movement, keeps `U` lifecycle rows out, excludes order-linked `S`/`A` fulfillment from being booked twice, and preserves signed returns. Rerunning a legacy `U`-only ticket preserves its Transaction and fulfillment evidence while classifying its old initial-booking event out of sales reporting. Booked period summaries aggregate activity by business day, so MTD, prior-year comparisons, forecasting, and item velocity use the same event meanings as current ROS sales.
- **Controlled Counterpoint Repair Reruns**: One-shot bridge repairs can restrict writes to an explicit, validated entity list while retaining the normal complete source preflight and audited `fix_rerun`. An immediately retried interrupted run may reuse the exact passed preflight UUID, which ROS revalidates before opening a new audited import run. Main Hub request failures now retain their underlying network error code and message for faster diagnosis.
- **Safe Counterpoint Payment-Only Matching**: Counterpoint payment duplicate recovery now returns no match when there are zero or multiple candidate Transactions instead of eagerly indexing an empty candidate list. Only one exact candidate may be superseded, with explicit 0/1/2-candidate regression coverage.
- **Counterpoint Source-Maintenance Reruns**: Historical source replacement recognizes ROS's own Counterpoint paid-price repair and reconciliation audit events as source maintenance instead of staff activity. Returns, refunds, exchanges, non-source allocations, fulfillment/procurement links, and line-linked audit dependencies remain protected and fail closed.
- **Conflict-Safe, Auditable Appointment System**: ROS appointments now save explicit durations, rooms/resources, staff and capacity conflict checks, revision guards, authenticated audit history, and reasoned soft cancellation instead of hard deletion. The Scheduler exposes the Conflicts/resource workspace, preserves one-off visits without inventing Customer links, opens exact appointments from Search, Operations, and Customer history, and prevents view-only staff from seeing mutation controls. Customer confirmation, cancellation, and reminder delivery uses store-local display time, current-slot/channel idempotency, saved-duration calendar attachments, and bounded retry backoff, while attended Measurement/Fitting milestone updates remain atomic and Pickup stays controlled by Orders/Register.
- **Saved Z-Report History and Compact Loading**: Historical Z-Report totals now prefer the immutable total saved at Register close and reconstruct only legacy snapshots that predate it. History and ROSIE report lists request compact rows without large saved-detail arrays, while opening a report still loads its complete booked-day evidence.
- **Podium Webhook and Inbox History Recovery**: Signed Podium deliveries now accept both documented camelCase and snake_case metadata keys without weakening signature verification. Conversation pulls use the provider-supported cursor contract, mark history current only after every message in a matched conversation is stored, keep failed histories visibly incomplete across refreshes, and distinguish local ROS webhook readiness from the provider subscription state shown in Settings.
- **Receipt Template Recovery and Live Delivery Readiness**: Receipt Settings now validates Standard and Picked Up templates against their actual production contracts, so the intentional single Order payment block no longer leaves Picked Up receipts permanently blocked by a legacy payment-history token. Each template tab shows its own issue count and can restore the Riverside default in one action. Digital receipt delivery reuses the established status indicator to show live Store Email and Podium readiness, including unsaved changes, missing setup, and provider-health failures. Test Text now honors the saved receipt-specific switch and saved MMS caption instead of accepting an unsaved client body.
- **Restart-Safe Podium Contact Reconciliation**: Main Hub startup closes contact-reconciliation audit rows interrupted by a prior server process, allowing the next authenticated run to proceed without leaving Settings stuck. A genuinely active reconciliation remains single-run and appears to staff as informational rather than as a provider error.
- **Truthful and Capacity-Safe Insights Readiness**: Native Insights no longer duplicates the complete semantic catalog in every ROSIE planner prompt, while the Main Hub ROSIE host keeps two concurrent slots with a 16,384-token total context so each planner request receives an effective 8,192-token budget. **Reporting ready** now requires both Cube Core and the ROSIE report planner; degraded planner capacity can no longer appear as a healthy reporting workspace.
- **Insights and ROSIE Status Clarity**: The Back Office Insights navigation now uses the same sparkle icon as the Insights workspace, while Ask ROSIE and ROSIE Chat show a live Ready, Checking, Unavailable, or Off badge from the configured ROSIE runtime so staff know whether assistance is available before submitting a question.
- **Open Gift Card Metrics and Counterpoint Customer Ownership**: Gift Card dashboard counts now use one consistent open-card definition—active status, positive balance, and an unexpired date—so historical Loyalty, Donated, Promo, depleted, void, and expired records remain searchable without inflating the headline cards. Counterpoint gift-card ingestion and the guarded metadata repair now resolve `SY_GFC.ORIG_CUST_NO` to the unique Riverside `customer_code`, fail closed on missing or ambiguous identities, preserve existing links when no source customer is supplied, and report the number of resolved customer links.
- **Main Hub Installer Environment and File-Replacement Safety**: Windows installs now serialize every installed server environment value with dotenv-safe quoting and escaping, while ROSIE, audit, and credential-repair scripts decode the same contract without changing the settings-owned value. Server updates also wait for both process exit and an exclusive executable handle before copying the new binary, failing before replacement if Windows does not release the prior build.
- **ROS-Issued Loyalty and Donated Gift Cards**: Loyalty and Donated issuance now records the acting staff member, preserves the server-authoritative one-year expiration in letters and History, requires an approval reason for manual or donated value, and prevents the manual loyalty-load API from bypassing staff management authorization. QBO Settings now owns a separate Donated Gift Card Expense mapping so donated redemption cannot be mislabeled as loyalty/promo spend or purchased-card liability.
- **Complete Gift Card Inventory Pagination**: Gift Cards now requests a bounded PostgreSQL page with the complete filtered total, shows the exact visible range, resets paging when filters change, and provides Previous/Next navigation on mobile and desktop instead of silently stopping at the server's first 100 cards while the summary counted the full inventory.
- **Bug Manager and Main Hub Error-Fix Hardening**: Client diagnostics now redact customer contact fields, URL query values, fragments, credentials, and tokens before Bug Manager submission. Hidden browser tabs no longer create false Main Hub outage events, rejected private-network heartbeats stop retrying, and expected staff corrections, card declines, connection notices, and an empty customer-email collection field use warning or informational handling instead of being misclassified as application errors.
- **Complete Inventory Reconciliation Queue**: Inventory Reconciliation now reports complete store-wide issue totals, supports validated issue filters and bounded pagination, and exports the entire filtered queue instead of silently limiting each issue type to 100 rows. Negative stock remains an authoritative physical-inventory or Counterpoint reconciliation task; Riverside does not invent stock adjustments.
- **Installed Settings Activation and Provider Resilience**: The Main Hub now loads its installed executable-adjacent environment file with precedence over stale inherited scheduled-task values. Meilisearch credential saves and clears explicitly report that a Main Hub restart is required, while Geoapify address requests use a bounded timeout and log only safe error classifications.
- **Receipt, Discount, and Counterpoint Reconciliation Corrections**: Wedding Deposit-only Transactions can build truthful receipts without fabricated merchandise lines, percentage discounts reject non-finite or over-100 values, alteration-service pricing no longer appears as discount-audit evidence, and historical Counterpoint gift-card applications match normalized card codes without case-sensitive false misses.
- **Maintainable Customer Communication Settings**: Podium now owns only OAuth, provider location/webhooks, Podium SMS, and contact diagnostics. Operational email wording moved to Email, review policy and wording to Customer Reviews, receipt delivery captions/subjects to Receipt Settings, and web chat to Online Store. Each section sends a narrow patch, blank wording inherits server defaults, the duplicated Podium manual was removed, the broad Podium clippy suppression is gone, and MMS attachments enforce Podium's 30 MB limit.
- **Void Refund Queue and RMS Customer Navigation**: A completed-sale void paid with more than one tender now keeps the full original paid amount open until every refund source is recorded; retrying an already successful source remains idempotent without closing the remaining cash, check, card, gift-card, or credit obligation. The Back Office RMS Charge customer directory now opens the selected Customer Relationship Hub reliably from its early-return workspace, with semantic workspace tabs for keyboard and assistive input.
- **Daily Financial Report Booked-Sales Parity**: The emailed headline now uses the same canonical booked net-sales calculation as ROS Today's Sales and the booked Register report instead of substituting fulfillment-recognized revenue. Three additional cards and a detailed section show current month-to-date booked net plus the same calendar-day window last year with signed dollar and percentage changes. Actual Visual Crossing business-day weather is included when available, simulated weather is never presented as actual financial-report data, and older report-history rows retain an explicit legacy recognized label.
- **Durable Wedding Builder Completion Guard**: Collect & Build now saves every reviewed member draft and stable checkout identity on Main Hub in the same transaction as the funded payer workflow, while later Deposit Only builds save each draft before advancing. Held-credit redemption rejects any mismatched member checkout identity, resume reloads the server-owned drafts, and Wedding Builder does not report completion until a fresh Main Hub read confirms every required member Transaction and receipt.
- **Wedding Deposit Daily Activity and Receipt Truthfulness**: The payer's held wedding-deposit Transaction is now labeled as deposit activity instead of merchandise, displays its tender exactly once, omits invented line-item, tax, and balance details, and routes staff to the required member-Transaction review until every funded suit has posted.
- **Main Hub Cube Insights Update Recovery**: The Windows updater again provisions the required `cube_ro` role and routes migration 185 through its transaction-scoped Cube compatibility path before starting the new server. Windows release packages now include the pinned non-Docker Cube runtime, portable Node host, and semantic model; the installer generates and preserves its credentials, supervises it as `Riverside OS Cube Core`, requires loopback readiness, and restores the prior Cube runtime and role password if an update fails.
- **Cube-Backed Governed Insights Preserved**: Native Insights continues to use Cube Core as its governed semantic engine. Cube reads the same Riverside PostgreSQL database through the restricted `cube_ro` role and approved `reporting.*` views; it does not own a separate reporting database or expose a separate staff login. ROSIE and the browser remain unable to submit arbitrary SQL.
- **Independent Podium SMS Controls**: Settings → Integrations → Podium now enables staff-authored texts, text receipts, Ready for Pickup, alteration-ready, appointment confirmation, appointment reminder, and unknown-sender welcome messages independently while retaining every editable message template. Server-side guards enforce each switch at its actual send path, and legacy stores migrate the former aggregate SMS choice to all individual workflows so an existing enabled configuration does not silently stop sending after update.
- **Collision-Safe Podium Contact and Message Reconciliation**: Riverside now keeps durable contact retry/state and append-only audit evidence, reads the complete Podium contact list with `read_contacts`, applies contact lifecycle webhooks, blocks ambiguous phone/email matches, supports audited manual conversation resolution, records exact outbound provider identities, and handles exact SMS opt-out commands without assigning shared identifiers to the newest customer. Full contact reconciliation is Settings Admin-only, single-run, and fail-closed when provider completeness cannot be proven; ROS remains the appointment source of truth while Podium delivers enabled confirmations and reminders.
- **Quiet English ROSIE Speech Recovery**: Main Hub updates no longer dump a full Kokoro-to-SenseVoice loopback test into the visible updater. The foreground update verifies the pinned assets, Gemma service, exact Riverside build, and server readiness, then starts speech certification under the background ROSIE watchdog. SenseVoice is now explicitly pinned to English with inverse text normalization in server, desktop, watchdog, and manual verification paths, and the health fixture uses ordinary English instead of depending on how Kokoro pronounces Riverside or ROSIE.
- **Imported Gift Card Classification and Expiration**: Counterpoint gift cards now retain their Sold / Purchased, Loyalty, Donated, or Promo classification from `SY_GFC`, and unmapped programs stop instead of silently becoming purchased liability. Loyalty, donated, and promo cards expire one calendar year after issue. A staff-authorized direct Main Hub preview/apply repair needs no bridge process or machine token, verifies the complete source count and balance, and preserves every card balance and event before changing imported metadata; Back Office also labels expired cards explicitly.
- **Consistent Natural Variation Ordering**: Register variation panels, POS Inventory pickers, Product Hub tables and tag reviews, variation workspaces, product setup, global search previews, promotion SKU lists, and storefront option lists now share one natural ordering rule. Apparel aliases and range labels follow merchandise order (`SMALL`, `MED`, `LG`, `XL`, `2XL`), numeric values sort numerically, ordinary text sorts alphabetically, and equivalent slash/hyphen suffix forms such as `M20001/2` and `M20001-2` stay together before suffix `10` without merging distinct SKU records.
- **Podium API, Delayed Reviews, Delivery, Webhook Recovery, and Message Catalog**: Customer contact sync now uses Podium's documented `phoneNumber` and `locations` fields, conversation assignment uses `PUT` with `assigneeUids`, user/message/review history follows provider cursors, and authenticated calls refresh once on 401 and honor 429 backoff without blindly retrying ambiguous message mutations. Eligible fulfilled Transactions now schedule an unbiased review request for 10:00 AM five days later instead of asking at checkout; Riverside creates the official Podium review link, sends it by tracked Podium SMS or Podium email, enforces the review-only customer opt-out independently from SMS/email and Podium campaign consent, applies the 180-day cadence on every entry point, and exposes scheduled and failed attempts in Reviews. Settings exposes editable operational SMS and Store Email templates, Podium review SMS/email templates, and receipt MMS captions/email subjects on their owning feature pages with supported placeholders. Scheduled notices report only channels that actually succeeded, and verified webhook JSON enters a leased retry queue before Riverside acknowledges it.
- **Helcim Terminal Try Again Recovery**: When the reader declines one card but keeps the same invoice open for **Try Again**, Register now remains pending, clearly tells staff to try the card again on the reader, and watches for the later unique approval. A decline and approval under the same invoice no longer make recovery ambiguous, and ROS does not require Manual Card for the approved payment.
- **Retryable Daily Financial Report Delivery**: Enabling the report now always generates and archives the business date even when auto-send is off or no recipients are configured. Failed or partial Z-close email delivery no longer marks the business date as sent, successful recipients remain recorded without being duplicated on retry, resend attempts record only actual successes, and regenerating an unsent date refreshes its single archive row instead of colliding with the one-report-per-date constraint. Saved recipient lists are normalized and validated before delivery, and automatic failures create an actionable staff alert.
- **Readable Receipt Delivery and Guided Podium Activation**: Emailed receipt images now stay within the message viewport instead of clipping their right edge. Printed receipt items use whitespace and bold product names—without divider rules—to make each new item clear. Podium setup now always presents `https://ros.riversidemens.com/callback` from non-loopback sessions and requires staff to open that secure Riverside origin before OAuth approval, preserving the browser-bound setup session.
- **Prominent Cash Change and Complete Payment Ledger**: Cash overpayments now place a large, high-contrast **Change due** callout beneath Receipt Contact on Sale Complete so the cashier sees the amount before starting the next sale. The Payment ledger separately shows the full cash **Payment**, the **Paid to Sale Amount**, and **Change Due** from the saved tender metadata; customer receipts continue to print **Cash Tendered** and **Change**.
- **Receipt Tax Detail, Order Payments, and Builder Delivery Tests**: Printed, previewed, emailed, and texted receipts now show one compact saved tax line per merchandise line: **4.75%: $0.00 4.00%: $0.00 Total Tax: $0.00**. Zero components remain visible so clothing, fully taxable, and non-taxable merchandise are immediately distinguishable without recalculating from display prices. Pickup and payment-on-order receipts consolidate the target Order, previously paid amount, today's tender, remaining balance, and paid-in-full status into one normal-sized **Order payment** section instead of repeating oversized payment-status and payment-history headings. Receipt Builder now permits the intentional Transaction/customer/date repetition in the barcode stub without disabling Print Test, Test Email, or Test Text while continuing to reject unexpected duplicate fields. Test Email rasterizes and embeds the receipt as an inline PNG so Outlook does not strip the SVG preview into a blank message.
- **RMS Charge Weekly Account Matching**: Weekly account-list imports now reuse an exact RMS account number already linked to one Riverside customer, then match a unique legacy Riverside customer code equal to the RMS account number before falling back to unique-phone matching. Ambiguous identifiers remain unmatched for staff review.
- **Actionable Notifications and Operational Review Routing**: Successful Fulfillment Order completion and routine negative-inventory reconciliation findings no longer flood the staff attention inbox. Fulfillment history remains on the Transaction Record, negative available stock remains in Inventory Reports → Inventory Reconciliation with transaction and inventory audit evidence, and existing noisy notification rows move to Earlier history without being deleted. Critical payment, backup, register, integration, recovery, and security failures continue to notify authorized staff.
- **Compact Sale Complete Layout**: Sale Complete now sizes to its actual receipt and transaction content on desktop and tablet instead of reserving a fixed-height blank region above **Begin new sale**.
- **Safe Main Hub Update Credentials and Working ROSIE Certification**: Routine Main Hub installs and updates now preserve existing staff credentials and permissions instead of invoking the lockout-only bootstrap-admin reset, and installer output no longer prints the recovery Access PIN into its transcript. Existing deployments using the legacy Meilisearch development key rotate to a private managed key during the normal coordinated service update with rollback-safe credential restoration. ROSIE speech certification waits for redirected native-process output to settle, accepts a structurally valid generated WAV as the TTS functional result, and proceeds through actual SenseVoice recognition even when a Windows native process returns unreliable status after producing valid output. Exit codes, WAV size, recognized text, warnings, failures, and skipped probes remain explicit. The elevated updater persists exact version/build and final post-restart `/api/ready` status in `deployment.status`.
- **Main Hub Insights Migration Recovery**: Migration 185 can create and secure the governed `cube_ro` reporting role even when normal migrations run under the restricted Riverside application role. The installer grants only the temporary role-management authority needed for that migration inside its database transaction, restores the application's prior privileges before commit, and rolls back both schema and privilege changes on failure instead of leaving a partially upgraded Main Hub.
- **ROSIE English Voices and Packaged Knowledge**: The pinned Kokoro multilingual model now uses its actual US-English Maple and Sol speaker IDs or British-English Vale ID instead of carrying obsolete voice numbers into Chinese speakers. Old workstation selections safely move to Maple, and server, desktop, and certification paths reject unsupported speaker IDs. Approved Help, staff, and ROSIE policy markdown is embedded for installed releases, so the intelligence panel no longer reports development source paths as missing; build-only refresh controls are disabled on packaged installations and optional Meilisearch is labeled without implying that local ROSIE knowledge is unavailable.
- **Direct POS Navigation and Audience-Specific Dashboards**: POS now exposes every permitted destination directly in one scrollable rail instead of nested Work and More groups. The complete Register Dashboard and Back Office Operations Dashboard remain distinct for their staff audiences, while shared notification ownership avoids duplicate polling. **Customer Orders** is first in the Register toolbar, **Custom Order** is in transient **More Actions**, Payment uses a compact red/green deposit-status strip with inline Manager Access, and open Order detail exposes **Cancel Order Items** beside its Items heading. POS Customers and Orders retain focused 25-record/action-first views while Back Office keeps its full management surfaces.
- **Indexed Customer Browse Ordering**: The default Customer browse path now selects each page through the existing customer-name index instead of sorting computed display aliases across the full customer table, substantially reducing initial POS and Back Office Customer-list latency.
- **Complete Customer Receipt History and Multi-Order Pickup Receipts**: Customer History now retains and directly reprints each completed sale, deposit/payment, pickup, pickup-with-payment, return, and exchange receipt event. A single pickup can include items from multiple Fulfillment Orders, and every printed, emailed, or text receipt identifies each item's source public `ORD-XXXX` number.
- **Partial Order-Item Cancellation and Refund Truth**: Register **Customer Orders** now exposes **Cancel Item** directly beside **Update Item** for unfulfilled Special, Custom, Wedding, and Layaway lines. The live Transaction ledger previews how much cancellation credit reduces the unpaid balance, the revised Order total, any remaining balance, and only the actual overpayment eligible for refund. Cancelled lines remain distinct from customer returns; received and Ready-for-Pickup goods stay on hand while their customer reservation is released; true refunds continue through multi-source Pay and verified Helcim settlement; and Return / Exchange rejects unfulfilled Order merchandise.
- **Helcim Refund Approval Before Record**: Refund-only Original Card tenders now submit through the canonical Helcim refund processor when staff select **Apply Refund**. The tender is not added and **Record Sale** stays unavailable until ROS verifies approved/captured provider status, the provider refund ID, and the committed refund-ledger event; final recording reuses the same idempotent tender identity. Exchange remainders continue settling after their replacement Transaction and inventory linkage are safely recorded.
- **Multi-Source Return and Exchange Settlement**: Refunds now retain every payment method entered in Payment instead of discarding all but the first source. Stable per-tender identities make retries idempotent, exchange remainders may combine original-card and local refund methods, and staged payments to existing Transaction Records remain in the cart and receive exchange credit through normal audited allocations.
- **Order Deposit Safety Guard**: Record Sale now stays neutral and unavailable for Order, Custom, Wedding, and Layaway Transactions until at least 25% is paid toward the current Transaction. An audited, checkout-bound **Override Deposit** Manager Access action permits a smaller or zero down payment without creating fake tender, while every partial payment is consistently marked and displayed as a **Deposit** and balance-closing payments remain **Payment in Full**.
- **Live ROS-Backed Wedding Party Hub**: The open party tracker now refreshes canonical Customer contact data, purchased Transaction-line merchandise, applied payments, held deposits, balances, Fulfillment Order lifecycle, alterations, and party-scoped appointments every minute, on focus, and on Wedding/appointment events. A held deposit remains **Deposit** until applied; **Paid** requires a linked Transaction with no balance due. Ordered, In Stock, and Picked Up remain read-only ROS-derived stages.
- **Wedding Party Setup and Tracking Archive**: New Party and Style & Order Details now select sellable ROS parent products for suit, shirt, tie, shoes, and accessories and scope each choice to **All**, **Groom Only**, **Groomsmen Only**, **Any**, or **Other** before Register opens the shared variation panel. Manager **Archive Tracking** records an audited tracker outcome while preserving every linked ROS Transaction, balance, deposit, appointment, alteration, shipment, and fulfillment record unchanged.
- **Fluid Search Across Desktop and PWA**: Remote staff searches now wait for a short typing pause, cancel superseded requests, and retain already-loaded results while replacements arrive. Register product search now starts suggestions after 250 ms while Enter and barcode scans remain immediate. Wedding Party Hub and other high-traffic customer, inventory, order, staff, online-store, appointment, and deposit searches no longer refresh or replace their workspace on every keystroke, including on slower PWA connections.
- **Fixed Register Checkout Dock**: The quantity/price keypad and contextual Pay, Complete Pickup, or Wedding Order action now remain full size in a fixed bottom dock. Customer, wedding, and sale-summary content scrolls independently above the controls, and the primary action is approximately 20% taller for totals and longer workflow labels.
- **Helcim Pending Approval Guard**: Register no longer shows or enables **Ready to Save** while the current checkout is still waiting for a Helcim card result. The normal card/PIN interaction window before outcome-recovery guidance is extended from 15 seconds to two minutes; approval, decline, cancellation, or expiry must be confirmed before the sale can be recorded.
- **Orders Pickup Cart Review**: Loading some or all open items from Customer Orders now returns staff to the Register Cart for review instead of immediately opening Payment. Historical balances are no longer staged automatically; staff can add new items, explicitly add a full or partial payment when intended, or complete an already-paid pickup without a new tender. An unpaid pickup requires an explicit choice to add payment or continue without it, and a fully picked-up Transaction Record remains **Open** and payable while money is due.
- **Register Multi-Wedding Selection**: When a customer belongs to more than one active wedding, Register now presents compact touch-sized party rows with party, role, date, status, **Start Order**, and **Measure** instead of silently using the first membership. The Wedding Checklist and Open action stay bound to that selection, and switching parties is blocked once Cart work exists.
- **Wedding Deposit History and Additional Builds**: Selecting a payer with prior Wedding Deposit activity now presents a clear Review & Reprint path from the Register toolbar. Staff can reopen payer and member receipts, resume unposted funded orders, and start a fresh Wedding Order for additional items after a member Transaction is posted without changing the earlier deposit or receipt records.
- **Register Wedding Layout and Staff-Facing Labels**: The Register quantity/price keypad now keeps its full touch-target height when wedding guidance is loaded, and the linked wedding member is identified once in the primary wedding banner instead of repeated in a secondary status chip. Daily Sales and CSV output now present `wedding_order` as **Wedding Order**. Wedding Order receipts print the party name and wedding date with the Wedding Order section.
- **Register Report Tender Consistency**: Daily Sales and Z-Reports now use the same authoritative payment-ledger tender totals and shared day metrics for card, RMS, cash, deposits, tax, shipping, alterations, and gift-card loads.
- **ROSIE Certification and Update Resilience**: The Windows certification probe now passes its Kokoro health-check sentence as one quoted positional argument and identifies US English for the pinned multilingual model. Certification uses deterministic, bounded HTTP, LLM, TTS, and STT checks with exact subsystem diagnostics. A degraded ROSIE certification is reported and retried without failing or rolling back an otherwise healthy Riverside update; staff receive concise recovery guidance and text chat remains available.

## [0.96.0] - 2026-08-02

### Fixed
- **Complete, Verified Main Hub Updates**: Normal Main Hub update paths now
  install and certify the release-pinned ROSIE stack instead of silently
  preserving an older model/runtime across a Riverside release. The in-app
  updater also verifies the GitHub SHA-256 digest before extracting a package,
  and server update checks no longer mistake an older release with a different
  build SHA for a same-version rebuild. Superseded ROSIE model files remain
  available for rollback until the complete Main Hub update passes readiness.
  Matching ROSIE runtime and speech pins are verified in place without copying
  bundled assets or downloading them again; speech markers now include the
  immutable repository revision so only a real pin change triggers replacement.
- **Updater Release Parity**: The Windows package now bundles the same pinned
  llama.cpp runtime required by the ROSIE installer, and the release gate fails
  if either its version or SHA-256 drifts. Development startup also selects a
  compatible Homebrew PostgreSQL dump/restore pair when available.

### Changed
- **Wedding Lifecycle Authority and Tracking Archive**: Wedding Hub now derives ordered,
  received, ready-for-pickup, and picked-up status from authoritative
  Transaction/Fulfillment Order lines. Authenticated party/member/appointment
  audit writes are atomic, scheduling overrides retain staff identity and
  reasons, and recent member activity opens the exact Transaction in Orders.
  Managers can archive tracking for passed, cancelled, incomplete, or legacy weddings without
  fabricating workflow completion; linked balances, deposits, fulfillment,
  appointments, alterations, shipping, and customer history remain unchanged
  and the tracker can be reopened from Closed / Archived with retained audit
  history.
- **ROSIE Local Intelligence Upgrade**: Pinned Google's official Gemma 4 E4B
  QAT Q4_0 model and matching vision projector, enabled provider-governed SSE
  answer streaming with usage telemetry, exposed the existing permission-gated
  read-only tool registry through native Gemma function calling, and added
  request-scoped JPEG/PNG/WebP attachments to Ask ROSIE and ROSIE Chat. Public
  cloud providers remain disabled. Normal Host installation now activates the
  text model and projector as one unit, certifies text, streaming, native-tool,
  and image behavior before readiness, restores the previous configuration on
  failure, and removes superseded managed model files after success.
- **Input-Method Accessibility**: Staff workflows now provide consistent
  semantic controls, visible focus, and keyboard activation across POS,
  customers, payments, inventory, staff, scheduling, notifications, search,
  and wedding management while preserving mouse and touch behavior.
- **One-Action Wedding Builder**: Collect & Build now prepares party parent
  products, exact member variations, optional alterations, individual No Tax
  reasons, and apply-all or per-member salesperson attribution as reloadable
  drafts. Only approved payer funding unlocks one final action that creates the
  separate member Transactions and Wedding Fulfillment Orders through the
  normal atomic checkout path. Completion shows detailed individual receipt
  actions, while stable checkout identities make partial retry post each member
  at most once. Deposit entry also supports one per-member quick amount applied
  only to explicitly selected party members, and payer-scoped Orders & Receipts
  reloads Deposit Only activity for later batch building. Selecting an
  individual wedding member in Register now offers the same parent-item and
  exact-variation Builder, identifies available held funds and their payer,
  and keeps all writes behind normal audited checkout.
- **Receipt Builder Preview Coverage**: Receipt Builder now previews the full
  customer-facing receipt structure and configurable sections instead of a
  shortened representative sample, so staff can verify placement and wording
  before saving a layout.
- **Customer Profile Discount Reasons**: Setting an ongoing automatic customer
  discount now requires a persistent reason on the customer profile. Removing
  the discount clears the reason, and existing discounted profiles are marked
  as legacy records whose original reason was not previously captured.
- **Faster Fail-Closed Windows Releases**: Same-tag Windows release reruns now cancel the superseded workflow instead of waiting behind assets that cannot be published. Signed component compilation overlaps the pre-retag gate, while package publication still requires both that gate and exact-commit Playwright success. Independent Rust caches now retain Riverside workspace-crate outputs so restored caches can accelerate repeat builds instead of preserving dependencies only. The release-contract validator normalizes Windows CRLF checkouts before evaluating workflow structure.

### Fixed
- **Variation Picker Navigation**: Cart additions, existing-line changes,
  Wedding Builder selections, and Customer Orders item updates now keep the
  item being built and all completed choices visible. A labeled Back action is
  available at every step and on pricing review, while completed choices can
  be selected directly for correction before confirmation.
- **Parked Wedding Collect & Build Sales**: Parking a Wedding Deposit sale now
  preserves every member's nonfinancial order draft, including exact variants,
  fulfillment choices, salesperson attribution, the current member, and the
  current workflow step. Recall restores the full workflow instead of only the
  payer Cart and deposit allocations.
- **Counterpoint Subset Duplicate Orders**: Superseded five exact Counterpoint
  open-document shells that copied ordered-item subsets from sales already
  booked in ROS. The source-locked repair retains the original ROS
  Transactions, provider-backed payments, inventory, lines, and fulfillment
  links; removes only the five copied non-provider allocations; and records
  immutable reconciliation snapshots and operator audit evidence.
- **Card Not Present and Manual Card Identity**: Card Not Present now persists
  as a Helcim-approved `card_not_present` tender, while Manual Card remains an
  externally approved `card_manual` tender with no live Helcim transaction.
  Sale Complete, receipts, Transaction History, Payments Health, and refund or
  exchange routing preserve that distinction without rewriting financial
  amounts.
- **Helcim Dispatch, Build Parity, and Checkout Continuity**: Card Reader sends one purchase directly to the assigned terminal without a separate pre-purchase diagnostic ping. Current Register clients identify their exact source build before Card Reader, Card Not Present, or Saved Card dispatch; a known Main Hub mismatch stops before Helcim receives a request. Repeating Card Reader for the same checkout returns its existing attempt instead of dispatching twice. Earlier pending or unresolved attempts remain Payments Health evidence without reserving the next checkout, while confirmed approvals stay bound to their original sale and cannot be duplicated or moved.
- **Z-Report Check and Deposit Reconciliation**: Register close now reviews
  each check from its authoritative payment tender instead of a partial
  Transaction allocation. Z-Reports include checks in every per-register
  breakdown and show Cash Deposit, Checks for Deposit, and their combined
  Total Deposit. Operational recovery warnings remain available in their
  audited workflows but no longer fill the financial Z-Report.
- **Nathan Webster Manual Card Refund Reconciliation**: Reconstructed the
  removed shirt on `TXN-566201` as a non-restocking itemized return and recorded
  the externally completed `$67.04` manual card credit through guarded
  migration 173. The picked-up suit remains unchanged and the Transaction
  Record now reconciles to a `$0.00` balance. Fully returned merchandise is
  presented under **Returned Items** instead of remaining open for pickup.
- **Glenn Jones WALK-IN Sale Attribution**: Reassigned the reviewed completed
  `TXN-624853` WALK-IN sale and its sole successful card payment to Glenn Jones
  (`GLENN-D8P9`) without changing merchandise, tax, inventory, fulfillment,
  tender, or balance. The exact repair is checksum-tracked and retained in both
  Transaction activity and the customer timeline. Fresh databases now record
  this immutable source-locked repair as not applicable when its exact source
  Transaction is absent, while any present-but-changed source evidence still
  fails closed.
- **Paid Order Item Removal Credits**: Removing a paid, unfulfilled order item
  now preserves the item as refund evidence instead of deleting it. Replacement
  items added to the same Transaction Record consume that credit first, leaving
  only the net refund or additional balance, while unrelated pickup items remain
  intact.
- **Wedding Deposit Cart and Receipt Truth**: Added a dedicated **Wedding
  Deposit** Cart toolbar action with a guided party, member, destination, and
  review workflow. Staff can start a party from Party Name and Wedding Date,
  add or link customers with roles, hold each member's amount for a future
  order or apply it to one exact open Transaction Record, and resume the funded
  batch later from the payer's account. A server preflight resolves changed
  balances and member links before tender; a decline posts nothing and leaves
  the reviewed allocations staged for retry. Source-tracked member-order
  handoff, payer and member receipt reprints, and atomic ledger/audit links keep
  each deposit tied to its payer, party, beneficiary, destination, salesperson,
  and eventual order. Sale Complete and printed, HTML, and text receipts name
  every beneficiary and destination, while the member receipt names who paid.
  Refunds run one member at a time, resolve the exact originating Helcim payment
  without staff-entered provider IDs, return money to the original payer rather
  than the member, preserve refundable capacity for the other members funded by
  the same charge, and record the result in both Customer histories.
- **Multi-Order Register Cart**: Customer Orders now keeps the workspace open
  while staff stage payments and pickups across several open orders. Starting a
  pickup preserves intentional partial payments already in the cart, and local
  cart recovery retains every source Transaction Record, selected pickup line,
  prior paid amount, and linked ready alteration so restored pickup work cannot
  be mistaken for a new merchandise sale. Completed pickup steps are
  idempotent, and recovery queues only the source orders that remain incomplete.
- **Sale-Complete-Only Order Pickup**: Customer Orders and Order Detail can no
  longer release pickup directly. They may only stage or hand off the order to
  the Register cart, and the pickup API rejects requests that did not originate
  from cart completion. Inventory, revenue, commission, pickup audit, line
  status, and order completion move only through the flow that opens **Sale
  Complete**.
- **Existing-Order Amendment Reporting and Audit Detail**: Merchandise added
  to an older open Transaction is booked on the store-local amendment date
  without moving the parent Transaction's original business date. Daily Sales
  and Z-Reports apply the signed net same-day value change, so increases raise
  Booked Subtotal and decreases reduce it without inflating the sale count.
  Removal of the final item remains visible in Daily Activity. Order and
  customer timelines identify the affected item, SKU, before/after price, and
  signed value change, and
  Register price edits verify the persisted server value before reporting
  success. Initial booking lines no longer repeat their Sale price as a purple
  Added amount; Added, Change, and Removed markers appear only for actual later
  amendments.
- **Sales and Tax Reporting Separation**: Daily Sales and Z-Reports now keep
  Subtotal, Tax, and Total With Tax as separate figures at the summary,
  day-group, transaction-card, print, and export levels. Sales, Booked Sales,
  Net Sales, refunds, and pickup sales remain pre-tax; tax is included only in
  the explicitly labeled Total With Tax or payment/transaction totals.
- **Recovered Helcim Payment Business Dates**: Attaching an already-approved
  historical Helcim payment now preserves the processor approval date on the
  payment movement, preventing a later ROS recovery from adding the old tender
  to the current Daily Sales or Z-Report.
- **Historical Counterpoint Repair Events Excluded From Daily Sales**:
  Counterpoint incident reconciliation now suppresses booking-event triggers
  while restoring historical line truth, so repair timestamps cannot make old
  orders appear as newly booked sales. The seven repair-generated events from
  the July 28 reconciliation were retained as audit evidence but excluded from
  reporting; no transaction, payment, tax, inventory, or customer balance was
  changed by the reporting correction.
- **Donald Dussing Order Amendment Reporting Repair**: Restored the reviewed
  July 28 `TXN-566034` / `B-1417953` staff amendment to Booked Daily Sales and
  Z-Reports, while Customer Interaction Timeline now hides internal and
  reporting-excluded Counterpoint repair bookkeeping.
- **July 21 Counterpoint Incident Final Reconciliation**: Re-read all 567
  retained records against live ROS and Counterpoint source evidence, then
  reconciled the seven proven operational exceptions through one exact,
  serializable, audited manifest. The operation preserved every Helcim payment
  and all inventory, removed only four proven Counterpoint import artifacts,
  restored exact completed lines and recognition, and left all seven records
  fulfilled with matching line/header/allocation totals and `$0.00` balance.
  Refund review and apply now require explicit refund evidence; a bare negative
  imported allocation is treated as an unresolved transfer offset, never as a
  customer refund.
- **In-Register Helcim Restore and Atomic Refund Completion**: The Register
  payment screen now provides a Restore workspace for the current sale that
  can refresh terminal health, re-verify and attach the exact approved Helcim
  sale or refund, reopen secure card entry, release evidence-free blockers,
  select an available terminal, or safely retry Record Sale without charging
  the customer twice. Non-default terminal use requires scoped, server-verified
  Manager Access. Paid cancellations, returns, and refunds do not change the
  original Transaction Record, inventory, customer balance, or receipt history
  until provider approval and Record Sale complete atomically; cross-sale
  provider evidence remains isolated.
- **Register Idle Lock Screen Identity**: An idle Register now opens the
  dedicated Register Locked Access PIN screen and rejoins the existing drawer
  after authentication instead of presenting the Drawer Open screen.
- **Cancelled and Fully Refunded Order Balance Integrity**: Cancelling a paid
  order now returns its exact negative merchandise to the Register for the
  linked Helcim refund, preserves the approved refund event for receipt
  reprinting, and never reopens a customer balance after settlement. Existing
  cancelled or fulfilled Transaction Records with a closed, fully completed
  refund obligation are repaired to `$0.00` balance due; partial returns and
  exchanges retain only their legitimate unsettled remainder.
- **Card Not Present Confirmation Recovery**: After hosted Helcim approval, the
  secure handoff retries temporary ROS ledger connection failures without
  asking staff to run the card again. Payments Health now reviews both terminal
  attempts and hosted Card Not Present events and can attach an exact approved
  provider event to an existing open Transaction Record through the audited
  order-payment recovery flow.
- **Takeaway Receipt and Add-Customer Overlay Regression**: Fully paid takeaway sales no longer inherit the pickup/payment-history receipt layout merely because their Transaction Record is fulfilled; pickup formatting now requires explicit picked-up line evidence or payment-on-order work. Opening Add Customer now closes the portaled Register search results instead of layering register controls over the customer form, and payment-on-order receipts and reports prefer the public fulfillment or imported Order number over both internal Counterpoint composite references and the fallback ROS Transaction number.
- **Truthful Payment-Event Receipts and Register Reporting**: Combined and payment-only checkouts now preserve the payment receipt Transaction Record separately from the older order receiving the money. Daily Sales and Z-Reports show **Payment on Order** with the public target Order/Transaction number, payment receipt number, amount, tender, and remaining balance; Receipt reprints the payment event while Detail opens the target order. Customer receipts no longer expose internal allocation keys or repeat cash tender/change per allocation. Alteration charges now count in Subtotal and Net Sales while remaining separately disclosed; shipping remains outside those subtotals, and neither service inflates Sales by Hour, sales count, or average sale. Credit Card Total also nets `card_present` refunds.
- **Combined Checkout Receipt and Report Reconciliation**: A checkout containing new takeaway merchandise plus a payment on an existing Order now appears as one Daily Sales and Z-Report transaction. Its receipt separates merchandise from **Payment on Order**, labels the full tender as **Total charged today**, and reconciles that total exactly; payment-only receipts no longer render a false **Taken Today** section or duplicate the payment as merchandise. A standalone RMS account collection remains an RMS payment receipt unless it carries an actual existing-Order allocation.
- **Cancellation Refund Handoff and Status Compatibility**: Transaction status JSON now uses canonical lowercase snake_case while accepting legacy PascalCase requests during mixed-version upgrades. Cancelling an already-cancelled Transaction Record is a row-locked no-op, preventing duplicate loyalty reversal or Register refund-queue amounts, and linked Helcim refunds send the original payment's provider transaction ID as `originalTransactionId`.
- **Restart-Safe Daily Backups**: The Main Hub now catches up a missing daily PostgreSQL backup after a restart or outage that spans the configured backup time, uses verified store-local backup evidence to avoid duplicate scheduled runs, and records pre-attempt schedule-context or verification-evidence failures instead of surfacing them only as generic overdue alerts.
- **Backup Release-Gate Coverage**: The financial invariant gate now verifies the restart-safe backup worker's store-local date, hour, and minute schedule context instead of looking for the retired clock helper.

## [0.95.5] - 2026-07-26

- Added an auditable Manager-only legacy Counterpoint order reconciliation workflow that scans all stored imported accounts, repairs only exact open-order/ticket/payment matches, moves legitimate later payments to the original order, supersedes duplicate imported artifacts, and leaves ambiguous cases unchanged for review without rerunning Counterpoint imports.
- Added manager-approved Register backdating that changes the transaction business date without moving actual tender-day evidence, plus explicit receipt and QBO clearing documentation.

### Fixed
- **E2E Meilisearch Isolation**: The deterministic Playwright stack now forces
  PostgreSQL search fallback and disables its daily Meilisearch rebuild worker.
  Resetting the sparsely seeded E2E database can no longer replace shared
  development or production indexes with empty or fixture-sized data, and the
  release gate preserves this boundary. GitHub Playwright lanes explicitly
  authorize destructive Register cleanup only inside their disposable
  PostgreSQL service databases.
- **Main Hub Migration 159 Update Compatibility**: Restored the canonical
  migration file byte-for-byte to the checksum already recorded on the Main
  Hub. The failed updater correctly rolled back before applying changes; the
  rebuilt package no longer rejects migration 159 because of a removed trailing
  newline, and no migration SQL or production data is changed by this repair.
- **Partial Pickup Without Automatic Payoff**: Selecting one or several pickup
  lines now loads only those items and does not add the remaining Transaction
  Record balance as an Order Payment. Insufficient cumulative payment coverage
  can be released through explicit audited Manager Access; unselected items and
  the remaining balance stay open.
- **Abandoned Helcim Setup Sale Lock**: HelcimPay now creates a pending provider
  attempt only after hosted checkout initialization succeeds. A stale tokenless
  setup that never opened card entry is finalized as
  `initialization_abandoned`, while any terminal, token, or provider evidence
  remains protected for audited recovery.
- **Return and Exchange History Visibility**: Customer and Transaction Record
  history now include completed return/exchange settlement activity and receipt
  context instead of hiding those financial events.
- **Counterpoint Source-Price Reconciliation and Return Fail-Closed Guard**: Compared all current imported sales and open/closed orders directly with Counterpoint SQL, applied only exact reviewed charged-price/tax and historical-refund repairs, and left ambiguous records financially unchanged. Migration 159 records 540 reviewed return/refund holds covering 941 lines; return, refund, void, and exchange settlement now stop before inventory or tender mutation when source, payment, or refund evidence is unresolved. Register return credit uses only the original stored charged price and tax—never current tax rules, catalog price, retail, or display price—and the Counterpoint Settings card is read-only status rather than a staff repair task.
- **Backup Restore Proof, Complete-Schema Access, and Operator Guardrails**: Main Hub installs now give `pg_dump`/`pg_restore` a protected PostgreSQL administrator connection so production-only schemas owned outside the limited app role do not break scheduled and manual backups. Settings and runtime diagnostics expose whether complete database backup access is configured and backup failures surface their server error. Restore drills now verify the PostgreSQL archive catalog, use a single restore transaction, compare the complete migration ledger/checksums and core row counts instead of a stale fixed migration number, and fail on any mismatch. The Settings restore control is disabled outside an explicitly enabled non-production drill and requires the operator to type the exact snapshot filename; post-restore compatibility no longer fabricates retired migration-ledger rows.
- **Counterpoint Paid-Price Recovery and Tender Safety**: Added a no-reimport, Staff-confirmed repair for the exact 10 imported Transaction Records / 21 lines whose July 21 lifecycle correction retained stale open-document pricing. The repair reconstructs remaining quantities from Counterpoint open-document financial lines and completed quantities from linked completed-ticket `S` lines; preserves Reg/Sale discount evidence; locks payments, allocations, quantities, customer, status, pickup, fulfillment, returns, and refunds read-only; and records immutable before/after evidence. Existing-order payments now fail closed before tender dispatch—and again during checkout—when charged lines/tax disagree with the stored total or balance.
- **False-Fulfillment Incident Evidence and Release Disclosure**: Retained immutable evidence for the exact 567-record Counterpoint cohort and its current classification of 557 traceability reviews, one current-exception review, nine failed recognition recoveries, and zero verified records. The initiating direct repair path remains disabled, the proposed enforcement/recovery design remains non-executable and unshipped, and pre-retag now verifies the evidence and emits a prominent non-blocking warning without presenting asset publication as incident resolution.
- **Helcim Payment Safety and Recovery**: Bound provider refunds/reverses to the authorized Transaction Record refund workflow; made terminal timeout/5xx outcomes single-dispatch and recovery-only; blocked alternate tender and completion while card truth is unresolved; allowed atomic failed/stale webhook recovery; fixed unsafe API-host overrides; and hardened same-key idempotency recovery, saved-card token containment, and merchant-rate-limit handling.
- **Non-Blocking Z-Close With Immutable Exception Evidence**: Authorized Register close no longer stops on pending checkout recovery, missing workstation acknowledgements, or unresolved Helcim attempts. Those issues remain visible and repairable, stay open after close, and are frozen with the same close-time tender reconciliation used by the immediate and archived Z-Report. A Helcim warning clears only when its successful tender is fully allocated to the attempt's exact checkout, and closes with unresolved issues retain a dedicated audit event; cash count, check review, deposit date, discrepancy-note, authorization, and Register #1 integrity requirements remain enforced.
- **Audit-Wide Register, Search, Reporting, and Runtime Integrity**: Hardened checkout replay and exchange/offline recovery audit paths; made global and operational searches cancellation-safe, permission-correct, indexed, bounded, and explicit about partial failures; added full-range paged Daily Sales search/export/print with exact counts; removed raw JSON/internal IDs and false money/count formatting from staff reports; made readiness and Dev Center diagnostics report unavailable evidence instead of zeros; and removed async telemetry work from the metrics registry lock.
- **Checkout Sale Isolation and Card-Recovery Truth**: Every completed sale—or sale cleared only after all provider outcomes are final and attached—starts a fresh checkout drawer identity and resets sale-local keypad, tender, and Card Not Present state. Card Not Present approvals must match the exact request, provider attempt, checkout, customer, and amount, so a late approval cannot attach to the next sale. Pending/unknown provider evidence keeps Clear Sale and alternate tender locked; Manager matching of an existing paid Transaction Record verifies immutable payment facts without creating or moving money; and a Payments Health review note no longer hides an approval that remains financially unlinked.
- **Refund and Exchange Financial Integrity**: Linked Helcim refunds now verify the current V2 transaction and card-batch state, reverse full open-batch charges, refund closed-batch charges, and defer return/inventory writes until provider approval. Card-funded exchanges preserve the completed exchange and leave a failed remainder visible for retry; refund APIs reject unsupported synthetic tenders; check refunds retain the check number; Staff Account refunds reduce receivables; manager-confirmed RMS/R2S refunds update both the negative payment ledger and linked RMS Charge records; and QBO clears return liabilities for the real negative RMS and Staff Account tenders.
- **Windows Release Compiler Resilience**: The long standalone Main Hub server build now compiles without the optional remote compiler wrapper, matching the Register updater build and preventing a dropped `sccache` connection from discarding an otherwise valid release compile.
- **Release Asset Set Reconciliation**: Published replacement assets now identify
  build `b954edad` throughout the tag, Release title, deployment ZIP, and all
  updater/build manifests. Three unreferenced companion-app MSI signatures left
  from the superseded build were removed because they no longer matched the
  rebuilt MSI files.
- **Fulfillment-Day QBO Shipping Balance**: Shipping revenue recognized after the tender day now releases the matching prepaid shipping amount from deposit liability, preventing fulfillment journals from crediting shipping income without the corresponding debit.
- **Payments Dashboard Read Path**: Added provider/reference indexes for Helcim payment history and settlement reconciliation joins to reduce slow dashboard queries as payment history grows.
- **Connection Failure Diagnostics**: Server-error logs now include the method and URI that produced the failure, and the Register connection banner requires two consecutive failed health probes so one transient timeout does not interrupt staff work.
- **Optional Redis Startup**: The Main Hub no longer attempts the implicit `localhost:6379` Redis endpoint when Redis is not configured; Redis remains available when `RIVERSIDE_REDIS_URL` is explicitly set.
- **Integration-Test Database Isolation**: Counterpoint reconciliation tests now use the dedicated `TEST_DATABASE_URL` instead of inheriting an application `DATABASE_URL` loaded by another parallel test, and active test guidance requires the complete migration baseline through 129 before DB-backed validation.
- **Customer and Wedding Data Protection**: Register customer lookup now cancels stale responses so an older search cannot replace the current results; duplicate-customer merges fail closed when linked measurements, alterations, balances, relationships, or operational history cannot be safely re-pointed; wedding schedule-conflict overrides now commit the appointment and required Manager audit row atomically; and parties with held deposits but no merchandise Transaction Record load zero-value economics instead of failing their financial/readiness view.
- **Windows Update Package Efficiency**: Windows deployment packages no longer re-download and re-bundle ROSIE speech models already installed on production Main Hubs. Every Main Hub update entry point now uses an explicit preservation mode that retains installed LLM/STT/TTS assets, ROSIE environment settings, active processes, and the LLM scheduled task, while fresh ROSIE setup retains its pinned download path.
- **Wedding Split-Deposit Reconciliation**: Wedding group-pay checkouts now retain payer identity, show payer and recipient history correctly, distinguish held deposits from unpaid member balances, expose funded-member totals in Wedding Manager, and reconcile the payer Transaction Record, wedding deposit liabilities, and total collected tender separately across Daily Sales, print, and CSV output without double-counting later redemption.
- **Approved Helcim Order-Payment Recovery**: Payments Health can now attach an approved but unlinked Helcim terminal payment to an exact open Transaction Record through the normal payment-allocation ledger, while checkout prevents approved provider tenders from being removed, parked, cleared, or overwritten by another terminal attempt.
- **Approved Helcim Parked-Sale Recovery**: Payments Health can now identify one exact retained cart for an approved but unlinked Helcim charge and let a payment-resolution manager create the missing Transaction Record through the normal checkout ledger without charging the card again, with amount/session/provider guards and complete recovery audit evidence.
- **Helcim Sale-Attachment Guard**: Checkout now refuses to record a sale when an approved Helcim attempt for the same retained checkout is still unattached, preventing a completed-looking Transaction Record with a missing payment; staff can attach the exact tender or use Payments Health to recover or refund it.
- **Staff Access Expiry Scheduling**: Long Staff Access expiry intervals are now chunked within the browser timer limit and rechecked, preventing clock-skew or fixed-date runtime tests from immediately revoking a newly authenticated session.
- **Single-Day Z-Report Boundaries**: Register close now resolves the oldest unclosed store-local business date, filters tenders, payments, adjustments, inventory activity, QBO staging, and daily financial reporting to that date, and requires missed dates to close one at a time instead of combining them under the morning the close was performed. Historical catch-up reports explicitly state when no separate drawer count existed rather than inventing a daily over/short amount.
- **Line Tax Controls and Non-Taxable Service Charges**: Register sale lines now cycle between Standard, Clothing, and No Tax with immediate per-line recalculation, server validation, audit metadata, and persisted sale-detail classification. Cart creation, price edits, discounts, totals, and checkout payloads also preserve zero state/local tax for alteration labor and the `SHIPPING` SKU; the server independently rejects taxed shipping lines and persists both service types with zero tax, while Ship current sale remains a separate non-taxable charge.
- **Main Hub Update Backup and Recovery Safety**: In-app, package, pushed-LAN, and fleet updates now require the configured PostgreSQL administrator for complete verified backups and never fall back to the limited Riverside app account; database passwords containing URI-reserved characters are handled safely; backups complete before an existing server is stopped or files are replaced; incomplete dumps are removed; optional status-file errors cannot interrupt install or rollback; later rollback failures no longer prevent an independent attempt to restore and restart the previous scheduled task; and rollback keeps the restored server environment synchronized with any PostgreSQL app-role credential change.
- **Staff Session Isolation and Connection Security**: Replaced retained raw-PIN Back Office authentication with hashed, opaque, expiring sessions bound to both station and tab/window identity; added independent revocation, PIN/deactivation invalidation, expiry enforcement, active-session Station Fleet tracking, a dedicated PIN-attempt rate limit, and a Tauri content security policy.
- **Register Session Audit Attribution**: Z-close reconciliation no longer depends on a retained four-digit credential, and Register close/handoff actions resolve the actual authenticated Staff session for audit attribution.
- **Hot-Path Connection Efficiency**: Throttled Register and Staff session activity writes to once per minute, warmed the PostgreSQL pool with bounded acquisition/lifetime settings, and configured shared outbound HTTP connection pooling, timeouts, and TCP keepalive.
- **Wedding Group-Pay Balance Safety**: Locked the beneficiary Transaction Record during split wedding payment allocation, ignored fully paid targets, and rejected disbursements above the live balance before consuming tender sources.
- **Atomic Transaction Audit History**: Shipping, refund, exchange, financial-date, status, and order-line mutations now persist their required transaction activity record in the same database transaction, preventing a committed change from returning a misleading failure because its later audit write failed.
- **Strict Employee-Pricing Startup**: Strict production startup now fails closed when the configured employee markup cannot be loaded instead of silently pricing with a 15% default.
- **Staff-Facing Failure Visibility**: Counterpoint exception CSV exports use the native desktop save bridge and report cancellation/failure accurately; role discount-cap loads/saves and Register product searches now surface connection or save failures instead of appearing successful or empty.
- **Sandbox Restore Proof**: The backup/restore drill now recognizes the repository's `e2e` environment as an allowed test sandbox while continuing to refuse production and unknown databases.
- **Cash Refund Reconciliation**: Cash refunds are included as negative cash activity so expected drawer cash, deposit totals, and Z-Report over/short results reflect the physical drawer after a refund.

### Changed
- **Payment, tax, and receipt follow-up**: Hardened card-not-present approval recovery and sale linking, normalized card tender reporting, added post-payment gift-card balances to receipts and Receipt Builder placement tokens, and made explicit single-line tax-status overrides server-authoritative without stale client tax mismatches blocking valid sales.
- **PostgreSQL 16 Operations Guidance**: Updated replication and WAL paths to the deployed PostgreSQL 16 baseline and replaced obsolete `recovery.conf` instructions with `standby.signal` guidance.
- **v0.95.0 Release Evidence**: Recorded published commit `b954edad`,
  exact-commit Lint/Playwright, successful Windows/macOS builds, the final
  26-asset release set, all ten exact-SHA updater/build manifests, the
  ROSIE-preserving short-SHA Windows deployment package, and the remaining
  physical Main Hub verification hold.

## [0.95.0] - 2026-07-11

- **Release Build Throughput and Promotion**: Corrected per-job Rust cache identities, upgraded sccache setup to its native Node 24 action, allowed Windows and macOS release builds to run concurrently while serializing publication, added non-publishing benchmark dispatches, and added exact-SHA candidate promotion with run, tag, artifact-digest, and updater-manifest provenance checks.

### Changed
- **Dependabot CI Queue Controls**: Grouped routine, major, and security dependency updates; reduced version-update PR caps; staggered monthly ecosystem schedules; and routed isolated companion-app dependency PRs through targeted locked-install/build validation instead of the full Riverside Playwright matrix.

## [0.90.0] - 2026-06-04

### Added
- **Release Provenance and Package Integrity Gates**: Added exact tag-to-commit verification, deployment-package SHA-256 manifests, external download checksum/revision pins, aggregate Playwright gating, and optional Authenticode/Apple trust enforcement before release publication.
- **Expanded Dependency Monitoring**: Added Dependabot and weekly npm audit coverage for every active JavaScript package alongside the existing Cargo audit.
- **RiversideOS User Manual PDF**: Added live, on-demand PDF generation in Help Center Settings with current effective manuals, embedded screenshots, clickable contents, PDF bookmarks, native desktop download, and print/save-to-PDF support.
- **Wedding Party Held Deposits in Register**: Added immediate beneficiary-customer deposit notices, Pay-screen application, customer-history visibility, fulfillment-timed QBO liability release, and atomic void/cancellation restoration for split wedding deposits held before a member has a Transaction Record.
- **Operational Outbox and Recovery Telemetry**: Added durable post-checkout side-effect processing, Main Hub-backed offline/print recovery visibility, phase metrics, and migration `124` operational recovery tables.
- **v0.90.0 Release Documentation Set**: Added current release notes and certification evidence for the v0.90.0 publication, replacing stale v0.85.9 current-release guidance in active deployment docs.
- **Pre-Go-Live Local Review Evidence**: Documented the source-side pre-go-live review results for QBO, Counterpoint sync, backups/restore, Helcim, Podium, Shippo, and release/update code paths that can be validated locally.
- **Shippo Health Coverage**: Added local Shippo health-check test coverage so disabled, missing-token, and healthy credential states are verified without requiring live shipping labels.
- **GO-LIVE Performance and Connectivity Review**: Added a current review artifact and focused Register/Back Office connection recovery coverage for LAN, Tailscale, PWA, and Tauri API-base behavior.

### Fixed
- **Windows Install Failure Safety**: Main Hub installation now fails closed on database/migration/bootstrap/readiness errors, creates a pre-migration backup, restores prior application files and scheduled-task configuration after failure, and no longer removes the workstation app before its replacement succeeds.
- **Playwright Result Truthfulness**: Added a required aggregate blocking check and repaired nightly Counterpoint/printing harnesses so failed shards or production-bundle source imports cannot be reported as an overall successful E2E result.
- **Recovery Authentication Continuity**: Operational recovery endpoints now use the shared Staff-or-Register authentication middleware, preventing a stale Register token from overriding valid Staff Access during recovery polling.
- **Mobile Toast Interaction Safety**: Toast notification bodies no longer intercept taps on Register controls underneath them; the visible dismiss control remains interactive.
- **Financial Runtime Boundaries**: Removed weather/provider waits from locked checkout/refund sections, enforced exact-cent tax and total parity, bounded printer dispatch, and made print failures activate the retry path.
- **Helcim, QBO, and IMAP Contracts**: Constrained provider idempotency/request identifiers, added Intuit webhook/OAuth/token-refresh validation, and replaced the legacy synchronous mailbox stack with bounded `async-imap` using current `imap-proto`.
- **RMS Charge CoreCard Purge**: Removed obsolete CoreCard credential surfaces, fake-host E2E dependencies, stale validation scripts, and deployment/manual guidance so RMS Charge is documented and tested as the internal Riverside/R2S workflow.
- **QBO Mapping Fallback Removal**: Removed fallback account mapping behavior from QBO journal staging and workspace copy. Exportable financial activity must now have explicit Chart of Accounts mappings instead of silently routing through a generic fallback.
- **QBO Inventory Adjustment Mapping**: Renamed the legacy inventory adjustment revenue mapping key to `REVENUE_INVENTORY_ADJUSTMENT` so the mapping matrix remains explicit, mappable, and auditable.
- **QBO Direct Layaway Deposit Journals**: Included direct layaway deposit payments in the daily QBO deposit-liability journal and drilldown evidence so deposit cash/card inflows no longer wait for a later fulfillment release before appearing in accounting review.
- **Register and Back Office Connectivity Recovery**: Bounded staff gate startup/API calls, aligned legacy API helpers with the shared runtime API base, and cleaned up checkout replay timeouts so LAN/Tailscale outages recover with clear staff-facing guidance.
- **Helcim Health Test Isolation**: Serialized Helcim environment mutation in unit tests to prevent nondeterministic credential-state failures during parallel cargo test execution.

### Changed
- **Build Runtime and Supply-Chain Refresh**: Upgraded CI to Node 24 and Rust 1.91, pinned GitHub Actions to immutable SHAs, narrowed release-token and signing-secret scope, removed redundant `node_modules` caches, added bounded job timeouts, and serialized same-tag release publishers.
- **Dependency Security Refresh**: Upgraded patched Rust and npm dependency graphs, including OpenDAL, Calamine, ammonia, quinn-proto, crossbeam-epoch, anyhow, and keyring, while retaining audit visibility for upstream Tauri/Linux maintenance warnings.
- **Actions Storage Retention**: Added short-lived build/report artifact retention and removed 4,316 obsolete Actions artifacts (about 276 GB) without deleting published release assets.
- **Release Metadata Bump**: Updated root, client, server, Tauri, standalone app, ROS Dev Center, and Windows deployment package metadata to v0.90.0.
- **Help/Manual Refresh**: Refreshed active manuals and help-manifest sources so in-app Help Center content reflects the current release guidance and avoids stale v0.85.9 "current release" directions.
- **Deployment Guidance Truthfulness**: Updated active deployment status docs to distinguish source readiness, GitHub release publication, release workflow assets, and physical Windows/hardware go-live gates.
- **Latest Same-Version Rebuild**: Prepared the 2026-07-11 `v0.90.0` replacement-tag rebuild with current production hardening, wedding held-deposit changes, recovery-auth continuity, release supply-chain verification, rollback-safe Windows deployment, and truthful CI gating. The prior full local release suite completed with 380 passed, 12 expected skips, and 0 failures; the rebuilt release additionally requires same-commit GitHub Playwright success before package publication.

## [0.85.9] - 2026-06-04

### Added
- **ROSIE AI Stack Automatic Updates**: Hardened the ROSIE AI installer script (`Install-RosieAiStack.ps1`) to track current component versions using version-specific state marker files (`sherpa_version.txt`, `stt_version.txt`, `tts_version.txt`). Component upgrades are automatically triggered and downloaded when script version pins or model repositories are updated.
- **Standalone App Self-Updaters**: Added shared Tauri updater plumbing for standalone support tools, including Deployment Manager, ROS Server Manager, Counterpoint Bridge GUI, and ROS Dev Center, with release manifest verification for same-version rebuild detection.
- **Orders Lifecycle Workbench Filters**: Added explicit Orders views for Open Orders, All Records, Closed, and Cancelled plus lifecycle filtering for NTBO, Ordered, Received, Needs Ready Check, Ready for Pickup, and Picked Up.
- **Ready-for-Pickup Staff Queue**: Added a dedicated Orders metric for received items that still need staff ready-check review before customer pickup notifications and release.

### Fixed
- **Windows Deployment Connection Probes**: Wrapped native database connection query tests with temporary `$ErrorActionPreference = "SilentlyContinue"` blocks in `install-server.ps1`, `reset-riverside-database.ps1`, `reset-postgres-password.ps1`, and `audit-system.ps1` to prevent terminating `NativeCommandError` exceptions when connection checks fail.
- **Counterpoint Bridge GUI Self-Containment**: Release builds now run from packaged bridge resources and a bundled Node runtime instead of invoking `npm install` or relying on system `node` at customer install time.
- **Counterpoint Historical Provenance in Orders**: New ROS-origin orders no longer display `CP Open Doc`/Counterpoint historical badges unless the transaction is marked as a Counterpoint import and has Counterpoint document or ticket references.
- **Customer Join/Split Data Separation**: Joined customer accounts now preserve per-person profile views for communications and CRM data, while split accounts keep post-split independence and parent-history guidance for pre-split purchases.

### Changed
- **Maintenance & Repair Layout Redesign**: Redesigned the vertically scrolling sidebar list in the Deployment Manager GUI to feature a horizontal sub-tab category menu (`Status & Control`, `Updates & Setup`, `Database Admin`, `Utility Scripts`, `Danger Zone`) and an expanded full-width log output console at the bottom with a larger adjustable height view.
- **Main Hub Nomenclature Alignment**: Updated and aligned user-facing labels, logs, descriptions, and action triggers from "Server PC" to **"Main Hub"** for architectural nomenclature consistency.
- **Role-Aware In-App Updates**: Update Manager copy and flow now distinguishes Main Hub, Register, and Back Office expectations, including Main Hub server/ROSIE responsibilities and workstation version gates.
- **ROSIE Local LLM Profiles**: Local llama.cpp startup now supports explicit host profiles for Intel i9-12900, Minisforum V3, Apple M3 Pro, Apple M3 Pro CPU-parity, and portable CPU hosts. The Intel i9-12900 profile pins compute and batch threads to 8, disables GPU offload, enables mmap/mlock where supported, and applies P-core affinity on Windows.
- **Release Asset Verification**: Release packaging now verifies updater manifests, build metadata, signatures, build SHA values, and referenced artifacts for POS and standalone app updater channels.

## [0.85.5] - 2026-06-03

### Added
- **Counterpoint Bridge GUI Optimization**: Major performance and UX improvements to the Counterpoint Bridge GUI application:
  - **Performance Enhancements**: Reduced polling frequency from 2s to 5s, added React useCallback/useMemo hooks for preventing unnecessary re-renders, implemented state change detection to only update React state when data actually changes, added cache control to fetch calls for fresh data, and memoized entity stats rendering.
  - **Modern UI Design**: Added real-time sync progress bar with percentage indicator and Zap icon, improved sync state display with animated spinner when syncing, enhanced visual hierarchy with icons and color-coded status, gradient buttons with hover effects, smooth transitions and animations, and clean professional layout with sidebar navigation.
  - **Riverside OS Integration**: Added direct workflow link button that opens the Riverside OS Counterpoint Sync workflow at `/settings/integrations/counterpoint-sync`, enabling seamless navigation between Bridge GUI and Riverside OS for complete GO LIVE workflow.
  - **Complete Entity Coverage**: Bridge GUI supports all 15 entities (Staff, Sales Reps, Vendors, Customers, Store Credits, Customer Notes, Categories, Catalog, Inventory, Vendor Items, Gift Cards, Orders/Tickets, Open Documents, Loyalty History, Receiving) with auto-schema detection for column name alignment.

### Fixed
- **Receipt Centering Issue**: Fixed ESC/POS receipt printing centering by:
  - Adding `spacing: false` and `margin: "full"` options to receiptline transform in both print and preview functions in `ReceiptSummaryModal.tsx`
  - Adding `^^` prefix to centered lines in `receipt_escpos.rs` `centered_lines` function to ensure receiptline treats them as centered/bold
  - These changes ensure proper centering of header and footer lines on thermal printers.
- **Deployment: PostgreSQL password prompts eliminated**: All bare `psql` calls in `install-server.ps1` that were missing the `-w` (no-password) flag have been fixed. `Invoke-PsqlScalar`, `Get-DatabaseEncoding`, `Get-MigrationLedgerExists`, `Get-MigrationApplied`, `Test-CoreIdentityMigrationApplied`, and the database existence check now all pass `-w`, ensuring psql never opens an interactive password prompt in any shell context (GUI-spawned child process or terminal).
- **Deployment: ROSIE `ggml-base.dll` locked during update**: `install-server.ps1` and `Install-RosieAiStack.ps1` now stop the `Riverside OS LLM Host` scheduled task and kill `llama-server`, `sherpa-onnx-offline`, and related processes before overwriting any ROSIE binaries. Prevents Windows from refusing to copy DLLs held open by a running process on incremental updates.
- **Deployment: ROSIE `sherpa-onnx` download aborted by CDN**: `Invoke-Download` in `Install-RosieAiStack.ps1` now retries up to 3 times with exponential backoff (2 s → 4 s), cleaning up partial files between attempts. Resolves "The request was aborted: The connection was closed unexpectedly" failures on GitHub CDN drops during large binary downloads.

### Changed
- **Counterpoint Bridge GUI Code Quality**: Fixed all Tailwind class lint warnings by updating to newer Tailwind CSS syntax (bg-gradient-to-r → bg-linear-to-r, hover:bg-white/[0.02] → hover:bg-white/2, etc.).


## [0.85.0] - 2026-05-31

### Added
- **POS Register GO LIVE Readiness Review**: Systematic end-to-end review of the POS Register (cart, checkout, payments, printing, sessions, offline), Back Office, Settings & Integrations, and Performance. Six critical fixes implemented (A–F):
  - **Fix A — Session Token Pre-Check**: `useCartCheckout` now probes `GET /api/sessions/current` before tendering. If the session has expired or been closed from another terminal, the cashier gets immediate feedback instead of a late server rejection.
  - **Fix B — Server-Side Printer Config**: Per-register-lane printer settings (receipt, tag, report printers, cash drawer) are now persisted in `store_settings.pos_station_config`. New endpoints `GET|PATCH /api/settings/printer-config/{register_lane}`. The Register Overlay hydrates settings on lane change and syncs them on successful open.
  - **Fix C — Offline Queue Recovery UI**: The POS cart header now polls the offline checkout queue every 10s and displays live badges: an amber "syncing" badge when items are queued, and a red "need recovery" badge when blocked items require manual attention.
  - **Fix D — Receipt Print Retry Queue**: Failed receipt prints are captured in a new `localforage` retry queue (`printRetryQueue.ts`). A "X print retry" danger button appears in the POS header; clicking opens a modal to retry individual jobs or dismiss them.
  - **Fix E — Dynamic Register Lanes**: The Register Overlay dropdown is no longer hardcoded to 4 lanes. It fetches `max_register_lanes` from the new public endpoint `/api/settings/pos-station-config/public` and generates options dynamically. Migration `058_pos_station_config.sql` adds the JSONB column.
  - **Fix F — Helcim Terminal Auto-Reconnect**: `NexoCheckoutDrawer` now runs a 4-second fallback polling interval alongside the SSE stream. If the SSE connection drops silently, polling continues to refresh the terminal attempt status until completion or cancellation.
- **ROSIE Token Telemetry System**: Comprehensive token usage tracking for cost analysis and provider comparison when evaluating local LLMs vs cloud-based APIs:
  - **Database Migration**: `060_rosie_token_telemetry.sql` adds `rosie_token_telemetry` table with fields for model name, provider, input/output tokens, and timestamp. Includes indexes for efficient date-based and provider/model queries.
  - **Non-Blocking Telemetry Recording**: `record_token_telemetry()` function in `rosie_intelligence.rs` uses `tokio::spawn` for fire-and-forget DB inserts, ensuring POS terminal performance is not impacted by telemetry recording.
  - **Token Metrics Query**: `get_token_metrics()` function returns daily tokens, monthly tokens, and estimated monthly cost (using placeholder rate of $0.50 per 1M tokens, configurable for per-provider rates).
  - **API Endpoint**: `GET /api/settings/rosie/token-metrics` exposes telemetry metrics for admin staff (requires `settings.admin` permission).
  - **UI Component**: `RosieTokenMonitor` component in `RosieSettingsPanel.tsx` displays daily token use, actual monthly usage, and estimated monthly cost with clear formatting and placeholder rate disclaimer.
- **ORDER Pick up Inventory and Lifecycle Guards**: Enhanced pickup workflow with inventory availability and lifecycle status checks:
  - **Inventory Availability Check**: Pickup guard now verifies `stock_on_hand >= quantity` for all unfulfilled lines before allowing pickup. Error message shows which items have insufficient inventory with need/have counts.
  - **Received Status Check**: When transitioning to `ReadyForPickup` status, system now verifies `received_at` is not NULL (item went through ordered → received lifecycle via vendor invoice). Prevents marking items ready before they physically arrive.
  - **Manager Override Mechanism**: Both inventory and received status checks can be bypassed using manager override with explicit reason (minimum 12 characters). Requires manager PIN and clear reason. Allows negative inventory for exceptional cases (receiving later brings stock positive).
  - **Payment Screen Recognition**: Fixed order payment line display for pickup transactions - now shows order payment line even when balance due is 0 if there were previous deposits, ensuring payment screen recognizes the transaction properly.
  - **Layaway and All Unfulfilled Transactions**: All pickup checks (inventory, received status, manager override, payment recognition) apply to layaway and all unfulfilled transactions regardless of fulfillment type or balance due status.

### Changed
- **Counterpoint Sync & Guided Migration Pipeline Consolidation**: Unified Counterpoint Sync and Migration Inventory Workbench into a single 8-step guided pipeline:
  - **8-Step Stepper**: SQL Bridge Sync → Inventory Catalog → Customers & CRM → Sales & Ticket History → Gift Cards & Liabilities → Open Orders & Layaways → Loyalty History → Audit & Live Cutover
  - **Consolidated Component**: Merged `InventoryMigrationWorkbench.tsx` logic into `CounterpointSyncSettingsPanel.tsx` under Step 2 sub-tabs
  - **Step 2 Sub-Tabs**: CSV Enrichment, Category Maps, Vendor Maps, AI Enrichment (ROSIE), SKU Gaps, Merge Preview
  - **Linear Step Enforcement**: Steps unlock sequentially based on completion of previous steps
  - **Pipeline Percentage**: Visual progress indicator showing completion across all 8 steps
  - **Backend Step Gate**: Step approval system with `approve-step` API endpoint
  - **Simplified Terminology**: "Open Orders & Deposits", "Gift Card Active Liabilities", "Sales & Ticket History", "Staging Area"
  - **Deleted Files**: Removed `InventoryMigrationWorkbench.tsx` (logic consolidated)
  - **Updated Navigation**: Removed "Migration Workbench" from `sidebarSections.ts` and `SettingsWorkspace.tsx`
- **NY Tax Audit Report Simplification**: Simplified the NY Tax Audit API response structure to match NY State filing requirements with user-friendly fields:
  - **Simplified Response**: Replaced complex line categorization (clothing_footwear_lines, local_only_exempt_lines, clothing_at_or_over_threshold_lines, etc.) with three clear sales categories: gross_sales, taxable_sales, nontaxable_sales.
  - **Tax Totals**: Added total_state_tax, total_local_tax, and total_tax_collected for easy reporting.
  - **Backend**: Updated `nys_tax_audit` function in `insights.rs` to aggregate data into the simplified structure.
  - **Frontend**: Updated `reportsCatalog.ts` to reflect the new simplified title and description.
- **Z-Report Print Layout Redesign**: Major visual overhaul of the Z-Report print output for better readability and professional appearance:
  - **Activity Cards**: Replaced table-based transaction list with card-based layout showing payment method pill, timestamp, customer name, transaction ID chip, and lane chip.
  - **Item Display**: Enhanced item rows with bold product names, muted SKU/fulfillment details, and monospace pricing in a clean grid layout.
  - **Money Section**: Reorganized transaction totals with clear labels for Transaction Amount, Sale Total, Paid, and Balance Due.
  - **CSS Styling**: Added new CSS classes for activity cards, pills, chips, section labels, and improved spacing/borders.
  - **Branding Update**: Changed header from "RIVERSIDE OS" to "RIVERSIDE MEN'S SHOP" throughout print outputs.
  - **Tauri Print Integration**: Added Tauri file save dialog for desktop app - saves HTML file and opens in default browser instead of direct print, with graceful fallback to browser print.
  - **Error Handling**: Added print failure error handling with user-friendly alerts.
- **Daily Sales Report Print Enhancements**: Improved daily sales report print output:
  - **Grand Total**: Added grand total calculation displayed at end of report with clear formatting.
  - **Document Title**: Added document title for browser tab identification.
  - **Generated Timestamp**: Added generated timestamp to report header and footer.
  - **Tauri Integration**: Added Tauri file save dialog for desktop app with same save-and-open workflow as Z-Report.
  - **Section Rename**: Changed "Activity Detail" to "Transaction List" for clarity.
- **Table Print Enhancements**: Improved generic table print output:
  - **Document Title**: Added document title based on report name.
  - **Branding Update**: Changed footer from "RIVERSIDE OS" to "Riverside Men's Shop".
  - **Tauri Integration**: Added Tauri file save dialog with save-and-open workflow.
  - **Error Handling**: Added print failure error handling.
- **Register Reports CSV Export Enhancement**: Improved CSV export with totals and Tauri native file dialog:
  - **Total Rows**: Added grand total row at end of CSV with TOTAL label and summed values for Transaction Total, Sales Total, Tax, and Net Total.
  - **Tauri Native Dialog**: Added Tauri file save dialog using `@tauri-apps/plugin-dialog` and `@tauri-apps/plugin-fs` for native file picker experience in desktop app.
  - **Fallback**: Graceful fallback to browser download method if Tauri environment is not available or save fails.
  - **Async Function**: Converted `handleExportCSV` to async function to support Tauri plugin imports.

### Migration
- `058_pos_station_config.sql` — adds `pos_station_config JSONB` to `store_settings` for lane limits and per-station printer configuration.
- `060_rosie_token_telemetry.sql` — adds `rosie_token_telemetry` table for tracking AI token usage with indexes on timestamp and provider/model.

## [0.80.9] - 2026-05-27

### Added
- **QBO Staging Lifecycle Management**: Three new endpoints to manage previously staged/synced journal entries:
  - **Revert to Pending** (`POST /api/qbo/staging/{id}/revert`): Un-approve an approved entry back to pending so mappings can be fixed and the journal regenerated before re-approval. Requires `qbo.staging_approve`.
  - **Retry Failed** (`POST /api/qbo/staging/{id}/retry`): Re-validate balance/accounts and re-attempt QBO JournalEntry POST for failed entries without requiring manual re-propose. Requires `qbo.sync`.
  - **Void Synced Entry** (`POST /api/qbo/staging/{id}/void`): Read the JE SyncToken from QBO, delete the JournalEntry via `?operation=delete`, and mark the local row `voided`. Enables re-staging a corrected entry for the same business date. Requires `qbo.sync`.
- **QBO Workspace UI — Lifecycle Actions**: Contextual action buttons in the staging table: Revert (amber, approved rows), Retry (orange, failed rows), Void in QBO (red/danger confirmation, synced rows). All gated behind confirmation modals with descriptive messaging.
- **QBO Voided Status**: New `voided` status in staging pipeline with distinct visual treatment (gray, line-through) in both Review & Send and History views.
- **Daily Financial Report System**: Automated end-of-day financial summary that generates, stores, and emails a comprehensive business-day report after register Z-close. Covers net sales, tenders, tax, returns, deposits, gift cards, alterations, inventory receiving, freight, category margins with COGS and margin %, and QBO journal status. Features:
  - **Settings Panel** (`Settings → Daily Financial Report`): Enable/disable, configure recipient emails, subject template, auto-send toggle, QBO status inclusion, and inventory activity toggle.
  - **Professional HTML Email**: Gradient header, color-coded KPI cards, clean data tables, margin heat coloring, QBO sync badge, and branded footer.
  - **Auto-Send After Close**: Automatically emails the report after Z-close when enabled. Skips duplicates if already sent for the business date.
  - **Test Send**: Send the most recent completed report as a test with `[TEST]` prefix. Supports email override for ad-hoc testing.
  - **Report History**: View all generated reports with net sales, status badges, in-app HTML preview modal, and one-click resend.
  - **API**: Full REST API at `/api/daily-reports/` — config, generate, send, test-send, history, detail, resend.
  - **Migration**: `052_daily_financial_reports.sql` — `daily_report_config` JSONB on `store_settings`, `daily_financial_reports` table with unique date constraint.

## [0.80.8] - 2026-05-27

### Added
- **Constant Contact Marketing Integration**: Direct synchronization of marketing-opted-in customers (`marketing_email_opt_in == true`) to selected mailing lists using high-performance v3 Bulk Import Activities. Allows mapping specific customer tags (e.g. `VIP`) and group codes to targeted mailing lists. Built a secure webhook receiver endpoint to ingest real-time campaign delivery events (sent, bounced, unsubscribed, opened, clicked) and display them on the customer relationship timeline. All API credentials and mappings are encrypted at rest using `RIVERSIDE_CREDENTIALS_KEY`.
- **Constant Contact Database Migration**: Added Migration `048_constant_contact_integration.sql` to track sync history logs and normalize/index email event records.
- **Counterpoint Post-Sync Line Resolution**: Changed the Counterpoint sync engine to map unresolved lines to the fallback variant (`HIST-CP-FALLBACK`) and store the original Counterpoint item key in the `vendor_reference` column. Implemented a post-sync resolver database update that dynamically links these lines to their correct variants once the catalog/barcodes are loaded or manually resolved, clearing the warnings and resolving corresponding sync issues automatically.
- **Proactive Dashboard Self-Healing**: Hooked the post-sync resolver into the Counterpoint Settings status dashboard API so that simply loading or refreshing the dashboard immediately resolves corrected items.
- **POS Register Idle Timeout**: Two-tier idle timeout — register open + 10 min of no interaction clears the session and shows the PIN overlay; PIN overlay idle for 5 min navigates to the POS Dashboard. Prevents unattended cashier sessions. Activity tracked via mouse, pointer, keyboard, touch, and scroll events.
- **POS Shell Strict Containment**: Closing the register (Z-report or session end) now always stays in the POS Shell with the PIN overlay showing. Only "Back to Back Office" exits POS mode. Fixes a regression where closing the register sometimes navigated to the Back Office.
- **POS Dashboard — Today's Sales Card**: Replaced the static "Register #N" stats card with a live "Today's Sales" card showing the current booked sales total filtered to today's date. Updates on every `refreshSignal` cycle.
- **POS Dashboard — Unread Notifications Card**: Replaced the "Priority Feed" stats card with an "Unread Notifications" card showing the real-time unread count for the signed-in staff member. Clicking opens the Notifications Drawer.

### Fixed
- **RMS Payment Lines Missing from Receipts**: Removed the `is_internal` filter from both branches of `selected_receipt_items_with_effective_qty` in `server/src/api/transactions.rs`. RMS Charge Payment lines, gift card loads, and alteration service lines now appear on all customer receipts (HTML, thermal ESC/POS, and email). Updated unit test to assert internal lines are included.
- **Receipt Text Wrapping (HTML)**: Applied `table-layout: fixed`, `overflow-wrap: break-word; word-break: break-word` to item table cells, and `width: 1%` on the nowrap qty/price columns in `receipt_studio_html.rs`. Prevents the qty column from stealing all available width in the 320px receipt container and causing product name "one or two letters" to break onto a second line. Also applied `overflow-wrap: break-word` to the `.paper` container and `table td` CSS rule as a global fallback.
- **Sales by Hour Stale Data**: `SalesByHourSnapshotCard.tsx` now filters the API response to `business_date === today` before computing the daily summary. Previously, if today had no hourly rows the card showed the most recent prior-day total instead of $0.
- **CI Lint (`cargo fmt`)**: Applied `cargo fmt` to `server/src/embedded_migrations.rs` — collapsed verbose multi-line `include_str!` tuples to single-line style, resolving the GitHub Actions `cargo fmt --check` failure on both server-lint and tauri-lint jobs.
- **Receipt Column Widths (HTML)**: Replaced `width:1%` shrink-to-fit with explicit proportional widths (`55%/25%/20%` standard, `65%/35%` gift) for more consistent layout across email clients, print, and narrow viewports.
- **E2E Contract Testing**: Updated the Playwright `tender-matrix-contract.spec.ts` test suite to assert that the RMS payment line is printed on the receipt (changing `expect(receipt).not.toContain(...)` to `toContain(...)`), aligning test assertions with the new receipt requirements.
- **Inventory Pricing Patch Flows — Backend Coverage**: Added integration tests for `patch_product_model` base-price cascade (`base_retail_price` changes clear `shelf_labeled_at` only for variants without `retail_price_override`) and `patch_variant_pricing` effective-price semantics (`price_changed` computed against old effective retail, `shelf_labeled_at` cleared only on real changes, no-op when override matches base).
- **Browser Print Fallback Popup Blocker Detection**: `openInventoryTagsPreviewWindow` in `client/src/components/inventory/labelPrint.ts` now returns `"blocked"` when `window.open` returns `null` (e.g., popup blocker). The fallback chain in `openInventoryTagsWindow` propagates this status. All UI callers (`VariationsWorkspace`, `ProductHubDrawer`, `InventoryControlBoard`) now toast an explicit error instead of silently failing or claiming success.
- **Batch Price Update Reprint Prompt**: `VariationsWorkspace` batch price updates now collect per-variant pricing responses and, if any variants experienced a real effective-price change with positive stock, present a single confirmation modal to print updated tags for all affected variations at once. Previously, batch updates silently skipped reprint prompting entirely.

## [0.80.7] - 2026-05-26

### Added
- **Transactional Outbox for QBO**: Added `qbo_sync_outbox` queuing inside the transaction checkout block. Decouples the live registers from QuickBooks Online downtime, rate limits, or transient connection issues by using an asynchronous sync worker with exponential backoff.
- **Offline Queue Conflict Alerts**: Allowed POS terminal checkouts during sync/offline replay to fall back to negative stock levels, inserting warning alerts to `negative_stock_alerts` and broadcasting notification updates to target admin staff.

### Fixed
- **Checkout State Machine & Idempotency**: Hardened transaction checkouts to write orders in a `Processing` state before terminal captures. Integrated client-side `checkoutClientId` idempotency to prevent dual sweeps, and hooked approved terminal payment webhooks to auto-recover and finalize stuck processing checkouts.
- **Strict Webhook Isolation Layers**: Enforced typed `serde` payload validation parsing on Helcim, Shippo, and Podium webhook entry points to prevent upstream API changes from propagating database exceptions.

## [0.80.6] - 2026-05-25

### Added
- **In-App Host Server Updater**: Integrated a native server update orchestration layer in Tauri (`server_updater.rs`). Allows the desktop app to download release packages, unpack binaries and script installers, and run them under Administrator permissions via a standard UAC dialog.
- **Update Manager UI Dashboard**: Enhanced `UpdateManagerPanel.tsx` and `appUpdater.ts` to display server status, download progress, and step-by-step update tracking.

### Fixed
- **Staff Help Viewer Authentication Fallback**: Hardened `server/src/api/help.rs` and help routing to gracefully fall back to the active POS register session credentials if active staff profile headers are absent or incomplete.
- **ROSIE Insights Optional Timeout Expansion**: Increased `ROSIE_OPTIONAL_INSIGHT_TIMEOUT_MS` in `client/src/lib/rosie.ts` from 15s to 120s to prevent premature request aborts on slower CPU-only workstation hardware.

## [0.80.5] - 2026-05-25

### Added
- **POS Register — Dedicated Payment Button**: A new **Payment** action button is available directly in the register toolbar under "Sale options" (next to **Gift Card**). Tapping it inserts the RMS Charge Payment line automatically, bypassing the need to search for "PAYMENT" in the product search. Cashier verification is enforced before the line is added.
- **Production Hardening Suite**: Enterprise-grade production features for scalability, reliability, and observability
- **Fal.ai Visual Sidecar Integration**: Centralized visual generation orchestration for staff avatars, catalog images, and promotional assets.
  - **Local-First Download Worker**: Downloads, crops, and caches generated images locally to comply with the offline-first contract.
  - **Secure Credentials Mapping**: Integrates API keys and webhook settings into the encrypted credentials database table.
  - **Robust Settings Dashboard**: Real-time billing credits, estimated spend and usage statistics, and visual generation job registry.

  - **Health Check Endpoints**: `/api/health`, `/api/ready`, `/api/live` for orchestration and monitoring
  - **Connection Pool Monitoring**: Automatic alerts when pool utilization exceeds 80%
  - **WAL Archiving**: Point-in-time recovery capability with monitoring and failure alerting
  - **System Alert Broadcasting**: Critical system events broadcast to all admin staff
  - **Global Rate Limiting**: IP-based and user-based DoS protection with configurable limits
  - **Redis Cluster Integration**: Distributed caching and locking with graceful fallback
  - **Background Job Queue**: Resilient async processing with retries, dead letter queues, and worker pools
  - **Comprehensive Metrics System**: Business KPIs and technical metrics with multiple export formats
- **Migration checksum drift detection**: Both `apply-migrations-psql.sh` and `apply-migrations-docker.sh` now store a SHA-256 hash of each migration file in `ros_schema_migrations.file_sha256`. On subsequent runs, if a previously applied file has been modified, the script prints a `⚠ DRIFT` warning instead of silently skipping. This prevents the class of bug where columns are added to an already-applied migration file and never reach the database.

### Fixed
- **Schema drift: missing columns**: Added migration `037_backfill_missing_columns.sql` to reconcile columns that were added to earlier migration files after they had already been applied — `store_media_asset.deleted_at/alt_text/usage_note` and `categories.variation_axis_presets`. Resolves 500 errors on the Store Dashboard and Categories API endpoints.
- **ROSIE on Server PC**: Windows server install now packages `llama-server.exe`, registers a **Riverside OS LLM Host** startup task on port 8080, and adds **Start-RiversideLlama.cmd** / Deployment Manager **Start ROSIE LLM Host** for repair.
- **RMS Charge race condition**: `reverse_rms_record_manual` now reads `host_reference` inside the same database transaction before commit, eliminating a read-after-commit race.
- **Gift Card lookup filtering**: `GET /api/gift-cards/{code}` now correctly restricts results to `active` non-expired cards, preventing POS use of void or expired cards.
- **Gift Card credit expiration check**: `credit_gift_card_in_tx` now verifies `expires_at > now()` before applying a refund credit.
- **Gift Card depleted reload liability**: Reloading a depleted purchased card now accumulates `original_value = original_value + amount` instead of overwriting it, preserving total liability history.
- **Loyalty monthly eligible filter**: The `monthly_eligible` endpoint now actually uses the `year` and `month` query parameters when provided, filtering to customers with positive ledger activity in that month.
- **Loyalty customer summary NULL safety**: `loyalty_customer_summary` now uses `COALESCE(..., 'Unknown')` to prevent deserialization panics when a customer has no name.
- **Loyalty redemption config validation**: `redeem_reward` now validates that `loyalty_point_threshold > 0` and `loyalty_reward_amount > 0` before processing, preventing point burns against an unconfigured program.
- **Commission recalc SQL safety**: Added explicit `SAFETY` comments to `format!` usages in `commission_recalc.rs` documenting that `ORDER_RECOGNITION_TS_SQL` is a compile-time constant with no injection risk.
- **Database migration runner**: Hardened multi-statement migration execution by splitting on semicolons and executing each non-empty, non-comment chunk individually with `sqlx::query()`. Strips `pg_dump` `SET` and `SELECT pg_catalog.set_config` preamble from migration files to prevent session-side-effect crashes. This is Send-safe across `tokio::spawn` boundaries (unlike `sqlx::raw_sql()`), fixing Windows Tauri compilation failures.
- **CI/CD — Windows deployment package concurrency**: Fixed static `group: windows-deployment-package` concurrency to `group: ${{ github.workflow }}-${{ github.ref }}`, preventing sequential tag pushes from cancelling each other before completion.
- **CI/CD — macOS ROS Dev Center upload paths**: Corrected artifact search paths from `src-tauri/target/` to repo-root `target/` to match the unified Cargo workspace layout, ensuring DMG and app.tar.gz actually reach the GitHub release.
- **POS RMS Charge access restored**: Removed an incorrect blanket `surface === "pos"` guard in `RmsChargeAdminSection.tsx` that blocked staff from viewing RMS Charge records and reporting to R2S while in POS terminal shell mode. Permission-based access (`customers.rms_charge`) remains the correct gate.

### Changed
- **RMS metadata cleanup**: Removed `linked_corecredit_*` fields from `RmsChargeSelectionMetadata` and RMS JSON metadata output. DB columns are preserved for backward compatibility but bound as `NULL` in new inserts.

### Removed
- **CoreCard / CoreCredit Integration**: Removed the entire CoreCard module (`server/src/logic/corecard/`) and all associated API routes, background workers, and test fixtures. The built-in RMS Charge workflow with Helcim as the sole payment provider now handles all charge account operations. This eliminates a deprecated third-party dependency and simplifies the payment architecture.

### Changed
- **Health Check Worker Heartbeats**: The `/api/ready` endpoint now validates actual worker heartbeats from background tasks (backup, notification, weather, email, podium) instead of returning hardcoded `true`. Each worker reports its liveness via `WorkerHealth::mark_heartbeat()`, enabling accurate readiness detection for orchestration systems.

## [0.70.1] - 2026-05-20
### Added
- **Inventory tag print date**: Tag Designer footer text is followed automatically by the print date on every inventory tag (HTML preview and Zebra/ZPL).
- **ROSIE AI model upgrade (E4B)**: Standardized the entire stack on Gemma 4 E4B (4B params, 5.4 GB Q4_K_M) — `MODEL_PIN.json`, Rust default paths, PowerShell installers, dev scripts, e2e mocks, and all docs updated from E2B → E4B.
- **Deployment Manager — PostgreSQL Status Panel**: Live diagnostics showing PG service state, psql connectivity, version, database existence, size, table count, and migration count with a Refresh button.
- **Deployment Manager — PostgreSQL service control**: Start PG / Restart PG / Stop PG buttons inside the status panel with auto-refresh after actions.
- **Deployment Manager — Stop Server**: Added a Stop Server button (previously only Start and Restart were available).
- **Deployment Manager — Uninstall flows**: Uninstall Server (removes binary, scheduled task, firewall rule — preserves database) and Uninstall Register (removes desktop app and shortcuts).

### Fixed
- **Deployment Manager**: Scripts receive `-ConfigPath`, run from the package root, and can relaunch elevated; privileged actions are blocked with a clear message when not running as Administrator.
- **Windows deployment scripts**: Hardened config path resolution, `installRoot` defaults, null-safe package manifest checks, Postgres user normalization (`Admin` → `postgres` / `riverside_app`), and `ros_schema_migrations` audit probe.
- **apply-riverside-migrations.ps1**: Safe property updates when `server` or JWT fields are missing from saved config.

### Removed
- **Stale `hotfix/` directory**: Deleted ~7,800 lines of duplicated deployment scripts that had fallen behind the canonical `deployment/windows/` copies, eliminating triple-maintenance burden and risk of running outdated scripts.

## [0.70.0] - 2026-05-19
### Added
- **Sweden-Style Cash Rounding**: POS transactions dynamically apply Sweden-style cash rounding (to nearest $0.05). Cash rounding offsets are recorded as a separate payment ledger entry (`cash_rounding_offset`) to ensure that base product prices, shipping, and tax lines are untouched and daily drawer reconciliation matches perfectly.
- **CoreCredit Financing**: Integrated consumer line-of-credit (CoreCard/CoreCredit) checks into checkout payment allocations.
- **ROSIE Local AI Copilot**: Powered by a local Gemma LLM sidecar under the strict ROSIE Operating Contract (RBAC constraints, user confirmation gates, no raw SQL).
- **Universal Search Aggregator**: Exposes `/api/search/aggregate` to search CRM, Catalog, Alterations, Weddings, and Help in a single backend call.
- **Transaction Backdating**: Checkout terminal supports booking date overrides to adjust commission and QBO entries.
- **Dynamic Shortcuts**: Combined deterministic backend commands and dynamic Rosie AI search intents in the `GlobalCommandSearch` dialog without duplication.

### Fixed
- **Responsive & QBO Test Stabilization**: Scope locators in `pwa-responsive.spec.ts` to ensure 100% pass rate on responsive/PWA E2E tests.
- **Database Scrubbing**: Added `ros-wipe-business-data-keep-bootstrap-admin.sql` to safely purge all development/testing activity while leaving the seed/bootstrap system metadata and admin users intact.
- **Host Service Commissioning**: Documented and verified startup task integration (`install-server.ps1` registering Axum API as a Scheduled Task and PostgreSQL as an Automatic startup service).

## [0.60.2] - 2026-05-19
### Added
- **Modernized Deployment Manager**: Rebuilt the legacy WinForms/PowerShell deployment manager as a robust, interactive React + Tauri desktop application.
  - **Installation Wizard**: Added a step-by-step UI for choosing station roles (Server vs. Register) and configuring network/database credentials via WowDash design tokens.
  - **Live Execution Streaming**: Decoupled deployment execution from the UI, streaming stdout/stderr directly from the classic PowerShell installation scripts into a live terminal block.
  - **Maintenance & Repair Dashboard**: Restored and expanded all legacy deployment utility functions into a dedicated tab.
    - **Server Control**: Start, Restart, Open Logs, and Check Package utilities.
    - **Database & Migrations**: Apply Migrations, Seed Database, and Factory Reset triggers.
    - **Utility Scripts**: Force ROSIE AI Updates, Sync Counterpoint Bridge, Repair Credentials, and Bootstrap Admin accounts.
  - **Zero-Friction Updates**: Included an inline PowerShell executor to enable rapid invocation of ad-hoc diagnostic scripts directly from the UI.

## [0.60.1] - 2026-05-19
### Changed
- Added known-host selection to the sign-in **API Host Settings** flow while preserving manual IP/URL entry for Register and PWA setup.
- Bumped release metadata to `0.60.1` across package, server, Tauri, and deployment-package defaults for the updater hotfix lane.
- Renamed the Bug Reports "Download for Codex" action to **Download AI diagnostic** so it is tool-agnostic.

### Fixed
- Added a server-side printer readiness endpoint so PWA/browser receipt stations can verify the server-to-printer TCP path before checkout.
- Updated printer settings so network receipt and Zebra tag checks use the same direct readiness path in browser/PWA and desktop contexts.
- Updated staff Help content for API host setup and PWA receipt-printer readiness behavior.
- Fixed ROSIE showing as unavailable on production: `server/src/launcher.rs` now calls `ensure_rosie_upstream_from_local_llama()` at startup to auto-set `RIVERSIDE_LLAMA_UPSTREAM` from `RIVERSIDE_LLAMA_HOST:RIVERSIDE_LLAMA_PORT` (default `127.0.0.1:8080`), bridging the Tauri-managed sidecar with the Axum ROSIE proxy for satellite clients.
- Fixed default LLM model path mismatch: both the server and Tauri sidecar now look for the **Gemma 4 E2B** model (matching `MODEL_PIN.json`) under `%LOCALAPPDATA%\riverside-os\rosie\` on Windows and `~/Library/Application Support/riverside-os/rosie/` on macOS — previously the code looked for the non-existent E4B variant.
- Wired the ROSIE AI stack into `install-server.ps1`: server installation now automatically downloads the pinned Gemma E2B GGUF (SHA256-verified), installs `sherpa-onnx` via `uv`, and fetches SenseVoice STT and Kokoro TTS models. Writes `RIVERSIDE_LLAMA_*` into the server `.env`. Supports `-SkipRosieSetup` for air-gapped installs.
- Added `MODEL_PIN.json` to the deployment package (`build-deployment-package.ps1`) so the installer can resolve the pinned model without hardcoded fallback values.
- Added `Install-RosieAiStack.ps1` / `Install-RosieAiStack.cmd` to the server hotfix package: a standalone ROSIE setup tool for existing Server PCs that downloads all required models and patches the running `.env` without a full server reinstall.

## [0.60.0] — 2026-05-17
### Added
- Added Windows desktop app recovery for the Backoffice / Server PC: when the local API is unreachable on sign-in, the app can start the installed `Riverside OS Server` scheduled task and retry the staff roster check.
- Added a single-release version contract: `/api/version` exposes the server release, `npm run check:version` verifies root/client/server/Tauri metadata parity, and Windows release workflows fail when release metadata disagrees.
- Added the POS Wedding Register workflow documentation covering customer wedding detection, checklist-driven item add, measurement gating, and Wedding Manager source-of-truth rules.
- Added Podium Inbox direct texting: staff can send SMS to an existing customer or enter a new phone number with first/last name to create a Podium-sourced contact before sending.
- Added Podium communications hardening for inbox health, provider sync, unmatched conversation review, webhook failure logging, mailbox/customer communication timeline visibility, and review invite provider status sync.
- Added Register transaction backdating from the live cart date/time control, with checkout persistence into reporting and QBO-effective dates for that transaction only.

### Changed
- Updated v0.50 GOLD release-certification documentation to reflect the 2026-05-14 Playwright evidence: the standard release gate passed with 310 passed / 31 skipped / 0 failed, and the previously skipped environment/visual-gated lanes were certified separately with 31 passed / 0 skipped / 0 failed.
- Replaced the Windows/Tauri placeholder app icon assets with the Riverside logo mark.
- Updated the Settings → Updates surface to show one `Riverside version`; Windows app, PWA/web app files, and server API mismatches are now reported as `Update incomplete` diagnostics instead of separate normal versions.
- Hardened the Windows updater release workflow so it clean-builds/verifies the client bundle and removes old Riverside MSI/signature/manifest assets before uploading the current release assets.
- Documented the Wedding Manager to Register handoff across the fulfillment contract, cutover design, and staff Register/Weddings guides.

### Fixed
- Allowed pennyless cash rounding on negative refund checkouts so a rounded cash payout can allocate back to the returned transaction without blocking payment finalization.
- Expanded Podium Inbox sync to page through current provider conversations and keep recent unmatched provider threads ordered ahead of older synced rows.
- Hardened release documentation around visual baseline, Payments Operations, Back Office sign-in, and E2E environment requirements so the certification record no longer treats those lanes as unresolved skips.
- Restored the Register salesperson requirement across normal Pay, special-order Review Order, and checkout-finalize paths; the server now rejects sale lines without a sale-level or line-level salesperson.
- Prevented the Windows desktop app from using the PWA service-worker update/cache path so an updated shell cannot keep rendering stale web app files.

## [0.4.5] — 2026-05-07
### Added
- Added online store workspace, merchandising, checkout, and store operations surfaces.
- Added in-app update manager and Windows deployment package workflow support.
- Added Helcim-focused Payments Operations documentation for event logging, fee sync, batch/settlement reconciliation, issue resolution, actual bank deposit matching, automation alerts, and test coverage.
- Added staff-facing Payments Operations guidance covering Overview, Batches, Reconciliation, Transactions, Deposits, Health, permission-gated actions, and expected-vs-actual deposit language.
- Added secure integration credential storage and unified credential settings.
- Added RMS account list snapshots and manual-first RMS Charge handling.
- Added Counterpoint cutover reconciliation for customers, inventory, open docs, category/vendor mappings, inventory fidelity checksums, and mismatch diagnostics.
- Added promo gift cards with event names, one-year expiration, POS tender support, and QBO expense mapping.

### Changed
- Bumped application/package metadata to `0.4.5` across root, client/POS, server, and Tauri manifests/lockfiles.
- Replaced card payment operations with Helcim-centered terminal routing, settlement, webhook logging, and shared-terminal support.
- Strengthened Windows deployment provenance, installer package behavior, and local deployment manager setup.
- Updated Counterpoint gift card and loyalty migration behavior to snapshot-only balances for cutover.
- Documented the schema-contract reset: active baseline migrations `001` through `008`, legacy pre-launch migration archive, separated seed phases, validation-only runtime startup, and schema guardrail scripts.
- Updated developer, local setup, E2E, and deployment docs to use baseline migrations plus `scripts/seeds/` instead of seed-like historical migrations.
- Updated developer, permissions, integration-scope, Settings, and E2E docs to reflect ROS-owned Helcim payment operations and the new `payments.*` permission boundaries.

### Fixed
- Hardened POS register startup flow and database pool sizing for deployment environments.
- Fixed CI/payment/offline blockers and hardened payments operations coverage.
- Fixed Counterpoint gift card snapshot behavior so historical ticket gift applications do not mutate imported current balances.
- Fixed Counterpoint transaction schema alignment and reconciliation visibility for cutover sign-off.
- Fixed Playwright local auto-boot readiness and Back Office navigation/sign-in helper stability for gift card browser smoke.

## [0.4.0] — 2026-05-01
### Added
- Deployment readiness audit for the production topology: Backoffice / Server PC, Register #1 Windows Tauri, Register #2 iPad PWA, and Windows laptop PWA/optional Tauri clients.
- Current deployment status sections documenting release artifact state, CI status, station install paths, and remaining go-live blockers.
- Step-by-step Windows server, Windows register, iPad PWA, and Windows laptop PWA installation checklists in the canonical deployment docs.
- Release documentation for the `v0.4.0` deployment-audit release candidate.

### Changed
- Bumped application/package metadata to `0.4.0` across root, client, server, and Tauri manifests/lockfiles.
- Clarified that `v0.4.0` requires fresh Windows installer/updater assets before station install, because the latest published Windows updater assets remain on the older `v0.2.1` release.
- Updated go/no-go guidance to keep the current Clippy failure and station hardware signoffs visible as release blockers.

### Fixed
- Corrected stale deployment doc links and clarified which guide is canonical for current deployment status.
 
## [0.3.4] — 2026-04-28
### Added
- **Store Events & Holidays Refinement**: 
  - Added **Holiday (Closed)** as a dedicated event kind with distinct visual rendering.
  - Implemented **Numerical Dates** in the print header (e.g., "Mon 27") for better date-of-month clarity.
  - **Unified Event Badges (H/E/M)**: New color-coded badge system for shift boxes:
    - **H (Red)**: Holiday / Store Closed.
    - **E (Green)**: Store Event / Training.
    - **M (Amber)**: Meeting.
- **Professional Print Overhaul**:
  - Full-page landscape utilization with high-density legibility pass.
  - **Large Bold Rendering**: Holidays and Events now use a massive 16px font in the header row for maximum visibility.
  - **Flexible "OFF" Labels**: The printout now respects custom non-working reasons like **"VAC"**, **"REQ OFF"**, and **"REQ"** instead of defaulting to generic "OFF".

### Fixed
- **Cloning Logic 500 Error**: Resolved a critical database schema mismatch that crashed the "Copy from Last Week" function.
- **Event Persistence**: Fixed a server-side loading bug where "Holiday" and "Event" types would reset to "Meeting" upon reload.
- **Print Button Crash**: Resolved a JavaScript error in the print builder caused by a missing date variable.
- **Filtering**: Staff marked as "Template" with zero hours are now correctly excluded from the printed schedule to save space.

### Changed
- **Header Unification**: All store events (not just holidays) now use the 16px bold font size in the professional print header.
- **Visual Grid**: Updated the Planning Grid to use red backgrounds for Holidays and star (★) icons for better at-a-glance recognition.

## [0.3.3] — 2026-04-26
### Changed
- **Standardized Stacking Tiers & Portaling Mandate (v0.3.3+)**: Completed a systemic sweep of the entire UI overlay architecture to resolve "buried" interactive elements.
  - Every Modal, Drawer, Wizard, and system prompt now uses `createPortal` targeting `#drawer-root` in `index.html`.
  - Enforced tiered z-index: **`z-100`** (Drawers/Hubs), **`z-200`** (Modals/Wizards), **`z-300`** (System Priority — Toasts, PWA Prompts).
  - All overlays use the **`.ui-overlay-backdrop`** CSS class for consistent background layering behavior.
  - Added the `Standardized Stacking Tiers & Portaling Mandate` section to `docs/CLIENT_UI_CONVENTIONS.md` and `UI_STANDARDS.md`.

### Fixed
- **Transaction Detail Drawer sub-modals** (Refund, Receipt, Attach to Wedding) no longer render behind their parent drawer.
- **Inventory Control Board** modals (Stock Adjustment, Maintenance/Damaged, Tag Print) portaled and stacked correctly.
- **Cart** inline Edit Order Payment modal portaled correctly.
- **`InventoryControlBoard.tsx`**: Added missing `createPortal` import from `react-dom`.
- **`PwaUpdatePrompt.tsx`**: Resolved a structural parsing error (premature function close) that caused `showInstallPrompt` and `handleInstall` to be inaccessible. Both the Update and Install prompt branches are now correctly structured within the component.
- Extended E2E coverage in `ui-portaling-stacking.spec.ts` for refund modal stacking, receipt modal stacking, and inventory adjustment portaling.

## [0.3.2] — 2026-04-26
### Added
- **Exchange/Return Wizard Redesign**: 
  - Comprehensive UI overhaul with a larger `3xl` width modal and "WowDash" glassmorphism (`backdrop-blur-xl`).
  - Phase-based navigation with guided "Active Instruction" panels and high-fidelity item triage.
- **60-Day Global Return Policy**:
  - Unified policy allowing returns/exchanges up to 60 days from any session.
  - Automatic escalation to **Manager PIN** override for transactions older than 60 days.
- **RBAC Auto-Synchronization**:
  - Profile role updates now automatically sync `staff_permission` sets and `max_discount_percent` while preserving manual overrides.
- **Hardware & Receipts**:
  - **Logo Support**: Added `ReceiptLine` logo support for thermal printers.
  - **Rich Attribution**: Receipts now include Cashier and Salesperson names.
  - **Builder Refinement**: Enhanced Receipt Builder panel with ESC/POS logic hardening and dedicated settings endpoint.
- **POS Intelligence**:
  - **Barcode Scanning**: Support for transaction lookup via receipt barcode scan.
  - **Tender Hardening**: Restricted purchased gift cards to the register and clarified shipping paths.
  - **Event Tracking**: Enhanced register payment tracking and detailed error event logging.
- **Mobile & PWA**:
  - Comprehensive small-screen workspace layout improvements for PWA use.
  - Expanded E2E coverage for small-screen audit and responsive flows.
- **Help Center**: Added controlled authoring for in-app help documentation.

### Changed
- **Unified Transaction Nomenclature**: Finalized the systematic renaming of "Orders" to **"Transactions"** across all financial ledger UI, API endpoints, and permission labels (e.g., `OrderSearchInput` → `TransactionSearchInput`).
- **Commission Architecture**: Reworked commissions into a dedicated reporting ledger for better auditability.
- **QBO Bridge**: Aligned staging logic with the revenue recognition basis.
- **Workspace UI**: Harmonized layouts between Orders and Alterations hubs.
- **Permissions**: Updated the Permission Catalog documentation in the UI to reflect the 60-day Manager PIN requirement.

- **CI Hardening & E2E Stability**:
  - Implemented explicit waits and stable test-IDs in the POS staff identity selection flow to resolve flaky "Target closed" failures.
  - Standardized staff selection helpers across POS and Back Office to use the new `staff-selector-button` and `staff-selector-dropdown` contracts.
  - Finalized the deprecation of **ZPL** receipts; removed stale server-side ZPL generation logic and updated all system defaults and error fallbacks to **ESC/POS**.
  - Pruned obsolete ZPL assertions from E2E coverage to eliminate false-positive CI failures.
- **Tax Integrity**: Hardened tax category controls and server-side checkout validation truth.
- **Meilisearch**: Resolved orders index synchronization and health status reporting bugs.
- **UI Navigation**: Fixed Operations dashboard card navigation and commission drilldown row keys.
- **Hardware**: Fixed alignment and wrapping bugs in ESC/POS receipt lines; tightened Epson hardware handshake.
- **Return Wizard**: Resolved a critical 422 Unprocessable Entity error caused by a schema mismatch on transaction line IDs and fixed walk-in exchange status checks.
- **React**: Fixed "unique key" warnings in the Exchange/Return item lists.
- **Backend**: Fixed compilation errors in `TransactionDetailResponse` and related summaries following the nomenclature refactor.
- **Correctness**: Fixed commission return adjustment drift and cargo fmt/clippy warnings in server.


## [0.3.1] — 2026-04-25
### Added
- **Production hardening audit package** with ranked audit report, fix plan, go/no-go checklist, coverage gap matrix, SQL audit probes, and local restore/probe evidence for Hybrid Tauri Host retail readiness.
- **Release-blocking audit contracts** for checkout tender financial truth, NYS/Erie tax behavior, commission payout timing, inventory truth, offline checkout recovery, register close, and QuickBooks staging/business-date behavior.
- **Release evidence docs** covering the `181 passed, 7 skipped, 0 failed` full local release gate and remaining human/hardware/QBO/restore signoffs.

### Changed
- Removed the POS UI E2E quarantine by adding explicit POS readiness contracts; the formerly quarantined POS specs are back in the release gate.
- QBO proposal and drilldown date windows now use configured store-local business date instead of naive UTC calendar cutoffs, with `business_timezone` carried in staging payloads.
- Updated offline/recovery staff documentation to explain blocked checkout recovery and close blockers.
- Bumped application/package metadata to `0.3.1`.

### Fixed
- Stabilized CI Playwright coverage for RMS receipt assertions and tax/QBO fixture isolation.
- Hardened offline checkout replay so 4xx responses retain blocked recovery rows instead of silently deleting queued sales; register close now blocks while checkout recovery is pending or blocked.
- Hardened register close parked-sale cleanup so server-backed parked sales are purged inside the close transaction with audit rows.
- Hardened checkout tender handling by rejecting check tender without a check number and preserving split-tender/cash-rounding ledger traceability.
- Hardened QBO approval/sync so unbalanced staged journals cannot be approved or synced.
- Hardened restore safety with preflight checks, backup catalog membership checks, strict-production guards, and local non-production restore drill evidence.

## [0.3.0] — 2026-04-25
### Added
- **Operational Perfection release** focused on clearer day-to-day workflows, staff-facing visibility, and safer guided decisions across existing modules.
- **Alterations workbench improvements** with garment-centered queue visibility, open-work summary cards, due/status/source filtering, search, Customer Profile alteration visibility, and universal search/Meilisearch coverage.
- **Customer intake refinements** with a more compact Add Customer drawer, duplicate review safeguards, address lookup feedback, and QuickBooks credential settings.
- **Existing order payment allocation foundation** for safely allocating checkout tender across today’s sale and existing open transaction balances without mutating order line items.
- **Operational dashboard visibility** for alteration workload and data-quality signals.

### Changed
- Unified dark shell styling across Back Office and POS/Register surfaces while keeping cards, panels, inputs, and tables readable.
- Refined Customer Profile tab order and renamed Messages to Communications for a clearer CRM flow.
- Updated Register order payment UI to expose safe existing-order payment lines in the current sale.
- Tightened help/staff documentation for visible workflow changes.

### Fixed
- Replaced the embedded full Alterations Hub in Customer Profile with a compact customer-specific alteration section.
- Fixed GitHub Actions failures from stale Alterations E2E selectors and SQLx macro usage in Meilisearch reindexing.
- Improved Alterations workbench layout so long lists and long garment text stay inside their sections.

## [0.2.1] — 2026-04-18
### Added
- **Printing & Layout Refactor**: 
  - Renamed hardware settings to **Printers & Scanners** to include support for barcode/QR peripherals.
  - Removed the redundant **System Control** sidebar in favor of a unified main-sidebar navigation, enabling **Full Workspace** width for all settings panels.
  - Moved **Receipt Builder** and **Tag Designer** to dedicated sections in the main sidebar for better organizational clarity.
  - **Live Thermal Preview**: Integrated the `receiptline` library into the Receipt Builder to provide a high-fidelity, CLI-style preview for legacy thermal (Standard) modes.
  - **Standard Mode Consolidation**: Integrated previously fragmented thermal settings (Store Identifier, Address/Phone toggles) directly into the Unified Receipt Builder.
- **Unified Hybrid Model**: 
  - Merged the standalone Backend Server (Rust Axum) into the Tauri app shell. 
  - Enabled **"Shop Host Mode"** in Settings, allowing a single desktop instance to manage the database and background workers (QBO, Messaging, Backups) for the entire shop.
  - Implemented **"One-Click Universal Updates"**, ensuring the server engine and register UI update in lockstep via the ROS updater.
- **Tailscale Remote Access Integration**: 
  - Integrated `tailscale` CLI management into the Settings workspace.
  - Added **MagicDNS QR-Code Onboarding**, allowing mobile devices to scan and instantly launch the ROS PWA via the private VPN.
  - Implemented **Tailscale Identity Auditing** (`whois`), allowing the server to identify which remote staff member is accessing the system.
  - Added a persistent **"Remote Node"** visual indicator in the Global Top Bar and Sign-In Gate when accessed via Tailscale.
- **Node.js Polyfill Architecture**: Instrumented the Vite build with `vite-plugin-node-polyfills` and explicit aliases (`util`, `stream`, `buffer`, `process`) to support SDK-level libraries in the Tauri browser environment.
- **ROS Dev Center (v1)**:
  - Added **Settings → ROS Dev Center** with Operations Health, Station Fleet, Alert Center, Guarded Actions, and Bug Manager overlays.
  - Added `/api/ops/*` contracts for health snapshots, integration status, station heartbeats, alert acknowledgement, guarded action auditing, and bug-incident linking.
  - Added permissions **`ops.dev_center.view`** and **`ops.dev_center.actions`** with strict admin-default role templates.
- **Integrated Wedding Management Hub (v0.2.1+)**: 
  - Restored the integrated Wedding Management Hub directly within the POS shell, enabling staff to transition between sales and logistical management without shell switching.
  - Implemented `pendingWmPartyId` state for seamless deep-linking from the Register Dashboard and Global Search.
  - Added a **"Manage Party"** quick-action to the Wedding Lookup Drawer for rapid context switching.
  - Refactored `navigateWedding` to prioritize the active POS mode, preventing unnecessary redirects to the standalone Wedding shell.
- **Reporting and migration hardening**:
  - Added migration **149** for ROS Dev Center telemetry/audit schema.
  - Added migration **150** restoring `reporting.order_lines.line_gross_margin_pre_tax` and keeping migration probes in sync.

### Changed
- **Release-candidate parity documentation**:
  - Documented local RC/runtime prerequisites, deterministic E2E stack ports, root/client install requirements, and local Metabase shared-auth expectations.
  - Added explicit RC signoff and operational signoff artifacts for final release review.

### Fixed
- **Release hardening and validation**:
  - Hardened production-facing config guidance for API base selection, CORS, storefront JWT secrets, and frontend dist expectations.
  - Corrected returns/exchanges checkout null handling and aligned receipt/reporting behavior with return-adjusted quantities.
  - Hardened RMS payment collection receipt/reporting behavior and unified historical Z-close reporting to canonical Register #1 rows.
  - Restored deterministic RC E2E execution, including the exchange flow, tender matrix coverage, and root `npm run pack` packaging workflow.

## [0.2.0] — 2026-04-16
### Added
- **Full-Width Workspace Modernization**: Transformed all primary workspaces (Orders, Customers, Inventory, etc.) into a high-performance, edge-to-edge layout. Deprecated nested scrolling in favor of native root document scrolling for a smoother "Pro" experience on 1080p, 1440p, and iPad 11 Pro screens.
- **Customer Relationship Hub Overhaul**: Modernized the Customer Profile UI with "WowDash" glassmorphism, financial KPIs (Lifetime Sales, Balance Due), and a tabbed interface distinguishing between financial Transactions and logistical Fulfillments.
- **Sticky Navigation Enforcement**: Optimized `GlobalTopBar` and `Sidebar` with persistent sticky positioning to anchor navigation during root scrolling.
- **Workspace Density Pass**: Refactored the Customers Workspace for high-density, full-page presentation.
- **Zero-Error Hygiene**: Achieved a 100% clean TypeScript and linting state for the modernization baseline.

### Fixed
- **Checkout Shadowing Vulnerability**: Resolved a critical 500 Internal Server Error in `transaction_checkout.rs` caused by variable shadowing of `transaction_id`. Renamed inner payment records to `payment_tx_id` to ensure correct `payment_allocations` referencing.
- **Case-Insensitive Tax Compliance**: Hardened `client/src/lib/tax.ts` and server-side logic to treat tax categories (e.g., "Clothing") as case-insensitive, ensuring consistent $110 NYS tax exemptions.
- **Light Mode Visual Performance**: Resolved visibility and contrast regressions in POS slideouts ("Finalize Pricing", "Confirm Item") by replacing hardcoded white text with themed semantic tokens (`text-app-text`).
- **Product Hub Layout**: Fixed a z-index surfacing issue in the inventory intelligence panel that obstructed navigation in specific viewports.

### Changed
- **Repository Capacity Optimization**: Reclaimed ~38 GB of disk space by purging redundant Rust target artifacts and cleaning legacy log files.
- **Documentation Alignment**: Synchronized `AGENTS.md`, `TRANSACTIONS_AND_WEDDING_ORDERS.md`, and `AI_REPORTING_DATA_CATALOG.md` with the latest financial integrity invariants and architectural renames.

### [0.2.0] — 2026-04-13 [In Progress]
### Added
- **Professional Reporting Architecture**: High-fidelity Letter/A4 audit documents (Z-Reports, Daily Sales) with decoupled hardware routing (System Print station).
- **Privacy Standard (Receipt Naming)**: Masked "First Name + Last Initial" format on all customer receipts.
- **Persistent Top Bar Architecture**: Introduced a universal, touch-friendly navigation anchor across all shells. Features persistent staff identity, universal breadcrumbs, centered search lookup, and a centralized "System Actions" group (Help, Bug Reports, Notifications, Theme).
- **Transaction-Centric Backend Refactor**: 
  - Systematic renaming of "Orders" to **"Transactions"** throughout the backend logic, API, and database models.
  - Standardized on `transaction_id` and `transaction_lines` to decouple financial ledger entries from logistical fulfillment objects.
  - Refactored core modules: `order_checkout` -> `transaction_checkout`, `order_list` -> `transaction_list`, etc.
  - Migration 142 formally established the `transactions` table and the new helper `fulfillment_orders` logistical registry.
- **Migration Invariant**: Mandatory `DROP VIEW IF EXISTS` for view-altering migrations.
- **Reporting Stabilization (Migration 143)**: Established the `reporting.transactions_core` and `reporting.fulfillment_orders_core` views as the new stable baseline for auditable financial and logistical reporting.
- **Avatar Path Resolution**: Robust multi-path resolution for staff portraits.
- **Audit Recovery**: New manual and emergency PIN reset scripts.
- **Layaway Manager (v2)**: 
  - Restored and hardened the **Layaway Manager** in POS with robust URL construction.
  - Integrated a centralized **Layaway Manager** workspace into the Back Office **Customers** section.
  - Resolved backend SQL decoding errors in order list.
- **Financial Accuracy (QBO Deposits)**: 
  - Automatically captures **New Deposit Inflows** (Credit Liability) for payments.
  - Ensured balanced journal cycle for all deposit lifecycle states.
- **Staff Lifecycle Management**: Implemented an "Add Staff" action in the Back Office roster, complete with an auditable creation API (`POST /api/staff/admin`) and automatic role-default application.
- **Optimized Administration UI**: Refactored the Staff Edit slideout using a search-first, high-density layout with robust sticky navigation and resolved visual regressions in the CRM search dropdown.

### Fixed
- **Schema Stabilizer**: Repaired table references in migration 135.
- **Authentication UX**: Restored **Full Names** for internal identification screens.
- **Build & Linting**: Fixed float ambiguities and reporting TypeScript types.
### Added
- **Unified PIN Authentication & UX (Auditable Authorization)**: 
  - Systematic terminology migration from legacy "Cashier Code" to **"PIN"** across the entire UI and backend.
  - **Persistent Identity Selection**: Integrated user roster dropdowns into all primary authentication gates (Back Office and POS). Selection is preserved via `localStorage`.
  - **Global Hardware Support**: Unified `NumericPinKeypad` with global keyboard listeners (0-9, Backspace, Enter) for rapid entry.
  - **Role-Based POS Authorization Bypass**: Implemented a dynamic permission-based skip for sensitive POS actions. Users with the `admin` role now automatically bypass manual PIN verification for **Order Attribution**, **Void All**, and **Large Price Overrides**.
  - **Auditable Manager Approvals**: Deployed the **Manager Approval Modal** for non-administrative staff. This allows any manager to authorize a high-risk action without changing the active cashier's session.
  - **System-Wide Authorization Logging**: Enhanced the `/api/auth/verify-pin` endpoint to record `authorize_action` and `authorize_metadata` in the `staff_access_log`.
- **Modularized POS Architecture**: Successfully transitioned the monolithic POS Cart to a high-performance modular hook system (`useCartActions`, `useCartCheckout`, `usePosSearch`).
- **RESTORED: Order Recall & Direct Pickup**: Fully restored the POS "Orders" recall functionality.
- **RESTORED: Parked Sale Snapshotting**: Re-enabled the ability to "Park" active sales to the server. Added a new **"Park Sale"** button to the main Register tool row, complete with server-backed snapshots and auditable recall.
- **RESTORED: Order Metadata Management**: Integrated the "Order Review" workflow into the checkout process.
- **Enhanced Cart Visualization**: Added real-time indicators to the Cart line items for **Rush** (Zap) and **Due Date** (Clock).
- **RESTORED: Intelligence & Decision Support Layer**: Finalized the integration of production-grade decision engines (Wedding Health, Inventory Brain v2, Truth Trace).
- **Simplified Register Standard**: Reduced complexity by limiting physical terminal lanes to exactly 3:
  - **Register #1 (Main)**: Controls the primary cash drawer and reconciliation.
  - **Register #2 (iPad)**: Reserved for mobile satellite sales.
  - **Register #3 (Back Office)**: Reserved for administrative activities and Headquarter sales.
- **Automatic Session Expansion**: Opening Register #1 now automatically initializes zero-float satellite sessions for Register #2 and #3, eliminating the need to manually open satellite lanes.
- **Admin Lane Default**: The Back Office POS entry now correctly defaults to Register #3 when the main drawer is active.
- **X-Report Deprecation**: Finalized the removal of legacy mid-shift snapshots in favor of real-time dashboards and unified Z-reconciliation.
- **Documentation Overhaul**: Synchronized all staff manuals and engineering guides with the new 3-register model.

### Changed
- **UI Normalization Sweep**: Reverted "Cinematic GUI" experimental styles (extreme rounding and 8px borders) to the production-grade design baseline (28px rounding, 2px borders).
- **Documentation Overhaul**: Synchronized all project documentation (`README.md`, `DEVELOPER.md`, `AGENTS.md`) and staff manuals with the current state of the application.
- **Modularized Cart State**: Centralized POS state management in the `useCartActions` hook.

### Fixed
- **Structural Build Errors**: Resolved 100+ blocking TypeScript errors introduced during the v0.2.0 transition.
- **Operations & Dashboard Stabilization**: 
  - **`RegisterDashboard.tsx`**: Removed orphaned `xReport` state and fetcher logic. Optimized `lucide-react` imports and removed unused props (`lifecycleStatus`, `onGoToTasks`). Fixed unsafe `any` type in Morning Compass queue mapping to properly handle `rush_order` and `task` kinds.
  - **`OperationalHome.tsx`**: Cleaned up unused Lucide icons (`Clock`, `ListChecks`, `Sparkles`) and removed the abandoned `pulseRows` variable to eliminate linting warnings.
  - **`WeddingHealthHeatmap.tsx`**: Hardened the component with explicit interfaces (`WmParty`, `PartyWithHealth`) and resolved "module not found" errors by updating `api.d.ts` and adding `Icon.d.ts`. Removed unused `catch` variables.

### Removed
- **Redundant Auth Gates**: Eliminated legacy PIN unlock overlays in `StaffWorkspace.tsx` that were redundant with the top-level Back Office gate.

## [0.1.9] — 2026-04-11
### Added
- **Helcim Power Integration**: Finalized the "Zero-Touch" PCI-compliant card vaulting flow and unlinked terminal credits. Staff can now save customer cards in the Relationship Hub for phone orders and issue credits directly back to cards when cart balances are negative.
- **Wedding Party Order Integration**: Implemented "Attach to Wedding" functionality in `OrdersWorkspace` to allow manual linking of legacy Counterpoint tickets to wedding party members.
- **Zero-Error Baseline Stabilization**: Achieved a 100% clean TypeScript build by resolving lingering type errors in `App.tsx`, `LoyaltyWorkspace.tsx`, and `CommissionManagerWorkspace.tsx`.
- **Relationship Hub Gating**: Ensured all Customer Hub tabs (Orders, Profile, Measurements, Payments) correctly respect RBAC permissions.
- **Help Center Manager E2E Expansion**: Added Playwright coverage for Settings navigation into Help Center Manager, tab visibility checks (Library, Editor, Automation, Search & Index, ROSIE readiness), and request-shape assertions for `generate-manifest` and `reindex-search` admin operations.
- **Help Admin API Gate Coverage**: Expanded `api-gates.spec.ts` with anonymous (`401`), non-Admin (`403`), and Admin success-shape checks for `/api/help/admin/ops/status`, `/api/help/admin/ops/generate-manifest`, and `/api/help/admin/ops/reindex-search`.
- **High-Risk Regression API Suite**: Added `high-risk-regressions.spec.ts` to cover migration-smoke route mounting, NYS tax audit shape/auth checks, revenue basis alias stability (`booked`/`sale`/`completed`/`pickup`), Help Manager RBAC + payload stability, session route auth behavior, and non-admin boundary enforcement on sensitive insights/help admin endpoints.
- **Phase 2 E2E Rollout (Finance + Help Lifecycle)**: Added `phase2-finance-and-help-lifecycle.spec.ts` with end-to-end admin policy lifecycle assertions for Help manuals (update + verify persistence + delete/revert), plus finance-sensitive endpoint contract checks for NYS tax audit payload stability, sales-pivot basis invariants, payments/session auth gates, and non-admin boundaries.
- **Deterministic Tender Matrix Contract Suite**: Added `tender-matrix-contract.spec.ts` to validate payment-intent and cancel endpoint behavior across tender modes (manual card/MOTO, reader card, saved-card invalid PM guardrails, credit-negative rejection, and session-safe non-card path checks) with deterministic API-level assertions.
- **E2E Stability Hardening**: Improved test resilience for Settings/Reports navigation timing by reducing dependence on brittle response timing and strengthening UI-ready assertions in the Podium and Reports workspace specs.

### Changed
- **UI Spacing Refinement**: Adjusted spacing and density across Back Office workspaces for better consistency with the high-density CRM overhaul.
- **Project Structure**: Formally updated all project modules to v0.1.9.
- **Test-Run Hygiene Documentation**: Clarified E2E run expectations around service availability (UI + API) to avoid false-negative `ERR_CONNECTION_REFUSED` failures when the frontend host is not running.
- **Visual Suite Policy**: Standardized visual baseline tests as opt-in (`E2E_RUN_VISUAL=1`) and non-blocking by default to avoid release failures caused by cross-machine font/render snapshot drift.
- **Visual Determinism Defaults**: Hardened Playwright runtime defaults for visual consistency by setting deterministic context controls (animations disabled, UTC timezone, en-US locale) and richer failure artifacts in visual mode.
- **E2E Coverage Depth**: Expanded release-focused Playwright inventory to include additional Phase 2 finance/help lifecycle regression checks for stronger release confidence on tax, reporting basis, admin policy persistence, RBAC boundaries, and tender contract safety.
- **CI Stabilization Hotfix (post-0.1.9 cut)**: Corrected server-side SQLx query typing for Meilisearch order sync, refreshed SQLx prepared query metadata under `server/.sqlx`, and resolved strict Clippy blockers that were preventing `Lint Checks` and `Playwright E2E` from progressing past server build.

## [0.1.8] — 2026-04-11
### Added
- **Morning Compass Evolution**: Formalized `RushOrderRow` and `needsOrder` tracking in the dashboard queue.
- **Custom Work Manual**: New in-app help for tailored services and rush fulfillment workflows.
- **Backup Resiliency Manual**: Documented "Universal Docker Fallback" for database operations.
- **Production-Ready Indexing**: Automatically generated help manifest to sync new manuals with the UI.

- **CRM High-Density Overhaul**: Transformed the Customer list into a visually stunning, name-dominant interface with combined financial/wedding data and tighter spacing.
- **Commission Manager Workspace**: Unified tracking for payouts, promo overrides, and combo rewards in a high-density Back Office hub.
- **SPIFF Incentive Engine**: Implemented specificity-based commission overrides (Variant > Product > Category) and a combo matching engine with strict single-salesperson attribution.
- **Receipt Privacy & Internal Filtering**: Standardized staff names on receipts as "First Name + Last Initial" and automated the filtering of internal SPIFF/Combo lines from customer-facing output.
- **CI/CD Resilience Hardening**: Implemented 30s Playwright buffers and codified 'GitHub CI Resilience' rules in `AGENTS.md` to ensure zero-failure deployments.
- **Navigation Sync**: Synchronized 'daily-sales' ID between Operations and Sidebar to maintain flawless navigation.


## [v0.1.8-alpha] - 2026-04-10 (Baseline)
### Added
- **Lightspeed Asset Recovery**: Integrated the Universal Importer with specific support for Lightspeed CSV headers, enabling bulk restoration of stock levels and asset valuation ($321k+ recovery case).
- **Live Indexing Visibility**: Refactored Meilisearch monitoring to show real-time "Indexing..." pulses and row count polling, eliminating "black box" behavior during mass data ingestion (114k+ records).
- **Counterpoint Staff Sync**: Formally enabled `SYNC_STAFF` with optimized queries for Users (`SY_USR`), Sales Reps (`PS_SLS_REP`), and Buyers (`PO_BUYER`). Implemented server-side consolidation to merge duplicate identities across tables.
- **Inventory Visibility**: Verified 114,000+ variants are fully indexed in Meilisearch.
- **System Stability**: Decoupled Bridge from main dev process to prevent network-related API crashes.
- **Bridge Operation Modes**: Implemented "Manual Mode" (default) for the Counterpoint Bridge. Continuous 15-minute polling is now disabled on startup and must be explicitly toggled ON via the Bridge Commander dashboard.
- **On-Demand Pulls**: Refined the Bridge Command UI to support targeted entity pulls (e.g., just Customers or just Inventory) while maintaining dependency order.
- **Custom Work Order Flow**: Implemented "MTM Light" SKU detection (`CUSTOM` prefix) and configuration modal for SUITS, SHIRTS, and more with variable pricing.
- **Rush Order & Urgency**: Added backend persistence and dashboard visibility for urgent orders with mandatory "Need By" dates.
- **Bridge (Tickets)**: Recovered **98,511 pending tickets** by implementing an item fallback mechanism. Sales history will now sync even if a legacy SKU is missing, ensuring accurate "Lifetime Spend" for all customers.
- **Catalog Architecture**: Fixed SKU hierarchy to match Counterpoint standards: `ITEM_NO` (I-XXXX) is the Parent/Handle, and `BARCODE` (B-XXXX) is the variant SKU. This resolves the synchronization blockages for historical sales.
- **Customer Identity**: Enhanced ticket linking to handle mixed ID formats (`114420` vs `C-114420`). Gary Garcia and others will now correctly see their historical spend attached to their primary loyalty profiles.
- **Meilisearch**: Fixed sync status reporting bug; totals now reflect the millions of records processed instead of only the last batch size.
- **Loyalty History**: Activated point-by-point history tracking for Counterpoint migrations.
- **Sales History Verification**: Confirmed historical ticket ingestion from `PS_TKT_HIST` is mapping correctly to `orders` and attributing spend to customer lifetime statistics (verified with customer Gary Bichler @ $1,695.34).

### Fixed
- **Meilisearch Sync Visibility**: Fixed a critical reporting bug where the server only recorded the size of the final processing batch for row counts. All indices (Customers, Products, Orders, etc.) now correctly report their total record volume instead of partial batch snapshots (e.g., 17,170 rows vs 170).
- **Counterpoint Identity Mapping**: Patched `counterpoint-bridge` to correctly map `ITEM_NO` to `product_identity`. This resolves a critical bug that caused 7,000+ duplicate "ghost" products to be created during synchronization.
- **Data Integrity Safety**: Implemented `catalog_handle` as the primary deduplication key for inventory recovery workflows.
- **System Tooling PATH**: Resolved "command not found" errors for `psql` and `docker` by correctly configuring `~/.zshenv` to include Homebrew and OrbStack paths for non-interactive shells.
- **Bridge Startup Regression**: Patched a critical syntax error in `counterpoint-bridge/index.mjs` (missing `tick` function declaration) that blocked system launch.
- **Gift Card History Sync**: Resolved a SQL error in `CP_GFT_CERT_HIST_QUERY` by replacing the invalid `RS_UTC_DT` column with the standard `DAT` column.
- **Launch Checklist Audit**: Updated `ThingsBeforeLaunch.md` with operational requirements for Custom/MTM flows, Rush Orders, and confirmed existing Gift Receipt functionality.
- **Bridge ↔ Metabase Port Conflict**: Resolved a critical port collision where both Metabase (Docker) and the Bridge Engine defaults conflicted on port 3001. Moved Bridge Command Center to port **3002**.
- **Bridge Commander CORS/Security**: Reconfigured the dashboard to open via HTTP (`http://localhost:3002`) instead of `file://` to resolve browser-enforced security blocks on synchronization requests.
- **Process Hygiene**: Implemented automatic cleanup of hanging server/Vite processes in the startup script to prevent `PoolTimedOut` and `EADDRINUSE` errors.

## [0.1.7] - 2026-04-10

### Fixed
- **Bridge Dashboard Stabilization**: Moved the Bridge Commander dashboard to port **3002** (eliminating port collisions with Metabase on 3001) and refactored manual sync triggers to use valid JSON payloads.
- **Schema Mapping Integrity**: Corrected SQL mapping in the Bridge for Counterpoint v8.2 (`UNIT_COST` and `CURR_AMT` parity).

## [0.1.6] - 2026-04-10

### Added
- **Unified Startup Script**: Created root-level **`START_ON_MAC.sh`** to orchestrate Docker context switching, container checks, and simultaneous launch of API, UI, and Counterpoint Bridge.
- **Bridge Integrated Into Dev Loop**: Added `dev:bridge` script to root `package.json`, allowing the sync engine to run concurrently with the API and UI in a single terminal session.

### Fixed
- **Bridge ↔ Metabase Port Conflict**: Resolved a critical port collision where both Metabase (Docker) and the Bridge Engine defaults conflicted on port 3001. Moved Bridge Command Center to port **3002**.
- **Bridge Commander CORS/Security**: Reconfigured the dashboard to open via HTTP (`http://localhost:3002`) instead of `file://` to resolve browser-enforced security blocks on synchronization requests.
- **Process Hygiene**: Implemented automatic cleanup of hanging server/Vite processes in the startup script to prevent `PoolTimedOut` and `EADDRINUSE` errors.

## [0.1.5] - 2026-04-10

### Added
- **Infrastructure Optimization (OrbStack Transition)**: Successfully migrated the local development environment from Docker Desktop to **OrbStack**, leveraging VirtioFS and native Apple Silicon optimizations for significantly faster container I/O and SQL performance.
- **OrbStack Management Guide**: Created `docs/ORBSTACK_GUIDE.md` detailing the "acid test" for engine identity, context switching, and socket linking protocols.
- **Docker Fresh Install**: Performed a clean build of all core services (`db`, `meilisearch`, `metabase`) on the new engine and successfully re-initialized the database schema with all 117 migrations.

### Changed
- **Documentation Alignment**: Updated all primary documentation (`README.md`, `DEVELOPER.md`, `AGENTS.md`) to reflect the move to OrbStack as the recommended Docker engine for macOS.

## [0.1.4] - 2026-04-10

### Added
- **Repository Hygiene & Capacity**: Reclaimed ~23 GB of disk space by purging redundant Rust build artifacts (`server/target`, `client/src-tauri/target`), removing unused local AI models (Gemma 2B), and cleaning legacy documentation blobs.

### Fixed
- **Settings Workspace Stabilization**: Resolved a `ReferenceError: tabs is not defined` that crashed the System Control panel. Refactored the sidebar to use a nested `groups` structure with section headers ("User", "Integrations", etc.) for improved UX organization.
- **API Endpoint Normalization**: Synchronized frontend `fetch` calls with server-side routes for **Podium** (`/api/settings/podium-sms`) and **Weather** modules.
- **REST Method Compliance**: Standardized all settings save operations to use `PATCH` instead of `PUT`, aligning with server-side Axum route definitions and technical debt reduction goals.
- **UI Interaction**: Restored vertical scrolling to the System Control sidebar via `overflow-y-auto` and the `no-scrollbar` utility.
- **Import Regression**: Repaired broken `backofficeHeaders` imports in `WeatherSettingsPanel.tsx` and `PodiumSettingsPanel.tsx` caused by an incorrect transition from library-based headers to hook-based authentication.

## [0.1.3] - 2026-04-10

### Fixed
- **Settings Workspace Stabilization**: Repaired structural JSX corruption in `SettingsWorkspace.tsx` and updated the modular `InsightsSettingsPanel` integration to restore a stable administrator UI.
- **Meilisearch Sync Performance**: Resolved Rust compilation errors in `meilisearch_sync.rs` related to Task indexing types.
- **Counterpoint Discovery Pipeline**: Patched the Counterpoint bridge validator logic by ensuring `CP_CUSTOMERS_QUERY` includes the mandatory `WHERE` and `ORDER BY` clauses required for store credit schema discovery.
- **Database Schema Health**: Applied Migration 115 to formalize `meilisearch_sync_status` tracking, resolving transient 500 errors in the Integrations dashboard.

## [0.1.2] - 2026-04-09

### Added
- **Search-First Administrative Mandate**: Systematically replaced manual UUID and SKU entry fields with fuzzy-search-powered components (`CustomerSearchInput`, `VariantSearchInput`) across Tasks, Appointments, Gift Cards, and Loyalty modules.
- **Meilisearch Sync Health Dashboard**: New visual interface in Settings → Integrations providing real-time visibility into index health, row counts, and synchronization success/failure for all tracked categories.
- **Physical Inventory Fallback**: Added a manual search and add capability to the inventory counting phase, allowing staff to lookup products without a physical barcode.
- **Joint Couple Accounts**: Implemented customer partner linking (existing or new) with automatic financial redirection to the primary account. Joint profiles feature combined lifetime spend, loyalty, and Transaction Record history while maintaining individual measurement privacy.

### Fixed
- Stabilized GitHub Actions CI by injecting Tauri Linux dependencies (`libwebkit2gtk-4.1-dev`, etc.) into the `ubuntu-latest` lint runner.
- Resolved "Zero-Warning Baseline" ESLint warnings by extracting shared logic out of React Context (`BackofficeAuthContext`, `ToastProvider`) and Components (`CustomerMeasurementVaultForm`, `LoyaltyRedeemDialog`) into `*Logic.ts` files to comply with Fast Refresh guidelines.
- Fixed 401 Unauthorized browser console spam in `Cart.tsx` when the POS eagerly fetched metadata before a valid register session or staff PIN was provided.
- **Backend Stabilization**: Resolved critical Type Mismatches in Rust server logic and fixed schema typos in migration 116.
- **Migration Ledger Reconciliation**: Manually synchronized the database migration ledger to resolve 500 errors caused by partially applied schemas.
- **Client Syntax & Import Fixes**: Resolved a syntax error in `InventoryControlBoard` and a broken import path for `VariantSearchInput` in `PhysicalInventoryWorkspace`.

## [0.1.0] - 2026-04-09

### Added
- Initial baseline versioning for the entire repository.
- Synchronized versions across `client`, `server`, and `tauri` at `0.1.0`.
- Integrated Counterpoint bridge for customer and catalog synchronization.
- Layaway operations and reporting module.
- Multi-lane register support and Z-close groupings.
- Notification center for staff alerts and daily digests.
- Staff task management and floor schedule system.
- Bug report flow with Sentry integration.
- Hardware bridge for legacy printer support via Tauri.
- Meilisearch integration for fuzzy product and help search.
