# POS Gift Cards

**Audience:** Cashiers selling or redeeming gift cards.

**Where in ROS:** POS mode → left rail **Gift Cards** for lookup; **Register** also has **GIFT CARD** for adding a purchased gift card load to the cart.

**Related permissions:** **gift_cards.manage** for issue/void/list in Back Office; **GIFT CARD** on the register uses the same POS/staff auth as the rest of the register. **Redemption** at tender often works with **POS session** + staff auth per server rules.

---

## How to use this screen

Use POS **Gift Cards** for balance lookup and use the **Register** gift card button when a customer is buying or reloading a purchased gift card. Treat every card as cash equivalent.

## Common tasks

### Sell / load value on a purchased card at the register

1. POS → **Register** → **GIFT CARD** (open register session / signed-in staff).
2. Enter the **load amount** on the keypad, then **scan** (or type) the card code. Codes are normalized to uppercase, so scanner case does not matter.
3. Add the line to the cart.
4. Finish checkout.

The card is only credited after the full sale is paid. If checkout does not complete, the card is not loaded.
After the sale, the receipt summary shows the loaded card as a masked code so staff can confirm the right card was credited.

Purchased cards with a positive, unexpired balance can be added to. Depleted purchased cards can be reused for a new sale; the old event history stays attached to that card code. Expired purchased cards with remaining balance must go through breakage review before they can be reloaded.

### Back Office gift card limits

Back Office is for lookup, void review, donated/giveaway issuance, and promo gift card issuance. Customer-paid purchased gift cards must be sold or reloaded through **Register** so the sale, tender, card event, and gift card liability are tracked together.

### Redeem toward checkout

1. On **tender** screen, choose **gift card**.
2. Scan or type the code.
3. Wait for Riverside to show the verified **Regular**, **Loyalty**, **Donated**, or **Promo** type, expiration, and **Balance before this transaction**.
4. Enter an amount no greater than that verified balance, select **Apply payment**, and complete the rest of the sale if needed.

Riverside does not allow a gift-card payment line until the active card and its balance have been checked. Checkout checks the balance again while saving the sale, so two registers cannot spend the same balance at the same time.
After the sale, the receipt summary shows the gift card type and masked card code in the tender summary.

### Balance inquiry (no sale)

1. **Lookup** only — do not add to cart.
2. Review the **running balance** and **recent activity** list.
3. Use the activity list to confirm whether the card was issued, loaded, used at checkout, refunded, or voided.
4. **Do not** read full code aloud in a crowded line; show screen to customer.

### Card shows void or zero

1. Stop — do not re-issue without manager.
2. Check **Back Office → Gift Cards → Card Inventory** for **events** trail.
3. A depleted purchased card may be reused through Register after manager/customer verification; a void card cannot.

## Helping a coworker

- **“Code won’t scan.”** — Type slowly; check **O vs 0**; try **Card Inventory** search by partial code.
- **“Balance wrong.”** — Compare **events** in BO; one **double redeem** is common.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Not found | Retype; trim spaces | BO lookup |
| Insufficient balance | Split tender | Customer uses second payment |
| Card cannot be verified | Check Card Inventory for status, balance, and expiration | Ask a manager if the card record looks wrong |
| Already voided | Stop sale | Manager |
| System double-charged | **Orders** → find duplicate tender | Refund process |

## When to get a manager

- **Fraud** patterns (buy with stolen card, immediate redeem).
- **Manual** balance correction or **goodwill** load.

---

## See also

- [gift-cards-loyalty-back-office.md](gift-cards-loyalty-back-office.md)
- [pos-register-cart.md](pos-register-cart.md)

**Last reviewed:** 2026-07-14
