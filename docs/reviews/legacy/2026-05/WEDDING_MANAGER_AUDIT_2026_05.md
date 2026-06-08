# Audit Report: Wedding Manager Subsystem (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-08
**Version Audited:** v0.85.0
**Auditor:** Devin (AI assistant)
**Scope:** Party model, member lifecycle, Morning Compass, SSE real-time events, wedding ledger, group disbursements, activity audit trail

---

## 1. Executive Summary

The Wedding Manager is the **differentiating subsystem** that tailors Riverside OS for formalwear retail. It provides a comprehensive party-centric data model, real-time dashboard via SSE, group disbursement payments, and a complete audit trail. The implementation is mature and well-integrated with the checkout, order lifecycle, and deposits subsystems.

**Overall Status:** Production Ready — 1 finding (informational), 0 blockers.

---

## 2. Party Data Model

### 2.1 Schema
- `wedding_parties` — core party entity with event date, groom/bride contacts, venue, salesperson, suit variant selection, style/price info, and soft-delete (`is_deleted`).
- `wedding_members` — individual party members linked to `customers`, with measurement tracking (`suit`, `waist`, `vest`, `shirt`, `shoe`), lifecycle booleans (`measured`, `suit_ordered`, `received`, `fitting`, `pickup_status`), lifecycle dates, ordered items/accessories, contact history, and pin notes.
- `wedding_activity_log` — audit trail per party with actor name, action type, description, and arbitrary metadata.

### 2.2 Member Lifecycle Tracking
Each member progresses through:
```
Needs Measure → Measured → Suit Ordered → Received → Fitting → Pickup Complete
```
With corresponding date fields (`measure_date`, `ordered_date`, `received_date`, `fitting_date`, `pickup_date`).

Members also have:
- `is_free_suit_promo` — flags promotional suit programs
- `customer_verified` — confirms customer identity linkage
- `import_customer_name`/`import_customer_phone` — preserved from data migration
- `alteration_status` — derived via subquery from most recent `alteration_orders` entry
- `suit_variant_id` — links to the party-level or member-specific suit selection

### 2.3 Party Queries
- `query_party_list_page` uses `QueryBuilder` for dynamic filtering with parameterized binds (safe from SQL injection).
- Search leverages Meilisearch when available, falling back to PostgreSQL `ILIKE` patterns with a graceful warning on Meilisearch failure.
- Phone search normalizes to digits-only via `digits_only()` before pattern matching against `groom_phone_clean` / `bride_phone_clean`.

---

## 3. Morning Compass Dashboard

### 3.1 Architecture
`get_morning_compass_bundle` assembles:
- `CompassStats` — aggregated counts (needs_measure, needs_order, overdue_pickups, rush_orders)
- Detailed action rows for each category
- Today's floor staff schedule

Uses `tokio::try_join!` to execute the 4 detail queries in parallel.

### 3.2 Finding: Compass Stats Query Structure
**Severity:** Informational
**Location:** `weddings.rs:52-78`

The aggregate stats query uses a `FULL OUTER JOIN` between `wedding_members/wedding_parties` and `transactions`:
```sql
FROM wedding_members wm
JOIN wedding_parties wp ON wm.wedding_party_id = wp.id
FULL OUTER JOIN transactions o ON o.customer_id = wp.id
```

The join condition `o.customer_id = wp.id` joins transactions where the customer_id happens to equal the wedding party UUID. Since `customer_id` is a customer UUID and `wp.id` is a wedding party UUID, this will almost never match unless there's a deliberate ID overlap. The `rush_orders` count filter operates only on the `o` alias, so it effectively counts rush orders from the FULL OUTER JOIN's right side where no match exists — which means it's counting from all transactions (NULL-joined).

However, in the **detail queries** (`list_rush_orders`, line 155), rush orders are correctly queried from `transactions o LEFT JOIN customers c` without any wedding join. The stats count and the detail list will likely diverge.

**Impact:** The rush_orders count in the compass stats may be incorrect, but the detail list shown to users is correct. Since the detail is limited to 20 rows, the count serves mainly as an indicator.

**Recommendation:** Align the stats query with the detail query by either removing the FULL OUTER JOIN or computing the rush_orders count separately.

---

## 4. SSE Real-Time Events

### 4.1 Implementation (`weddings.rs:267`)
```rust
async fn wedding_events_stream(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>> + Send>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let rx = state.wedding_events.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|item| match item {
        Ok(json) => Some(Ok(Event::default().data(json))),
        Err(BroadcastStreamRecvError::Lagged(n)) => {
            tracing::debug!(skipped = n, "wedding sse client lagged");
            None
        }
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}
```

### 4.2 Assessment
- **Authorization**: `require_weddings_view` is called before subscribing — no unauthorized SSE access.
- **Broadcast channel**: Uses `tokio::sync::broadcast` via `state.wedding_events`. Each subscriber gets a clone of the receiver.
- **Lag handling**: Lagged clients (too slow to consume) skip missed events and log at debug level. Events are not queued indefinitely.
- **Keep-alive**: 15-second interval prevents proxy/firewall timeout.
- **Route**: Mounted at `/events` under the wedding router.

**Assessment:** Sound implementation. The lag-skip behavior is appropriate for a real-time dashboard — stale data is better discarded than queued.

---

## 5. Group Disbursements & Payment Flow

### 5.1 Disbursement at Checkout
During `execute_checkout`, if `wedding_disbursements` are present:
1. Each disbursement targets a `wedding_member_id` with an `amount`.
2. The system looks up whether that member has an open order (unfulfilled transaction linked via `wedding_member_id`).
3. **If order exists**: A `payment_allocation` is inserted targeting the order, with `kind: wedding_group_disbursement` metadata. The target order's `amount_paid` is incremented and totals recalculated.
4. **If no order exists**: The amount is credited to the beneficiary customer's `customer_open_deposit_account` via `credit_party_split`, creating a deposit balance for future use.
5. A deferred wedding activity log entry records the disbursement.

### 5.2 Validation
- Disbursement amounts must be non-negative
- Total disbursements cannot exceed `amount_paid`
- Combined disbursements + order payments cannot exceed `amount_paid`
- Refund checkouts cannot include disbursements
- RMS payment collections cannot include disbursements

---

## 6. Wedding Ledger

The `try_load_party_ledger` function builds a comprehensive financial view:
- **Summary**: Total transaction value, total paid, and balance due across all party members
- **Line items**: A `UNION ALL` query combining:
  1. Order lines (from `transactions` linked via `wedding_member_id`)
  2. Group payout allocations (from `payment_allocations` with `kind = wedding_group_disbursement`)
  3. Direct member payments (from `payment_transactions` with `wedding_member_id`)
- Each line includes a `fulfillment_profile` classification (takeaway, mixed, wedding_order, special_order, other) derived via subquery.

---

## 7. Activity Audit Trail

`insert_wedding_activity` records every significant event:
- Actor defaults to "Riverside POS" if empty
- Each entry captures: party ID, optional member ID, actor name, action type, description, and arbitrary JSON metadata
- Called from multiple workflows: member updates, disbursements, suit selection changes, status transitions

---

## 8. Conclusion

The Wedding Manager subsystem is well-designed for its domain. The party model, member lifecycle tracking, financial ledger, and real-time SSE dashboard provide comprehensive wedding retail management. The integration with checkout disbursements and deposit accounts correctly handles the complex "group pays for individuals" payment pattern unique to wedding retail.

The Morning Compass stats query has a minor structural issue with the rush orders FULL OUTER JOIN, but the detail display is correct.

**Status: PRODUCTION READY**
