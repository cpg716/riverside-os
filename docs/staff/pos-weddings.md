# POS Weddings

**Audience:** Consultants and floor staff handling wedding parties at the register.

**Where in ROS:** POS mode → left rail **Weddings** (heart icon).

**Related permissions:** **weddings.view** to read; **weddings.mutate** to change party/member state.

---

## How to use this screen

POS **Weddings** keeps **party lookup**, **balances**, and **next steps** beside the cart so you do not jump to Back Office during a busy Saturday. It uses the same **native** wedding UI as the main module (no external iframe).

## Common tasks

### Open the correct party

1. POS → **Weddings**.
2. Search **groom last name**, **bride**, **event date**, or **party ID** from paperwork.
3. Confirm **event date** and **city** aloud with customer before taking payment.

### Explain balance due

1. Open **party** or **member** financial view (per UI).
2. Point to **balance_due** line; explain **what is left** vs **what was paid**.
3. If **disbursement** (split payers) applies, follow **trained** checkout — do not split arbitrarily.

### Quick “is my tux ready?”

1. Find **member** row.
2. Read **pipeline** / **pickup** status from screen text only.
3. If status unclear, **Alterations** or **Orders** may have detail — get lead.

## Helping a coworker

- **“Party not found.”** — Try **alternate spelling**; check **event year**; verify not **archived**.
- **“Balance zero but customer disagrees.”** — Open **Orders** linked to member; compare **receipt** numbers.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Tab missing | **weddings.view** | Manager |
| Stale balance | **Refresh** / re-open party | Network |
| Cannot save edit | **weddings.mutate** | Manager |
| Wrong member paid | **Disbursement** reversal needs lead | [WEDDING_GROUP_PAY_AND_RETURNS.md](../WEDDING_GROUP_PAY_AND_RETURNS.md) |

## When to get a manager

- **Contract** or **package** changes mid-event.
- **Refund** spanning multiple payers.
- **Legal name** change on contract vs POS profile.

---

## See also

- [weddings-back-office.md](weddings-back-office.md)
- [../WEDDING_GROUP_PAY_AND_RETURNS.md](../WEDDING_GROUP_PAY_AND_RETURNS.md)

**Last reviewed:** 2026-04-04
