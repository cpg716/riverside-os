# Riverside OS Simplify, Enhance, Optimize audit — 2026

## Mission

Audit every staff-facing Riverside OS screen, shell, workspace, drawer, modal,
wizard, loading state, empty state, error state, and responsive layout. The
goal is not to remove operational depth. It is to make the correct action
obvious, the current state easy to understand, and the application feel fast,
cohesive, graphical, and production-ready.

This is the master audit ledger. Findings are recorded before broad UI changes
are implemented.

## Product standard

### Simplify

- Put the staff member's primary task and next action first.
- Remove duplicated summaries, decorative status copy, and repeated labels.
- Use plain staff language and progressive disclosure for advanced controls.
- Preserve every permission, deep link, audit path, and authoritative record.

### Enhance

- Use meaningful icons, status color, compact illustrations, mini charts, and
  visual grouping where they improve recognition.
- Pair icons with labels; do not replace understandable controls with cryptic
  icon-only actions.
- Give loading, empty, degraded, success, and blocked states distinct visual
  treatment and useful next steps.
- Preserve keyboard, touch, mouse, and assistive-input behavior.

### Optimize

- Keep existing results visible while refreshed data loads.
- Debounce, cancel, and reject stale high-traffic requests.
- Lazy-load measured low-frequency work without making core staff paths wait.
- Reduce unnecessary renders and repeated provider/API work.
- Measure representative p50 and p95 task timing before claiming a workflow is
  fast.

## Non-negotiable guardrails

- Financial truth, tax, tender, inventory, fulfillment, permissions, Manager
  Access, provider evidence, and audit history take priority over fewer taps.
- Transactions and Fulfillment Orders remain distinct.
- A graphic must clarify status, hierarchy, choice, or progress. Decorative
  graphics must not crowd out the task.
- Settings, development, diagnostics, and advanced administration may remain
  more detailed than daily staff work.
- Source review, automated validation, local browser review, store-hardware
  certification, and production verification are separate claims.

## Production evidence boundary

- This audit is being performed read-only against the Tailscale-connected Main
  Hub with the existing authenticated staff session and real production-scale
  data. No Register was opened and no customer, Transaction, Fulfillment Order,
  wedding, appointment, inventory, message, payment, staff, or setting record
  was changed.
- Main Hub `/api/ready` reported ready with authoritative, current Meilisearch
  state and automatic repair enabled.
- The Main Hub remained ready on build
  `4874c43bad3b80eb24a85370007cd917fe3d1afb`. That SHA matched repository
  `HEAD` when the production/source trace began. Concurrent work advanced local
  `main` to `fe821085705d6b9ca36caaeb698932eb06afe69f` during validation; the audit
  does not claim that later commit is deployed or represented by the observed
  production UI.
- Production observations below use aggregate counts only. Customer names,
  contact details, record IDs, message bodies, and other identifying data are
  deliberately excluded from this ledger.
- Approximate timings are end-to-visible interaction samples from one remote
  audit session, not a statistically valid p50/p95 performance certification.
- The production Till was closed. POS visual and source findings therefore use
  the dedicated 2026-08-16 POS audit; tender, drawer, scanner, printer, camera,
  terminal, and reconnect behavior still require controlled store-hardware
  drills.

## Severity model

| Priority | Meaning |
| --- | --- |
| P0 | Financial, security, authorization, data-loss, or irreversible workflow risk |
| P1 | Blocks or hides a primary staff task, loses draft work, or breaks a major responsive path |
| P2 | Repeated friction, confusing hierarchy, slow feedback, or avoidable operational noise |
| P3 | Visual consistency, copy, spacing, iconography, and finish |

## Audit order and status

The order follows daily frequency and operational criticality. Shared shell
findings are recorded whenever they appear because they affect every section.

| Order | Staff area | Included surfaces | Status |
| ---: | --- | --- | --- |
| 1 | Shared entry and shell | Staff sign-in, top bar, Back Office and POS rails, universal search, notifications, Help, ROSIE, responsive shell ownership | Production core pass complete; responsive and signed-out passes remain |
| 2 | POS / Register | Open, sell, scan/search, Cart, customer/payment rail, tenders, completion, recovery, close, reports, dialogs, hardware handoffs | Audited 2026-08-16; follow-ups retained |
| 3 | Customers | Directory, Add Customer, Customer Relationship Hub, duplicate review, RMS Charge entry, customer handoffs | Production core pass complete; bulk and specialized flows remain |
| 4 | Transactions and fulfillment | Orders, Transaction detail, pickup, payment-on-order, return, exchange, cancellation, receipt history | Production list/detail pass complete; mutation wizards remain |
| 5 | Weddings | Action Board, Parties, Calendar, member workflow, deposits, Collect & Build, archive, drawers and wizards | Production core pass complete; mutation wizards remain |
| 6 | Alterations and appointments | Queue, intake, scheduling, conflicts, pickup, linked-customer and Register handoffs | Production core pass complete; mutation paths remain |
| 7 | Inventory and receiving | Find Item, Product Hub, catalog editing, ordering, receiving, batch scan, corrections, reports, physical inventory | Production navigation/readiness pass complete; mutation paths remain |
| 8 | Staff communications | Customer Interactions, Podium Inbox, Mailbox, Reviews, notification drawer and customer communication views | Production core pass complete; active concurrent remediation noted |
| 9 | Payments and customer value | Payments Operations, RMS Charge, gift cards, loyalty, layaways, deposits and reconciliation | Production overview/value pass complete; deposit and layaway detail remain |
| 10 | Operations and reporting | Operations Dashboard, Timeline, Daily Sales, Pickup Queue, Reports, Insights and printing | Production core pass complete; P0 reporting defect identified |
| 11 | Staff operations | Tasks, schedule, team, commissions, access and audit | Production core pass complete; mutation paths remain |
| 12 | Shipping and online work | Shipping Hub, Online Store staff workspaces and customer handoffs | Production core pass complete; live shipment flow unavailable |
| 13 | Administrative surfaces | QBO, Settings, integrations, Help management, ROS Operations and ROS Dev Center | Entry and navigation pass complete; intentionally allowed more detail |

