# RMS Charge Accounts

**Audience:** Sales support, managers, and Back Office staff who review or maintain linked RMS accounts.

**Where in ROS:** Back Office → **Customers** → **RMS charge** → `Accounts`

## What this section is for

The `Accounts` section shows which CoreCredit/CoreCard account is linked to the active Riverside customer.

Use it to:

- confirm the account link
- review account status
- review verification details
- see available credit and current balance when available
- confirm whether the customer is likely ready for an RMS financing or payment workflow

## How linking works

Riverside links a Riverside customer to one or more CoreCredit/CoreCard accounts in `customer_corecredit_accounts`.

Important rules:

- the active Riverside customer is the source of truth
- account resolution happens on the server
- POS never relies on name-only matching at checkout
- UI-facing account values remain masked

## Status meanings

- `active`
  The account is eligible for normal RMS use unless another restriction is present.
- `inactive`
  The account should not be used for new RMS activity until verified.
- `restricted`
  The account may be blocked from some or all RMS actions.
- `stale`
  Riverside needs a refresh, webhook update, or repair poll before staff should trust the current snapshot.

## What to do if no account is found

1. Confirm the correct customer is attached.
2. Check whether a duplicate or wrong customer profile was used.
3. Check whether the customer should already have a linked RMS account.
4. If the customer truly has no linked account in Riverside, do not force the sale through RMS Charge.
5. Escalate to trained sales support or a manager to review linking and verification.

## What not to do

- Do not ask POS staff to type in raw account numbers from memory.
- Do not use name-only matching at checkout.
- Do not expose unmasked account identifiers.
- Do not link or unlink accounts casually if recent RMS activity exists.
