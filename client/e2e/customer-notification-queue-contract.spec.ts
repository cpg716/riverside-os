import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

function repoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

const notificationQueue = repoFile(
  "client/src/components/operations/NotificationQueueOperationsSection.tsx",
);
const notificationApi = repoFile("server/src/api/customer_notifications.rs");

test("Customer Notifications filters by effective delivery outcome", () => {
  expect(notificationApi).toContain("END AS effective_status");
  expect(notificationApi).toContain("cnq.delivery_status = 'failed'");
  expect(notificationApi).toContain("cnq.delivery_status = 'pending'");
  expect(notificationQueue).toContain("new URLSearchParams({");
  expect(notificationQueue).toContain('status: "all"');
  expect(notificationQueue).toContain("include_reviewed:");
  expect(notificationQueue).toContain("row.effective_status === status");
  expect(notificationQueue).toContain('row.effective_status === "failed"');
  expect(notificationQueue).toContain('row.effective_status === "sent"');
});

test("opaque Podium delivery failures receive staff-readable guidance", () => {
  expect(notificationQueue).toContain('error.includes("P0005")');
  expect(notificationQueue).toContain(
    "Podium accepted this SMS, but carrier delivery failed.",
  );
  expect(notificationQueue).toContain("Provider code:");
});