The inventory includes the current Back Office sidebar subsections, all POS
rail tabs, shell-level drawers, and the overlays owned by each workspace. The
older `client/UI_WORKSPACE_INVENTORY.md` no longer lists every current POS and
Back Office destination and should be refreshed during the shared-shell pass.

## Stop-the-line production finding

| Priority | Surface | Finding | Evidence | Required direction |
| --- | --- | --- | --- | --- |
| P0 | Operations → Daily Sales | The **Today** dashboard displayed **New Orders 1,118** beside zero booked sales. The value is not scoped to the selected day. | In `register_day_activity.rs`, booked-basis `order_in_range` is only `status NOT IN ('cancelled')`; the `special_order_sale_count` query reuses it without a selected-range booking-event predicate. The production number therefore counts historical non-cancelled special/custom Transactions. | Remove or mark the metric unavailable until it is derived from authoritative in-range booking events. Add reconciliation coverage for today, custom ranges, backdated work, later additions, and imported Counterpoint ownership before restoring it to screen, print, CSV, or Z-report output. |

This financial-truth defect outranks the visual program. No graphical redesign
should make the incorrect value more prominent.

The source remediation is complete and recorded below: the metric now uses
authoritative initial booking events inside the selected store-local range.
Exact-release CI and post-deployment Main Hub verification remain separate
gates before the correction can be called live.

## Completed evidence: POS / Register

The current detailed review is
[`POS_REGISTER_FULL_AUDIT_2026-08-16.md`](POS_REGISTER_FULL_AUDIT_2026-08-16.md).
That pass corrected verified scan behavior, camera cleanup, idle-event churn,
five Cart-owned dialog accessibility gaps, and compact Customer & Pay access.

Remaining master-backlog items:

- P1: complete the complex-dialog keyboard and nested-overlay pass one
  financial workflow at a time;
- P1: certify scanner, camera, printers, drawer, Helcim, and reconnect behavior
  on store equipment;
- P2: measure low-frequency POS modules before further lazy loading;
- P2: consider a permission-filtered station action grid and read-only customer
  display; and
- P2: preserve customer-facing quote and training-mode opportunities without
  creating parallel checkout logic.

## Customer workspace audit — core directory and Hub pass

### Evidence boundary

- Read the customer RBAC and staff workflow contracts.
- Traced `CustomersWorkspace`, `AddCustomerDrawer`,
  `CustomerRelationshipHubDrawer`, shell handoffs, and focused Playwright
  coverage.
- Duplicate Review and the all-customer RMS Charge workspace remain separate
  detailed audit slices; this pass verified their entry and permission
  boundaries only.
- Reviewed local rendering at the normal desktop viewport and at 390 × 844,
  then repeated the primary directory and Hub paths on the Main Hub with
  production data.
- The production directory contained 35,073 profiles, including 313 profiles
  with balances and 275 wedding dates within 30 days. The first 100-row page
  reported 92 incomplete profiles, 41 without a phone, and 91 without an
  email. These counts are production-scale evidence, not permission to
  normalize or overwrite imported customer data.
- A neutral no-result production search took about 2.2 seconds from typing to
  settled empty state, including client typing and debounce time.
- No customer record was saved, merged, linked, messaged, or otherwise
  mutated.

### Preserve these strengths

- Customer search uses a 280 ms delay, aborts superseded requests, rejects
  stale responses, and retains visible rows while replacements load.
- Desktop tables and compact cards share one authoritative customer source.
- Browse failures, successful empty results, and incremental loading are
  distinguished.
- The Customer Hub preserves RBAC, linked-person boundaries, Transactions,
  Fulfillment Orders, measurements, weddings, shipments, loyalty, and history.
- Add Customer includes duplicate detection, manual address entry, assisted
  address selection, inline validation, and a persistent submit footer.
- Customer, Register, wedding, appointment, and Transaction handoffs reuse
  existing domain routes rather than parallel workflows.

### Findings

