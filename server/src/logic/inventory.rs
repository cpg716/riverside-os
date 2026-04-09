//! Inventory-domain notes.
//!
//! Inbound PO freight is stored on [`receiving_events`](crate::api::purchase_orders) and is
//! intended to post to QuickBooks using the `COGS_FREIGHT` ledger mapping. Stock receipts use
//! the vendor **raw** unit cost on `inventory_transactions`; freight is not embedded in
//! `landed_cost_component` for that ledger row.
