# Pennyless Cash Rounding (Swedish Rounding) — Riverside OS

Cash rounding is currently **OFF** in Riverside OS. Cash, card, check, gift card, store credit, deposits, pickups, returns, and exchanges must settle to the exact cent until Riverside explicitly enables pennyless-cash operation.

Riverside OS retains Swedish Rounding support for a future pennyless-cash rollout. When enabled, it must remain a **transaction-level adjustment on the main Transaction Record**. It must never create a separate Transaction Record, pickup, deposit, or orphaned payment activity.

---

## 1. Rounding Logic: The $0.05 Rule

When enabled, rounding applies **only** to the portion of the transaction paid in cash. The rounding logic follows the standard Swedish Rounding model:

| Transaction Ending In | Action | Resulting Cash Amount |
|-----------------------|--------|-----------------------|
| `.00`, `.01`, `.02`   | Round down | `.00` |
| `.03`, `.04`, `.05`, `.06`, `.07` | Round to nearest $0.05 | `.05` |
| `.08`, `.09`          | Round up | `.10` |

### Calculation Formula
In both backend (Rust) and frontend (TypeScript), the calculation is performed as:
`rounded = Math.round(amount_in_cents / 5) * 5`

---

## 2. Financial Architecture & Integrity

Unlike a "discount," cash rounding is a **transaction-level settlement adjustment**. To maintain legal and tax compliance, the system preserves the exact mathematical total and stores the adjustment on the main Transaction Record.

### Data Model
The `orders` table includes two dedicated fields:
- **`total_price`**: The precise, unrounded total. **This is the basis for Sale Tax calculation.**
- **`rounding_adjustment`**: The difference between the exact total and the collected cash (e.g., `-0.02` if $10.02 rounded down to $10.00).
- **`final_cash_due`**: The human-readable rounded amount presented to the cashier.

Current disabled-state invariant:
- New checkout payloads must omit `rounding_adjustment` and `final_cash_due`.
- Receipts, daily history, register close, QBO staging, pickups, deposits, and refund processing must use exact-cent transaction totals.
- Historical transactions that already carry `rounding_adjustment` remain auditable as historical records.

Future enabled-state invariant:
- `rounding_adjustment` must belong to the main Transaction Record being settled.
- It may be shown on receipts, daily history, register close, and QBO staging as part of that Transaction Record.
- It must not be represented as a separate Transaction Record, a pickup, a deposit, or a payment row that is not allocated to the settled transaction.

### Tax Invariant
Tax is calculated on the `total_price` BEFORE rounding. This ensures that the store correctly remits tax on every cent earned, regardless of the physical currency used for payment.

---

## 3. POS Register Workflow

### Detection & Display
While rounding is currently OFF, the **CASH** tab requires the exact-cent balance. **Full Balance** loads the exact remaining amount, and **Complete Sale** stays unavailable until tenders settle the exact balance.

When rounding is enabled in the future and a cashier selects the **CASH** tab in the Payment Ledger drawer, the system must:
1. Calculates the `roundingAdjustment` based on the remaining balance.
2. Displays a **Rounding Adjustment** line (e.g., `Rounded: -0.02`) in the Balance Due footer.
3. Updates the **Pay Balance** shortcut to load the rounded amount onto the keypad.

### Split Payments
If a customer pays $50 with a Credit Card and the remaining $10.02 with Cash:
- The Credit Card split remains exactly `$50.00`.
- The Cash split rounds from `$10.02` to `$10.00`.
- The order stores a `rounding_adjustment` of `-0.02`.

### Cash Refunds
While rounding is OFF, cash refunds pay the exact-cent customer credit. When enabled, cash refunds follow the same nickel rule, but the sign is negative:

- The returned merchandise, tax, and any deposit credit remain exact to the cent.
- The drawer payout is rounded to the nearest `$0.05`.
- The difference is stored on the original transaction as `rounding_adjustment`.
- Checkout allocation must allocate the negative payment back to the returned transaction instead of treating the extra penny difference as uncovered order payment.

Example: an exact customer credit of `$71.23` paid out in cash becomes a `$71.25` drawer payout with a `$0.02` cash-rounding adjustment. The refund stays auditable as one negative cash payment plus the rounding line.

---

## 4. QBO Journal Accounting

Rounding adjustments must be accounted for in the general ledger to ensure the daily journal stays balanced.

### Ledger Mapping
A new internal key **`CASH_ROUNDING`** is introduced. Administrators must map this key in **Settings → QBO Bridge** to a dedicated account (typically "Cash Over/Short" or "Miscellaneous Income/Expense").

### Journal Entry Logic
When rounding is enabled and the daily staging journal is generated:
- All `rounding_adjustment` values for fulfilled orders are aggregated.
- A single journal line is created for the sum:
    - **Negative Sum (Rounding Down)**: Recorded as a **Debit** (Expense).
    - **Positive Sum (Rounding Up)**: Recorded as a **Credit** (Income).

---

## 5. Key Source Files

| File | Role |
|------|------|
| `server/src/logic/money.rs` | Backend rounding utility (`calculate_swedish_rounding`) |
| `client/src/lib/money.ts` | Frontend rounding utility (`calculateSwedishRounding`) |
| `server/src/models/mod.rs` | Order model updates for rounding fields |
| `client/src/hooks/useCartCheckout.ts` | Checkout payload handling for rounding metadata |
| `client/src/components/pos/Cart.tsx` | Return/exchange settlement payload handling |
| `server/src/logic/qbo_journal.rs` | Aggregation and mapping of rounding to the daily journal |
| `client/src/components/pos/NexoCheckoutDrawer.tsx` | UI calculation and display of rounding adjustments |

---

*Last updated: 2026-06-02*
