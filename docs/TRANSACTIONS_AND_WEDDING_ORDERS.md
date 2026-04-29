# Transactions and Fulfillment Orders — Riverside OS

Riverside OS employs a decoupled **transaction-centric architecture** that separates the financial tracking of user purchases (Transactions) from the logistical process of acquiring and delivering items (Fulfillment Orders).

## Core Architecture

- **Transactions (`transactions`, visible numbers like `TXN-10001`)**: Represent the financial ledger and customer commitment. Every checkout action creates a single Transaction. It records the total price, amounts paid, balance due, and acts as the anchor for receipts and refunds.
- **Fulfillment Orders (`fulfillment_orders`, visible numbers like `ORD-10001`)**: Represent the logistical state of the items to be delivered. A single Transaction can have its line items mapped to one or more Fulfillment Orders. Fulfillment orders handle the physical workflow: procurement, special ordering, shipment, and physical pickup.

## User Interface (UI) Mapping

To ensure clarity for staff, the Riverside OS interface uses standard industry terminology:
- **Orders (Sidebar)**: High-level entry into logistical management.
- **Orders Workspace**: The central fulfillment workspace where special, custom, and wedding orders are tracked through their logistical lifecycle.
- **Sales History**: The historical archive of all financial commitments, accessible as a secondary audit view within the POS or CRM contexts.
- **Daily Sales**: Financial reporting focused on register sessions and tender counts.

## The Decoupling

In legacy systems, an "Order" represented both the financial receipt and the physical box of goods. Riverside OS decouples these concepts to handle complex retail realities:
- A customer pays for several items on a single receipt (**1 Transaction**).
- 1 item is taken home today (**Takeaway**).
- Other items are tracked as **Fulfillment Orders** in one of three primary categories:

### The Three Fulfillment Types

1. **Special Order**: Standard catalog items that are out of stock and must be procured from a vendor. They use fixed catalog pricing and standard costs.
2. **Custom (MTM)**: Made-to-measure garments that remain a true first-class Custom order type. The sale price is entered at booking. The actual vendor cost is entered later, when the garment is received. Known Custom SKUs currently include `100` (HSM Custom Suit), `105` (HSM Custom Sport Coat), `110` (HSM Custom Slacks), and `200` (Individualized Custom Shirt). ROS also stores a small structured set of vendor-form references for these orders so staff can review the booked fabric, style, model, size anchors, sleeve or cuff measurements, and vendor reference notes without re-reading every handwritten form.
3. **Wedding Order**: Items tied to a specific wedding party. These are often standard catalog items but are logically grouped to ensure the whole party is outfitted before the event date. Linking a wedding member in the POS automatically switches out-of-stock items to this fulfillment type.
4. **Checkout Security**: Finalizing checkout requires a valid **Access PIN**. Manager-only actions (overrides, large discounts) require a **Manager Access** credential verification.

Special and Custom stay separate operational contracts. Custom is not just another label for a Special Order.

## Operational Workflow

### 1. Booking (Transactions)
When the cashier completes checkout, a Transaction is generated. If items cannot be taken away immediately, those `transaction_lines` are mapped to new or existing Fulfillment Orders.
- **Rounding Adjustments**: For cash transactions, the `rounding_adjustment` field records the delta between the calculated total and the physical cash collected (Pennyless/Swedish Rounding). This ensures the balance due is accurately reduced to zero without altering line-item prices.

### 2. Deposits & Accounting
- The customer may pay a partial deposit against the **Transaction**.
- The partial deposit is booked exclusively as Liability. 

### 3. Logistical Tracking (Fulfillment Orders)
- Store management views **Fulfillment Orders** in the pipeline.
- Goods are procured out to vendors.
- Upon arrival, items are marked `Reserved` against the exact `fulfillment_order_id`.

### 4. Financial Recognition (Fulfillment Event)
Revenue recognition is strictly tied to the `fulfilled_at` timestamp on individual `transaction_lines`.
- When an item is physically handed over, the `transaction_line` is marked as fulfilled.
- At this moment, revenue is recognized for that specific line item.
- Sales tax is captured.
- Staff commissions trigger based on completion, rather than initial booking.

## Wedding Orders

Wedding transactions follow the exact same architecture but enforce group-level constraints:
- They are tied to a `wedding_party`.
- The financial `Transactions` can be paid for via "Group Pay" disbursements.
- The logistical `Fulfillment Orders` still track the physical movement of the suits and rentals independently of who paid the balance.
- Shared Orders views should continue to show the linked party and member context so staff do not mistake a Wedding order for a generic open order.

### Wedding Member Nomenclature

To maintain the v0.2.0 boundaries, wedding members use two distinct links:
1. **`transaction_id` (The Financial Anchor)**: Links the member to their financial receipt/checkout (`transactions` table). Use this for balances, deposits, and payments.
2. **`fulfillment_order_id` (The Logistical Link)**: Individual items for a member (found in `transaction_lines`) link to the logistical `fulfillment_orders` table. Use this to track if a suit has been ordered from a vendor or received in-store.

### Integrated Wedding Hub (v0.2.1+)

In v0.2.1, the Wedding Management Hub is integrated as a first-class workspace within the POS shell. 
- **Navigation Context**: Navigating to a wedding party from the POS (e.g., via the Register Dashboard or a Search drawer) keeps the user in **POS mode**.
- **Deep Linking**: The POS shell uses a `pendingWmPartyId` state to initialize the Hub with the correct party context immediately upon switching tabs.
- **Unified Auth**: Like other POS-mirrored workspaces, the Hub respects the authenticated staff member's permissions and uses the register's operational context for actions.

## Developer Guidelines — Invariants & Anti-Patterns

### Shadowing of `transaction_id`

When working in `transaction_checkout.rs` or other financial handlers, avoid shadowing the **Retail Transaction ID** (the root purchase) with a **Payment Transaction ID** (the individual tender movement). 

- **Retail Transaction ID**: Represents the overall customer purchase (`transaction_id`).
- **Payment Transaction ID**: Represents a specific payment event in `payment_transactions` (name this `payment_tx_id`).

Failure to maintain distinct naming leads to **Foreign Key violations** in the `payment_allocations` table, as the system may attempt to allocate a payment to its own ID rather than the parent retail transaction.

### Case-Insensitive Tax Categories

Always treat `tax_category` strings (e.g., `Clothing`, `Footwear`) as case-insensitive in both the Rust and TypeScript logic. The POS and server must normalize these categories to lowercase before evaluating $110 tax exemption thresholds to prevent parity mismatches.
