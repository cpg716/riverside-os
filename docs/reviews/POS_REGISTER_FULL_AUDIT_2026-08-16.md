# ROS Register full experience and performance audit — 2026-08-16

## Executive result

The Register is operationally deep, financially defensive, and already stronger than a generic retail checkout for formalwear work. The audit did not identify a broken financial, inventory, permission, or checkout-authority invariant. It did identify five concrete staff-experience problems that could be corrected without changing those contracts:

1. verified product barcode aliases could resolve successfully but stop at the search result instead of adding to the cart;
2. the camera scanner could retain a camera stream when closed during startup or unmounted;
3. normal pointer movement rebuilt the ten-minute idle timer on every event;
4. five Cart-owned dialogs did not consistently trap focus, close with Escape, or restore focus; and
5. below the desktop breakpoint, the customer, totals, keypad, and **Pay** controls were outside the usable Register view.

All five are corrected in this audit. The compact Register now uses an explicit **Customer & Pay** view below 1024 px and preserves the simultaneous cart/payment layout at 1024 px and above. Exact server-verified SKU, product-barcode, and active-alias scans add immediately; ambiguous or name-only results still require staff selection.

This is source, automated-test, and isolated local-browser evidence. It is not Main Hub, payment-provider, scanner-wedge, camera-permission, receipt-printer, cash-drawer, or outage/reconnect certification.

## Audit method and boundaries

- Traced the POS shell, Register session, Cart, search/scanner, checkout, completion, closeout, report, recovery, permissions, and Help contracts through the existing code and focused documentation.
- Inventoried the POS navigation and the Register's direct components, menus, prompts, modals, drawers, wizards, and completion surfaces.
- Reviewed existing Playwright coverage for navigation, small screens, modal containment, dropdowns, checkout, tenders, receipt recovery, closeout, pickup, returns/exchanges, alterations, weddings, and offline recovery.
- Exercised the Register in an isolated E2E runtime at 390 × 844, 768 × 1024, 1024 × 1366, and 1440 × 900. No live provider or store hardware was used.
- Favored focused, measurable changes. No payment math, inventory movement, tax, authorization, database, or provider behavior was broadened.

## Complete surface inventory and assessment

### Shell, identity, and navigation

| Surface | Features reviewed | Assessment |
| --- | --- | --- |
| Unified entry | Staff sign-in, POS entry, register selection, initial float, session restore | Clear separation between authenticated staff and the active Register session. Preserve. |
| Sale identity | Staff identity, sale cashier, salesperson default and line attribution, Switch flow | Explicit and audit-friendly. The visible staff/salesperson distinction is valuable. |
| Idle and lock | Ten-minute active-Register lock, five-minute PIN-overlay return, activity listeners | Correct behavior retained; pointer activity is now throttled so normal mouse movement does not continuously rebuild timers. |
| Top bar | Back, search, handoff/close, ROSIE, Help, issue reporting, theme, notifications, profile | Strong universal tools. Compact labels at phone width remain understandable with accessible names. |
| POS navigation | Dashboard, Register, Customers, Weddings, Alterations, Orders, Tasks, Customer Notifications, Podium Inbox, Mailbox, RMS Charge, Inventory, Payments, Reports, Gift Cards, Loyalty, Layaways, Shipping, Settings | Broad but coherent. Permission and POS-settings restrictions remain authoritative. |
| Subsections | Customers: All, Add, Duplicate Review. Settings: Staff Profile, Printers & Scanners | Appropriate POS-only scope. Administrative settings remain hidden. |

### Register primary workspace

