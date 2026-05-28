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

export async function enqueueFailedPrint(job: Omit<FailedPrintJob, "id" | "timestamp" | "attempts">): Promise<string> {
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
  window.dispatchEvent(new Event("print_queue_changed"));
  return id;
}

export async function getFailedPrintJobs(): Promise<FailedPrintJob[]> {
  const keys = await printStore.keys();
  const items: FailedPrintJob[] = [];
  for (const key of keys) {
    const item = await printStore.getItem<FailedPrintJob>(key);
    if (item) items.push(item);
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
  }
}
