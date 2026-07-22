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
  reportStationCloseStatus,
  resolveRecoveryJob,
  validRecoveryUuid,
  type ServerRecoveryJob,
  type ServerRecoveryKind,
} from "./serverRecovery";
import {
  scrubSensitivePinKeys,
  sensitivePinKeysWereRemoved,
} from "./sensitiveData";

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
  recoveryKind?:
    "offline_replay" | "online_unconfirmed" | "pickup_after_payment";
  recoveryKey?: string;
  recoveryTransactionId?: string;
  recovery_steps?: Array<
    | {
        kind: "ship_transaction" | "pickup_transaction";
        transaction_id: string;
        transaction_line_ids: string[];
      }
    | {
        kind: "alteration_pickup";
        alteration_id: string;
      }
  >;
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
const RECOVERY_SYNC_INTERVAL_MS = 10_000;
type CheckoutMirrorVersion = {
  version: number;
  settled: boolean;
  promise: Promise<ServerRecoveryJob | null>;
};

const recoveryMirrorInFlight = new Map<string, CheckoutMirrorVersion>();
const checkoutReplayInFlight = new Map<string, Promise<void>>();
const checkoutQueueVersions = new Map<string, number>();

function checkoutQueueVersion(id: string): number {
  return checkoutQueueVersions.get(id) ?? 0;
}

function markCheckoutQueueChanged(id: string): void {
  checkoutQueueVersions.set(id, checkoutQueueVersion(id) + 1);
}

async function storeQueuedCheckout(item: QueuedCheckout): Promise<void> {
  markCheckoutQueueChanged(item.id);
  await checkoutStore.setItem(item.id, item);
}

async function removeQueuedCheckout(id: string): Promise<void> {
  markCheckoutQueueChanged(id);
  await checkoutStore.removeItem(id);
  recoveryMirrorInFlight.delete(id);
}

function checkoutServerKey(id: string): string {
  return `checkout:${id}`;
}

function serverKindForCheckout(item: QueuedCheckout): ServerRecoveryKind {
  if (item.recoveryKind === "pickup_after_payment")
    return "pickup_after_payment";
  if (item.recoveryKind === "online_unconfirmed") return "checkout_unconfirmed";
  return "checkout_offline";
}

