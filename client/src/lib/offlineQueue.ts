/**
 * POS checkout recovery queue (localforage).
 *
 * **Queued:** completed checkout payloads when `navigator.onLine` is false (see `Cart`).
 * **Blocked recovery:** online checkout outcomes that are unconfirmed, or paid
 * pickup follow-up work that did not complete. These rows do not auto-replay.
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
import {
  listCurrentRegisterRecoveryJobs,
  mirrorRecoveryJob,
  resolveRecoveryJob,
  validRecoveryUuid,
  type ServerRecoveryKind,
} from "./serverRecovery";

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
  recoveryKind?: "offline_replay" | "online_unconfirmed" | "pickup_after_payment";
  recoveryKey?: string;
  recoveryTransactionId?: string;
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

const CHECKOUT_REPLAY_TIMEOUT_MS = 15_000;
const RECOVERY_SYNC_INTERVAL_MS = 30_000;

function checkoutServerKey(id: string): string {
  return `checkout:${id}`;
}

function serverKindForCheckout(item: QueuedCheckout): ServerRecoveryKind {
  if (item.recoveryKind === "pickup_after_payment") return "pickup_after_payment";
  if (item.recoveryKind === "online_unconfirmed") return "checkout_unconfirmed";
  return "checkout_offline";
}

async function mirrorQueuedCheckout(item: QueuedCheckout): Promise<void> {
  const serverSafeItem: QueuedCheckout = {
    ...item,
    authHeaders: headersSafeForOfflinePersist(item.authHeaders),
  };
  await mirrorRecoveryJob({
    client_job_key: checkoutServerKey(item.id),
    kind: serverKindForCheckout(item),
    status: (item.status ?? "pending") === "blocked" ? "blocked" : "pending",
    register_session_id: validRecoveryUuid(item.payload.session_id),
    transaction_id: validRecoveryUuid(item.recoveryTransactionId),
    checkout_client_id: validRecoveryUuid(item.payload.checkout_client_id),
    label: item.recoveryKind ?? "Offline checkout replay",
    payload: serverSafeItem,
    last_error: item.lastErrorMessage,
    attempt_count: item.attemptCount ?? 0,
  });
}

async function syncCheckoutRecoveryWithServer(): Promise<void> {
  const local = await getCheckoutQueue();
  await Promise.all(local.map((item) => mirrorQueuedCheckout(item)));
  const server = await listCurrentRegisterRecoveryJobs();
  const localIds = new Set(local.map((item) => item.id));
  let changed = false;
  for (const job of server) {
    if (job.kind === "receipt_print") continue;
    const item = job.payload as Partial<QueuedCheckout>;
    if (!item?.id || !item.payload || localIds.has(item.id)) continue;
    await checkoutStore.setItem(item.id, item as QueuedCheckout);
    changed = true;
  }
  if (changed) window.dispatchEvent(new Event("queue_changed"));
}

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
  void mirrorQueuedCheckout(item);
  window.dispatchEvent(new Event("queue_changed")); // Notify React listeners
  return id;
}

/** Record a manager-visible recovery blocker without auto-replaying it. */
export async function enqueueBlockedCheckoutRecovery(
  payload: CheckoutPayload,
  status: number,
  message: string,
  options: {
    recoveryKind: NonNullable<QueuedCheckout["recoveryKind"]>;
    recoveryKey?: string | null;
    recoveryTransactionId?: string | null;
    authHeaders?: Record<string, string>;
  },
): Promise<string> {
  const normalizedKey =
    options.recoveryKey?.trim() ||
    payload.checkout_client_id?.trim() ||
    options.recoveryTransactionId?.trim() ||
    crypto.randomUUID();
  const id = `recovery:${options.recoveryKind}:${normalizedKey}`;
  const existing = await checkoutStore.getItem<QueuedCheckout>(id);
  const item: QueuedCheckout = {
    ...(existing ?? {}),
    id,
    payload,
    timestamp: existing?.timestamp ?? Date.now(),
    status: "blocked",
    attemptCount: existing?.attemptCount ?? 0,
    lastAttemptAt: Date.now(),
    blockedAt: existing?.blockedAt ?? Date.now(),
    lastErrorStatus: status,
    lastErrorMessage: message.trim().slice(0, 1000),
    recoveryKind: options.recoveryKind,
    recoveryKey: normalizedKey,
    recoveryTransactionId: options.recoveryTransactionId?.trim() || undefined,
    authHeaders: headersSafeForOfflinePersist(options.authHeaders),
  };
  await checkoutStore.setItem(id, item);
  void mirrorQueuedCheckout(item);
  window.dispatchEvent(new Event("queue_changed"));
  return id;
}

export async function clearBlockedCheckoutRecovery(match: {
  checkoutClientId?: string | null;
  recoveryKey?: string | null;
  recoveryTransactionId?: string | null;
}): Promise<void> {
  const checkoutClientId = match.checkoutClientId?.trim();
  const recoveryKey = match.recoveryKey?.trim();
  const recoveryTransactionId = match.recoveryTransactionId?.trim();
  if (!checkoutClientId && !recoveryKey && !recoveryTransactionId) return;

  const items = await getCheckoutQueue();
  let changed = false;
  for (const item of items) {
    if ((item.status ?? "pending") !== "blocked") continue;
    const itemCheckoutClientId = item.payload.checkout_client_id?.trim();
    const matched =
      (checkoutClientId && itemCheckoutClientId === checkoutClientId) ||
      (recoveryKey && item.recoveryKey === recoveryKey) ||
      (recoveryTransactionId && item.recoveryTransactionId === recoveryTransactionId);
    if (matched) {
      await checkoutStore.removeItem(item.id);
      void resolveRecoveryJob(checkoutServerKey(item.id), "resolved", "Checkout recovery cleared");
      changed = true;
    }
  }
  if (changed) window.dispatchEvent(new Event("queue_changed"));
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
  void resolveRecoveryJob(checkoutServerKey(id), "resolved", "Checkout synchronized");
  window.dispatchEvent(new Event("queue_changed"));
}

export async function updateQueuedCheckout(item: QueuedCheckout): Promise<void> {
  await checkoutStore.setItem(item.id, item);
  void mirrorQueuedCheckout(item);
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
      const controller = new AbortController();
      const timeout = window.setTimeout(
        () => controller.abort(),
        CHECKOUT_REPLAY_TIMEOUT_MS,
      );
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/api/transactions/checkout`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...auth,
          },
          body: JSON.stringify(item.payload),
          signal: controller.signal,
        });
      } finally {
        window.clearTimeout(timeout);
      }

      if (response.ok) {
        const data = await response.json().catch(() => ({})) as { warnings?: string[] };
        if (data.warnings && data.warnings.length > 0) {
          console.warn(`Offline sync completed with warnings for item ${item.id}:`, data.warnings);
        }
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
    const initialize = async () => {
      if (navigator.onLine) await syncCheckoutRecoveryWithServer();
      await reloadQueue();
    };
    void initialize();

    const handleOnline = async () => {
      setIsOnline(true);
      await syncCheckoutRecoveryWithServer();
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
    const recoveryPoll = window.setInterval(() => {
      if (!navigator.onLine) return;
      void syncCheckoutRecoveryWithServer().then(reloadQueue);
    }, RECOVERY_SYNC_INTERVAL_MS);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("queue_changed", handleQueueChanged);
      window.clearInterval(recoveryPoll);
    };
  }, [baseUrl, getAuthHeaders, reloadQueue]);

  return { isOnline, queueCount, pendingCount, blockedCount };
}
