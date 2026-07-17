# QBO bridge (QuickBooks Online)

**Audience:** Bookkeepers and admins.

**Where in ROS:** Back Office → **QBO bridge**. Subsections: **Connection**, **Mappings**, **Staging**, **History**.

**Related permissions:** **qbo.view** minimum; **qbo.mapping_edit**, **qbo.staging_approve**, **qbo.sync** for writes.

---

## How to use this area

Data flows **ROS → mappings → staging → approve → sync → QuickBooks**. Skipping **staging review** creates painful reversals in QBO.

## Connection

**Purpose:** Link the store’s QBO company and confirm **OAuth** health.

1. **Settings** → **QuickBooks Online** → save or update the **Client ID**, **Client Secret**, and Intuit **Webhook Verifier Token** in the secure credentials card. The verifier token is copied from the Development or Production Webhooks page for the same Intuit app/environment.
2. Pick the sandbox/production setting, then click **Connect to QuickBooks** and approve the Riverside app in the Intuit authorization window.
3. Confirm the returned **Realm ID / company ID** in the same Settings panel.
4. Use the **QBO Health** card in Settings to check token status, company verification, live API health, and sandbox/production mode.
5. Click **Refresh Token** only when the card shows the token is refreshable or stale.
6. Click **Refresh QBO accounts** before mapping so account pickers use the current QuickBooks chart of accounts.
7. **QBO bridge** → **Connection**.
8. Verify **connected** state and **company** name match expectation.
9. If **token expired**, use the Settings health card first, then reconnect per UI if refresh is not possible. The system also auto-refreshes tokens in the background when within 10 minutes of expiry.
10. Configure Intuit's webhook URL as `https://<public-ros-api-host>/api/auth/qbo/webhook`. Riverside rejects missing or invalid `intuit-signature` values, does not store unsigned payloads, and returns an error if the signed event cannot be durably recorded so Intuit can retry it.
11. Never share the **client secret** or **Webhook Verifier Token** in chat. Routine QBO credential updates belong in Backoffice Settings, not environment files.

## Mappings

**Purpose:** Map ROS **accounts**, **products**, **tenders**, and **expense** paths to QBO entities.

1. **Mappings** → work tab by tab. Map category revenue/inventory/COGS, Custom garment overrides, tenders, tax, deposit holding, gift card liability, loyalty expense, store credit liability, refund queue clearing, forfeited deposit income, alterations income, customer shipping income, receiving clearing, and supplier inbound freight. Map **Helcim card clearing** once for Helcim card, manual, vault, and web checkout tenders. If your store takes **R2S payment collections** on the register (**PAYMENT** line), ensure **ledger** includes **`RMS_R2S_PAYMENT_CLEARING`** (pass-through) and the **tender** matrix includes **Check** if you use checks — **[`../POS_PARKED_SALES_AND_RMS_CHARGES.md`](../POS_PARKED_SALES_AND_RMS_CHARGES.md)**.
2. **Save** after each section; screenshot or export **before** large changes.
3. Use the blank option to clear a wrong mapping, then save. Cleared mappings are removed from ROS and future staging will warn if that account is required.
4. After mapping change, expect **new** staging rows to reflect the new chart.

## Staging

**Purpose:** Review **journal bundles** before they hit QBO.

ROS does not post checkout-by-checkout revenue journals directly to QBO. Sales, tax, COGS, customer shipping income, supplier inbound freight, deposits, returns, gift-card liability, tender clearing, and operational inventory movement flow through the reviewed **Daily QBO Staging Journal** so accounting has one clear approval point.

