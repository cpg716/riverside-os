/**
 * Receipt print retry queue (localforage).
 * Stores failed print jobs so cashiers can retry later from the POS header.
 */
import localforage from "localforage";

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
  await pruneFailedPrintJobs();
  window.dispatchEvent(new Event("print_queue_changed"));
  return id;
}

export async function getFailedPrintJobs(): Promise<FailedPrintJob[]> {
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
  window.dispatchEvent(new Event("print_queue_changed"));
}

export async function incrementPrintAttempt(id: string): Promise<void> {
  const item = await printStore.getItem<FailedPrintJob>(id);
  if (item) {
    item.attempts += 1;
    await printStore.setItem(id, item);
    if (isRetiredPrintJob(item)) {
      window.dispatchEvent(new Event("print_queue_changed"));
    }
  }
}
