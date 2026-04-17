# Pennyless Cash Rounding (Swedish Rounding) — Riverside OS

As of 2026, the US has phased out the penny. Electronic transactions remain exact to the cent, but cash transactions must be rounded to the nearest $0.05. Riverside OS implements "Swedish Rounding" to handle this compliance requirement while maintaining financial integrity.

---

## 1. Rounding Logic: The $0.05 Rule

Rounding applies **only** to the portion of the transaction paid in cash. The rounding logic follows the standard Swedish Rounding model:

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

Unlike a "discount," cash rounding is a **presentation-layer adjustment**. To maintain legal and tax compliance, the system preserves the exact mathematical total.

### Data Model
The `orders` table includes two dedicated fields:
- **`total_price`**: The precise, unrounded total. **This is the basis for Sale Tax calculation.**
- **`rounding_adjustment`**: The difference between the exact total and the collected cash (e.g., `-0.02` if $10.02 rounded down to $10.00).
- **`final_cash_due`**: The human-readable rounded amount presented to the cashier.

### Tax Invariant
Tax is calculated on the `total_price` BEFORE rounding. This ensures that the store correctly remits tax on every cent earned, regardless of the physical currency used for payment.

---

## 3. POS Register Workflow

### Detection & Display
When a cashier selects the **CASH** tab in the Payment Ledger drawer, the system automatically:
1. Calculates the `roundingAdjustment` based on the remaining balance.
2. Displays a **Rounding Adjustment** line (e.g., `Rounded: -0.02`) in the Balance Due footer.
3. Updates the **Pay Full Balance** shortcut to load the rounded amount onto the keypad.

### Split Payments
If a customer pays $50 with a Credit Card and the remaining $10.02 with Cash:
- The Credit Card split remains exactly `$50.00`.
- The Cash split rounds from `$10.02` to `$10.00`.
- The order stores a `rounding_adjustment` of `-0.02`.

---

## 4. QBO Journal Accounting

Rounding adjustments must be accounted for in the general ledger to ensure the daily journal stays balanced.

### Ledger Mapping
A new internal key **`CASH_ROUNDING`** is introduced. Administrators must map this key in **Settings → QBO Bridge** to a dedicated account (typically "Cash Over/Short" or "Miscellaneous Income/Expense").

### Journal Entry Logic
When the daily staging journal is generated:
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
| `server/src/logic/order_checkout.rs` | Persistence of rounding metadata during checkout |
| `server/src/logic/qbo_journal.rs` | Aggregation and mapping of rounding to the daily journal |
| `client/src/components/pos/NexoCheckoutDrawer.tsx` | UI calculation and display of rounding adjustments |

---

*Last updated: 2026-04-15*