async function postQueuedCheckoutMirror(
  item: QueuedCheckout,
): Promise<ServerRecoveryJob | null> {
  const serverSafeItem = scrubSensitivePinKeys<QueuedCheckout>({
    ...item,
    authHeaders: headersSafeForOfflinePersist(item.authHeaders),
  });
  return mirrorRecoveryJob({
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

function mirrorQueuedCheckout(
  item: QueuedCheckout,
  reuseSettledVersion = false,
): Promise<ServerRecoveryJob | null> {
  // Keep every state transition in call order. In particular, a blocked update
  // must trail an already-started pending mirror instead of being coalesced away.
  const version = checkoutQueueVersion(item.id);
  const previous = recoveryMirrorInFlight.get(item.id);
  if (
    previous?.version === version &&
    (!previous.settled || reuseSettledVersion)
  ) {
    return previous.promise;
  }
  const request = (previous?.promise ?? Promise.resolve(null))
    .catch(() => null)
    .then(() => postQueuedCheckoutMirror(item))
    .catch(() => null);
  const entry: CheckoutMirrorVersion = {
    version,
    settled: false,
    promise: request,
  };
  recoveryMirrorInFlight.set(item.id, entry);
  void request.finally(() => {
    if (recoveryMirrorInFlight.get(item.id) === entry) {
      entry.settled = true;
    }
  });
  return request;
}

async function syncCheckoutRecoveryWithServer(): Promise<void> {
  const local = await getCheckoutQueue();
  const mirrorResults = await Promise.all(
    local.map(async (item) => ({
      item,
      job: await mirrorQueuedCheckout(item),
    })),
  );
  let changed = false;
  for (const { item, job } of mirrorResults) {
    if (!job) continue;
    if (job.status === "resolved") {
      await removeQueuedCheckout(item.id);
      changed = true;
      continue;
    }
    if (job.status !== "pending" && job.status !== "blocked") continue;
    const current = await checkoutStore.getItem<QueuedCheckout>(item.id);
    if (!current) continue;
    const authoritative = checkoutWithServerState(current, job);
    if (!sameServerManagedCheckoutState(current, authoritative)) {
      await storeQueuedCheckout(authoritative);
      changed = true;
    }
  }

  const server = await listCurrentRegisterRecoveryJobs();
  const localIds = new Set((await getCheckoutQueue()).map((item) => item.id));
  for (const job of server) {
    if (!matchesCheckoutQueueKind(job.kind)) continue;
    if (job.status !== "pending" && job.status !== "blocked") continue;
    const item = queuedCheckoutFromServer(job);
    if (!item || localIds.has(item.id)) continue;
    await storeQueuedCheckout(item);
    localIds.add(item.id);
    changed = true;
  }
  if (changed) window.dispatchEvent(new Event("queue_changed"));
}

function checkoutWithServerState(
  item: QueuedCheckout,
  job: ServerRecoveryJob,
): QueuedCheckout {
  return scrubSensitivePinKeys<QueuedCheckout>({
    ...item,
    status: job.status === "blocked" ? "blocked" : "pending",
    attemptCount: Math.max(item.attemptCount ?? 0, job.attempt_count),
    lastErrorMessage: job.last_error?.trim() || item.lastErrorMessage,
    recoveryTransactionId:
      job.transaction_id?.trim() || item.recoveryTransactionId,
  });
}

function sameServerManagedCheckoutState(
  first: QueuedCheckout,
  second: QueuedCheckout,
): boolean {
  return (
    first.status === second.status &&
    first.attemptCount === second.attemptCount &&
    first.lastErrorMessage === second.lastErrorMessage &&
    first.recoveryTransactionId === second.recoveryTransactionId
  );
}

function queuedCheckoutFromServer(
  job: ServerRecoveryJob,
): QueuedCheckout | null {
  const payload = job.payload as Partial<QueuedCheckout>;
  if (
    !payload?.id ||
    !payload.payload ||
    checkoutServerKey(payload.id) !== job.client_job_key
  ) {
    return null;
  }
  return checkoutWithServerState(
    scrubSensitivePinKeys(payload as QueuedCheckout),
    job,
  );
}

function matchesCheckoutQueueKind(kind: ServerRecoveryKind): boolean {
  return (
    kind === "checkout_offline" ||
    kind === "checkout_unconfirmed" ||
    kind === "pickup_after_payment"
  );
}

/** Enqueue a POS checkout when the network is unreachable. */
export async function enqueueCheckout(
  payload: CheckoutPayload,
  authHeaders?: Record<string, string>,
): Promise<string> {
  const id = crypto.randomUUID();
  const item: QueuedCheckout = {
    id,
    payload: scrubSensitivePinKeys(payload),
    timestamp: Date.now(),
    status: "pending",
    attemptCount: 0,
    authHeaders: headersSafeForOfflinePersist(authHeaders),
  };
  await storeQueuedCheckout(item);
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
    recoverySteps?: QueuedCheckout["recovery_steps"];
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
    payload: scrubSensitivePinKeys(payload),
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
    recovery_steps: options.recoverySteps,
    authHeaders: headersSafeForOfflinePersist(options.authHeaders),
  };
  await storeQueuedCheckout(item);
  void mirrorQueuedCheckout(item);
  window.dispatchEvent(new Event("queue_changed"));
  return id;
}

async function completeQueuedCheckoutAuditSync(
  item: QueuedCheckout,
  resolutionNote: string,
): Promise<boolean> {
  const mirrored = await mirrorQueuedCheckout(item, true);
  if (mirrored?.status === "resolved") return true;
  const resolved =
    (mirrored?.status === "pending" || mirrored?.status === "blocked") &&
    (await resolveRecoveryJob(
      checkoutServerKey(item.id),
      "resolved",
      resolutionNote,
    ));
  if (resolved) return true;

  await storeQueuedCheckout(
    scrubSensitivePinKeys<QueuedCheckout>({
      ...item,
      status: item.status ?? "pending",
      attemptCount: (item.attemptCount ?? 0) + 1,
      lastAttemptAt: Date.now(),
      lastErrorMessage:
        item.status === "blocked"
          ? (item.lastErrorMessage ??
            "Transaction recorded. Riverside is retrying its recovery audit sync before Z-close.")
          : "Transaction recorded. Riverside is retrying its recovery audit sync before Z-close.",
    }),
  );
  return false;
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
      (recoveryTransactionId &&
        item.recoveryTransactionId === recoveryTransactionId);
    if (matched) {
      // Paid follow-up records clear only after the server verifies their exact persisted
      // pickup/shipping/alteration checklist through the Manager recovery workflow.
      if (item.recoveryKind === "pickup_after_payment") continue;
      if (
        await completeQueuedCheckoutAuditSync(item, "Checkout recovery cleared")
      ) {
        await removeQueuedCheckout(item.id);
      }
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
    if (item) {
      const sanitized = scrubSensitivePinKeys(item);
      if (sensitivePinKeysWereRemoved(item, sanitized)) {
        await storeQueuedCheckout(sanitized);
      }
      items.push(sanitized);
    }
  }
  return items.sort((a, b) => a.timestamp - b.timestamp);
}

/** Remove an item from the queue after successful sync. */
export async function dequeueCheckout(id: string): Promise<void> {
  const item = await checkoutStore.getItem<QueuedCheckout>(id);
  if (
    item &&
    !(await completeQueuedCheckoutAuditSync(item, "Checkout synchronized"))
  ) {
    window.dispatchEvent(new Event("queue_changed"));
    return;
  }
  await removeQueuedCheckout(id);
  window.dispatchEvent(new Event("queue_changed"));
}

/** Clear the local mirror after the audited server recovery endpoint succeeds. */
export async function clearLocallyRecoveredCheckout(
  clientJobKey: string,
): Promise<void> {
  const prefix = "checkout:";
  if (!clientJobKey.startsWith(prefix)) return;
  const id = clientJobKey.slice(prefix.length);
  if (!id) return;
  await removeQueuedCheckout(id);
  window.dispatchEvent(new Event("queue_changed"));
}

export async function updateQueuedCheckout(
  item: QueuedCheckout,
): Promise<void> {
  const sanitized = scrubSensitivePinKeys(item);
  await storeQueuedCheckout(sanitized);
  void mirrorQueuedCheckout(sanitized);
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
    const body = (await response.json().catch(() => ({}))) as {
      error?: unknown;
    };
    if (typeof body.error === "string" && body.error.trim()) {
      return body.error;
    }
  }
  const text = await response.text().catch(() => "");
  return text.trim() || `Checkout replay failed with HTTP ${response.status}`;
}

async function queuedCheckoutAtReplayVersion(
  id: string,
  replayVersion: number,
): Promise<QueuedCheckout | null> {
  if (checkoutQueueVersion(id) !== replayVersion) return null;
  const current = await checkoutStore.getItem<QueuedCheckout>(id);
  if (
    !current ||
    (current.status ?? "pending") !== "pending" ||
    checkoutQueueVersion(id) !== replayVersion
  ) {
    return null;
  }
  return current;
}

async function replayQueuedCheckout(
  queuedItem: QueuedCheckout,
  baseUrl: string,
  getLiveAuthHeaders?: () => Record<string, string>,
): Promise<void> {
  const current = await checkoutStore.getItem<QueuedCheckout>(queuedItem.id);
  if (!current || (current.status ?? "pending") !== "pending") return;
  const replayVersion = checkoutQueueVersion(current.id);
  if (!validRecoveryUuid(current.payload.checkout_client_id)) {
    if (await queuedCheckoutAtReplayVersion(current.id, replayVersion)) {
      await blockQueuedCheckout(
        current,
        400,
        "Legacy queued checkout is missing its exact checkout identity and cannot be replayed safely. Review it with a manager.",
      );
    }
    return;
  }

  try {
    const attemptItem = {
      ...current,
      attemptCount: (current.attemptCount ?? 0) + 1,
      lastAttemptAt: Date.now(),
    };
    const live = getLiveAuthHeaders?.() ?? {};
    const stored = current.authHeaders ?? {};
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
        body: JSON.stringify(current.payload),
        signal: controller.signal,
      });
    } finally {
      window.clearTimeout(timeout);
    }

    if (response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        warnings?: string[];
      };
      if (data.warnings && data.warnings.length > 0) {
        console.warn(
          `Offline sync completed with warnings for item ${current.id}:`,
          data.warnings,
        );
      }
      await dequeueCheckout(current.id);
    } else if (response.status >= 400 && response.status < 500) {
      const message = await responseErrorText(response);
      console.warn(
        "Checkout flush client error; blocking queued item for manager recovery",
        current.id,
        response.status,
      );
      if (await queuedCheckoutAtReplayVersion(current.id, replayVersion)) {
        await blockQueuedCheckout(attemptItem, response.status, message);
      }
    } else {
      if (await queuedCheckoutAtReplayVersion(current.id, replayVersion)) {
        await updateQueuedCheckout(attemptItem);
      }
      console.error("Flush rejected by server:", response.status);
    }
  } catch (e) {
    if (await queuedCheckoutAtReplayVersion(current.id, replayVersion)) {
      await updateQueuedCheckout({
        ...current,
        attemptCount: (current.attemptCount ?? 0) + 1,
        lastAttemptAt: Date.now(),
      });
    }
    console.error("Flush network failure on item", current.id, e);
  }
}

