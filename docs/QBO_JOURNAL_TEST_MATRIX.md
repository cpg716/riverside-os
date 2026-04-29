# QBO daily journal — verification matrix

Use a **sandbox** QuickBooks company and ROS staging data. After `POST /api/qbo/staging/propose`, review `warnings`, `totals.balanced`, and line memos. Use staging drilldown where available.

## Recognition-day revenue (effective qty)

| Scenario | Expect |
|----------|--------|
| Pickup / in-store takeaway fulfilled on date D, no returns | Revenue/COGS/tax from effective qty = sold qty |
| Shipped order label purchased / marked in transit / delivered on date D | Revenue/COGS/tax posts on the shipment recognition date, even when `transactions.fulfilled_at` is null |
| Partial return before journal re-run for D | Revenue/COGS/tax reduced proportionally vs `order_return_lines` |
| Full return of fulfilled line | Category net for that merchandise → 0 for that line’s share |

## Return-day contra (same store-local business date as `order_return_lines.created_at`)

| Scenario | Expect |
|----------|--------|
| Line return + cash/card refund tender on same day | Tender lines use **credit** for negative payment amounts; **debit** category revenue for returned product; **debit** sales tax mapping for returned tax |
| Return with **restock** | Additional **debit** inventory + **credit** COGS for restocked cost |
| Return with no restock | No COGS reversal lines |

## Tenders and refunds

| Scenario | Expect |
|----------|--------|
| Positive `payment_transactions` | Debit to mapped tender (cash in) |
| Negative amounts (refunds) | Credit to same tender account (cash out); memo includes `refund/outflow` |
| Gift card paid liability | Same sign rules; liability / expense mappings unchanged |

## Deposits

| Scenario | Expect |
|----------|--------|
| Deposit release on fulfill date | Category split uses **effective** net per category (post-return) |
| Final payment collected on pickup date | Same-day pickup payment posts as current tender/revenue; only prior deposits release from `liability_deposit` |
| **New Deposit Inflow** | Payments on unfulfilled orders today must correctly credit `liability_deposit` to balance the cash debit. |
| Layaway forfeiture | Prior layaway deposits debit `liability_deposit` and credit `income_forfeited_deposit` on the forfeiture date |

## Regression checks

- [ ] Single tender, single category, balanced journal  
- [ ] Multi-split checkout (multiple tenders)  
- [ ] Gift card `sub_type` `paid_liability` vs `loyalty_giveaway`  
- [ ] Exchange pair (two transactions) does not double-count if only reporting by recognition
- [ ] Shipped transaction has no QBO revenue before shipment recognition event

## Ledger mapping fallbacks (inventory / COGS)

Suit **component swap** cost-delta lines and some **return-day restock** paths use `ledger_mapping` fallbacks when category-specific accounts are not set:

| Fallback key | Role |
|--------------|------|
| **`INV_ASSET`** | Debit/credit inventory asset for restock and swap net cost moves |
| **`COGS_DEFAULT`** | Offset COGS side for swap cost delta when used with **`INV_ASSET`** |

Staging checklist:

- [ ] **`INV_ASSET`** mapped in **`ledger_mappings`** before relying on restock or swap inventory lines  
- [ ] **`COGS_DEFAULT`** mapped for swap COGS offset when swaps occur on the journal date  
- [ ] If **propose** shows a warning about **`INV_ASSET`** missing on a return day with restock COGS, add the mapping and re-propose  

See also **[`SUIT_OUTFIT_COMPONENT_SWAP_AND_QBO.md`](./SUIT_OUTFIT_COMPONENT_SWAP_AND_QBO.md)** for swap accounting notes.

## Operational note

`activity_date` is the store-local business date from `store_settings.receipt_config.timezone` through `reporting.effective_store_timezone()`. QBO uses the same recognition basis as reporting: pickup / in-store takeaway recognizes from fulfillment timestamps, and shipped transactions recognize from the earliest qualifying shipment event (`label_purchased`, `in_transit`, or `delivered`). Re-running **propose** for an older `activity_date` after returns restates that day’s recognition nets. Return-day contra lines appear on the **return** business date. Align with your accountant on recognition policy.
