# Audit Report: Offline Operations & Sync (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-08
**Version Audited:** v0.85.0 (commit `73cdd56`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of the POS offline checkout queue (`offlineQueue.ts`) — enqueue, flush/replay, 4xx blocking, idempotency, auth header sanitization, queue state management, and register-close interaction.

---

## 1. Executive Summary

The Offline Operations & Sync subsystem is a **resilient, fault-tolerant** client-side queue that enables POS operations during network outages. The implementation correctly handles the critical financial edge cases: 4xx client errors block items for manager recovery instead of silently deleting completed sales, auth headers are sanitized before persistence, and server-side `checkout_client_id` idempotency guards prevent duplicate orders during replay.

**Overall Status:** Production Ready — 0 blockers, 0 regressions. P1-001 from the Production Hardening audit fully remediated.

---

## 2. Architecture Trace

### 2.1 Storage Layer
```
localforage instance: RiversideOS / checkout_queue
  → IndexedDB / WebSQL (browser-native persistent storage)
  → Survives tab close, browser restart, device reboot
  → Namespaced to prevent collision with other app data
```

### 2.2 Queue Entry Model
```typescript
interface QueuedCheckout {
  id: string;              // crypto.randomUUID()
  payload: CheckoutPayload;
  timestamp: number;       // enqueue time
  status: "pending" | "blocked";
  attemptCount: number;
  lastAttemptAt: number;
  blockedAt: number;
  lastErrorStatus: number;
  lastErrorMessage: string;
  authHeaders: Record<string, string>;  // sanitized snapshot
}
```

### 2.3 Enqueue Flow
```
enqueueCheckout(payload, authHeaders)
  → Generate UUID via crypto.randomUUID()
  → Strip sensitive auth data via headersSafeForOfflinePersist()
  → Store as { status: "pending", attemptCount: 0 }
  → Dispatch "queue_changed" event for React state update
```

Only completed retail checkouts are queued. Complex operations (wedding party creation, register session management, back-office mutations) are intentionally blocked without a live API.

### 2.4 Flush / Replay Flow
```
flushCheckoutQueue(baseUrl, getLiveAuthHeaders)
  → Guard: skip if !navigator.onLine
  → Filter to "pending" items only (skip "blocked")
  → For each pending item:
      → Increment attemptCount
      → Merge stored auth headers with live headers (live takes precedence)
      → POST to /api/transactions/checkout with 15-second AbortController timeout
      → If response.ok:
          → Log any warnings from server
          → Remove from queue (dequeueCheckout)
      → If 4xx (client error):
          → Block item for manager recovery (blockQueuedCheckout)
          → Preserve error status and message (trimmed to 1000 chars)
      → If 5xx (server error):
          → Keep as pending, increment attempt count
          → Will retry on next flush
      → If network error:
          → Keep as pending, increment attempt count
          → Will retry when online event fires
```

### 2.5 4xx Blocking (P1-001 Remediation)
The April Production Hardening audit identified that 4xx responses previously caused queue items to be silently deleted — a potential loss of financial data. This has been fully remediated:

- 4xx errors now transition items to `status: "blocked"` with error context
- Blocked items remain in persistent storage
- Error status and message are captured for diagnostic display
- Manager intervention required to resolve blocked items
- Register close is blocked while pending/blocked items exist

### 2.6 Auth Header Sanitization
`headersSafeForOfflinePersist()` strips sensitive authentication secrets (PINs, tokens) from the stored headers. During replay, the current live auth headers are merged on top, ensuring:
- No credentials leak into persistent storage
- Replay uses fresh authentication context
- Session continuity maintained across outage

### 2.7 Server-Side Idempotency
Each checkout payload includes a unique `checkout_client_id`. The server's checkout handler uses this for two-layer idempotency:
1. Pre-insert check within the transaction
2. Unique constraint race catch (`transactions_checkout_client_id_uidx`)

This prevents duplicate orders if the same checkout is replayed multiple times (e.g., if the client reconnects during a replay attempt and retries).

---

## 3. UI Integration

### 3.1 React Hook: `useOfflineSync`
```typescript
useOfflineSync(baseUrl, getAuthHeaders)
  → Returns: { isOnline, queueCount, pendingCount, blockedCount }
  → Listens for: online, offline, queue_changed events
  → Auto-flush on reconnect (online event)
```

### 3.2 Floor Visibility
- **OfflineBanner**: Top-of-screen "Offline Mode" / "Connected" status
- **Pending Syncs**: Count badge showing queued + blocked items
- **Staff Warning**: Alert against clearing browser cache while pending items exist

### 3.3 Queue Summary
`getCheckoutQueueSummary()` provides real-time breakdown:
- `totalCount`: All queued items
- `pendingCount`: Ready for next flush attempt
- `blockedCount`: 4xx errors requiring manager review

---

## 4. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| Persistence layer | localforage/IndexedDB | Confirmed | ✅ No regression |
| Flush strategy | "online event auto-flush" | Confirmed with 15-second timeout | ✅ No regression |
| Idempotency | checkout_client_id noted | Confirmed: two-layer server guard | ✅ No regression |
| 4xx handling | P1-001: silently discarded | **Fully remediated**: blocks item for recovery | ✅ Fixed |
| Auth sanitization | headersSafeForOfflinePersist noted | Confirmed: strips secrets, merges live on replay | ✅ No regression |
| Register close guard | Recommended | Confirmed: close blocked while pending/blocked exist | ✅ Implemented |
| Queue state tracking | Not detailed | Verified: pending/blocked status with attempt count | ✅ Enhanced |
| Blocked item diagnostics | Not documented | Verified: error status, message, blockedAt timestamp | ✅ New finding |

---

## 5. Findings

### 5.1 Positive: Financial Data Safety
The 4xx blocking pattern is the correct approach for a financial system. A completed sale must never be silently deleted from the recovery queue — it represents real revenue that the store has already collected cash/card for. Blocking for manager review ensures no financial data is lost.

### 5.2 Positive: Timeout Protection
The 15-second `AbortController` timeout on replay requests prevents the queue flush from hanging indefinitely on a slow or partially-responsive API, which is critical during network recovery scenarios.

### 5.3 Positive: Event-Driven UI Updates
The `queue_changed` custom event pattern keeps the React UI in sync with queue mutations without polling. This is efficient and provides immediate feedback to floor staff.

---

## 6. Conclusion

**0 blockers, 0 regressions.** The Offline Operations & Sync subsystem is production-ready with robust financial data safety, proper 4xx error handling (P1-001 fully remediated), auth header sanitization, and server-side idempotency guards.
