# Metabase Field Modeling Checklist (Riverside OS)

This is the practical follow-through for the **reporting readability contract**.  
Use it when configuring the **Metabase data model** so staff see **human-readable business labels** instead of UUIDs, raw enum strings, and internal-only join fields.

Companion:
- [METABASE_REPORTING.md](./METABASE_REPORTING.md)
- [PLAN_METABASE_INSIGHTS_EMBED.md](./PLAN_METABASE_INSIGHTS_EMBED.md)

---

## Goal

Metabase should feel like a **store intelligence workspace**, not a database browser.

That means:

- visible fields should prefer **display ids**, **names**, **dates**, and **business labels**
- raw UUIDs should normally be **hidden**
- views should be organized around **business grain**
- saved questions and dashboards should use the **curated reporting views**, not raw app tables

---

## Global rules

Apply these rules across the `reporting` schema:

1. **Hide by default**
   - `*_id` UUID fields
   - internal metadata / JSON fields
   - technical helper columns that are only useful for joins

2. **Show by default**
   - `*_display_id`
   - `*_display_name`
   - `customer_name` / `customer_display_name`
   - `operator_name` / `operator_display_name`
   - `primary_salesperson_name` / `primary_salesperson_display_name`
   - dates like `booked_business_date`, `recognition_business_date`, `event_date`

3. **Friendly labels**
   - `transaction_display_id` → `Transaction #`
   - `fulfillment_order_display_id` → `Fulfillment Order #`
   - `customer_display_name` or `customer_name` → `Customer Name`
   - `operator_display_name` or `operator_name` → `Operator`
   - `primary_salesperson_display_name` or `primary_salesperson_name` → `Salesperson`
   - `booked_business_date` → `Booked Business Date`
   - `recognition_business_date` → `Fulfilled Business Date`

4. **Drill-through pattern**
   - Keep UUID fields in the model for relationships and drill-through.
   - Hide them from normal browse so staff do not see them unless an admin explicitly surfaces them.

---

## Model priority

Use these as the primary Metabase sources:

### 1. `reporting.transactions_core`

Use for:
- transaction-level sales
- customer-level booked vs fulfilled reporting
- staff performance
- transaction-level operational dashboards

Visible first:
- `transaction_display_id`
- `booked_business_date`
- `recognition_business_date`
- `status`
- `customer_display_name`
- `customer_company_name`
- `customer_phone`
- `customer_email`
- `operator_display_name`
- `primary_salesperson_display_name`
- `total_price`
- `amount_paid`
- `balance_due`
- `sale_channel`
- `fulfillment_method`

Hide by default:
- `transaction_id`
- `customer_id`

### 2. `reporting.order_lines`

Use for:
- line-level product sales
- best sellers
- margin questions
- line fulfillment analysis

Visible first:
- `order_short_id`
- `order_business_date`
- `order_recognition_business_date`
- `order_status`
- `product_name`
- `sku`
- `customer_display_name`
- `customer_phone`
- `quantity`
- `unit_price`
- `line_extended_price`
- `fulfillment`
- `is_fulfilled`
- `line_extended_cost`
- `line_gross_margin_pre_tax`

Hide by default:
- `line_id`
- `order_id`
- `product_id`
- `variant_id`
- `fulfillment_order_id`
- `customer_id`

### 3. `reporting.fulfillment_orders_core`

Use for:
- logistical order tracking
- pickup / shipment / procurement dashboards
- wedding fulfillment visibility

Visible first:
- `fulfillment_order_display_id`
- `fulfillment_status`
- `customer_display_name`
- `customer_phone`
- `customer_email`
- `wedding_party_name`
- `created_at`
- `fulfilled_at`
- `notes`

Hide by default:
- `fulfillment_order_id`
- `customer_id`

### 4. `reporting.shipments_active`

Use for:
- live shipment dashboards
- carrier/service reporting
- shipping financials and label-cost analysis

Visible first:
- `transaction_display_id`
- `fulfillment_order_display_id`
- `customer_name`
- `customer_phone`
- `status`
- `carrier`
- `service_name`
- `tracking_number`
- `shipping_charged_usd`
- `quoted_amount_usd`
- `label_cost_usd`
- `created_at`

Hide by default:
- `shipment_id`
- `transaction_id`
- `order_id`
- `fulfillment_order_id`
- `customer_id`

### 5. `reporting.alterations_active`

Use for:
- active alterations queue
- overdue fitting/alteration dashboards

Visible first:
- `transaction_display_id`
- `fulfillment_order_display_id`
- `customer_name`
- `customer_phone`
- `customer_email`
- `status`
- `due_at`
- `is_overdue`
- `created_at`
- `updated_at`

Hide by default:
- `alteration_id`
- `transaction_id`
- `order_id`
- `fulfillment_order_id`
- `customer_id`

### 6. `reporting.payment_ledger`

