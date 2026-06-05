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
6. Enter the R2S approval, authorization, merchant, or support reference if one is available.
7. Complete the sale after the account and program are selected.

Important:

- Riverside does not silently choose the plan for the cashier.
- The sale should not move forward until a program is picked.
- If no account is found, stop and ask a manager to import the latest RMS Account List or link the customer account before tendering.
- Do not enter PAN, CVV, card tokens, or full account numbers in Riverside.

## RMS payment collection flow

1. Tap the **Payment** button in the register functions (toolbar), or search **`PAYMENT`** in the product search to add the `RMS CHARGE PAYMENT` line.
2. Attach the customer.
3. Enter the payment amount.
4. Open checkout and confirm the masked RMS account shown by Riverside.
5. Use the allowed payment-collection tender flow: cash or check.
6. Enter the R2S reference if available.
7. Complete the collection. Riverside records the payment and creates the Sales Support follow-up; the R2S follow-up is still required.

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
- no linked or imported account is found
- the customer wants a refund or reversal
- you are unsure whether the transaction actually posted
