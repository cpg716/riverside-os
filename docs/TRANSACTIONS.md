# Transactions Documentation Index

**Status:** Canonical transactions front door. Start here when changing checkout records, fulfillment-order logistics, deposits, layaways, pickup, returns, refunds, exchanges, or wedding order linkage.

Riverside OS separates financial and logistical truth:

- **Transactions** (`transactions`, `TXN-...`) are the financial ledger records for checkout, payments, balances, receipts, refunds, and reporting.
- **Fulfillment Orders** (`fulfillment_orders`, `ORD-...`) are the logistical records for physical goods, procurement, shipment, special orders, custom orders, wedding orders, and pickup readiness.

Never use **Order** alone when the distinction matters. Say **Transaction** for the financial ledger and **Fulfillment Order** for logistics.

## Where To Go

| Need | Canonical doc | Notes |
| --- | --- | --- |
| Domain model and terminology | [`TRANSACTIONS_AND_WEDDING_ORDERS.md`](TRANSACTIONS_AND_WEDDING_ORDERS.md) | Transaction vs Fulfillment Order split, wedding member linkage, checkout inventory impact, and ID naming rules. |
| Pickup, partial fulfillment, and shipping | [`TRANSACTION_FULFILLMENT_AND_PICKUP.md`](TRANSACTION_FULFILLMENT_AND_PICKUP.md) | Register and Back Office pickup flows, stock effects, and fulfillment permissions. |
| Returns, refunds, exchanges, voids | [`TRANSACTION_RETURNS_EXCHANGES.md`](TRANSACTION_RETURNS_EXCHANGES.md) | Refund queue, line returns, exchange links, POS exchange wizard, and RBAC. |
| Deposits and open deposits | [`DEPOSIT_OPERATIONS.md`](DEPOSIT_OPERATIONS.md) | Liability treatment, deposit keypad, wedding group pay disbursements, release, and forfeiture. |
| Layaway lifecycle | [`LAYAWAY_OPERATIONS.md`](LAYAWAY_OPERATIONS.md) | Layaway booking, inventory flags, payments, pickup, and forfeiture. |
| Wedding group pay and returns | [`WEDDING_GROUP_PAY_AND_RETURNS.md`](WEDDING_GROUP_PAY_AND_RETURNS.md) | Party disbursements, member transactions, open deposits, and refund allocation. |
| Transaction record hub | [`TRANSACTION_RECORD_HUB_GUIDE.md`](TRANSACTION_RECORD_HUB_GUIDE.md) | Staff-facing transaction detail hub behavior. |
| Reporting basis | [`REPORTING.md`](REPORTING.md) | Booked vs fulfilled reporting, recognition timing, Metabase, and reports. |
| Staff procedure | [`staff/transactions-back-office.md`](staff/transactions-back-office.md) | Back Office transaction workflow for staff. |

## Maintenance Rules

- Transaction API references should point to `server/src/api/transactions.rs`.
- Checkout logic references should point to `server/src/logic/transaction_checkout.rs`.
- Recalculation references should point to `server/src/logic/transaction_recalc.rs`.
- Staff docs should link to `docs/staff/transactions-back-office.md`, not the former `orders-back-office.md`.
- If workflow behavior changes, update the relevant specialized doc and the staff procedure in the same PR when practical.
