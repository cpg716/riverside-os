# Wedding + Counterpoint Cutover Linking

Design for starting ROS mid-season when existing wedding parties are imported into Wedding Manager and existing sales/orders arrive through the Counterpoint bridge.

## Goal

ROS must become the source of truth going forward without losing the real current status of weddings already in progress.

The cutover workflow should let staff:

1. Import current wedding parties and members.
2. Sync Counterpoint customers, tickets, open documents, payments, and order lines into ROS.
3. Match those imported sales/orders to the correct wedding party and member.
4. Set each member item to the correct ROS lifecycle state.
5. Review exceptions before the party is trusted by Readiness, Orders, Inventory, and Register.

This is a one-time cutover workflow that can also be reused later for cleanup when a Counterpoint ticket was imported without enough wedding context.

## Plain-English Model

Think of cutover as a three-column review:

| Column | Staff question | Source |
|--------|----------------|--------|
| Wedding party | Which party and event is this? | Imported Wedding Manager party |
| Member | Which person is this sale/order for? | Imported party member + ROS customer |
| Transaction lines | What did they buy, and where does each item stand today? | Counterpoint-synced ROS Transaction Records |

Staff are not re-entering money. Staff are only connecting existing ROS records to the right party/member and confirming operational status.

## Source of Truth Rules

1. **Money comes from ROS Transaction Records.** Imported Counterpoint tickets/payments become ROS transaction/payment records. Wedding Manager must not ask staff to type paid totals or balances during cutover.
2. **Item status lives on transaction lines.** The authoritative order state is the ROS order lifecycle on each non-takeaway `transaction_lines` row.
3. **Wedding Manager reads lifecycle truth.** Wedding readiness, member badges, Orders, Inventory, and Register should all read the same linked transaction-line state.
4. **Matching suggestions are not final.** ROS may suggest a party/member/order match, but a staff member must confirm before it affects readiness or lifecycle.
5. **Placeholder items do not become NTBO.** If the exact product/variation is not known because measurements are still needed, the item must stay **Needs Measurements** until staff update the exact variation.
6. **No silent financial changes.** Linking imported records to wedding members cannot change transaction totals, tender rows, tax, deposit liability, or revenue recognition.
7. **Register follows Wedding Manager.** POS can surface a member's wedding checklist and add linked sellable items to the cart, but checklist-only or placeholder items remain Wedding Manager review items until the exact ROS product variation is known.

## Proposed Staff Workflow

### 1. Run Counterpoint Sync First

In Settings -> Integrations -> Counterpoint:

1. Sync staff.
2. Sync vendors.
3. Sync customers.
4. Sync catalog/inventory.
5. Sync open documents and ticket history.

This gives ROS the customer and transaction records that Wedding Manager will connect to.

### 2. Import Current Wedding Parties

In Weddings -> Parties:

1. Import the party list.
2. Confirm event date, party name, salesperson, and contact details.
3. Confirm members exist for each person who has or may have a sale/order.

Imported parties start as **Needs Cutover Review** until their linked sales/order status is confirmed.

### 3. Open Cutover Review

Add a staff-facing action:

**Weddings -> Cutover Review**

Recommended default view:

- **Needs review**: parties imported but not fully connected.
- **Suggested matches**: ROS found likely transactions or customers.
- **Blocked**: conflicting customer/order/payment clues.
- **Reviewed**: staff confirmed the links.

Each party card should show:

- party name and event date
- member count
- possible ROS customer matches
- possible Transaction Records
- unresolved balance total from linked/imported transactions
- lifecycle summary: Needs Measurements, Ready to Order, Ordered, Received, Ready for Pickup, Picked Up

### 4. Match Party and Members

Inside a party review screen, staff should see one row per member.

For each member:

1. Confirm or choose the ROS customer.
2. Review suggested Transaction Records.
3. Attach the correct transaction lines to the member.
4. Mark unrelated lines as **Not this member**.
5. Leave uncertain matches unresolved.

Suggested match signals:

| Signal | Confidence |
|--------|------------|
| exact `customer_code` / Counterpoint customer number | high |
| exact email or phone | high |
| same customer name + event date note/reference | medium |
| same last name + party name | medium |
| product/category looks like formalwear but no customer match | low |
| payment amount only | low; never auto-select alone |

High-confidence matches may be preselected, but staff still confirm.

### 5. Confirm Current Item Lifecycle

