# Offline and degraded network — operational playbook

**Audience:** floor leads and managers when Wi‑Fi is flaky or the API is unreachable.

## What keeps working

- A **simple take-now sale** can be **queued on the device** (`client/src/lib/offlineQueue.ts`) only when it is paid with cash, a physical check, or a verified **Manual Card** approval completed outside ROS. ROS prints **SALE SAVED - PENDING SYNC** with the recovery identity; the receipt is not yet a Main Hub Transaction Record. When connectivity returns, the client replays the exact checkout and mirrors unresolved recovery state to the Main Hub. Watch the app header for **offline / pending sync** indicators.
- If Helcim already approved a **simple take-now** sale but the Main Hub drops before checkout confirmation, staff select **Record Sale** once. ROS saves the exact checkout identity, prints a **PAYMENT APPROVED - PENDING SYNC** receipt, and replays that unchanged checkout after reconnecting. This is not a new offline card authorization; never run the card again. Shipping, pickup, orders, exchanges, alterations, and wedding disbursements require live recovery instead.
- If replay returns a server/client validation error, Riverside keeps the checkout as a **blocked recovery** item instead of deleting it. A manager must review, retry, or export/resolve the blocked item.
- Failed receipt-print jobs are also mirrored to the Main Hub and can be restored on another linked register in the same open till shift. A successful retry or explicit dismissal resolves the central copy.
- **Already loaded** product and customer data in memory may still be usable for reference until the next hard refresh.

## What does not work without the API

- **Opening or closing** register sessions, **most Back Office** writes, **live** inventory and price lookups, **new** customer creation against the server, and **staff permission** resolution if the session cannot reach the API.
- Shipping, Fulfillment Orders, order payments, weddings, pickups, alterations, returns/exchanges, gift-card activity, deposits, account/store-credit tenders, tax-exempt sales, backdated sales, and below-cost approvals require a live Main Hub connection. Riverside keeps these checkouts open and does not queue them.
- If the device still reports online but the **Main Hub server is down**, ordinary sales remain open instead of being queued. Wait for the red server banner to clear. The only exception is the exact already-approved Helcim take-now recovery described above.

## Recommended floor procedure

1. **Do not start** orders, weddings, pickups, alterations, returns/exchanges, or account-ledger activity while the register shows offline.
2. If an eligible checkout **queues**, give the customer the **Pending Sync** receipt, keep the device online long enough for the Main Hub recovery copy to appear, and do not ring the sale again. Do not clear browser storage until sync completes; note the **pending count** for the next manager handoff.
3. For **open orders** that need payment or edits, move to a **connected terminal** or wait for connectivity rather than duplicating work on paper.
4. After an outage, confirm **`pending sync`** and **blocked recovery** counts are **zero** and spot-check **Orders** in Back Office for the affected period.
5. Review and repair pending or blocked checkout recovery before close when practical. If work remains, assign an owner and use the ordinary authorized close. Riverside keeps the recovery available in its operational workspace and audited close record; close never resolves or dismisses it, and the warning does not print on the financial Z-Report.

## Engineering notes

- Production PWA: set **`RIVERSIDE_CORS_ORIGINS`** to your HTTPS app origins (`server/src/main.rs`). Optional **`RIVERSIDE_STRICT_PRODUCTION=true`** refuses startup without an allowlist.
- **Replay timeout (v0.80.7):** Each queued checkout replay uses a 15-second `AbortController` timeout. If a TCP connection hangs (half-open), the item is retried on the next flush cycle rather than blocking the entire queue indefinitely.
- **Durable recovery (migration 124):** `operational_recovery_job` stores server-visible checkout and receipt-print recovery state. POS reads are scoped to the authenticated till-close group; store-wide review requires `register.reports`. Persisted payloads strip PINs, register-session tokens, authorization headers, and cookies.