1. **Staging** → sort by **date** or **status**.
2. Treat the row date as the store-local business date shown by Riverside. Sales revenue follows recognition timing: pickup / in-store takeaway posts when fulfilled, and shipped transactions post when the shipment is label-purchased / in transit / delivered.
3. After **Z-Close**, ROS stages the daily journal for that business date. A background worker also auto-proposes the previous business date at 2 AM local time, so most days will already have a review row when accounting opens. If the pending or needs-review row already exists, staging refreshes it with the latest facts. If the day was already approved or synced and later activity changes the day, ROS creates a revision row for the same business date.
4. Open a row → **drilldown** to lines; fix **unmapped** SKUs, customer shipping income, supplier freight, liability, clearing, or fallback accounts **before** approve. Rows with no postable journal lines or blocking missing-mapping warnings stay in `needs_review` and cannot be approved until mappings are fixed and the journal is regenerated. Operational inventory moves can now appear in the same journal preview: Receiving, Return to Vendor, Damaged, Physical Count, and Adjustments. Supplier freight from receiving stays separate from merchandise receiving and must not be added into item cost.
5. Before approving a day with disputed fulfillment, loyalty, commission, tax, or receipt totals, confirm `reporting.transaction_status_integrity` has no ROS register issues for that window. Do not approve around a status mismatch until pickup / shipment workflow or IT repair resolves it.
6. Before approving card-heavy days, use **Payments → Sync Fees** so the merchant-fee expense and clearing offset use API-returned fee data when Helcim has provided it. ROS does not estimate missing fees or net amounts.
7. **Approve** only when totals match **ROS** expectations for that close.
8. **Sync** after approve; watch **History** for success/fail.
9. **Revert** — if an approved entry needs mapping fixes or regeneration, click **Revert** to move it back to **pending**. Fix mappings in Settings, then re-approve.
10. **Retry** — if a synced entry **failed** (network, token expiry, QBO rejection), click **Retry**. ROS re-validates balance/accounts and re-attempts the POST. No need to re-stage.
11. **Void in QBO** — if a **synced** journal needs to be completely removed from QuickBooks (wrong date, duplicate, data correction), click **Void in QBO**. This deletes the JournalEntry in Intuit and marks the local row `voided`. You can then re-stage a corrected entry for that business date.

Backdated sales are manager-approved and are governed by separate sale and tender dates. The **business date** controls the booked-sales/reporting day. Every payment movement retains its actual processing day for tender, drawer, deposit, provider-batch, and QBO payment-movement reconciliation; this applies to card, cash, check, and internal tenders. Do not use QBO staging to move a payment to a different day. Any post-sale payment-date correction requires an accounting-authorized ROS correction with a documented reason and must remain explainable against provider or drawer evidence.

For a backdated checkout, map **Backdated sale clearing** to a dedicated QBO clearing account before approval. ROS posts the actual tender to the payment day and credits this clearing account; the backdated business-day journal debits the same clearing account and posts the existing revenue or deposit-liability entry. The two legs carry the transaction/payment evidence in journal detail. If the mapping is missing, staging remains unbalanced and cannot be approved. Do not map this key to revenue, a bank account, or a merchant-fee expense account.

Payments → Deposits can record actual bank deposits and match them to expected Helcim batches for review. That matching is audit evidence only: it does not create a QuickBooks deposit, post a bank deposit, or change the daily journal bundle.

## Sandbox certification signoff

Before pilot accounting relies on QBO posting, run these scenarios in the QBO sandbox company and sign off the result. A checked row means the staged journal was reviewed in ROS, approved by the accounting owner, synced to QBO, and compared back to Riverside reports.

