/**
 * POS offline checkout queue (localforage).
 *
 * **Queued:** completed checkout payloads when `navigator.onLine` is false (see `Cart`).
 * **Not queued:** cart edits, session open/close, back-office mutations — those require API access.
 * **Flush:** on `online` event, `flushCheckoutQueue` POSTs each item to `/api/transactions/checkout`.
 * Header shows **Offline Mode** / **Pending Syncs** via `useOfflineSync`.
 * **4xx handling:** client errors block the item for manager recovery instead of
 * deleting a completed sale. Successful replays use `checkout_client_id`
 * idempotency on the server.
 */
import localforage from "localforage";
import { useEffect, useState, useCallback } from "react";
import type { CheckoutPayload } from "../components/pos/types";
import { headersSafeForOfflinePersist } from "./posRegisterAuth";

// Define the shape of our queued objects for resilience
export interface QueuedCheckout {
  id: string; // Unique local identifier (UUID)
  payload: CheckoutPayload;
  timestamp: number;
  status?: "pending" | "blocked";
  attemptCount?: number;
  lastAttemptAt?: number;
  blockedAt?: number;
  lastErrorStatus?: number;
  lastErrorMessage?: string;
  /** Snapshot at enqueue time (PIN and other secrets stripped — replay merges live headers). */
  authHeaders?: Record<string, string>;
}

export interface CheckoutQueueSummary {
  totalCount: number;
  pendingCount: number;
  blockedCount: number;
}

// Ensure the local instance is safely namespaced.
const checkoutStore = localforage.createInstance({
  name: "RiversideOS",
  storeName: "checkout_queue",
});

/** Enqueue a POS checkout when the network is unreachable. */
export async function enqueueCheckout(
  payload: CheckoutPayload,
  authHeaders?: Record<string, string>,
): Promise<string> {
  const id = crypto.randomUUID();
  const item: QueuedCheckout = {
    id,
    payload,
    timestamp: Date.now(),
    status: "pending",
    attemptCount: 0,
    authHeaders: headersSafeForOfflinePersist(authHeaders),
  };
  await checkoutStore.setItem(id, item);
  window.dispatchEvent(new Event("queue_changed")); // Notify React listeners
  return id;
}

/** Retrieve all queued items sorted by timestamp */
export async function getCheckoutQueue(): Promise<QueuedCheckout[]> {
  const keys = await checkoutStore.keys();
  const items: QueuedCheckout[] = [];
  for (const key of keys) {
    const item = await checkoutStore.getItem<QueuedCheckout>(key);
    if (item) items.push(item);
  }
  return items.sort((a, b) => a.timestamp - b.timestamp);
}

/** Remove an item from the queue after successful sync. */
export async function dequeueCheckout(id: string): Promise<void> {
  await checkoutStore.removeItem(id);
  window.dispatchEvent(new Event("queue_changed"));
}

export async function updateQueuedCheckout(item: QueuedCheckout): Promise<void> {
  await checkoutStore.setItem(item.id, item);
  window.dispatchEvent(new Event("queue_changed"));
}

export async function blockQueuedCheckout(
  item: QueuedCheckout,
  status: number,
  message: string,
): Promise<void> {
  await updateQueuedCheckout({
    ...item,
    status: "blocked",
    attemptCount: item.attemptCount ?? 0,
    lastAttemptAt: Date.now(),
    blockedAt: Date.now(),
    lastErrorStatus: status,
    lastErrorMessage: message.trim().slice(0, 1000),
  });
}

export async function getCheckoutQueueSummary(): Promise<CheckoutQueueSummary> {
  const items = await getCheckoutQueue();
  let blockedCount = 0;
  let pendingCount = 0;
  for (const item of items) {
    if ((item.status ?? "pending") === "blocked") blockedCount += 1;
    else pendingCount += 1;
  }
  return {
    totalCount: items.length,
    pendingCount,
    blockedCount,
  };
}

async function responseErrorText(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) {
      return body.error;
    }
  }
  const text = await response.text().catch(() => "");
  return text.trim() || `Checkout replay failed with HTTP ${response.status}`;
}

/** 
 * Flush the queue aggressively by trying to submit every item. 
 * Resolves to the array of un-syncable items if any fail.
 */
export async function flushCheckoutQueue(
  baseUrl: string,
  getLiveAuthHeaders?: () => Record<string, string>,
): Promise<void> {
  if (!navigator.onLine) return; // Prevent loop thrashing if offline

  const queue = await getCheckoutQueue();
  const pending = queue.filter((item) => (item.status ?? "pending") === "pending");
  if (pending.length === 0) return;

  for (const item of pending) {
    try {
      const attemptItem = {
        ...item,
        attemptCount: (item.attemptCount ?? 0) + 1,
        lastAttemptAt: Date.now(),
      };
      const live = getLiveAuthHeaders?.() ?? {};
      const stored = item.authHeaders ?? {};
      const auth = { ...stored, ...live };
      const response = await fetch(`${baseUrl}/api/transactions/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...auth,
        },
        body: JSON.stringify(item.payload),
      });

      if (response.ok) {
        await dequeueCheckout(item.id);
      } else if (response.status >= 400 && response.status < 500) {
        const message = await responseErrorText(response);
        console.warn(
          "Checkout flush client error; blocking queued item for manager recovery",
          item.id,
          response.status,
        );
        await blockQueuedCheckout(attemptItem, response.status, message);
      } else {
        await updateQueuedCheckout(attemptItem);
        console.error("Flush rejected by server:", response.status);
      }
    } catch (e) {
      await updateQueuedCheckout({
        ...item,
        attemptCount: (item.attemptCount ?? 0) + 1,
        lastAttemptAt: Date.now(),
      });
      console.error("Flush network failure on item", item.id, e);
    }
  }
}

/** 
 * Hook for consuming queue state and connectivity
 */
export function useOfflineSync(
  baseUrl: string,
  getAuthHeaders?: () => Record<string, string>,
) {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [queueCount, setQueueCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [blockedCount, setBlockedCount] = useState(0);

  const reloadQueue = useCallback(async () => {
    const summary = await getCheckoutQueueSummary();
    setQueueCount(summary.totalCount);
    setPendingCount(summary.pendingCount);
    setBlockedCount(summary.blockedCount);
  }, []);

  useEffect(() => {
    void reloadQueue();

    const handleOnline = async () => {
      setIsOnline(true);
      await flushCheckoutQueue(baseUrl, getAuthHeaders);
      void reloadQueue();
    };

    const handleOffline = () => {
      setIsOnline(false);
    };

    const handleQueueChanged = () => {
      void reloadQueue();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("queue_changed", handleQueueChanged);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("queue_changed", handleQueueChanged);
    };
  }, [baseUrl, getAuthHeaders, reloadQueue]);

  return { isOnline, queueCount, pendingCount, blockedCount };
}
