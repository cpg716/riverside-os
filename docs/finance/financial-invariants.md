# Riverside OS Financial Invariants

This document is the source policy for release-gated financial checks. If a workflow moves money, inventory value, tax, tender, liability, freight, discount, or margin, it must obey these rules and must be covered by `npm run check:financial-invariants`.

## Non-Negotiable Rules

1. Supplier inbound freight is separate from merchandise item cost.
   - Receiving item cost, weighted average cost, inventory asset value, and receiving merchandise clearing use invoice unit cost only.
   - Supplier freight posts separately through inbound freight expense and receiving clearing.
   - Supplier freight must not be mixed with customer shipping.

2. Customer shipping is separate from supplier freight.
   - Customer-paid shipping is the amount charged to the customer on shipped orders.
   - Customer shipping posts as shipping income on the recognized fulfillment/shipment business date.
   - Free-shipping or shipping discount promotions must remain explicit promotion/discount evidence. They must not become supplier freight and must not silently disappear.

3. Merchandise revenue, COGS, tax, and discounts remain distinct.
   - Revenue is merchandise net of line discounts, not tender and not tax.
   - COGS is based on stored merchandise unit cost and recognized quantity.
   - Discounts and comps must be visible in reporting and cannot be folded into tax, shipping, tender, or inventory cost.

4. Booked and fulfilled activity are separate.
   - Order-style, layaway, custom, and wedding-order lines do not recognize revenue/COGS until fulfillment/pickup or the configured shipment recognition event.
   - Deposits collected before fulfillment are liabilities until release.

5. Tender and liability movement are separate from revenue.
   - Cash, check, cards, store credit, open deposit, RMS, and gift card tenders are payment movement.
   - Purchased gift-card sales create liability, not revenue.
   - Paid gift-card redemption relieves liability. Loyalty, donated, or promo gift-card redemption posts to the configured promotional expense path.
   - Store credit and open deposit redemption relieve their liabilities, not cash/card tender revenue.

6. Wedding program economics must remain auditable.
   - Free groom/groomsmen promotional suits are comps/discounts, not ordinary paid sales.
   - Wedding party reports must show paid units, free/comped units, merchandise revenue, merchandise cost, gross profit, promo cost/discount, and margin without hiding the free item impact.

7. QBO journal proposals must preserve the above separation.
   - The daily QBO staging journal must show separate lines for merchandise receiving, inbound supplier freight, customer shipping income, tax, tenders, liabilities, deposits, gift cards, and inventory movement.
   - Any unmapped required account must produce a warning or blocker; the system must not silently post to the wrong category.

## Required Release Gates

`npm run check:financial-invariants` must pass before a go-live build or release retag. The gate checks:

- Source-level formulas for receiving, freight, customer shipping, gift cards, deposits, and QBO staging.
- User-facing labels so misleading internal names do not appear in reports.
- Required E2E coverage files and scenario names for high-risk financial workflows.
- Production SQL probe coverage for deployment/database signoff, including discount evidence,
  customer/employee discount linkage, commission event completeness, commission duplicate
  detection, return commission adjustments, QBO balance state, inventory risk, register
  state, shipping/freight separation, and backup freshness.

Live store-data drills are still required for accounting signoff. The automated gate prevents known classes of financial mistakes from entering a release, but it does not replace comparing a real QBO sandbox/company sync against Riverside reports.
