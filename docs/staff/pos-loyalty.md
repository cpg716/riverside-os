# POS Loyalty

**Audience:** Cashiers applying loyalty at the register.

**Where in ROS:** POS mode → left rail **Loyalty** (star icon).

**Related permissions:** **loyalty.program_settings** / **loyalty.adjust_points** for Back Office changes; earning and redeeming at POS uses **staff or POS session** rules.

---

## How to use this screen

**Loyalty** covers **earning points** on qualifying sales and **redeeming** rewards (discount or tender) per **Program Settings**. If the program says “$1 = 1 pt,” do not promise a different rate — read the screen.

## Common tasks

### Attach customer before loyalty

1. **Register** → attach **customer** to cart if SOP requires it for earn/redeem.
2. POS → **Loyalty** → **apply earn** or **redeem** (per UI).
3. Confirm **new balance** or **discount** before **Complete Sale**.

### Redeem a reward

1. Confirm **threshold** met (e.g. 500 pts).
2. Apply **reward**; verify **subtotal** dropped correctly.
3. Complete tender for **remaining** balance.

### Customer says “I should have more points”

1. Read **balance** on screen.
2. If dispute, **do not** adjust at POS unless trained — send to **Back Office → Loyalty → Adjust Points** with manager.
3. Check **recent returns**; points may have **clawed back**.

## Helping a coworker

- **“Redeem grayed out.”** — Customer not on cart, below threshold, or **excluded category** in program rules.
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
