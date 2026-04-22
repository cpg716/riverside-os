# RMS Charge Exceptions

**Audience:** Sales support, managers, and authorized Back Office staff who handle RMS follow-up work.

**Where in ROS:** Back Office → **Customers** → **RMS charge** → `Exceptions`

## What an exception is

An exception is an RMS item that Riverside could not complete or verify automatically.

Common exception types include:

- failed purchase post
- failed payment post
- failed refund or reversal
- webhook processing failure
- stale or mismatched account state
- duplicate or replay hold
- reconciliation mismatch

## How to work the queue

### Assign

Use `Assign to Me` when you are taking ownership of an RMS issue.

- claim the issue before retrying or resolving it
- use assignment so other staff can see that the issue already has an owner
- if an issue is already assigned, do not assume it is yours unless the workspace shows `Assigned to you`

### Retry

Use `Retry` when:

- the failure was temporary
- the item is marked retryable
- the account, program, and transaction still look correct

### Assign

Use `Assign` when a specific support or finance user should own the exception.

### Resolve

Use `Resolve` when the issue is actually cleared and the notes explain why.

Resolution notes should say what cleared the issue, for example:

- host confirmed the original post
- duplicate failure was reviewed and closed
- wrong customer link was corrected before follow-up
- finance confirmed no further action was needed

## When NOT to retry

Do **not** retry if:

- the account is clearly inactive or restricted
- the program is invalid for that account
- the customer or account link is wrong
- the original item already posted successfully and the exception is only stale
- the issue is actually a reconciliation review issue, not a fresh host post attempt
