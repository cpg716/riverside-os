# Returns, refunds, and exchanges (staff abstract)

**Full detail:** [../../ORDERS_RETURNS_EXCHANGES.md](../../ORDERS_RETURNS_EXCHANGES.md).

---

## What staff should remember

1. **Before payment:** removing lines or voiding an **unpaid** cart differs from **after payment** workflows.
2. **After payment:** use the **return** / **refund** / **exchange** flows your training covers — permissions such as **orders.refund_process** gate who can do them.
3. A **refund queue** may apply: partial refunds and returns can interact with **open queue** rows — do not “work around” the UI without manager approval.
4. **Exchanges** may link orders via **exchange group** semantics — follow the in-app flow rather than manual balance edits.

---

## Escalation

- Large refunds, **tax-exempt** corrections, or anything that **feels** like fraud → manager.
- Detail screens: [../orders-back-office.md](../orders-back-office.md), [../pos-register-cart.md](../pos-register-cart.md).

---

**Last reviewed:** 2026-04-04
