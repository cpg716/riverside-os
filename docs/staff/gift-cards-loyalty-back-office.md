# Gift Cards and Loyalty (Back Office)

**Audience:** Managers and leads.

**Where in ROS:** Back Office has two top-level tabs: **Gift Cards** and **Loyalty**. Each has its own subsections (see below).

**Related permissions:** **gift_cards.manage** gates the whole **Gift Cards** tab. **Loyalty** uses **loyalty.program_settings** and/or **loyalty.adjust_points** depending on subsection (see [permissions-and-access.md](permissions-and-access.md)).

---

## How to use these tabs

Use **Gift Cards** for card lookup, donated/giveaway issuance, promo gift card issuance, and voids. Use **Loyalty** for points economics. Cashiers redeem gift cards in POS, but Riverside now checks the real card type during checkout so purchased, loyalty, donated, and promo cards follow the right accounting path.

Purchased gift cards are sold or reloaded from **Register** only. Do not issue customer-paid gift card value from Back Office.

Gift card codes are normalized to uppercase for scanner workflows. Reusing a depleted physical card preserves all prior event history on the same code. Cards with a positive, unexpired balance can be topped up through the matching workflow. Expired purchased cards with remaining balance must be swept through QBO breakage review before reuse; expired loyalty, donated, and promo balances are closed as non-liability value before the code is reassigned.

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
4. If the code was previously depleted, Riverside reactivates the same card record and keeps prior history. If it had an expired non-liability balance, Riverside closes the expired balance before loading the new approved value.

### Issue Promo

**Purpose:** Event, bridal show, community, or store-promotion issuance. Promo cards expire after one year and do not use the purchased-card liability path.

1. **Gift Cards** → **Issue Promo**.
2. Enter the card code, amount, and **event name**.
3. Link a customer if the card is assigned to one person.
4. Add notes for finance/support context if needed.
5. Confirm the new card appears in **Gift Cards** with the event name.
6. Promo codes can be reused after depletion; the new event name is saved on the card record.

---

## Loyalty

### Monthly Eligible

**Purpose:** Review who qualifies for periodic rewards before you message or fulfill perks.

1. **Loyalty** → **Monthly Eligible** (requires **loyalty.program_settings**).
2. Select the customers you want to fulfill in this batch.
3. Click **Start Batch**.
4. For each customer, scan one loyalty gift card per reward block. With the standard 5,000-point / $50 program, a customer with 15,000 points gets three separate $50 gift cards.
5. ROS prints one award letter after the customer has no more reward blocks available. The letter can include the issue date, one-year expiration date, card count, card codes, and card table from the template.
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
3. Use **Save Template** when only the award-letter wording changed. Use **Save Changes** when reward economics changed.
4. Available letter tags include `{{first_name}}`, `{{reward_amount}}`, `{{total_reward_amount}}`, `{{card_code}}`, `{{card_codes}}`, `{{card_count}}`, `{{cards_table}}`, `{{issue_date}}`, and `{{expiration_date}}`.
5. Test with a **low-value** internal customer account if policy allows.

---

## POS coordination

If POS says a gift card type does not match, check the card record in Back Office first. Purchased cards should be sold/reloaded from **Register** and redeemed as **Paid**. Loyalty reward cards should be redeemed as **Loyalty**. Donated cards should be redeemed as **Donated**. Promo gift cards should be redeemed as **Promo**.

Expired purchased-card balances post to gift card breakage during QBO proposal generation. Loyalty, donated, and promo cards expire after one year but do not create purchased-card breakage because they are not customer-paid liabilities.

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
