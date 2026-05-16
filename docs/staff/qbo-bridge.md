# QBO bridge (QuickBooks Online)

**Audience:** Bookkeepers and admins.

**Where in ROS:** Back Office → **QBO bridge**. Subsections: **Connection**, **Mappings**, **Staging**, **History**.

**Related permissions:** **qbo.view** minimum; **qbo.mapping_edit**, **qbo.staging_approve**, **qbo.sync** for writes.

---

## How to use this area

Data flows **ROS → mappings → staging → approve → sync → QuickBooks**. Skipping **staging review** creates painful reversals in QBO.

## Connection

**Purpose:** Link the store’s QBO company and confirm **OAuth** health.

1. **Settings** → **QuickBooks Online** → save or update the **Client ID** and **Client Secret** in the secure credentials card.
2. Save the **Realm ID / company ID** and sandbox setting in the same Settings panel.
3. **QBO bridge** → **Connection**.
4. Verify **connected** state and **company** name match expectation.
5. If **token expired**, use **reconnect** / refresh flow per UI (often requires **admin** login to Intuit).
6. Never share **client secret** in chat. Routine QBO credential updates belong in Backoffice Settings, not environment files.

## Mappings

**Purpose:** Map ROS **accounts**, **products**, **tenders**, and **expense** paths to QBO entities.

1. **Mappings** → work tab by tab. Map category revenue/inventory/COGS, Custom garment overrides, tenders, tax, deposit holding, gift card liability, loyalty expense, store credit liability, refund queue clearing, forfeited deposit income, alterations income, and shipping income. Map **Helcim card clearing** once for Helcim card, manual, vault, and web checkout tenders. If your store takes **R2S payment collections** on the register (**PAYMENT** line), ensure **ledger** includes **`RMS_R2S_PAYMENT_CLEARING`** (pass-through) and the **tender** matrix includes **Check** if you use checks — **[`../POS_PARKED_SALES_AND_RMS_CHARGES.md`](../POS_PARKED_SALES_AND_RMS_CHARGES.md)**.
2. **Save** after each section; screenshot or export **before** large changes.
3. Use the blank option to clear a wrong mapping, then save. Cleared mappings are removed from ROS and future staging will warn if that account is required.
4. After mapping change, expect **new** staging rows to reflect the new chart.

## Staging

**Purpose:** Review **journal bundles** before they hit QBO.

1. **Staging** → sort by **date** or **status**.
2. Treat the row date as the store-local business date shown by Riverside. Sales revenue follows recognition timing: pickup / in-store takeaway posts when fulfilled, and shipped transactions post when the shipment is label-purchased / in transit / delivered.
3. After **Z-Close**, ROS stages the daily journal for that business date. If the pending row already exists, staging refreshes it with the latest facts. If the day was already approved or synced and later activity changes the day, ROS creates a revision row for the same business date.
4. Open a row → **drilldown** to lines; fix **unmapped** SKUs, shipping income, liability, clearing, or fallback accounts **before** approve.
5. Before approving card-heavy days, use **Payments → Sync Fees** so the merchant-fee expense and clearing offset use API-returned fee data when Helcim has provided it. ROS does not estimate missing fees or net amounts.
6. **Approve** only when totals match **ROS** expectations for that close.
7. **Sync** after approve; watch **History** for success/fail.

Backdated corrections are governed. The **business date** controls the sales/reporting day and the **payment effective date** controls tender, deposit, and payment movement evidence. Do not use QBO staging to move a payment to a different day unless the payment effective date was corrected in ROS with a documented reason.

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
| Exchange with replacement sale | Return and replacement effects are understandable and traceable. | |
| Deposit/open balance activity | Deposit liability and relief behavior matches the transaction detail. | |
| Shipping income | Shipping income maps to the configured account. | |
| Warning-bearing journal | Accounting reviews warnings before approval; warnings are not ignored because the journal balances. | |
| Failed sync and retry | Failed row remains visible, error is assigned, and retry does not create an unexplained duplicate. | |
| Duplicate-post check | Re-sync/retry uses the existing staging row/request path and does not create a second QBO journal for the same approved row. | |
| Z-close handoff | The Z-report row shows the QBO staging state for the closed business date. | |

Pilot rule: only the accounting owner or store owner approves warning-bearing journals. Cashiers and floor managers may close the register, but they do not clear QBO staging for pilot accounting.

## History

**Purpose:** **Audit** of what posted when — troubleshooting and month-end proof.

1. **History** → filter by **date** or **status**.
2. Open failed rows; read **error** text literally (Intuit messages are specific).
3. Fix root cause in **Mappings** or **ROS** data, then **re-stage** per SOP.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Sync failed | Read **error** in History | Fix mapping, refresh QBO accounts, and re-stage |
| Duplicate journal concern after retry | Check History for the same staging row / request id | Accountant |
| Class/location mismatch | Update mapping version | [QBO_JOURNAL_TEST_MATRIX.md](../QBO_JOURNAL_TEST_MATRIX.md) |
| OAuth loop | Different browser | Intuit status |

## When to get a manager

- **Month-end** inventory **asset** adjustments.
- **Sales tax** filing questions — ROS supports ops; CPA decides filing.
- Any remap of shipping income, store credit liability, refund queue clearing, forfeited deposit income, or RMS clearing accounts.

---

## See also

- [../QBO_JOURNAL_TEST_MATRIX.md](../QBO_JOURNAL_TEST_MATRIX.md)
- [../SUIT_OUTFIT_COMPONENT_SWAP_AND_QBO.md](../SUIT_OUTFIT_COMPONENT_SWAP_AND_QBO.md)

**Last reviewed:** 2026-05-15
