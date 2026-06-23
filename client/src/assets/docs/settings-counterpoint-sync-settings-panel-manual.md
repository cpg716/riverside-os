---
id: settings-counterpoint-sync-settings-panel
title: "Counterpoint Import and Sign-Off"
order: 1087
summary: "Connect the Counterpoint Bridge to Main Hub ROS, import data, resolve exceptions, review duplicates, and confirm go-live proof."
source: client/src/components/settings/CounterpointSyncSettingsPanel.tsx
last_scanned: 2026-06-22
tags: settings-counterpoint-sync-settings-panel, counterpoint, bridge, import, signoff
status: approved
---

# Counterpoint Import and Sign-Off

## Screenshots

![Counterpoint command center](../images/help/settings-counterpoint-sync-settings-panel/main.png)

![Inventory control board](../images/help/inventory-control-board/main.png)

![Orders workspace](../images/help/orders-workspace/main.png)

## What this is

Counterpoint Settings is the one-time ROS Import Command Center. For go-live, the Counterpoint Bridge reads Counterpoint SQL and posts directly to the Main Hub ROS intake on port 3000. ROS records source counts, landed proof, exceptions, duplicate-customer review, and final readiness.

Use this panel to verify facts before cutover. Bridge row counts mean data was sent. ROS landed counts mean ROS wrote and linked rows for proof.

## Go-live workflow

1. Open the Bridge app on the Counterpoint PC.
2. Confirm the Bridge can reach Main Hub ROS.
3. Run **Full Import / Recheck All** in the Bridge.
4. Open **Import & Proof** in ROS.
5. Follow **Current next step** at the top of the command center.
6. Confirm required areas show landed proof.
7. Resolve import exceptions, then rerun the affected import area if needed.
8. Review **Customer Duplicates** after customers land.
9. Confirm final proof is ready before go-live sign-off.

Do not sign off while required rows are failed, missing, or waiting for exception review.

## Current next step

The command center reads the Bridge heartbeat, source counts, landed proof, import exceptions, and required-area readiness. It then names the next action:

- Start the Bridge if ROS is not receiving a heartbeat.
- Run Full Import / Recheck All if source-count proof has not landed.
- Fix preflight blockers if Counterpoint SQL or mapping proof is blocked.
- Wait for landed proof if rows were sent but ROS has not written proof yet.
- Fix the first open exception when a source row cannot land cleanly.
- Review the first required area that is not ready.
- Move to final sign-off only after required areas are ready.

Use Support Diagnostics only when the current next step says proof or Bridge status is not progressing.

## Import proof

The proof table compares:

- **Expected**: rows Counterpoint reported during preflight.
- **Sent**: rows the Bridge posted to Main Hub ROS.
- **Landed**: rows ROS wrote and linked for proof.
- **Gap**: difference between expected and landed proof.
- **Ready**: whether that area can pass go-live review.

Some rows can intentionally create more than one ROS row, such as matrix variants. ROS proof should explain that clearly; unexplained gaps or failed required areas need review.

## Exceptions

Import exceptions identify Counterpoint rows that did not land cleanly. Use **Resolve** only after the source row has landed in ROS or the exception already has ROS linkage. If the row still has no landed proof, fix the missing customer, variant, tender, or mapping data and rerun the affected import area.

Historical Counterpoint sales can include unresolved item lines when Counterpoint provides payment/header value but no exact item variant. ROS preserves the original Counterpoint item key so staff can correct the product when the exact line is known.

## Duplicate customers

Customer rows with duplicate email addresses do not stop the customer import. ROS preserves the raw Counterpoint source data, lands the customer without violating the unique email rule, and opens review work so staff can merge or correct duplicates before sign-off.

## Clean restart

Use **Reset Counterpoint import** only before go-live when an import needs to start over. Reset clears imported Counterpoint rows, import proof, exceptions, quarantine, stale diagnostics, CSV/reference cleanup artifacts, and active import pointers. It keeps staff access, store settings, register/printer configuration, local ROS setup, and reviewed Counterpoint mapping configuration.

## Updating after more Counterpoint work

Before go-live, if staff keep working in Counterpoint after an import, use **Update Since Last Run** in the Bridge without resetting ROS. ROS uses Counterpoint document, customer, product, variant, gift card, and loyalty keys to update existing imported records and land new rows. If a single area needs repair, use that area's **Fix** button. After every rerun, review **Current next step**, proof gaps, exceptions, open orders, deposits, and customer duplicates again before sign-off.

Use **Reset Counterpoint import** only when the previous import should be discarded and the store wants a clean baseline.

## Support diagnostics

Support Diagnostics is for troubleshooting proof, exceptions, and Bridge communication. It is not the normal import workflow and should not replace the current-run proof table.

## Imported tax semantics

Historical Counterpoint-imported transactions preserve gross historical totals for audit and reconciliation. Imported tax fields may be zero when Counterpoint did not provide itemized tax detail.

That imported tax detail is not current-period tax collection. Current Riverside OS tax reporting and QBO proposals should use current ROS activity, not historical imported activity.

## What to watch for

- Do not sign off from Bridge row counts alone.
- Confirm ROS landed proof for required areas.
- Resolve exceptions before final sign-off.
- Review customer duplicates before opening live operations.
- Confirm imported rows are auditable and distinguishable from current ROS transactions.

## Related workflows

- [QBO Workspace](manual:qbo-workspace)
- [Inventory Control Board](manual:inventory-control-board)