| Surface | Features reviewed | Assessment |
| --- | --- | --- |
| Register header | Parked-sale count, Staff, Switch, salesperson, store clock, transaction date/time | Dense but task-relevant. It retains visible attribution and backdating context. |
| Product entry | Partial product/style/SKU search, Enter behavior, keyboard focus shortcut, scanner wedge, camera | Server-authoritative scan resolution now drives immediate addition. Name-only and ambiguous matches remain reviewable. |
| Cart actions | Customer Orders, Wedding Manager, Return / Exchange, Start Alteration, More Actions, Clear Sale | Six primary actions remain visible without clipping at reviewed widths. |
| More Actions | Suit Swap, Start Custom Order, Load Gift Card, Pay RMS Account, Pay Staff Account, Layaway, Order options, Park Sale | Good progressive disclosure for lower-frequency workflows. The dialog now has focus containment, Escape, and focus restoration. |
| Cart lines | Variation, quantity, price, fulfillment, salesperson, tax category, gift wrap, alterations, removal, shipping, existing Transaction payments, wedding deposits | Comprehensive formalwear behavior. The compact call-to-action no longer obscures the final line because the cart reserves bottom space below 1024 px. |
| Customer rail | Search by name/phone/email/code, add customer, walk-in, profile, balances/open work, quick actions | Essential checkout context. It is now reachable at every reviewed viewport through the compact two-view workflow. |
| Totals and keypad | Retail state, discounts, tax, shipping, deposit/payment lines, quantity/price keypad, Apply, Pay | Desktop remains persistent. Compact widths receive the full rail with a clear **Back to cart** action and current total. |
| Parked work | Server-backed parked-sale list, customer warning, resume/delete, count refresh | Strong recovery model. The Cart-owned parked-sale and customer prompts now follow the shared dialog keyboard contract. |

### Product and selling workflows

| Surface | Features reviewed | Assessment |
| --- | --- | --- |
| Search resolution | Product-name search, parent/variant results, exact SKU, vendor SKU, product barcode, active alias, variation choice | Fixed: direct verified resolutions are ordered before fuzzy results and can add immediately. Fuzzy/name-only results never silently add. |
| Camera scan | Start, permission/start failure, retry, successful result, duplicate debounce, close/unmount | Fixed: stop/clear now runs for retry, close, unmount, and start/close races; keyboard dialog behavior added. Live camera permission still needs device certification. |
| Product intelligence | Product details and line-product navigation | Useful without placing edit authority into search results. Preserve existing domain paths. |
| Variations | Required option selection, incomplete-selection guidance, pricing review, add selected SKU | Strong exact-build gate. Do not replace with a convenience fallback. |
| Custom items/orders | subtype, vendor/form measurements, price/cost, notes, booking details | Domain rich. The long workflow warrants focused keyboard/a11y standardization before further feature growth. |
| Alterations | quick/full intake, linked source line, charge, due date, notes, edit, pickup completion | Well integrated with the cart and customer rather than operating as a disconnected tool. |
| Shipping | address/shipping charge and fulfillment context | Properly distinct from merchandise and transaction math. |

### Customer, order, and formalwear workflows

| Surface | Features reviewed | Assessment |
| --- | --- | --- |
| Customer selection | lookup, add, profile, open work, customer-required prompts | Strong operational context; avoids raw identifiers. |
| Customer Orders | lookup, items, pickup selection, payment toward an existing Transaction, cancellation/refund staging | Financial Transaction and logistical Fulfillment Order concepts remain distinct. |
| Weddings | party/member lookup, Collect & Build review, member drafts, deposits, salesperson confirmation | A major ROS advantage. Payment does not post until the normal approved checkout path completes. |
| Suit Swap | guided variation replacement | Appropriate guided workflow; preserve exact variation and inventory rules. |
| Layaway | creation, payment, balance, pickup/resume | Integrated into the authoritative payment and inventory paths. |
| Return / Exchange | original Transaction lookup, line choice, 60-day rule, Manager Access, refund/exchange phases | Strong policy enforcement and auditability. Complex keyboard/focus behavior remains a priority follow-up. |
| Pickup | availability/received guards, Manager Access with justification, fulfillment completion | Fail-closed design is correct for stock and revenue recognition. |
| RMS/staff accounts | customer/account selection, payment amount, balance context | Correctly exposed as explicit actions and payment lines, not ad-hoc discounts. |

### Checkout, tender, and completion

