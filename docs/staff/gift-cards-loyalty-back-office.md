# Gift Cards and Loyalty (Back Office)

**Audience:** Managers and leads.

**Where in ROS:** Back Office has two top-level tabs: **Gift Cards** and **Loyalty**. Each has its own subsections (see below).

**Related permissions:** **gift_cards.manage** gates the whole **Gift Cards** tab. **Loyalty** uses **loyalty.program_settings** and/or **loyalty.adjust_points** depending on subsection (see [permissions-and-access.md](permissions-and-access.md)).

---

## How to use these tabs

Use **Gift Cards** for **liability** (inventory of cards, issuance, voids). Use **Loyalty** for **points economics** (who qualifies, manual adjustments, program rules). Cashiers **redeem** both from POS — coordinate with [pos-gift-cards.md](pos-gift-cards.md) and [pos-loyalty.md](pos-loyalty.md).

---

## Gift Cards

### Card Inventory

**Purpose:** Find cards, confirm **balance** and **status** (active vs void).

1. **Gift Cards** → **Card Inventory**.
2. Search by **full code**, **last four**, or customer link if the UI exposes it.
3. Open a row to read **issue date**, **initial value**, **remaining balance**, and **void** flag.
4. **Void** only with written SOP — it changes **liability** and may need accounting notice.

### Issue Purchased

**Purpose:** Sell a new card after **payment** is collected (or as part of a documented comp workflow).

1. **Gift Cards** → **Issue Purchased**.
2. Enter **amount** / **SKU** / **quantity** per training.
3. Confirm the new card appears in **Card Inventory** with correct balance.
4. Give the customer **gift receipt** or activation slip per store policy.

### Issue Donated

**Purpose:** Marketing or charity issuance — usually **manager-only**.

1. **Gift Cards** → **Issue Donated**.
2. Complete fields; add **reason** in notes if the form supports it.
3. File any **paper approval** your finance team requires.

---

## Loyalty

### Monthly Eligible

**Purpose:** Review who qualifies for periodic rewards before you message or fulfill perks.

1. **Loyalty** → **Monthly Eligible** (requires **loyalty.program_settings**).
2. Scan the list; export only on **secure** machines — **PII** applies.
3. Run outreach per **program settings** (email/SMS rules and opt-ins).

### Adjust Points

**Purpose:** Correct mistakes or apply goodwill **points** with an audit trail.

1. **Loyalty** → **Adjust Points** (requires **loyalty.adjust_points**).
2. Search **customer**; confirm **identity** before reading balance aloud.
3. Enter **delta** (+/-) and **reason** / note.
4. Save; ask the customer to **re-open** loyalty on POS or their next visit to confirm.

### Program Settings

**Purpose:** **Earn rates**, **tiers**, caps, and messaging — **high impact**.

1. **Loyalty** → **Program Settings** (**loyalty.program_settings**).
2. Change **one** variable at a time when possible; document **before/after** for the team chat or logbook.
3. Test with a **low-value** internal customer account if policy allows.

---

## POS coordination

If POS says **card not found** but BO shows the card: check **spaces**, **activation** timing, **void** flag, and that the cashier typed the code correctly. If POS **points** look wrong after an adjust: customer may need a **fresh** cart or **re-sign-in** to refresh cached reads.

## Helping a coworker

- **Gift card at register:** Look up in **Card Inventory** first; read **balance** and **void** status only.
- **Loyalty dispute:** Open **Adjust Points** history if exposed; do not re-adjust without manager if amounts are large.

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