| Priority | Surface | Finding | Evidence | Proposed direction |
| --- | --- | --- | --- | --- |
| P1 | Customer Hub | Unsaved Profile edits can be abandoned by changing tabs or closing the drawer. | Profile draft baseline is used to build the save patch, but tab and drawer navigation do not guard a dirty draft. | Track dirty state; warn before close, customer switch, or tab change; keep safe navigation immediate when clean. |
| P1 | Customer directory | A no-result search followed by clear and an immediate **Balance Due** filter could leave the directory at zero rows after the filter was cleared and **Refresh** was pressed. Leaving and re-entering Customers restored rows; applying **Balance Due** after a clean remount returned 100 rows. | Reproduced on the Main Hub. Existing debounce, abort, and stale-response guards do not cover this search-clear-filter sequence. | Give each request a complete query/filter generation token, test this exact sequence, and expose the active query/filter state with one reliable reset action. |
| P1 | Customer Hub | The three common quick actions are below a ten-tab navigation wall instead of being part of the identity/action header. | Production Hub showed the actions directly below the tab list; they are not below the full Profile body. | Put icon-and-label quick actions with customer identity before the section navigator; keep permission and shell handoffs unchanged. |
| P1 | Customer Hub, compact | Ten text-only tabs consume four header rows at 390 px and delay the content. | Live 390 × 844 review. | Replace the flat tab wall with a compact icon-and-label section navigator using grouped progressive disclosure; retain every destination and deep link. |
| P2 | Customer Hub | The always-visible Save bar covers compact content and appears when no field changed. | Live desktop and 390 × 844 review. | Show a compact sticky save state only when dirty; reserve enough scroll space and expose saved/unsaved status. |
| P2 | Customer Hub | Customer facts repeat across badges, four answer cards, seven navigation metrics, snapshot items, Things to know, and two ROSIE cards. | Profile render and live DOM review. | Use one graphical overview with balances, open work, wedding, loyalty, and profile completion; move detail to the owning destination. |
| P2 | Customer directory | Search and the customer list sit below four large metric cards and a second completeness dashboard. | Live desktop review. | Keep search/Add Customer in the first viewport; condense management metrics into one collapsible visual band. |
| P2 | Customer directory | Footer copy such as **Customer List Updated**, **Compact List**, and **Customer profiles** looks like status but adds no actionable state. | `CustomersWorkspace` footer. | Remove it or replace it with a real last-refresh/result-count indicator only when useful. |
| P2 | Customer directory | The placeholder **Try Ch Gar, phone, code, or company...** is cryptic staff copy. | Live rendered search. | Use plain searchable fields: name, phone, email, customer code, or company. |
| P2 | Customer directory | Pipeline-stat and customer-group failures are silently ignored, leaving dashes or missing filters without explanation. | `fetchPipelineStats` and customer-group effect. | Keep directory use available, but show a compact degraded indicator and targeted retry. |
| P2 | Customer directory | Production-scale completeness debt overwhelms row-level scanning, while legacy imported display names include malformed punctuation and placeholder-like values. | 92 of the first 100 rows were incomplete; no identifying examples are retained here. | Add an auditable data-quality queue and compact quality badge/filter. Never auto-correct identity fields without reviewed evidence. |
| P2 | Add Customer | Closing a populated intake drawer has no unsaved-draft warning. | `AddCustomerDrawer` passes its close callback directly to `DetailDrawer`. | Warn only after meaningful edits; keep an untouched drawer one-click close. |
| P2 | Add Customer | The nested missing-email prompt handles Escape locally but does not use the shared focus trap and focus-return contract. | Email prompt implementation. | Apply the shared nested-modal accessibility pattern and restore focus to Create customer. |
| P2 | Customer bulk work | Selecting a wedding party immediately starts multiple customer writes, and wedding/group assignment sends one request per selected customer. | Bulk wedding and group handlers. | Add a review/confirm step and a server-owned bounded batch operation with clear partial-result reporting. |
| P2 | Initial loading | A newly opened Hub uses one line of loading copy inside a very large drawer. | Live/source loading branch. | Render a lightweight customer-header and section skeleton so the drawer feels stable immediately. |
| P3 | Customer directory | Management metrics use strong cards and icons, but the combined card volume competes with the primary lookup task. | Live desktop review. | Retain meaningful icons and colors in a smaller summary strip; prioritize search hierarchy. |

### Customer acceptance criteria

- Customer search and **Add Customer** are visible without scrolling at common
  desktop and tablet sizes.
- Existing results remain visible during refresh, with no stale response able
  to replace a newer query.
- The Hub exposes customer identity plus **Start sale**, **Message**,
  **Book appointment**, and **Add to wedding** as immediate, labeled graphical
  actions when permitted.
- Compact Hub navigation occupies no more than two header rows and every
  current destination remains reachable by keyboard, touch, and deep link.
- A customer balance, open-work count, wedding state, loyalty balance, or
  profile-completeness fact is summarized once, with detail in its owning
  section.
- Save UI appears only for a dirty draft and never obscures the focused field.
- Dirty profile or Add Customer drafts cannot be discarded without an explicit
  choice.
- Initial, refreshing, empty, degraded, and failed states are visually
  distinct and accessible.
- Customer stats/group failures never masquerade as authoritative zeroes or
  silently missing configuration.
- Bulk changes show the target, selected count, and expected action before the
  first write, then return one complete or explicitly partial result.

### Customer validation record

- Focused Customer Profile layout, Relationship Hub responsive cards, linked
  profiles, Add Customer address behavior, duplicate review, and lifecycle
  coverage: 16/16 scenarios passed.