| Surface | Features reviewed | Assessment |
| --- | --- | --- |
| Checkout entry | customer/walk-in decision, sale preflight, session pre-check, exact checkout identity | Defensive against expired sessions and duplicate submission. |
| Tenders | cash, check, gift card, store credit, RMS/staff account, manual/terminal card, split payment, deposits/payment in full | Broad and governed. No tender-authority rule was relaxed. |
| Cash | amount, full balance, change, separate cash-rounding offset | Accounting boundary is correct and must remain server-authoritative. |
| Helcim/card | attempt evidence, stream/poll recovery, approved-payment reconciliation, manual handoff | Resilient source design. Live approve/decline/cancel/stale-terminal drills remain mandatory. |
| Completion | posted Transaction result, receipt summary, print/email, gift receipt, preview, change due, required next action | Comprehensive. Complex completion/nested dialogs need a dedicated keyboard pass rather than scattered local fixes. |
| Print recovery | queued failed jobs, retry, dismissal, staff feedback | Strong recovery behavior. The Cart-owned failed-print dialog now follows shared focus/Escape behavior. |

### Session close, reporting, hardware, and resilience

| Surface | Features reviewed | Assessment |
| --- | --- | --- |
| Register Dashboard | session state, lane context, starting/ending work | Clear operational entry point. |
| Shift handoff | cashier transition and session continuity | Appropriate explicit handoff rather than implicit identity replacement. |
| Cash adjustments | paid-in/paid-out context and audit entry | Correctly separate from merchandise sales. |
| Close Register | counts, tenders, discrepancies, unresolved issues, Manager Access, linked-lane close | Deliberately defensive; do not compress away discrepancy review. |
| Reports | daily/register activity, tender totals, Z output, print behavior | Financial truth and reconciliation take precedence over visual simplification. |
| Printers & scanners | lane configuration, receipt/tag paths, camera/wedge entry | Configuration is constrained appropriately in POS. Hardware acceptance remains external. |
| Offline/recovery | persisted draft, blocked-item recovery, narrow deferred tender eligibility, reconnect replay, receipt evidence | Conservative fail-closed model is correct. Live outage and reconnect drills remain required. |

## Changes completed in this audit

### 1. Verified scans now behave like scans

The scan endpoint already labels its authoritative match as `sku`, `barcode`, `barcode_alias`, `catalog_handle`, or `product_name`. The client now carries that result kind through search and treats every authoritative non-name resolution as a verified scan. Exact SKU, product barcode, and active-alias input therefore adds the resolved variation immediately. A product-name match stays visible for staff review.

Concurrent fuzzy and direct results are also ordered so the verified direct result cannot be hidden by an earlier fuzzy duplicate.

### 2. Camera resources and keyboard behavior are deterministic

Camera start, retry, close, unmount, and the start-then-close race now converge on a single release path. Pending debounce work is cleared, active scanning is stopped, and the scanner is cleared. The camera surface is now a labelled modal with focus containment, Escape close, and focus restoration.

### 3. Idle tracking is lighter without weakening the lock

The ten-minute security timeout still resets on meaningful keyboard, pointer, touch, and scroll activity. High-frequency `mousemove` replacement uses `pointermove` and limits timeout reconstruction to once per second.

### 4. Cart-owned dialogs use the shared accessibility contract

The More Actions menu, existing-Transaction payment editor, parked-sales list, parked-customer prompt, and failed-print retry surface now:

- expose dialog semantics and a stable accessible title;
- contain Tab/Shift+Tab focus;
- close with Escape when safe; and
- restore focus to the staff control that opened them.

### 5. Compact Register checkout is usable

At widths below 1024 px, staff now work in two explicit views:

1. **Cart** — identity, date, product entry, action grid, and sale lines; and
2. **Customer & Pay** — customer selection, sale summary, keypad, and Pay.

The current total stays on the view-switch button. **Back to cart** returns to selling. At 1024 px and above, the existing side-by-side layout is unchanged.

## Remaining findings and prioritized roadmap

### P1 — complete the complex-dialog keyboard pass

Several large workflow surfaces expose dialog semantics but do not yet uniformly use the shared focus trap, Escape policy, and focus restoration: Custom Order, Customer Orders, alteration intake, Exchange/Return, Suit Swap, receipt completion/preview, and Wedding deposits. These should be handled one workflow at a time with nested-dialog and in-flight-mutation tests. A bulk markup-only change would risk closing a financial workflow at the wrong layer.

Acceptance criteria:

