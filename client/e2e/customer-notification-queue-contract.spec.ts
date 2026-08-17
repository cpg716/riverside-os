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
const interactionsWorkspace = repoFile(
  "client/src/components/operations/CustomerInteractionsOperationsSection.tsx",
);
const posSidebar = repoFile("client/src/components/pos/PosSidebar.tsx");
const sidebarSections = repoFile("client/src/components/layout/sidebarSections.ts");
const notificationApi = repoFile("server/src/api/customer_notifications.rs");
const interactionsLogic = repoFile("server/src/logic/customer_interactions.rs");
const customerNotificationLogic = repoFile(
  "server/src/logic/customer_notifications.rs",
);
const notificationScheduler = repoFile(
  "server/src/logic/notification_scheduler.rs",
);

test("Customer Interactions filters by effective delivery outcome", () => {
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

test("uses the concise Customer Interactions name with a two-line POS label", () => {
  expect(notificationQueue).toContain("Customer Interactions");
  expect(sidebarSections).toContain('label: "Customer Interactions"');
  expect(posSidebar).toContain('label: "Customer Interactions"');
  expect(posSidebar).toContain('<span className="block">Customer</span>');
  expect(posSidebar).toContain('<span className="block">Interactions</span>');
});

test("unifies the three communication sources without replacing their workspaces", () => {
  expect(notificationApi).toContain('route("/customer-interactions"');
  expect(interactionsLogic).toContain("FROM customer_notification_queue cnq");
  expect(interactionsLogic).toContain("FROM podium_message pm");
  expect(interactionsLogic).toContain("FROM mailbox_messages mm");
  expect(interactionsLogic).toContain("manual_channels_available");
  expect(interactionsWorkspace).toContain('label: "All activity"');
  expect(interactionsWorkspace).toContain('label: "Text messages"');
  expect(interactionsWorkspace).toContain('label: "Email"');
  expect(interactionsWorkspace).toContain('label: "Automated queue"');
  expect(interactionsWorkspace).toContain("setTimeout(() => setSearch");
  expect(interactionsWorkspace).toContain("AbortController");
});

test("failed deliveries have contact correction, safe retry, and future alerts", () => {
  expect(notificationQueue).toContain("Update customer");
  expect(notificationQueue).toContain("Retry delivery");
  expect(notificationQueue).toContain("/api/reviews/invite-rows/");
  expect(notificationQueue).toContain("/receipt/");
  expect(notificationQueue).toContain("/send-now");
  expect(customerNotificationLogic).toContain(
    '"customer_contact_delivery_failed"',
  );
  expect(customerNotificationLogic).toContain(
    '"hub_tab": "profile"',
  );
  expect(customerNotificationLogic).toContain(
    "Resolved automatically after a successful delivery.",
  );
  expect(customerNotificationLogic).toContain(
    "delete_app_notification_by_dedupe",
  );
  expect(customerNotificationLogic).toContain("CUSTOMERS_HUB_EDIT");
  expect(notificationScheduler).toContain(
    "mark_customer_notification_delivery_result",
  );
});

test("opaque Podium delivery failures receive staff-readable guidance", () => {
  expect(notificationQueue).toContain('error.includes("P0005")');
  expect(notificationQueue).toContain(
    "Podium accepted this SMS, but carrier delivery failed.",
  );
  expect(notificationQueue).toContain("Provider code:");
});
