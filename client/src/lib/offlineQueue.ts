/**
 * POS offline checkout queue (localforage).
 *
 * **Queued:** completed checkout payloads when `navigator.onLine` is false (see `Cart`).
 * **Not queued:** cart edits, session open/close, back-office mutations — those require API access.
 * **Flush:** on `online` event, `flushCheckoutQueue` POSTs each item to `/api/transactions/checkout`.
 * Header shows **Offline Mode** / **Pending Syncs** via `useOfflineSync`.
 * **4xx handling:** client errors dequeue the item so the queue cannot wedge forever; invalid payloads must be re-run manually. Successful replays use `checkout_client_id` idempotency on the server.
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
  /** Snapshot at enqueue time (PIN and other secrets stripped — replay merges live headers). */
  authHeaders?: Record<string, string>;
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

/** 
 * Flush the queue aggressively by trying to submit every item. 
 * Resolves to the array of un-syncable items if any fail.
 */
export async function flushCheckoutQueue(
  baseUrl: string,
  getLiveAuthHeaders?: () => Record<string, string>,
): Promise<void> {
  if (!navigator.onLine) return; // Prevent loop thrashing if offline

  const pending = await getCheckoutQueue();
  if (pending.length === 0) return;

  for (const item of pending) {
    try {
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
        // Validation / auth will not succeed on blind retry — drop to avoid a stuck queue.
        console.warn(
          "Checkout flush client error; removing queued item",
          item.id,
          response.status,
        );
        await dequeueCheckout(item.id);
      } else {
        console.error("Flush rejected by server:", response.status);
      }
    } catch (e) {
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

  const reloadQueue = useCallback(async () => {
    const q = await getCheckoutQueue();
    setQueueCount(q.length);
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

  return { isOnline, queueCount };
}
