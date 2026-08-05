import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const repoFile = (path: string) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("routine fulfillment and inventory telemetry stay out of Notifications", async () => {
  const [transactions, notificationJobs, operationalOutbox] = await Promise.all([
    repoFile("server/src/api/transactions.rs"),
    repoFile("server/src/logic/notifications_jobs.rs"),
    repoFile("server/src/logic/operational_outbox.rs"),
  ]);

  expect(transactions).not.toContain("emit_order_fully_fulfilled");
  expect(transactions).not.toContain(
    "Failed to broadcast system alert for pickup negative stock",
  );
  expect(transactions).not.toContain(
    "Failed to broadcast system alert for shipping negative stock",
  );
  expect(notificationJobs).not.toContain("run_negative_available_stock_admin");
  expect(operationalOutbox).not.toContain("checkout_negative_stock:");

  expect(transactions).toContain(
    "review Inventory Reports → Inventory Reconciliation",
  );
  expect(operationalOutbox).toContain(
    "checkout completed with negative inventory reconciliation finding",
  );
});
