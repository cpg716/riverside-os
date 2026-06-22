# Counterpoint One-Time Import Runbook

This runbook is the go-live import path for Riverside OS. Counterpoint Bridge is a one-time migration tool: it reads Counterpoint SQL, sends the required data to Main Hub ROS, ROS writes the rows into PostgreSQL, and staff resolve any exceptions before final sign-off.

There is one go-live workflow only: Bridge extraction, ROS import proof, exception repair, customer duplicate review, and final sign-off.

## Required Outcome

Before go-live, ROS must have ready proof for the required import areas:

- Staff and sales reps
- Vendors
- Catalog parent products
- Catalog variants/SKUs
- Inventory quantity rows
- Customers
- Customer notes
- Gift card current balances
- Customer loyalty balances
- Open documents and open-document lines
- Open-document deposits/payments when available
- Closed ticket history, lines, payments, and notes
- Store credit opening balances when available

## Clean Start

Use **Reset Baseline** in Settings → Counterpoint when a rehearsal or failed run needs to be discarded. This clears imported Counterpoint rows, import proof, exceptions, and active import pointers.

Reset keeps Riverside OS setup data that should not be destroyed: staff access, store settings, register and printer configuration, and local deployment state.

After reset, refresh Settings → Counterpoint and confirm the proof table no longer shows stale landed rows from the discarded run.

## Bridge Setup

On the Counterpoint PC, open Riverside Counterpoint Bridge.

1. Paste only the SQL Server connection string value into the SQL connection field.
2. Set Main Hub ROS URL to the Main Hub API URL, for example `http://10.64.70.196:3000`.
3. Save configuration.
4. Click **Check Main Hub ROS**.
5. Confirm the Bridge shows that Main Hub ROS is ready.
6. Click **Auto-config Schema Probe** and confirm schema alignment is verified.

The Bridge should report that it is posting directly to Main Hub ROS intake.

## Run Import

Click **Run Full Extraction** in the Bridge.

The Bridge sends the import areas in dependency order so ROS can link rows correctly:

1. Staff and sales reps
2. Vendors and categories
3. Catalog parent products and variants
4. Inventory quantities and vendor item links
5. Customers and customer notes
6. Gift cards, loyalty balances, and store credit opening balances
7. Closed ticket history, lines, payments, and notes
8. Open documents, open-document lines, and deposits/payments

Do not use the Bridge record count alone as sign-off evidence. The Bridge count only proves that rows were sent. ROS proof proves which rows landed and linked.

## Review In ROS

Open Settings → Counterpoint → **Import & Proof**.

Read the proof table as:

- **Expected**: rows Counterpoint reported during preflight.
- **Sent**: rows Bridge posted to ROS.
- **Landed**: rows ROS wrote and linked for proof.
- **Gap**: expected minus landed proof.
- **Failed**: rows ROS could not land.
- **Review-landed**: rows ROS preserved but still needs staff review.
- **Ready**: whether that required area can pass go-live review.

Go-live is not ready while any required area is failed, missing landed proof, or has unresolved exceptions.

## Resolve Exceptions

Open import exceptions from the proof screen.

For each exception:

1. Read the entity, source key, message, and suggested fix.
2. Fix the missing source relationship or mapping problem.
3. Rerun the affected import area from the Bridge when needed.
4. Click **Resolve** only after ROS can prove the source row landed.

The Resolve action must not close an exception just because the batch was retried. It closes only when the source row is linked to ROS proof or the exception already has valid ROS linkage.

## Customer Duplicates

After customers land, open **Customer Duplicates**.

Counterpoint customers with duplicate emails can land without violating ROS uniqueness rules. Review and merge duplicate pairs before sign-off so staff can find customers cleanly after go-live.

## Final Sign-Off

Final sign-off requires:

- Bridge online during the import run.
- Current import proof shows required areas ready.
- No unresolved required-area exceptions.
- Customer duplicate queue reviewed.
- Gift card balances landed.
- Loyalty balances landed.
- Open documents and deposits/payments reviewed.
- Inventory quantities landed with no unexplained required gap.
- Closed ticket history available for customer lookup and returns review.

Once sign-off is complete, Counterpoint Bridge is no longer part of daily Riverside OS operations.

## Troubleshooting

Use **Support Diagnostics** only when proof or Bridge communication is unclear. It is not the normal operator workflow.

Common issues:

- **Bridge cannot reach Main Hub ROS**: confirm the Main Hub API URL and Windows firewall.
- **SQL connection fails**: paste only the connection-string value, not the `.env` variable name or quotes.
- **Expected and landed counts differ**: review exceptions and rerun the affected import area.
- **Variant count appears higher than sent**: confirm whether one Counterpoint source row legitimately creates multiple ROS proof rows before treating it as a failure.
- **Open documents fail**: check missing customers, missing variants, missing tender/payment linkage, or unresolved document mapping.

## Historical Tax Note

Counterpoint imported history preserves gross historical totals for audit and customer lookup. Imported historical line tax may not be authoritative for tax filing. Current Riverside OS tax reporting and QBO proposals should use current ROS activity.
