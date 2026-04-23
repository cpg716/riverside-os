# Commission & SPIFF Operations

Riverside OS provides a unified **Commission Manager** within the Staff module to centralize payout tracking, SPIFF promotional logic, and granular commission rate overrides.

## Commission Manager Workspace

Access this workspace via **Staff → Commission Manager**. It requires the `staff.manage_commission` permission.

The workspace is divided into three primary functional areas:
1. **Payout Ledger**: A high-density log of every commission-eligible line item sold. It displays the salesperson, order reference, calculated commission, and status.
2. **Promo Manager (Rules)**: Manage specificity-based overrides and flat SPIFF bonuses.
3. **Combo Rewards**: Configure multi-item bundles that trigger incentives for single-salesperson transactions.

## Fulfillment-based payroll rule

Commission payouts follow the **fulfillment / recognition** clock, not the original booking date.

- **Pickup / takeaway:** payout timing follows the fulfilled / pickup moment.
- **Shipments:** payout timing follows the first qualifying shipment recognition event.
- **Effective-dated staff rate changes:** Riverside can apply a new base rate from a chosen date and reconcile eligible unfinalized lines from that date.
- **Salesperson corrections:** reassignment recalculates immediately for eligible unfinalized lines.
- **Finalized payouts:** once a line has been paid out and finalized, Riverside preserves the locked amount and requires accounting adjustment instead of silent rewrite.

---

## Specificity Hierarchy

When calculating commissions, the engine evaluates rules in a strict order of specificity. The first rule that matches a line item is applied:

1. **Variant Rule**: Matched by a specific SKU's `variant_id`.
2. **Product Rule**: Matched by a `product_id`.
3. **Category Rule**: Matched by a `category_id`.
4. **Category Default**: Inherited from the category's legacy `override_commission_rate` if no rules match.
5. **Staff Base Rate**: The fallback rate defined on the staff profile.

Rules can provide either a **percentage override** (e.g., 5% instead of the staff's usual 2%) or a **fixed SPIFF amount** (e.g., $10 bonus per item sold), or both.

---

## Combo Rewards (Bundles)

Combo rewards are multi-item incentives designed to encourage bundle sales (e.g., a "Wedding Suit Bundle" consisting of 1 Suit, 1 Tie, and 1 Shirt).

### Trigger Rules
- **Quantity Required**: Each item in the combo must meet the minimum quantity required.
- **Single Salesperson Requirement**: Most importantly, **all items in the bundle must be attributed to the same salesperson** on the order. If multiple staff members split the items, the combo incentive is not triggered.
- **Auto-Detection**: The system automatically evaluates satisfied combos during checkout and inserts a reward line item into the order.
- **Configuration**: Use the **Configure Combo** modal within the Promo Manager to define target categories and quantities.

---

## Internal Incentive Lines (`is_internal`)

SPIFF and Combo rewards are recorded as **internal line items** within an order.
- They have a price of **$0.00**.
- The reward amount is stored in the `calculated_commission` column.
- They are flagged as `is_internal = TRUE` in the database.

> [!IMPORTANT]
> Internal lines are automatically filtered from all customer-facing receipts (Thermal ZPL, Studio HTML, SMS, and Email). They are intended strictly for payroll and staff auditing.

---

## Receipt Privacy Standards

To protect staff privacy while providing a personal touch, salesperson names on customer receipts follow the **First Name + Last Initial** format:
- Example: "Christopher Green" -> **"Christopher G."**
- Example: "Mary Watson" -> **"Mary W."**

This formatting is enforced using the `staff_name_for_customer_receipt` helper in `server/src/logic/receipt_privacy.rs`.