- initial focus is deliberate;
- Tab and Shift+Tab cannot leave the active dialog;
- Escape closes only the top safe layer and is disabled during irreversible/in-flight work;
- nested confirmation, preview, and Manager Access surfaces retain their own focus; and
- focus returns to the correct originating action.

### P1 — certify the changed paths on store equipment

Run the normal workstation acceptance drill for physical scanner aliases, camera permission/start/close/retry, receipt and tag printers, drawer kick, cash counts, Helcim approve/decline/cancel/stale recovery, network loss/reconnect, and duplicate-submit prevention. Source correctness is not hardware certification.

### P2 — measure and defer-load the remaining low-frequency shell sections

The shell already lazy-loads many substantial workspaces. Register Reports, Tasks, Layaways, Podium Inbox, Mailbox, and Customer Notifications are still eager imports. Capture the production bundle and Register-interactive timing first, then lazy-load only modules that measurably reduce initial POS work. Keep Register, session, sidebar, and recovery paths immediately available.

### P2 — make frequent actions station-aware

Extend the existing action grid into a permission-filtered, per-station arrangement. Allow managers to promote common products or workflows, but route every tile through the existing search, pricing, permission, tax, inventory, and audit paths. Never let a shortcut become a parallel checkout implementation.

### P2 — add a read-only customer-facing display

Provide a second-screen route for item descriptions, quantities, discounts, tax, total, tender progress, and receipt choice. Exclude cost, internal notes, staff controls, customer-private details, and every mutation capability.

### P2 — add an unmistakably isolated training mode

Training must be unable to authorize a payment, move inventory, create financial records, affect reports, or call live providers. Every screen and receipt must be permanently watermarked, with a separate data lifecycle and Manager-controlled entry.

### P2 — establish a formal quote lifecycle

Support draft, version, reopen, expiry, send, and deposit request while preserving the boundary between a non-financial quote, a posted financial Transaction, and a logistical Fulfillment Order.

### P3 — decompose only measured hot paths

`Cart`, the checkout drawer, close modal, order loader, and receipt completion surface are large. Extract narrow state/visual seams only where profiling or ownership defects justify the work, and keep existing behavioral tests at every seam. Do not rewrite the Register.

## Performance and experience guardrails

- Measure search-to-result, scan-to-line, Pay-open, tender-confirmed, receipt-ready, and close-complete p50/p95 on representative workstations.
- Treat a fast visual response as incomplete if authoritative server work is still pending; show explicit busy/recovery state.
- Do not trade financial reconciliation, exact variation selection, Manager Access, or recovery evidence for fewer taps.
- Keep the most common path keyboard/scanner friendly and every action touch-sized.
- Keep compact and desktop behavior under the same business components; avoid a separate mobile checkout implementation.
- Lazy-load low-frequency modules only after measurement and retain meaningful loading/error feedback.
- Prefer server-verified identifiers and visible selection over client guesses or silent fallbacks.

## Validation record

- In-app browser review at 390 × 844, 768 × 1024, 1024 × 1366, and 1440 × 900 — passed for the cart, compact checkout rail, action menu, Escape close, focus restoration, and desktop dual-pane layout.
- `npm run typecheck` — passed.
- `npm run lint` — passed after rerunning separately from Playwright temporary-output cleanup.
- Focused scan, camera, parked-sale, idle, dialog, and checkout-dock source contracts — 5 passed.
- Targeted runtime Playwright set covering responsive smoke, modal containment, dropdown/variation behavior, camera/parked actions, fixed navigation, rapid navigation, checkout entry, and Custom Order entry — all 16 tests passed across the focused run and isolated reruns. The long shared-runtime run exposed intermittent post-auth bootstrap resets; the three affected journeys passed when rerun individually.
- `npm run check:help-impact` — passed; five impacted files and three substantive Help/docs/ROSIE updates detected.
- Production frontend build — passed; the final-state `npx tsc --noEmit && npx vite build` completed with 3,792 modules transformed.
- `git diff --check` — passed.

## Release and certification boundary

- No release, push, deployment, production configuration, or Main Hub change is authorized by this audit.
- Run the normal release gates against the exact commit selected for a release.
- Validate the compact workflow with representative staff on the actual Register display before treating it as production-certified.
- Retain a rollback path for the UI build even though no database or server contract changed.
