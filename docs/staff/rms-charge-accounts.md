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
- removing a link changes Riverside's customer relationship only; it does not change the CoreCard account itself
- link and unlink corrections are recorded in the staff audit trail

## Safe correction workflow

1. Confirm the correct Riverside customer first.
2. Confirm the masked RMS account before changing anything.
3. Use `Remove Link` only when the customer-to-account relationship in Riverside is wrong.
4. Read the confirmation message before removing the link.
5. Re-link the account only after you are sure the corrected customer relationship is right.

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