- The combined shared-runtime run completed 13 scenarios and hit three
  Back Office sign-in bootstrap timeouts before the affected scenario began.
  Each affected desktop, linked-profile, and Geoapify scenario passed in an
  isolated rerun.
- Live local browser review covered the normal desktop viewport and
  390 × 844. The responsive tests additionally cover 768 × 1024,
  1024 × 1366, and 1440 × 900.
- Main Hub production data and one remote staff-session timing sample were
  exercised read-only. Physical workstation and store-hardware behavior were
  not exercised.

## Transactions and Fulfillment Orders — production list/detail pass

### Production evidence

- **All Orders** reported 1,338 matching records; 165 were Wedding Orders,
  1,293 needed action, 353 were ready for pickup, and 155 were overdue.
- The first 100-row page became visible in roughly three seconds. Switching
  **All Orders** to **Open Orders** retained the old mixed rows for more than ten
  seconds with no visible refreshing state. The settled result reported 860
  matching rows. Leaving the stale list available also left rows clickable.
- Once the filter had settled, a current Open Transaction detail loaded in
  about one second.
- Production contains zero-value, zero-line, wedding-linked records in the
  order-scoped list. Their detail still offered broad cancellation, return,
  refund, and Register actions despite having no actionable merchandise.
- No Transaction, line, tender, pickup, refund, cancellation, or receipt was
  changed.

### Findings

| Priority | Surface | Finding | Evidence | Proposed direction |
| --- | --- | --- | --- | --- |
| P1 | Orders list | Old mixed-status rows remain visible and actionable under the new active filter while a slow refresh runs. | Production filter change; `renderTransactionListState` renders no updating state whenever retained rows exist. | Retain rows for continuity but visibly mark the list **Updating**, disable unsafe row actions until its request generation settles, and test rapid filter/search changes. |
| P1 | Orders list | Missing customer/order summaries can trigger one detail request per visible row. | Source uses `Promise.all` across `rowsNeedingNames`; the production page can contain 100 rows. | Return complete list summaries from one authoritative endpoint or use one bounded batch lookup. Do not issue a 100-request fan-out. |
| P1 | Order pipeline | Pipeline failures become confident zeroes. | `loadPipelineStats` suppresses errors and the cards render `?? 0`; initial production render showed zeroes before real counts. | Add skeleton, loaded, degraded, and retry states. Never render operational zero until the corresponding query succeeds. |
| P1 | Information architecture | The staff-visible Orders workspace is always requested with `record_scope=orders`; there is no equally discoverable general **Transaction Records** archive in the main rail. **Payments → Transactions** is a provider-payment view, not the financial Transaction archive. | Workspace request construction, sidebar inventory, and production navigation. | Add one plain-language **Transaction Records** entry that opens the authoritative financial archive; keep **Fulfillment Orders** or **Orders** explicitly logistical. |
| P1 | Modal accessibility | Pickup, suit-swap, readiness-checklist, wedding-link, cancellation, and exchange overlays do not consistently provide dialog semantics, focus trapping, Escape, nested-overlay ownership, and focus restoration. | Direct source trace across `TransactionDetailDrawer`, `AttachOrderToWeddingModal`, and `PosExchangeWizard`. | Apply the shared portaled modal contract one mutation flow at a time without changing server guards. |
| P2 | Order data quality | Zero-line wedding-linked records appear alongside actionable Fulfillment Orders and can present all-zero lifecycle cards. | Production All Orders/detail. | Classify these as cutover/data-quality records, or suppress them from the action queue while preserving an auditable archive. |
| P2 | Detail actions | The drawer duplicates **Open in Register** and **Cancel Order Items**, and shows actions such as **Return All** when no fulfilled returnable item is present. | Production zero-line and open-line detail views. | Derive one eligibility-aware action hierarchy: primary next action, secondary safe actions, and advanced history/override actions behind disclosure. Keep server validation authoritative. |
| P2 | Detail identity | A raw register-session UUID is exposed in routine detail. | Production detail. | Show Register number and session date; retain the raw identifier under audit details or copyable technical evidence. |

Preserve the financial snapshot, payment/pickup checks, item-level lifecycle,
readiness guardrails, Manager Access, and the strict Transaction versus
Fulfillment Order distinction.

### Validation boundary

- On the proper test-support stack, five of seven focused Orders/list scenarios
  passed. Two stopped at the shared Back Office sign-in bootstrap before their
  scenario began.
- An isolated rerun made the unfulfilled-item cancellation-preview scenario
  pass. The POS order round-trip scenario repeated the same sign-in bootstrap
  timeout and remained at the sign-in gate; it did not reach or fail the order
  round-trip assertions.
- The focused list failure-state scenario passed. The unresolved bootstrap
  instability must not be reported as a passing Orders contract.

## Weddings — production core pass

### Production evidence and findings

