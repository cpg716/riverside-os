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
3. Run **Full Extraction** in the Bridge.
4. Open **Import & Proof** in ROS.
5. Confirm required areas show landed proof.
6. Resolve import exceptions, then rerun the affected import area if needed.
7. Review **Customer Duplicates** after customers land.
8. Confirm final proof is ready before go-live sign-off.

Do not sign off while required rows are failed, missing, or waiting for exception review.

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

Use **Reset Baseline** only before go-live when a rehearsal needs to start over. Reset clears imported Counterpoint rows, import proof, exceptions, and active import pointers. It keeps staff access, store settings, register/printer configuration, and local ROS setup.

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
