# POS Loyalty

**Audience:** Cashiers applying loyalty at the register.

**Where in ROS:** POS mode → left rail **Loyalty** (star icon).

**Related permissions:** **loyalty.program_settings** opens the POS Loyalty workspace. **loyalty.adjust_points** controls the separate Back Office adjustment screen.

---

## How to use this screen

**Loyalty** covers **earning points** on qualifying sales and **issuing loyalty reward cards** when a customer reaches the threshold. Riverside currently earns 5 points per whole eligible merchandise dollar; service, excluded, internal, gift-card-load, and RMS Charge payment lines do not earn points.

## Common tasks

### Attach customer before loyalty

1. **Register** → attach **customer** to cart if SOP requires it for earn/redeem.
2. POS → **Loyalty** to check who is eligible and issue a reward card when needed.
3. Confirm the customer’s **new points balance** after any reward issuance.
4. Use **Back Office → Loyalty → Adjust Points → Loyalty Activity** or **Reward History** to confirm the last earn, reward issue, or clawback before you answer a dispute.
5. If the customer is linked as a couple, loyalty follows the shared primary loyalty account. POS will show the shared balance and history even if you searched the partner’s profile.

### Issue a reward card

1. Confirm the configured **threshold** is met. Riverside enforces a minimum threshold of 5,000 points.
2. Choose how many configured reward blocks to load on this card. With a $50 reward, 2 blocks loads $100.
3. Scan or enter a **loyalty gift card code** in the reward dialog.
4. Issue the selected value to that card. Repeat with another card, or leave unused blocks on the loyalty account for later.
5. If the customer is checking out right now, complete the sale separately in the register.

Use a row's **Redeem Reward** button for one customer. For a group, select the customers, choose **Start Batch**, then choose the reward amount for each scanned card. Print letters and labels after the batch from the same fulfillment window.

### Customer says “I should have more points”

1. Read **balance** on screen.
2. Open **Back Office → Loyalty → Adjust Points**, select the customer, and read **Loyalty Activity**. It shows whether points were earned, a reward card was issued, or points were removed after a return or refund.
3. Confirm the sale has reached fulfillment recognition. Takeaway sales earn at completed checkout; ordered, custom, wedding, shipped, and layaway lines earn after pickup / fulfillment.
4. If dispute, **do not** adjust at POS unless trained — send to **Back Office → Loyalty → Adjust Points** with manager.
5. Check **recent returns**; points may have **clawed back**.

## Helping a coworker

- **“Issue reward card” is unavailable.** — Customer is below the threshold or reward settings are unavailable.
- **“Why did the sale total not change?”** — Loyalty redemption issues a reward card only. It does not change the open sale total.
- **“Double earn fear.”** — Void and re-ring **only** with lead approval.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| No earn on sale | Confirm Transaction is fulfilled and category is not excluded | Manager reads **Program Settings**; IT can check `reporting.transaction_status_integrity` |
| Wrong customer points | Detach / reattach profile | Privacy — verify ID |
| Redeem + return loop | See **transactions** return policy | [TRANSACTION_RETURNS_EXCHANGES.md](../TRANSACTION_RETURNS_EXCHANGES.md) |
| Balance API error | Retry once | IT if repeated |

## When to get a manager

- **Goodwill** point grants.
- Changing **expiration** or **tier** rules.

---

## See also

- [gift-cards-loyalty-back-office.md](gift-cards-loyalty-back-office.md)
- [customers-back-office.md](customers-back-office.md)

**Last reviewed:** 2026-08-12