| Priority | Surface | Finding | Evidence | Proposed direction |
| --- | --- | --- | --- | --- |
| P1 | Action Board | The initial render displayed **0 Active Parties** without a loading qualifier, then populated 97 parties several seconds later. | Main Hub first render. | Render a stable skeleton or **Loading party work** state; never use a temporary zero as operational truth. |
| P2 | Action Board | **Needs Measure 1,704** is a raw member-task total that overwhelms the 97-party workload and does not communicate which events are at risk first. | Main Hub aggregate cards. | Make event risk and next deadline primary; group member work under the party and show task totals as supporting detail. |
| P2 | Readiness | Readiness is the stronger operational view but is secondary to the noisier Action Board. | Production readiness loaded 100/100 records with 8 Critical, 36 At risk, 55 Safe, and 1 Complete, plus a truthful **Analyzing wedding readiness** loader. | Promote a compact risk/readiness layer as the daily default while retaining the Action Board for task execution. |
| P2 | Party cards | Party and readiness card accessible names combine party code, risk, people, date, salesperson, style, completion, member count, and action into one dense control. | Production accessibility tree. | Use a concise event header, graphical readiness/progress, one next action, and progressive disclosure for style and member detail. |
| P2 | Party detail | The selected party workspace exposed many parallel headings, badges, pending states, member controls, Manager Financials, history, archive, print, and order actions in one view. | Read-only production party detail. | Establish a fixed hierarchy: event identity/risk, next action, member progress, then financial/admin detail. Keep blocked pickup, deposits, and canonical Transaction evidence prominent where relevant. |
| P3 | Wedding shell | **Cutover**, **Reports**, and **Settings** compete with Parties, Appointments, and Readiness in the staff shell. | Production shell navigation. | Group low-frequency manager/admin tools under a permission-aware **More** destination; keep frequent staff tasks visible. |

Preserve the canonical customer/Transaction/lifecycle aggregates, distinct
held-deposit versus applied-payment evidence, event streaming, Archive Tracking
audit, one-action builder review, and per-member Transaction/Fulfillment Order
creation.

## Alterations and Appointments — production core pass

### Alterations

Production showed 15 open garments and 3 overdue. The workbench provides clear
overdue, due-today, ready, in-work, and intake grouping, meaningful status
color, capacity context, source linkage, and a compact mode.

| Priority | Finding | Proposed direction |
| --- | --- | --- |
| P1 | Every card exposes **Advance**, three direct status chips, **Plan / Reassign**, and **Print Card**. Choosing **ready** can have an external customer-notification side effect, but it is presented like an ordinary one-click chip. | Use one prominent **Next status** action and an overflow for exceptional status changes. Make any transition that sends customer communication explicit: **Mark ready & notify**, with destination/result evidence and retry-safe behavior. |
| P2 | The page stacks four metrics, a workflow explainer, a daily schedule, an add-open-work rail, filters, and six workbench lanes before/around the core garment work. | Default to the urgent workbench plus today's capacity; disclose scheduling and explanatory detail as task-specific panels. Preserve the Alterations nested-scroll exception. |
| P2 | Repeated tiny uppercase labels and multiple status pills make each card slower to scan than the garment, due date, and next action require. | Use a garment thumbnail/icon, due-state timeline, concise customer/garment label, and one action. Put IDs, created time, notes, and alternate states under detail. |

### Appointments

The selected production day had no appointments, yet the day view still
rendered 53 empty 15-minute rows from 8:00 AM through 9:00 PM.

| Priority | Finding | Proposed direction |
| --- | --- | --- |
| P2 | An empty day requires scrolling past an all-day slot grid after the page already says no appointments exist. | Use store hours, compress closed/empty ranges, and offer **New Appointment** plus a graphical open-capacity strip. Expand exact 15-minute slots on interaction. |
| P2 | Search, date stepping, date input, Day/Week, Today, Print, and New Appointment compete in two dense header rows. | Make date/view the primary control group, keep New Appointment primary, and move print/search into compact labeled utilities. |

Preserve conflict checking, roster availability, schedule overrides, wedding
member linkage, status synchronization, keyboard activation, and print layouts.

## Inventory and receiving — production navigation/readiness pass

### Production evidence

- The Inventory Hub reported $224,183.33 asset value, 366,532 out-of-stock SKU
  alerts, 2,797 replenishment candidates, and 164 vendors.
- Find Item, Receive Stock, Batch Scan, and Physical Inventory were opened
  read-only. Receiving correctly showed a three-step staged workflow and no
  document ready to receive; Physical Inventory correctly showed no active
  count session.

### Findings

| Priority | Surface | Finding | Evidence | Proposed direction |
| --- | --- | --- | --- | --- |
| P1 | Inventory Hub | The asset-value **+2.4%** trend is hard-coded, not calculated. Stats initialize to zero and fetch failures are console-only. | `InventoryWorkspace.tsx` and production Hub. | Remove the trend until an authoritative comparison exists. Add loading/degraded states; never turn missing stats into zero. |
| P2 | Inventory Hub | **Stock Alerts 366532** is unformatted and too broad to drive a staff task; it counts every active variant with on-hand at or below zero. | Production metric and control-board SQL. | Format large values and prioritize sellable/recently sold/reorderable exceptions. Keep the full variant count available as technical detail. |
| P2 | Find Item | Catalog cleanup, Counterpoint reference readiness, missing-field diagnostics, quick filters, long vendor/category selects, and the sellable item list share one staff surface. | Production Find Item. | Keep item search and Product Hub first. Move migration/normalization diagnostics to a manager cleanup workspace and retain a small degraded-data badge. |
| P2 | Hub navigation | The hub repeats the expanded sidebar destinations as job cards plus subtool chips. | Production Inventory Hub. | Let the sidebar own destination switching and use the Hub for prioritized work, recent documents, and alerts that lead directly to a job. |

