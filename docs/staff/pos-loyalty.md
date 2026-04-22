# POS Loyalty

**Audience:** Cashiers applying loyalty at the register.

**Where in ROS:** POS mode → left rail **Loyalty** (star icon).

**Related permissions:** **loyalty.program_settings** / **loyalty.adjust_points** for Back Office changes; earning and redeeming at POS uses **staff or POS session** rules.

---

## How to use this screen

**Loyalty** covers **earning points** on qualifying sales and **issuing loyalty reward cards** when a customer reaches the threshold. If the program says “$1 = 1 pt,” do not promise a different rate — read the screen.

## Common tasks

### Attach customer before loyalty

1. **Register** → attach **customer** to cart if SOP requires it for earn/redeem.
2. POS → **Loyalty** to check who is eligible and issue a reward card when needed.
3. Confirm the customer’s **new points balance** after any reward issuance.
4. Use the **Recent loyalty activity** panel to confirm the last earn, reward issue, or clawback before you answer questions.
5. If the customer is linked as a couple, loyalty follows the shared primary loyalty account. POS will show the shared balance and history even if you searched the partner’s profile.

### Issue a reward card

1. Confirm **threshold** met (e.g. 500 pts).
2. Scan or enter a **loyalty gift card code** in the reward dialog.
3. Issue the reward to that card.
4. If the customer is checking out right now, complete the sale separately in the register.

### Customer says “I should have more points”

1. Read **balance** on screen.
2. Read the **Recent loyalty activity** list in POS. It will show whether points were earned, a reward card was issued, or points were removed after a return or refund.
3. If dispute, **do not** adjust at POS unless trained — send to **Back Office → Loyalty → Adjust Points** with manager.
4. Check **recent returns**; points may have **clawed back**.

## Helping a coworker

- **“Issue reward card” is unavailable.** — Customer is below the threshold or reward settings are unavailable.
- **“Why did the sale total not change?”** — Loyalty redemption issues a reward card only. It does not change the open sale total.
- **“Double earn fear.”** — Void and re-ring **only** with lead approval.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| No earn on sale | Category excluded | Manager reads **Program Settings** |
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

**Last reviewed:** 2026-04-04