| Scenario | Expected evidence | Signed |
|----------|-------------------|--------|
| Normal sales day | ROS staged journal balances and QBO journal matches expected revenue/tax/tender lines. | |
| Cash, card, check mix | Tender clearing lines match Register Reports and Z-report evidence. | |
| Gift card sale/redemption | Liability movement is visible and not treated as normal sales revenue. | |
| Loyalty reward issued | Loyalty expense / loyalty gift-card handling matches the staged journal. | |
| Return/refund day | Contra revenue/tax/refund clearing lines match the return evidence. | |
| Completed-sale void day | Original sale remains traceable, void record is explainable, refund/reversal evidence clears correctly, and any revision row is reviewed before approval. | |
| Exchange with replacement sale | Return and replacement effects are understandable and traceable. | |
| Deposit/open balance activity | Deposit liability and relief behavior matches the transaction detail. | |
| Customer shipping income | Customer-paid shipping maps to the configured shipping income account and is not supplier freight. | |
| Supplier inbound freight | Freight paid on vendor receiving maps to supplier freight expense and receiving clearing, separate from merchandise item cost. | |
| Operational inventory moves | Receiving, RTV, Damaged, Physical Count, and Adjustments appear with the expected inventory / clearing / shrinkage mapping. | |
| Warning-bearing journal | Accounting reviews warnings before approval; warnings are not ignored because the journal balances. | |
| Failed sync and retry | Failed row remains visible, error is assigned, and retry does not create an unexplained duplicate. | |
| Duplicate-post check | Re-sync/retry uses the existing staging row/request path and does not create a second QBO journal for the same approved row. | |
| Auto-propose | Previous business date appears in staging automatically after overnight worker runs. | |
| Approval audit trail | Approved rows show approver name and approval timestamp in History detail. | |
| Token health check | Token Health endpoint shows valid/refreshable status and minutes remaining. | |
| Z-close handoff | The Z-report row shows the QBO staging state for the closed business date. | |
| Revert to pending | Approved row reverts to pending; approver info cleared; can be re-approved after mapping fix. | |
| Retry failed posting | Failed row re-validates and re-posts; transitions to synced on success; stays failed with new error on re-failure. | |
| Void synced journal | Synced row is deleted in QBO; local status becomes voided; re-staging creates a revision row. | |

Pilot rule: only the accounting owner or store owner approves warning-bearing journals. Cashiers and floor managers may close the register, but they do not clear QBO staging for pilot accounting.

## History

**Purpose:** **Audit** of what posted when — troubleshooting and month-end proof.

1. **History** → filter by **date** or **status**.
2. Open failed rows; read **error** text literally (Intuit messages are specific).
3. Fix root cause in **Mappings** or **ROS** data, then **re-stage** per SOP.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Sync failed | Click **Retry** on the failed row; read error text literally | Fix mapping, refresh QBO accounts, retry again |
| Approved but needs fix | Click **Revert** to move back to pending, fix mappings, re-approve | Re-propose from Staging for fresh data |
| Wrong journal posted to QBO | Click **Void in QBO** to delete it, then re-stage and post corrected version | Accountant manual void in QBO |
| Duplicate journal concern after retry | Check History for the same staging row / request id | Accountant |
| Class/location mismatch | Update mapping version | [QBO_JOURNAL_TEST_MATRIX.md](../QBO_JOURNAL_TEST_MATRIX.md) |
| OAuth loop | Different browser | Intuit status |

## When to get a manager

- **Month-end** inventory **asset** adjustments.
- **Sales tax** filing questions — ROS supports ops; CPA decides filing.
- Any remap of shipping income, store credit liability, refund queue clearing, forfeited deposit income, or RMS clearing accounts.

---

## Daily Financial Report

After Z-close, ROS can automatically generate and email a comprehensive **Daily Financial Report** covering net sales, tenders, tax, returns, deposits, gift cards, alterations, inventory receiving, freight, category margins, and the QBO journal status for the business date. Configure in **Settings → Daily Financial Report**. Reports are stored and viewable in the same Settings panel.

See [../DAILY_FINANCIAL_REPORT.md](../DAILY_FINANCIAL_REPORT.md) for full configuration and API reference.

## See also

- [../QBO_JOURNAL_TEST_MATRIX.md](../QBO_JOURNAL_TEST_MATRIX.md)
- [../SUIT_OUTFIT_COMPONENT_SWAP_AND_QBO.md](../SUIT_OUTFIT_COMPONENT_SWAP_AND_QBO.md)
- [../DAILY_FINANCIAL_REPORT.md](../DAILY_FINANCIAL_REPORT.md)

**Last reviewed:** 2026-07-17