Preserve blind counts, reviewed variance publishing, receiving staging before
stock mutation, scanner/audio feedback, PO linkage, and inventory-ledger rules.

## Communications and alerts — production core pass

### Production evidence

- The global bell reported 1,446 unread alerts.
- Operations showed 9 unread Podium conversations and 78 unread mailbox
  messages. Mailbox showed 175 Inbox messages, 200 All Mail, and 200 Unmatched.
- Customer Notifications reported 43 items, 43 needing review, and 3 failures.
- Review Requests contained pending, rate-limited, and failed provider work;
  failures exposed raw transport error strings.

### Findings

| Priority | Surface | Finding | Proposed direction |
| --- | --- | --- |
| P1 | Notification drawer | 1,446 unread makes the capped **99+** badge non-actionable. Many items repeat the same mailbox or Podium nudge, including duplicated copy such as **Still unread: Still unread**. | Bundle by conversation/source and priority, show a manageable **Needs action** count, and keep total history behind filtering. Fix notification generation/deduplication before visual polish. |
| P1 | Mailbox | Every sampled message was unmatched, while delivery-failure messages compete with customer correspondence in the same inbox. | Add matching-confidence/status filters, group delivery failures into a delivery-health queue, and make **Needs reply**, **Needs match**, and **Delivery problem** the primary work buckets. |
| P1 | Reviews | Staff see raw `reqwest`/provider URL errors, repeated rate-limit messages, and many generic **Record/Open/Retry** controls with no unique accessible context. | Present one provider-health incident with affected count and safe retry timing; keep raw diagnostics behind Details. Give row actions record-specific accessible names. |
| P2 | Communication architecture | Bell alerts, Customer Notifications, Podium Inbox, Mailbox, Reviews, and customer-history messaging each expose overlapping unread/review concepts. | Create one **Communications** operational home with channel tabs and a unified Needs Action count. Preserve Podium, Store Email, reviews, assignment, and audit as distinct providers/workflows underneath. |
| P2 | Podium composer | Emoji buttons are announced only as glyphs. | Add plain accessible names such as **Insert smile** while retaining the compact graphical controls. |

Preserve **Assigned to** separately from **Replying as**, linked-active-staff
eligibility, provider delivery evidence, read/unread history, deep links, and
customer communication consent. A concurrent customer-interactions and
delivery-recovery commit advanced local `main` during this audit but was not on
the observed production build; implementation must inspect it before
duplicating or superseding its notification/mailbox work.

## Payments and customer value — production overview pass

| Priority | Surface | Finding | Evidence and direction |
| --- | --- | --- | --- |
| P1 | Reconciliation | Production showed **99+** reconciliation items, including repeated unlinked-payment, fee-not-ready, and net-not-ready warnings. The Health view also identified one approved Helcim payment not attached to a ROS Transaction Record. | Keep every record-level evidence row, but lead with grouped incidents, age, dollars at risk, last successful sync, and one safe remediation path. Do not attach the unlinked approval without exact terminal receipt and customer-account proof. |
| P1 | Deposits | **18** deposit items needed review. Expected and actual deposit tables contained same-day/same-amount-looking rows that remained unlinked, while the screen also said there were no unmatched expected batches. | Trace matching with authoritative Helcim batch/deposit identifiers before changing data. Clarify **expected**, **actual**, **linked**, and **cleared** in one reconciliation timeline and never imply that visually similar amounts are proof of a match. |
| P2 | Payments | The sidebar owns Overview, Batches, Deposits, Reconciliation, Transactions, and Health while the page repeats those tabs and adds Disputes. | Choose one navigation authority and expose Disputes consistently. Keep **Sync Batches/Fees** separate from passive review and clearly show last successful sync. |
| P2 | Reconciliation detail | The same full sentence—processor fee/net evidence is unavailable—is repeated for many individual rows. | Summarize by cause and count with expandable record evidence; retain raw processor IDs only in the detail layer. |
| P2 | Loyalty | 321 customers were at or above threshold; some rows had many rewards ready, yet the page repeats a generic **Redeem Reward** button across the large list. | Make the batch fulfillment workflow primary, group high-count customers, show card/letter/label readiness, and give every action a customer-specific accessible name. |
| P3 | Gift Cards | The production workspace handled 393 open cards with a strong scan-first action, liability and card-kind summary, filters, pagination, and ledger-safe issue boundaries. | Preserve this hierarchy. Add selected-card history as the next useful enhancement rather than redesigning the whole workspace. |

The Payments empty state correctly distinguished no card activity today from
settlement readiness, and Health correctly warned that alerts do not close
issues or change totals. Gift-card liability, loyalty rewards, store credit,
deposits, tender allocation, and payment-provider Transactions must remain
separate concepts.

## Operations, reports, and Insights — production core pass

