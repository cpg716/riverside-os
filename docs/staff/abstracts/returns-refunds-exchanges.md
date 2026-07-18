# Returns, refunds, and exchanges (staff abstract)

**Full detail:** [../../TRANSACTION_RETURNS_EXCHANGES.md](../../TRANSACTION_RETURNS_EXCHANGES.md).

---

## What staff should remember

1. **Before payment:** removing lines or voiding an **unpaid** cart differs from **after payment** workflows.
2. **After payment:** use the **return** / **refund** / **exchange** flows your training covers — permissions such as **orders.refund_process** gate who can do them, even though the financial API/routes now live under **transactions**.
3. A **refund queue** may apply: partial refunds and returns can interact with **open queue** rows — do not “work around” the UI without manager approval.
4. **Exchanges** may link Transaction Records via **exchange group** semantics — follow the in-app flow rather than manual balance edits. Picking a return line only stages the return; it is not final until the refund or exchange settlement succeeds.
5. **Completed-sale voids:** POS **Reports -> Daily Sales -> Void** requires Manager Access. The original Transaction Record stays visible, a permanent void record is written, and any money movement still goes through the refund workflow.
6. **Original-card refunds:** ROS verifies the linked Helcim transaction and batch. Returned merchandise and inventory do not finalize before the provider approves the refund.
7. **Exchange card remainder:** the exchange and inventory return remain saved if Helcim is unavailable; the remaining amount stays in the refund queue for retry instead of blocking or duplicating the exchange.
8. **Tender-specific evidence:** check refunds require the check number; Staff Account refunds reduce the receivable; RMS Charge refunds require the completed RMS/R2S reference and Manager Access; Open Deposit is restored through cancellation/void.

---

## Escalation

- Large refunds, **tax-exempt** corrections, completed-sale voids, or anything that **feels** like fraud -> manager.
- Detail screens: [../transactions-back-office.md](../transactions-back-office.md), [../pos-register-cart.md](../pos-register-cart.md), [../pos-void-transactions.md](../pos-void-transactions.md).

---

**Last reviewed:** 2026-07-17
