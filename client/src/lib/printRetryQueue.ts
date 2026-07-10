/**
 * Receipt print retry queue (localforage).
 * Stores failed print jobs so cashiers can retry later from the POS header.
 */
import localforage from "localforage";
import {
  listCurrentRegisterRecoveryJobs,
  mirrorRecoveryJob,
  resolveRecoveryJob,
  validRecoveryUuid,
} from "./serverRecovery";
import { getPosRegisterAuth } from "./posRegisterAuth";

export interface FailedPrintJob {
  id: string;
  transactionId: string;
  label: string;
  printableBase64: string;
  timestamp: number;
  attempts: number;
}

const printStore = localforage.createInstance({
  name: "RiversideOS",
  storeName: "print_retry_queue",
});

const PRINT_RETRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PRINT_RETRY_MAX_ITEMS = 50;
const PRINT_RETRY_MAX_ATTEMPTS = 5;
let lastServerHydrateAt = 0;

function printServerKey(id: string): string {
  return `print:${id}`;
}

async function mirrorPrintJob(item: FailedPrintJob): Promise<void> {
  await mirrorRecoveryJob({
    client_job_key: printServerKey(item.id),
    kind: "receipt_print",
    status: "blocked",
    register_session_id: validRecoveryUuid(getPosRegisterAuth()?.sessionId),
    transaction_id: validRecoveryUuid(item.transactionId),
    label: item.label,
    payload: item,
    last_error: "Receipt print did not complete",
    attempt_count: item.attempts,
  });
}

async function hydratePrintJobsFromServer(): Promise<void> {
  if (!getPosRegisterAuth()?.sessionId) return;
  const now = Date.now();
  if (now - lastServerHydrateAt < 30_000) return;
  lastServerHydrateAt = now;
  const jobs = await listCurrentRegisterRecoveryJobs();
  for (const job of jobs) {
    if (job.kind !== "receipt_print") continue;
    const item = job.payload as Partial<FailedPrintJob>;
    if (
      !item?.id ||
      !item.transactionId ||
      !item.label ||
      !item.printableBase64 ||
      typeof item.timestamp !== "number" ||
      typeof item.attempts !== "number"
    ) {
      continue;
    }
    const existing = await printStore.getItem<FailedPrintJob>(item.id);
    if (!existing) await printStore.setItem(item.id, item as FailedPrintJob);
  }
}

function isRetiredPrintJob(item: FailedPrintJob, now = Date.now()): boolean {
  return (
    now - item.timestamp > PRINT_RETRY_MAX_AGE_MS ||
    item.attempts >= PRINT_RETRY_MAX_ATTEMPTS
  );
}

async function pruneFailedPrintJobs(): Promise<void> {
  const keys = await printStore.keys();
  const now = Date.now();
  const active: FailedPrintJob[] = [];
  let changed = false;

  for (const key of keys) {
    const item = await printStore.getItem<FailedPrintJob>(key);
    if (!item || isRetiredPrintJob(item, now)) {
      await printStore.removeItem(key);
      if (item) {
        void resolveRecoveryJob(
          printServerKey(item.id),
          "dismissed",
          "Print retry expired",
        );
      }
      changed = true;
      continue;
    }
    active.push(item);
  }

  const overflow = active
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(PRINT_RETRY_MAX_ITEMS);

  for (const item of overflow) {
    await printStore.removeItem(item.id);
    void resolveRecoveryJob(
      printServerKey(item.id),
      "dismissed",
      "Print retry queue limit reached",
    );
    changed = true;
  }

  if (changed) {
    window.dispatchEvent(new Event("print_queue_changed"));
  }
}

export async function enqueueFailedPrint(job: Omit<FailedPrintJob, "id" | "timestamp" | "attempts">): Promise<string> {
  await pruneFailedPrintJobs();
  const id = crypto.randomUUID();
  const item: FailedPrintJob = {
    id,
    transactionId: job.transactionId,
    label: job.label,
    printableBase64: job.printableBase64,
    timestamp: Date.now(),
    attempts: 0,
  };
  await printStore.setItem(id, item);
  void mirrorPrintJob(item);
  await pruneFailedPrintJobs();
  window.dispatchEvent(new Event("print_queue_changed"));
  return id;
}

export async function getFailedPrintJobs(): Promise<FailedPrintJob[]> {
  await hydratePrintJobsFromServer();
  await pruneFailedPrintJobs();
  const keys = await printStore.keys();
  const items: FailedPrintJob[] = [];
  for (const key of keys) {
    const item = await printStore.getItem<FailedPrintJob>(key);
    if (item && !isRetiredPrintJob(item)) items.push(item);
  }
  return items.sort((a, b) => b.timestamp - a.timestamp);
}

export async function removeFailedPrintJob(id: string): Promise<void> {
  await printStore.removeItem(id);
  void resolveRecoveryJob(printServerKey(id), "resolved", "Receipt print recovery cleared");
  window.dispatchEvent(new Event("print_queue_changed"));
}

export async function incrementPrintAttempt(id: string): Promise<void> {
  const item = await printStore.getItem<FailedPrintJob>(id);
  if (item) {
    item.attempts += 1;
    await printStore.setItem(id, item);
    void mirrorPrintJob(item);
    if (isRetiredPrintJob(item)) {
      window.dispatchEvent(new Event("print_queue_changed"));
    }
  }
}