| Priority | Surface | Finding | Proposed direction |
| --- | --- | --- | --- |
| P1 | Pickup Queue | The queue showed 100 items and many cards whose next action said pickup was blocked by a balance, while all four summary cards and the guidance strip reported 0 Ready, Rush, Due Soon, and Blocked. | Derive summary and rows from the same server-owned readiness model. Balance due, partial readiness, lifecycle, fitting, and item count must feed the classification. Do not call the queue clear or safe from client-only urgency. |
| P1 | Pickup Queue backend | The query includes every `open`/`pending_measurement` Transaction and does not enforce its comment's requirement for at least one unfulfilled item. Urgency ignores balance due; the client separately calls it blocked in copy. | Define an authoritative pickup-eligibility DTO with reason codes and counts, filter the queue to real release work, and add reconciliation tests against Order detail readiness. |
| P2 | Operations Dashboard | The page is visually strong but duplicates click-through metric cards and a second row of smaller metrics before the action board. | Keep one role-aware action summary and use small trend graphics only where backed by data. Prioritize exceptions over repeated totals. |
| P2 | Reports | The 39-report catalog has strong categories, icons, search, access filtering, and direct Register/commission handoffs. Labels such as **Manager report** beside **Staff Access** can appear contradictory. | Rename metadata to **Audience** or **Report type** and show actual access separately. Preserve the categorized graphical library. |
| P2 | Insights | Two saved reports with the same title and date differed only by row count. | Treat reruns as versions or show parameters/time so History does not become duplicate-looking clutter. Preserve the excellent Ask → Explore → Deliver visual workflow. |

The P0 Daily Sales defect above is corrected and reconciled in source. Daily
Sales, its print/CSV output, and Z-report copy still require exact-release CI
and post-deployment Main Hub verification before the correction is certified
live.

## Staff operations — production core pass

| Priority | Surface | Finding | Evidence and direction |
| --- | --- | --- | --- |
| P1 | Team accessibility | The Team workspace exposed no semantic heading and repeated generic **Edit Profile** controls across 63 visible staff cards. | Add an `h1`/`h2`, searchable roster landmark, and staff-specific accessible action names. |
| P2 | Team | 63 of 64 records were active; the default card wall includes many operational, imported, and system-like profiles, frequently with **No PIN**, before the staff member a manager needs. | Default to recently active/scheduled staff, add search and role/access filters, and move dormant/system records to managed disclosure. Do not silently deactivate or alter access. |
| P2 | Schedule | The weekly view rendered the full 63-person × 7-day grid, largely as repeated **OFF** cells. | Default to scheduled staff and exceptions, with **Show all staff** available. Use coverage bars and gap indicators above the detailed grid. |
| P2 | Tasks | The production **My tasks** view had no open or recently completed work and no contextual next step beyond the empty text. | Use a lightweight completion illustration and, when permitted, a clear path to Team/Admin templates without crowding the staff view. |
| P3 | Commissions | Financial basis and recognized-sale wording are clear; manager detail is appropriately verbose. | Preserve the explicit recognition basis and source evidence. Use compact visual totals only if they reconcile to the table. |

## Shipping, Online Store, and administration — production entry pass

| Priority | Surface | Finding | Proposed direction |
| --- | --- | --- | --- |
| P2 | Online Store | The sidebar exposes eight destinations, the workspace repeats a 14-item tab strip, and the Dashboard repeats the same destinations as action cards. | Separate daily web operations—Orders, carts needing action, fulfillment—from storefront administration. Use one navigation authority and allow admin setup to remain detailed. |
| P2 | QBO bridge | The page displayed **2 map accounts ready** while the connection status said the Realm ID was missing and journals could not be sent. | Say **2 accounts mapped** and keep overall readiness **Not connected** until all required connection evidence succeeds. |
| P3 | Shipping | The empty production Shipping Hub clearly explained where POS/online shipments will appear and separated **Carrier handoff** from **New shipment**. | Preserve this empty-state hierarchy; validate the live label, tracking, error, and handoff flows when production shipments exist. |
| P3 | Settings | Settings Hub already groups 29 settings into Store & Staff, Register & Printing, Data & Maintenance, Connected Services, and Help & System. | Preserve the grouped hub. Verbose integration diagnostics remain appropriate behind these categories. |

## Shared shell, Help, and ROSIE — production core pass

### Preserve these strengths

- The sidebar logo remains the visual identity anchor and the Global Top Bar
  avoids duplicating it.
- Remote Access, Till Closed, staff identity, POS entry, universal search, Help,
  ROSIE, theme, notifications, and profile are visible and keyboard-addressable.
- Universal Search opens with a focused, plain-language explanation and covers
  customers, Transaction Records, Fulfillment Orders, inventory, weddings,
  shipments, and alterations.
- Help includes topic navigation, screenshots, print, and ROSIE handoff. ROSIE
  has a restrained empty state instead of pretending to know the answer.

### Findings

