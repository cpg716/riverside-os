# QBO daily journal — verification matrix

Use a **sandbox** QuickBooks company and ROS staging data. After `POST /api/qbo/staging/propose`, review `warnings`, `totals.balanced`, and line memos. Use staging drilldown where available.

QBO sales posting is **Daily Staging Journal only**. Checkout and Helcim webhook recovery record transactions, payments, allocations, and fulfillment evidence in ROS, but they do not directly post transaction-level revenue journals to QBO.

## Recognition-day revenue (effective qty)

| Scenario | Expect |
|----------|--------|
| Pickup / in-store takeaway fulfilled on date D, no returns | Revenue/COGS/tax from effective qty = sold qty |
| Shipped order label purchased / marked in transit / delivered on date D | Revenue/COGS/tax posts on the shipment recognition date, even when `transactions.fulfilled_at` is null |
| Customer-charged shipping on a completed transaction | Credit mapped **Shipping income** (`income_shipping` / default, or `REVENUE_SHIPPING` fallback) on the same completed business date |
| Supplier inbound freight on a receiving event | Debit mapped **COGS_FREIGHT** and credit **INV_RECEIVING_CLEARING** separately; freight is not added to item cost or inventory asset value |
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
| Helcim card / manual / vault / web checkout payments | All Helcim card methods aggregate to the **`helcim_card`** tender mapping so QBO needs one card-clearing account |
| Helcim merchant fees synced from API | Debit **merchant fee** expense and credit the same Helcim clearing account, leaving clearing at net |
| Helcim reconciliation issue reviewed/resolved/marked expected | No QBO journal change by itself; reconciliation issue workflow is audit history only. Actual bank deposit matching is handled separately in Payments and still does not post to QBO. |
| Helcim actual bank deposit manually recorded or matched to batches | No QBO journal or deposit is created. Matching records bank-cleared evidence inside ROS only and leaves clearing/deposit posting for a separate reviewed workflow. |

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
- [x] Gift card `sub_type` `paid_liability` vs `loyalty_giveaway` / `donated_giveaway` / `promo_gift_card`
- [x] Gift card breakage sweep: Expired purchased liability cards zeroed out, event logged, debits `liability_gift_card` and credits `income_gift_card_breakage` (or `REVENUE_GIFT_CARD_BREAKAGE`)
- [x] Gift card breakage bypass: Expired promotional/donated/loyalty cards (`is_liability = false`) are NOT swept, no breakage event generated, no QBO staging journal entry generated
- [x] Financial invariant release gate: `npm run check:financial-invariants` verifies source formulas, receiving/freight/shipping labels, E2E coverage hooks, and production SQL probes before go-live/retag
- [ ] Shipping income mapping is present before syncing a day with customer-charged shipping
- [ ] Supplier freight mapping (`COGS_FREIGHT` + `INV_RECEIVING_CLEARING`) is present before syncing a day with received freight
- [ ] Exchange pair (two transactions) does not double-count if only reporting by recognition
- [ ] Shipped transaction has no QBO revenue before shipment recognition event

## Ledger mapping fallbacks (inventory / COGS)

Suit **component swap** cost-delta lines, operational inventory moves, and some **return-day restock** paths use `ledger_mapping` fallbacks when category-specific accounts are not set:

| Fallback key | Role |
|--------------|------|
| **`INV_ASSET`** | Debit/credit inventory asset for restock, receiving, adjustment, and swap net cost moves |
| **`COGS_DEFAULT`** | Offset COGS side for swap cost delta when used with **`INV_ASSET`** |
| **`INV_RECEIVING_CLEARING`** | Credit side for received inventory before vendor bill/AP posting |
| **`INV_RTV_CLEARING`** | Debit/credit side for return-to-vendor inventory moves |
| **`INV_SHRINKAGE`** | Expense side for damaged or shrinkage inventory moves |
| **`COGS_FREIGHT`** | Inbound freight/shipping cost from receiving events — separate from merchandise COGS |

Staging checklist:

- [ ] **`INV_ASSET`** mapped in **`ledger_mappings`** before relying on restock or swap inventory lines  
- [ ] **`INV_RECEIVING_CLEARING`** mapped before relying on PO receiving lines in the daily journal
- [ ] **`COGS_DEFAULT`** mapped for swap COGS offset when swaps occur on the journal date  
- [ ] **`COGS_FREIGHT`** mapped before relying on receiving freight lines in the daily journal  
- [ ] If **propose** shows a warning about **`INV_ASSET`** missing on a return day with restock COGS, add the mapping and re-propose  

See also **[`SUIT_OUTFIT_COMPONENT_SWAP_AND_QBO.md`](./SUIT_OUTFIT_COMPONENT_SWAP_AND_QBO.md)** for swap accounting notes.

## Operational note

`activity_date` is the store-local business date from `store_settings.receipt_config.timezone` through `reporting.effective_store_timezone()`. QBO uses the same recognition basis as reporting: pickup / in-store takeaway recognizes from fulfillment timestamps, and shipped transactions recognize from the earliest qualifying shipment event (`label_purchased`, `in_transit`, or `delivered`). Re-running **propose** for an older `activity_date` after returns restates that day’s recognition nets. Return-day contra lines appear on the **return** business date. Align with your accountant on recognition policy.

QBO API posts use deterministic Riverside request ids per staging row. Journal creation and deletion use distinct 44-character identifiers, both within Intuit's 50-character limit. If either call is retried after an ambiguous network failure, the same staging action reuses its request id instead of intentionally creating a duplicate operation.

## Connection health checks

Before relying on sync:
- [ ] **Company Info** returns the expected QBO company name (live Intuit validation)
- [ ] **Token Health** shows `valid` with > 10 minutes remaining, or `refreshable` with a healthy refresh token
- [ ] After token refresh, **Token Health** updates to `valid` with new expiry
- [ ] Intuit Webhooks has the public `/api/auth/qbo/webhook` URL and the matching Development/Production verifier token is saved in Settings
- [ ] A missing, malformed, or bad `intuit-signature` is rejected before the payload enters `qbo_webhook_events`

## Automation checks

- [ ] Auto-propose worker creates a pending row for the previous business date after 2 AM local time
- [ ] Approval captures `approved_by_staff_id` and `approved_at` visible in History detail
- [ ] Re-sync of an already-synced approved row does not create a duplicate JournalEntry (same request id)

## Lifecycle management checks

- [ ] **Revert to Pending**: Approved entry reverts to `pending`; `approved_by_staff_id` and `approved_at` cleared; entry can be re-approved after mapping fix
- [ ] **Revert guard**: Attempting revert on a `pending`, `synced`, or `failed` row returns a conflict error
- [ ] **Retry Failed**: Failed entry re-validates balance + accounts, re-attempts QBO POST, transitions to `synced` on success with new `journal_entry_id`
- [ ] **Retry guard**: Attempting retry on a non-`failed` row returns a conflict error
- [ ] **Retry re-fails gracefully**: If QBO rejects the retry, row returns to `failed` with updated error message
- [ ] **Void Synced**: Synced entry reads SyncToken from QBO, deletes the JournalEntry via `?operation=delete`, marks local row `voided`
- [ ] **Void guard**: Attempting void on a non-`synced` row returns a conflict error
- [ ] **Void + re-stage**: After voiding, proposing the same business date creates a new revision row referencing the voided entry
- [ ] **Audit trail**: All three actions log to `staff_access_log` with correct `event_kind` and staff identity
- [ ] **Permission enforcement**: Revert requires `qbo.staging_approve`; Retry and Void require `qbo.sync`
