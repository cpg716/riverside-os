# POS Gift Cards

**Audience:** Cashiers selling or redeeming gift cards.

**Where in ROS:** POS mode → left rail **Gift Cards**; **Register** also has **GIFT CARD** (next to Clear Sale) for amount + scan onto purchased cards (any staff with an open register session or Back Office sign-in).

**Related permissions:** **gift_cards.manage** for issue/void/list in Back Office; **GIFT CARD** on the register uses the same POS/staff auth as the rest of the register. **Redemption** at tender often works with **POS session** + staff auth per server rules.

---

## How to use this screen

Use POS **Gift Cards** for **balance lookup**, **activation / issue** flows your store trains, and **redemption** toward a sale. Treat every card as **cash equivalent** — wrong code = wrong customer money.

## Common tasks

### Sell / load value on a purchased card at the register

1. POS → **Register** → **GIFT CARD** (open register session / signed-in staff).
2. Enter the **load amount** on the keypad, then **scan** (or type) the card code.
3. Confirm — balance updates in **gift_cards** / **gift card events** (same as Back Office issue for new codes). **Depleted** cards can be loaded again with the same code.

### Sell a new gift card (if not sold as a catalog SKU)

1. POS → **Gift Cards** → **Issue** / **Activate** (per UI).
2. Enter **amount**; confirm **fee** or **bonus** rules with SOP.
3. Take **payment** in **Register** if the flow sends you to the cart.
4. Hand customer the **printed** code or email; they should verify **last 4** match screen.

### Redeem toward checkout

1. On **tender** screen, choose **gift card**.
2. **Scan** or type code; confirm **name mask** or balance if shown.
3. Apply **partial** amount if allowed; complete remainder with card/cash.
4. Print receipt showing **remaining balance** if applicable.

### Balance inquiry (no sale)

1. **Lookup** only — do not add to cart.
2. **Do not** read full code aloud in a crowded line; show screen to customer.

### Card shows void or zero

1. Stop — do not re-issue without manager.
2. Check **Back Office → Gift Cards → Card Inventory** for **events** trail.

## Helping a coworker

- **“Code won’t scan.”** — Type slowly; check **O vs 0**; try **Card Inventory** search by partial code.
- **“Balance wrong.”** — Compare **events** in BO; one **double redeem** is common.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Not found | Retype; trim spaces | BO lookup |
| Insufficient balance | Split tender | Customer uses second payment |
| Already voided | Stop sale | Manager |
| System double-charged | **Orders** → find duplicate tender | Refund process |

## When to get a manager

- **Fraud** patterns (buy with stolen card, immediate redeem).
- **Manual** balance correction or **goodwill** load.

---

## See also

- [gift-cards-loyalty-back-office.md](gift-cards-loyalty-back-office.md)
- [pos-register-cart.md](pos-register-cart.md)

**Last reviewed:** 2026-04-04
