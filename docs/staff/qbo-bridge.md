# QBO bridge (QuickBooks Online)

**Audience:** Bookkeepers and admins.

**Where in ROS:** Back Office → **QBO bridge**. Subsections: **Connection**, **Mappings**, **Staging**, **History**.

**Related permissions:** **qbo.view** minimum; **qbo.mapping_edit**, **qbo.staging_approve**, **qbo.sync** for writes.

---

## How to use this area

Data flows **ROS → mappings → staging → approve → sync → QuickBooks**. Skipping **staging review** creates painful reversals in QBO.

## Connection

**Purpose:** Link the store’s QBO company and confirm **OAuth** health.

1. **QBO bridge** → **Connection**.
2. Verify **connected** state and **company** name match expectation.
3. If **token expired**, use **reconnect** / refresh flow per UI (often requires **admin** login to Intuit).
4. Never share **client secret** in chat; use **Settings** or env per IT.

## Mappings

**Purpose:** Map ROS **accounts**, **products**, **tenders**, and **expense** paths to QBO entities.

1. **Mappings** → work tab by tab (**Sales**, **Inventory**, **Expenses** if present). If your store takes **R2S payment collections** on the register (**PAYMENT** line), ensure **ledger** includes **`RMS_R2S_PAYMENT_CLEARING`** (pass-through) and the **tender** matrix includes **Check** if you use checks — **[`../POS_PARKED_SALES_AND_RMS_CHARGES.md`](../POS_PARKED_SALES_AND_RMS_CHARGES.md)**.
2. **Save** after each section; screenshot or export **before** large changes.
3. After mapping change, expect **new** staging rows to reflect the new chart.

## Staging

**Purpose:** Review **journal bundles** before they hit QBO.

1. **Staging** → sort by **date** or **status**.
2. Treat the row date as the store-local business date shown by Riverside; open a row → **drilldown** to lines; fix **unmapped** SKUs or accounts **before** approve.
3. **Approve** only when totals match **ROS** expectations for that close.
4. **Sync** after approve; watch **History** for success/fail.

## History

**Purpose:** **Audit** of what posted when — troubleshooting and month-end proof.

1. **History** → filter by **date** or **status**.
2. Open failed rows; read **error** text literally (Intuit messages are specific).
3. Fix root cause in **Mappings** or **ROS** data, then **re-stage** per SOP.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Sync failed | Read **error** in History | Fix mapping |
| Duplicate journal | Do not re-approve same window | Accountant |
| Class/location mismatch | Update mapping version | [QBO_JOURNAL_TEST_MATRIX.md](../QBO_JOURNAL_TEST_MATRIX.md) |
| OAuth loop | Different browser | Intuit status |

## When to get a manager

- **Month-end** inventory **asset** adjustments.
- **Sales tax** filing questions — ROS supports ops; CPA decides filing.

---

## See also

- [../QBO_JOURNAL_TEST_MATRIX.md](../QBO_JOURNAL_TEST_MATRIX.md)
- [../SUIT_OUTFIT_COMPONENT_SWAP_AND_QBO.md](../SUIT_OUTFIT_COMPONENT_SWAP_AND_QBO.md)

**Last reviewed:** 2026-04-04
