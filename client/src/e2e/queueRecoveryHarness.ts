import {
  dequeueCheckout,
  flushCheckoutQueue,
  syncCheckoutRecoveryWithServer,
  updateQueuedCheckout,
} from "../lib/offlineQueue";
import {
  enqueueFailedPrint,
  getFailedPrintJobs,
  removeFailedPrintJob,
} from "../lib/printRetryQueue";

declare global {
  interface Window {
    __RIVERSIDE_E2E_QUEUE_HARNESS__?: {
      dequeueCheckout: typeof dequeueCheckout;
      enqueueFailedPrint: typeof enqueueFailedPrint;
      flushCheckoutQueue: typeof flushCheckoutQueue;
      getFailedPrintJobs: typeof getFailedPrintJobs;
      removeFailedPrintJob: typeof removeFailedPrintJob;
      syncCheckoutRecoveryWithServer: typeof syncCheckoutRecoveryWithServer;
      updateQueuedCheckout: typeof updateQueuedCheckout;
    };
  }
}

window.__RIVERSIDE_E2E_QUEUE_HARNESS__ = Object.freeze({
  dequeueCheckout,
  enqueueFailedPrint,
  flushCheckoutQueue,
  getFailedPrintJobs,
  removeFailedPrintJob,
  syncCheckoutRecoveryWithServer,
  updateQueuedCheckout,
});
