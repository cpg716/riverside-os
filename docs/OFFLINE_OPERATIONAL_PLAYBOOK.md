# Offline and degraded network — operational playbook

**Audience:** floor leads and managers when Wi‑Fi is flaky or the API is unreachable.

## What keeps working

- **Completed checkouts** can be **queued on the device** (`client/src/lib/offlineQueue.ts`). When connectivity returns, the client replays them. Watch the app header for **offline / pending sync** indicators.
- If replay returns a server/client validation error, Riverside keeps the checkout as a **blocked recovery** item instead of deleting it. A manager must review, retry, or export/resolve the blocked item.
- **Already loaded** product and customer data in memory may still be usable for reference until the next hard refresh.

## What does not work without the API

- **Opening or closing** register sessions, **most Back Office** writes, **live** inventory and price lookups, **new** customer creation against the server, and **staff permission** resolution if the session cannot reach the API.

## Recommended floor procedure

1. **Avoid starting** large special-order or wedding checkouts if the register shows offline unless you can complete the sale in one connected push.
2. If checkout **queues**, **do not clear browser storage** on that device until sync completes; note the **pending count** for the next manager handoff.
3. For **open orders** that need payment or edits, move to a **connected terminal** or wait for connectivity rather than duplicating work on paper.
4. After an outage, confirm **`pending sync`** and **blocked recovery** counts are **zero** and spot-check **Orders** in Back Office for the affected period.
5. Do not close the register while checkout recovery is pending or blocked; the close flow blocks Z-close until recovery is resolved.

## Configuration (engineering)

- Production PWA: set **`RIVERSIDE_CORS_ORIGINS`** to your HTTPS app origins (`server/src/main.rs`). Optional **`RIVERSIDE_STRICT_PRODUCTION=true`** refuses startup without an allowlist.