function queueCheckoutReplay(
  item: QueuedCheckout,
  baseUrl: string,
  getLiveAuthHeaders?: () => Record<string, string>,
): Promise<void> {
  const existing = checkoutReplayInFlight.get(item.id);
  if (existing) return existing;
  const replay = replayQueuedCheckout(item, baseUrl, getLiveAuthHeaders).catch(
    (error) => {
      console.error("Checkout replay failed unexpectedly", item.id, error);
    },
  );
  checkoutReplayInFlight.set(item.id, replay);
  void replay.finally(() => {
    if (checkoutReplayInFlight.get(item.id) === replay) {
      checkoutReplayInFlight.delete(item.id);
    }
  });
  return replay;
}

/** Flush every pending checkout once; concurrent triggers share the per-item replay. */
export async function flushCheckoutQueue(
  baseUrl: string,
  getLiveAuthHeaders?: () => Record<string, string>,
): Promise<void> {
  if (!navigator.onLine) return;
  const pending = (await getCheckoutQueue()).filter(
    (item) => (item.status ?? "pending") === "pending",
  );
  for (const item of pending) {
    await queueCheckoutReplay(item, baseUrl, getLiveAuthHeaders);
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
      if (navigator.onLine) {
        await syncCheckoutRecoveryWithServer();
        await flushCheckoutQueue(baseUrl, getAuthHeaders);
      }
      await reloadQueue();
      if (navigator.onLine) {
        const summary = await getCheckoutQueueSummary();
        await reportStationCloseStatus(summary);
      }
    };
    void initialize();

    const handleOnline = async () => {
      setIsOnline(true);
      await syncCheckoutRecoveryWithServer();
      await flushCheckoutQueue(baseUrl, getAuthHeaders);
      void reloadQueue();
      const summary = await getCheckoutQueueSummary();
      await reportStationCloseStatus(summary);
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
      void syncCheckoutRecoveryWithServer().then(async () => {
        await flushCheckoutQueue(baseUrl, getAuthHeaders);
        await reloadQueue();
        const summary = await getCheckoutQueueSummary();
        await reportStationCloseStatus(summary);
      });
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
