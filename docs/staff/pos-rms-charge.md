# POS RMS Charge

**Audience:** POS staff and managers

**Where in ROS:** POS → `Register` for RMS Charge tendering, plus POS → `RMS Charge` for the slim RMS Charge workspace for permitted staff

## When to use RMS Charge

Use `RMS Charge` when the customer is financing a new sale through their RMS account.

Use the separate RMS payment collection flow when the customer is making a payment toward an existing RMS balance.

## RMS Charge sale flow

1. Attach the customer to the sale.
2. Open checkout and choose `RMS Charge`.
3. Confirm the masked account shown by the system.
4. If more than one account appears, choose the correct masked account.
5. When the plan picker appears, choose the financing program.
6. Complete the sale only after Riverside confirms the host post succeeded.

Important:

- Riverside does not silently choose the plan for the cashier.
- The sale should not move forward until a program is picked.

## RMS payment collection flow

1. Search `PAYMENT`.
2. Add the `RMS CHARGE PAYMENT` line.
3. Attach the customer.
4. Enter the payment amount.
5. Use the allowed payment-collection tender flow.
6. Complete the collection only after Riverside confirms the host post succeeded.

## Error handling

- `Decline or restriction`
  Do not tell the customer it went through.
- `No customer`
  Attach the correct customer first.
- `System error`
  Do not assume the sale completed. Escalate if the same error repeats.

## Manager escalation rules

Get a manager when:

- the customer disputes the account shown
- the system reports a repeated host error
- the customer wants a refund or reversal
- you are unsure whether the transaction actually posted