| Priority | Surface | Finding | Proposed direction |
| --- | --- | --- | --- |
| P1 | POS shell ownership | `Payments` is rendered in the POS rail but missing from `POS_SHELL_TABS` in `App.tsx`; a Global Top Bar handoff can therefore treat it as Back Office-owned. | Add the smallest focused shell-contract correction and a route-ownership test. |
| P1 | Notifications | The always-visible 1,446-unread badge dominates every workspace and does not represent a workable priority. | Show actionable, deduplicated count and severity; keep total history in the drawer. |
| P2 | Sidebar | The expanded Back Office rail exposes more than twenty top-level destinations plus nested subnavigation. BO/POS badges add repeated visual noise. | Group destinations around **Sell & Serve**, **Fulfill**, **Communicate**, **Manage**, and **Analyze** while keeping the most-used six immediately available and every permission/deep link intact. |
| P2 | Duplicate navigation | Inventory, Payments, Staff, Online Store, and other workspaces repeat sidebar destinations as page tabs/cards. | Assign one owner for destination switching; use page content for status, recent work, and next actions. |
| P2 | Help context | Help opened to **Checkout & Payment** while the active Back Office context was not Register checkout. | Resolve the active shell/workspace to the relevant manual when known; otherwise open a task-search library without implying context. |
| P2 | Overlay semantics | Help and ROSIE each exposed duplicate **Close drawer** controls in one dialog tree. | Keep one semantic dialog owner and one named close action per drawer while preserving portal/z-index contracts. |

## Cross-product implementation sequence

1. **Trust first:** correct the Daily Sales date-scope defect; reconcile Pickup
   Queue classification; remove hard-coded or silent-zero operational metrics.
2. **State clarity:** add truthful loading/updating/degraded states to Orders,
   Weddings, Customers, Inventory, and all dashboards that initialize to zero.
3. **Daily work:** make customer lookup, open Transactions/Fulfillment Orders,
   wedding risk, pickup readiness, alterations due work, and communications
   follow-up the first-viewport tasks.
4. **Action safety:** prune inapplicable actions, consolidate duplicated actions,
   protect dirty drafts, and make external side effects explicit.
5. **Navigation:** simplify the shared rail and remove page-level duplicate
   navigation without removing permissions, routes, or deep links.
6. **Accessibility:** complete dialog focus/keyboard contracts and give repeated
   row actions unique accessible names.
7. **Visual enhancement:** add progress rings, readiness timelines, risk bands,
   capacity bars, small reconciled trends, and purposeful icons only after the
   underlying state is authoritative.
8. **Performance:** eliminate list fan-out requests, test rapid search/filter
   sequences, and collect representative workstation p50/p95 timings.

## Remaining full-audit work

This production core pass is not the end of the every-surface program. The next
ledger slices are the mutation and exceptional paths: Transaction pickup,
payment-on-order, return, exchange, cancellation and receipt recovery; wedding
member creation, deposits, Collect & Build, archive/reopen and appointment
mutation; alterations intake/status/notification; inventory Product Hub,
ordering, receiving post, corrections and count publish; payment deposits,
reconciliation, disputes and layaways; shipment creation/label/handoff; compact
and tablet breakpoints; signed-out/permission-denied states; and the low-use
Settings/ROS Operations/ROS Dev Center screens. Each slice should be audited
against the Main Hub where safe, then implemented and validated as a focused
change rather than a repository-wide visual rewrite.

## Source remediation record — 2026-08-16

The production-core findings above now have a first implementation pass in the
working tree:

- Daily Sales counts new Special/Custom Orders from authoritative in-range
  initial booking events; later amendments no longer inflate the selected day.
- Pickup Queue uses one server-owned readiness classification for rows and
  summary totals. Orders retains visible rows during refresh but makes them
  read-only, bounds list-detail hydration, distinguishes Fulfillment Orders
  from Transaction Records, and prunes ineligible detail actions.
- Customer lookup owns one current request generation and one complete reset.
  The Hub and Add Customer protect meaningful drafts, compact navigation uses
  progressive disclosure, initial Hub loading is visually stable, and reviewed
  wedding/group changes use bounded permission-checked server batches.
- Wedding Readiness leads the workspace; temporary zero party counts are gone,
  low-frequency tools are grouped, and party work leads with risk and a next
  action. Alterations cards expose one primary progression action and name the
  notification side effect. Empty appointment days show graphical capacity;
  appointment search and print are compact utilities.
- Inventory removes fabricated trend data and silent-zero summaries, then uses
  the Hub for prioritized evidence instead of duplicate navigation. Online
  Store similarly leads with daily operations and moves setup detail behind
  disclosure and sidebar-owned navigation.
- Communications shows a workable action badge, prevents recursive reminder
  generation, normalizes old reminder titles, gives Mailbox primary work
  buckets, groups review-provider incidents, and names compact emoji/action
  controls for assistive input.
- Payments leads reconciliation with grouped cause, age, known amount, and last
  successful sync; Deposit review explains Expected → Actual → Linked →
  Cleared; Disputes is consistently reachable. Reports, QBO, Insights, Staff,
  Schedule, Tasks, Help context, shell ownership, rail grouping, and shared
  drawer semantics received the corresponding clarity and accessibility fixes.

This record is source-level completion, not a production certification. A full
ethos sign-off still requires an authorized deployment of the exact working
tree, repeat read-only review against Main Hub data, controlled mutation-flow
rehearsals, compact/tablet checks, and physical Register, printer, scanner,
camera, drawer, terminal, and outage/reconnect drills. Settings, ROS Operations,
and ROS Dev Center remain intentionally denser and are not judged by the same
staff brevity standard.