Use for:
- tender breakdowns
- payment audit
- payment-linked customer and transaction review

Visible first:
- `business_date`
- `category`
- `status`
- `payment_method`
- `check_number`
- `gross_amount`
- `merchant_fee`
- `net_amount`
- `payer_name`
- `payer_phone`
- `primary_transaction_display_id`
- `linked_transaction_display_ids`
- `linked_customer_names`
- `card_brand`
- `card_last4`

Hide by default:
- `id`
- `payment_transaction_id`
- `payer_id`
- `linked_transaction_id`
- `stripe_intent_id` for staff-facing models unless explicitly needed

### 7. `reporting.merchant_reconciliation`

Use for:
- merchant settlement review
- Stripe fee / net settlement analysis

Visible first:
- `occurred_at`
- `payment_method`
- `amount`
- `merchant_fee`
- `net_amount`
- `transaction_display_id`
- `linked_transaction_display_ids`
- `linked_customer_names`
- `revenue_recognition_date`
- `tax_commission_basis_date`

Hide by default:
- `transaction_id`
- `payment_transaction_id`
- `order_id`

### 8. `reporting.wedding_party_economics`

Use for:
- wedding revenue and margin dashboards
- party-level health reporting

Visible first:
- `wedding_party_name`
- `event_date`
- `groom_name`
- `bride_name`
- `wedding_salesperson_name`
- `member_count`
- `order_count`
- `total_revenue`
- `total_cost`
- `total_profit`
- `margin_percent`
- `free_suits_marked`

Hide by default:
- `wedding_party_id`

### 9. `reporting.loyalty_point_ledger`

Use for:
- loyalty movement audit
- staff adjustment review

Visible first:
- `created_at`
- `customer_display_name`
- `customer_phone`
- `customer_email`
- `transaction_display_id`
- `reason`
- `delta_points`
- `balance_after`
- `created_by_staff_name`

Hide by default:
- `id`
- `customer_id`
- `transaction_id`
- `order_id`
- `created_by_staff_id`
- `metadata`

### 10. `reporting.loyalty_reward_issuances`

Use for:
- reward issuance tracking
- customer reward consumption

Visible first:
- `created_at`
- `customer_display_name`
- `customer_phone`
- `customer_email`
- `transaction_display_id`
- `points_deducted`
- `reward_amount`
- `applied_to_sale`
- `issued_by_staff_name`

Hide by default:
- `id`
- `customer_id`
- `transaction_id`
- `order_id`
- `issued_by_staff_id`
- `remainder_card_id`

### 11. `reporting.order_loyalty_accrual`

Use for:
- points-earned reporting by sale / staff / customer

Visible first:
- `transaction_display_id`
- `order_business_date`
- `order_status`
- `customer_display_name`
- `customer_phone`
- `customer_email`
- `points_earned`
- `product_subtotal`
- `total_price`
- `amount_paid`

Hide by default:
- `transaction_id`
- `order_id`
- `customer_id`

### 12. `reporting.loyalty_customer_snapshot`

Use for:
- customer loyalty leaderboard
- current balance and lifetime earn/redeem summaries

Visible first:
- `customer_display_name`
- `customer_code`
- `phone`
- `email`
- `current_balance`
- `lifetime_earned_from_orders`
- `lifetime_points_redeemed`
- `net_manual_adjustments`
- `rewards_issued_count`
- `total_reward_dollars_issued`

Hide by default:
- `customer_id`
- keep `first_name` / `last_name` hidden if `customer_display_name` is used as the main label

---

## Recommended dashboard anchors

Use these source views as the anchor for curated dashboards:

- **Executive Sales Overview** → `transactions_core`
- **Staff Performance** → `transactions_core`
- **Product & Margin** → `order_lines`
- **Shipping Operations** → `shipments_active`
- **Alterations Queue** → `alterations_active`
- **Payments & Settlement** → `payment_ledger`, `merchant_reconciliation`
- **Weddings** → `wedding_party_economics`, `fulfillment_orders_core`
- **Loyalty** → `loyalty_customer_snapshot`, `loyalty_point_ledger`, `order_loyalty_accrual`

---

## Metabase admin steps

For each primary reporting view:

1. Open **Admin → Table Metadata**
2. Choose the `reporting` schema table/view
3. Hide UUID fields and low-signal technical columns
4. Rename the visible fields to business-friendly labels
5. Set semantic types where useful
   - Email
   - Phone
   - Currency
   - Category
   - Created At / Event Date / Business Date
6. For dashboard-first views, reorder fields so business labels appear near the top
7. Rebuild or refresh saved questions so they use readable fields first

---

## Quality bar

Use this quick test:

If a floor manager opens a table in Metabase and sees mostly:
- names
- transaction numbers
- dates
- dollars
- statuses

then the model is healthy.

If they mostly see:
- UUIDs
- raw ids
- technical helper fields
- cryptic code names

then the model still needs cleanup.
