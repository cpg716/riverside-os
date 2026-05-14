# Gift Cards and Loyalty (Back Office)

**Audience:** Managers and leads.

**Where in ROS:** Back Office has two top-level tabs: **Gift Cards** and **Loyalty**. Each has its own subsections (see below).

**Related permissions:** **gift_cards.manage** gates the whole **Gift Cards** tab. **Loyalty** uses **loyalty.program_settings** and/or **loyalty.adjust_points** depending on subsection (see [permissions-and-access.md](permissions-and-access.md)).

---

## How to use these tabs

Use **Gift Cards** for card lookup, donated/giveaway issuance, promo gift card issuance, and voids. Use **Loyalty** for points economics. Cashiers redeem gift cards in POS, but Riverside now checks the real card type during checkout so purchased, loyalty, donated, and promo cards follow the right accounting path.

Purchased gift cards are sold or reloaded from **Register** only. Do not issue customer-paid gift card value from Back Office.

---

## Gift Cards

### Card Inventory

**Purpose:** Find cards, confirm **balance** and **status** (active vs void), and review recent card activity.

1. **Gift Cards** → **Card Inventory**.
2. Search by **full code**, **last four**, or customer link if the UI exposes it.
3. Select a row to read **initial value**, **remaining balance**, **status**, **customer link**, and **recent activity**.
4. Use the activity panel to confirm whether the card was **issued**, **loaded**, **used at checkout**, **refunded to card**, or **voided**.
5. **Void** only with written SOP — it changes **liability** and may need accounting notice.

### Issue Donated

**Purpose:** Marketing or charity issuance — usually manager-approved.

1. **Gift Cards** → **Issue Donated**.
2. Complete fields; add **reason** in notes if the form supports it.
3. File any **paper approval** your finance team requires.

### Issue Promo

**Purpose:** Event, bridal show, community, or store-promotion issuance. Promo cards expire after one year and do not use the purchased-card liability path.

1. **Gift Cards** → **Issue Promo**.
2. Enter the card code, amount, and **event name**.
3. Link a customer if the card is assigned to one person.
4. Add notes for finance/support context if needed.
5. Confirm the new card appears in **Gift Cards** with the event name.

---

## Loyalty

### Monthly Eligible

**Purpose:** Review who qualifies for periodic rewards before you message or fulfill perks.

1. **Loyalty** → **Monthly Eligible** (requires **loyalty.program_settings**).
2. Select the customers you want to fulfill in this batch.
3. Click **Start Batch**.
4. For each customer, scan the loyalty gift card, choose the points block being redeemed, and click **Issue and print letter**.
5. If the customer has enough points for another reward, scan the next card for that same customer. Otherwise continue to the next selected customer.
6. When the batch is complete, print the mailing labels for the completed customers.
7. Open **Reward History** if you need to reprint an award letter or an individual mailing label.

### Adjust Points

**Purpose:** Correct mistakes or apply goodwill **points** with an audit trail.

1. **Loyalty** → **Adjust Points** (requires **loyalty.adjust_points**).
2. Search **customer**; confirm **identity** before reading balance aloud.
3. Enter **delta** (+/-) and **reason** / note.
4. Save; ask the customer to **re-open** loyalty on POS or their next visit to confirm.
5. Review **Loyalty Activity** to confirm whether the customer recently earned points, had a reward issued, or lost points after a return or refund.
6. For couple-linked customers, loyalty follows the primary linked account. Adjustments, reward issuance, and history all resolve to that shared primary loyalty record even if staff opened the partner profile first.

### Program Settings

**Purpose:** **Earn rates**, **tiers**, caps, and messaging — **high impact**.

1. **Loyalty** → **Program Settings** (**loyalty.program_settings**).
2. Change **one** variable at a time when possible; document **before/after** for the team chat or logbook.
3. Test with a **low-value** internal customer account if policy allows.

---

## POS coordination

If POS says a gift card type does not match, check the card record in Back Office first. Purchased cards should be sold/reloaded from **Register** and redeemed as **Paid**. Loyalty reward cards should be redeemed as **Loyalty**. Donated cards should be redeemed as **Donated**. Promo gift cards should be redeemed as **Promo**.

## Helping a coworker

- **Gift card at register:** Look up in **Card Inventory** first; compare **balance**, **status**, and the most recent activity before changing anything.
- **Loyalty dispute:** Open **Loyalty Activity** first; do not re-adjust without manager approval if the amount is large.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Card balance wrong | **Card Inventory** detail | Audit / manager |
| Cannot issue | **403** or over limit | **gift_cards.manage** |
| Loyalty subsection missing | Effective permissions | [permissions-and-access.md](permissions-and-access.md) |
| Adjust rejected | Exceeds program rule | Manager |
| Double tender at POS | One **void** of duplicate line | Orders lead |

## When to get a manager

- **Fraud** suspicion on gift cards.
- **Accounting** period-end **liability** true-up.
- **Legal** review for loyalty **expiration** or **tier** changes.

---

## See also

- [pos-gift-cards.md](pos-gift-cards.md)
- [pos-loyalty.md](pos-loyalty.md)
- [../STAFF_PERMISSIONS.md](../STAFF_PERMISSIONS.md)

**Last reviewed:** 2026-04-04