After attaching lines, staff confirm each item status.

| Staff label | ROS lifecycle state | When to use |
|-------------|---------------------|-------------|
| Needs measurements | `needs_measurements` | Placeholder suit/item exists, but exact variation is unknown |
| Ready to order | `ntbo` | Exact product/variation is known and still needs vendor ordering |
| Ordered | `ordered` | Item has been sent to vendor or is on a vendor order |
| Received | `received` | Item is physically in store but not verified ready for customer release |
| Ready for pickup | `ready_for_pickup` | Item is ready to release, pending balance and pickup rules |
| Picked up | `picked_up` | Item was already released to the customer |

For wedding placeholder suits, the safest default is **Needs measurements**. Staff must update the item to the exact variation before moving it to Ready to Order / NTBO.

### Register handoff after review

After a party/member is reviewed, the Register uses the same Wedding Manager context:

1. Staff attach the customer in POS Register.
2. POS shows current wedding memberships and a **Wedding Checklist**.
3. Linked sellable product variations can be added as **Take now**, **Order**, or **Measure**.
4. Checklist-only entries stay visible but are not charged until a sellable ROS product variation is linked.
5. Checkout creates normal ROS Transaction Records and keeps the `wedding_member_id` link for readiness.

This means cutover review should focus on linking customers, transaction lines, and exact product variations cleanly. If a member still has an uncertain suit, leave it **Needs measurements** so Register and Order Stock do not treat it as ready for vendor ordering.

### 6. Resolve Exceptions

Cutover Review should keep a party blocked until these are resolved:

- member has no linked ROS customer and has imported transactions that might belong to them
- transaction line is attached to a party but not a member
- imported transaction has an open balance but no member assignment
- order line has placeholder product/variation and is marked Ready to Order or Ordered
- two members are linked to the same transaction line
- lifecycle says Received/Ready/Picked Up without a linked imported transaction line
- paid/balance data is missing from the imported ROS transaction

Staff-facing copy should avoid database terms:

- "This sale needs a member"
- "This item still needs measurements"
- "This item has not been connected to a vendor order"
- "This item is in ROS but not reviewed for this wedding yet"

## Recommended UI Design

### Cutover Review Dashboard

Place this inside **Weddings**, near **Readiness**:

```
Weddings
  Action Board
  Parties
  Calendar
  Readiness
  Cutover Review
```

The dashboard should have four tabs:

1. **Needs Review**
2. **Suggested**
3. **Blocked**
4. **Reviewed**

Top summary cards:

- Parties needing review
- Members missing sales/orders
- Items needing measurements
- Orders ready to vendor-order
- Balance exceptions

### Party Review Screen

Recommended layout:

1. Party header: name, event date, salesperson, review status.
2. Member rows: member, customer match, linked Transaction Records, lifecycle badge.
3. Right-side review panel: selected member/order-line details.
4. Footer actions:
   - Save Draft
   - Mark Reviewed
   - Send to Manager Review

### Member Row States

| State | Visual intent |
|-------|---------------|
| Not reviewed | neutral badge |
| Suggested match | blue badge |
| Needs measurements | red/rose badge |
| Ready to order | amber badge |
| Ordered | blue badge |
| Received | indigo badge |
| Ready pickup | green badge |
| Conflict | red badge requiring review |

### Review Completion

When staff click **Mark Reviewed**, ROS should check:

- every attached transaction line belongs to exactly one member
- every non-takeaway linked line has a lifecycle state
- every placeholder item remains Needs Measurements
- every open balance is visible
- every exception is either resolved or intentionally manager-reviewed

Only then should the party leave **Needs Cutover Review** and become normal Wedding Manager readiness flow.

## Data Design

Use existing records as much as possible:

- `transactions` remain the financial anchor.
- `transaction_lines` remain the lifecycle source of truth.
- `wedding_parties` and `wedding_members` remain the wedding grouping layer.
- existing attach-to-wedding behavior remains the base linking mechanism.

Small additions recommended:

### Party Review State

Add review fields to `wedding_parties` or a companion table:

| Field | Purpose |
|-------|---------|
| `cutover_review_status` | `not_required`, `needs_review`, `in_review`, `blocked`, `reviewed` |
| `cutover_reviewed_at` | timestamp of review completion |
| `cutover_reviewed_by` | staff member who completed review |
| `cutover_review_notes` | short staff note for exceptions |

### Match Suggestions

Use a separate suggestion table so guesses do not become truth:

| Field | Purpose |
|-------|---------|
| `wedding_party_id` | party being reviewed |
| `wedding_member_id` | optional member suggestion |
| `customer_id` | suggested ROS customer |
| `transaction_id` | suggested Transaction Record |
| `transaction_line_id` | optional exact line |
| `confidence` | `high`, `medium`, `low` |
| `reason` | staff-readable reason |
| `status` | `suggested`, `accepted`, `rejected`, `ignored` |

Accepted suggestions should call the same attachment/lifecycle services used by normal Orders and Wedding Manager workflows.

### Audit Events

Every accepted, rejected, or manually created link should write an audit event with:

- staff member
- party/member
- transaction/line
- previous lifecycle
- new lifecycle
- source: `counterpoint_cutover_review`
- reason shown to staff

This makes the cutover explainable later.

## Lifecycle Mapping Guidance

Counterpoint data may not map cleanly to ROS lifecycle states. Use deterministic evidence first, then staff review.

| Counterpoint/ROS evidence | Suggested ROS lifecycle | Staff review needed? |
|---------------------------|-------------------------|----------------------|
| exact item missing size/variation; placeholder note | Needs measurements | yes |
| open special/backorder line with exact SKU and no vendor order evidence | Ready to order / NTBO | yes |
| open line linked to vendor order or staff confirms vendor ordered | Ordered | yes |
| received inventory or staff confirms item is in store | Received | yes |
| item in store and alterations/prep complete | Ready for pickup | yes |
| historical/current record indicates already picked up | Picked up | yes |
| normal completed historical sale, no open fulfillment | no open wedding lifecycle needed | review only if tied to active party |

Do not infer Ready for Pickup only because an item is paid. Payment readiness and physical readiness are separate.

## Operational Examples

### Example A: Placeholder Suit Before Measurements

1. Counterpoint ticket imports for Chris Garcia with "The Suit" placeholder.
2. Wedding party import includes Chris Garcia.
3. Cutover Review suggests Chris customer + transaction match.
4. Staff accepts the member link.
5. Item stays **Needs measurements**.
6. After measurements, staff edits line to exact variation and marks it **Ready to order**.

### Example B: Exact Suit Already Ordered

1. Counterpoint open document imports with exact suit SKU and vendor-order note.
2. Cutover Review suggests member and line.
3. Staff confirms it is already sent to vendor.
4. ROS line becomes **Ordered**.
5. Wedding Readiness shows vendor follow-up until receiving.

### Example C: Item Already In Store

1. Counterpoint record or staff review shows item arrived.
2. Staff links the line and marks **Received**.
3. If alterations are needed, Alterations remains the prep workflow.
4. Staff marks **Ready for pickup** only after prep is complete and balance rules pass.

## Permissions

Recommended permissions:

| Action | Permission |
|--------|------------|
| View Cutover Review | `weddings.view` + `orders.view` |
| Accept/reject suggestions | `weddings.mutate` |
| Change lifecycle during cutover | `orders.lifecycle_manage` |
| Mark party reviewed | `weddings.mutate` |
| Override conflicts | manager approval |

## Validation and Sign-Off

Before cutover is considered complete:

1. Run Counterpoint sync status checks.
2. Confirm every imported active party is in one of:
   - Reviewed
   - Manager Review
   - intentionally excluded
3. Spot-check balances against imported Transaction Records.
4. Spot-check item lifecycle counts against the physical wedding board.
5. Confirm Wedding Readiness shows expected blockers.
6. Confirm Orders and Inventory queues show expected NTBO/Ordered/Received counts.

## Smallest Safe Implementation Plan

1. Add cutover review status and audit fields.
2. Build read-only suggestion generation from existing customers, transactions, and transaction lines.
3. Add a Wedding Manager **Cutover Review** screen for review and attachment.
4. Reuse existing attach-to-wedding and order lifecycle transition services.
5. Add manager-review handling for conflicts.
6. Add targeted tests for:
   - high-confidence suggestion does not auto-link
   - accepted line links to the selected member only
   - placeholder line cannot become NTBO without exact variation
   - reviewed party appears in Wedding Readiness
   - rejected suggestion stays rejected after re-sync

This keeps the architecture intact: Counterpoint imports data, ROS stores financial truth, staff confirms wedding context, and lifecycle remains line-level truth going forward.
