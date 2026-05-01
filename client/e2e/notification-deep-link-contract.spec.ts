import { expect, test } from "@playwright/test";

import {
  isActionableNotificationDeepLink,
  isCompletableNotification,
  isSharedReadEligibleNotification,
  notificationDestinationLabel,
  notificationPrimaryInteraction,
  notificationRecencyBucket,
  notificationSeverity,
} from "../src/lib/notificationDeepLink";
import {
  bulkArchivableNotificationIds,
  bulkReadableNotificationIds,
} from "../src/lib/notificationLifecycle";

test.describe("Notification deep-link contracts", () => {
  test("order notifications are actionable with order_id", async () => {
    expect(
      isActionableNotificationDeepLink({
        type: "order",
        order_id: "txn-order-id",
      }),
    ).toBe(true);
    expect(
      notificationPrimaryInteraction("order_fully_fulfilled", {
        type: "order",
        order_id: "txn-order-id",
      }),
    ).toBe("open");
    expect(
      notificationDestinationLabel({
        type: "order",
        order_id: "txn-order-id",
      }),
    ).toBe("Orders");
  });

  test("order notifications are actionable with transaction_id", async () => {
    expect(
      isActionableNotificationDeepLink({
        type: "order",
        transaction_id: "txn-transaction-id",
      }),
    ).toBe(true);
    expect(
      notificationPrimaryInteraction("pickup_stale", {
        type: "order",
        transaction_id: "txn-transaction-id",
      }),
    ).toBe("open");
  });

  test("appointment notifications remain actionable with appointment context", async () => {
    expect(
      isActionableNotificationDeepLink({
        type: "appointments",
        section: "scheduler",
        appointment_id: "appt-1",
      }),
    ).toBe(true);
    expect(
      notificationDestinationLabel({
        type: "appointments",
        section: "scheduler",
        appointment_id: "appt-1",
      }),
    ).toBe("Appointments");
  });

  test("bundles stay preview-oriented instead of direct-open", async () => {
    const bundleLink = {
      type: "notification_bundle",
      bundle_kind: "order_due_stale",
      items: [
        {
          title: "Order 1",
          subtitle: "Open order",
          deep_link: { type: "order", transaction_id: "txn-1" },
        },
      ],
    };

    expect(isActionableNotificationDeepLink(bundleLink)).toBe(false);
    expect(
      notificationPrimaryInteraction("order_due_stale_bundle", bundleLink),
    ).toBe("preview");
    expect(
      isCompletableNotification("notification_bundle", bundleLink),
    ).toBe(false);
  });

  test("announcements stay preview-oriented and are not completable", async () => {
    const announcementLink = {
      type: "none",
      broadcast_from: {
        full_name: "Manager",
        avatar_key: "ros_default",
      },
    };

    expect(isActionableNotificationDeepLink(announcementLink)).toBe(false);
    expect(
      notificationPrimaryInteraction("admin_broadcast", announcementLink),
    ).toBe("preview");
    expect(
      isCompletableNotification("admin_broadcast", announcementLink),
    ).toBe(false);
  });

  test("completion action is reserved for task-like rows", async () => {
    expect(
      isCompletableNotification("task_due_soon", {
        type: "staff_tasks",
        instance_id: "task-1",
      }),
    ).toBe(true);

    expect(
      isCompletableNotification("notification_bundle", {
        type: "notification_bundle",
        bundle_kind: "task_due_soon",
        items: [],
      }),
    ).toBe(true);

    expect(
      isCompletableNotification("register_cash_discrepancy", {
        type: "register",
      }),
    ).toBe(false);
  });

  test("severity mapping distinguishes system, urgent, action, info, and announcements", async () => {
    expect(
      notificationSeverity("admin_broadcast", {
        type: "none",
      }),
    ).toBe("announcement");

    expect(
      notificationSeverity("register_cash_discrepancy", {
        type: "register",
      }),
    ).toBe("system");

    expect(
      notificationSeverity("notification_bundle", {
        type: "notification_bundle",
        bundle_kind: "order_due_stale",
        items: [],
      }),
    ).toBe("urgent");

    expect(
      notificationSeverity("task_due_soon", {
        type: "staff_tasks",
        instance_id: "task-1",
      }),
    ).toBe("action");

    expect(
      notificationSeverity("morning_low_stock", {
        type: "inventory",
      }),
    ).toBe("info");

    expect(
      notificationSeverity("notification_bundle", {
        type: "notification_bundle",
        bundle_kind: "podium_sms_bundle",
        items: [],
      }),
    ).toBe("info");
  });

  test("shared read eligibility is explicit for shared notification classes", async () => {
    expect(
      isSharedReadEligibleNotification("notification_bundle", {
        type: "notification_bundle",
        bundle_kind: "podium_sms_bundle",
        items: [],
      }),
    ).toBe(true);

    expect(
      isSharedReadEligibleNotification("morning_low_stock_bundle", {
        type: "notification_bundle",
        bundle_kind: "morning_low_stock",
        items: [],
      }),
    ).toBe(true);

    expect(
      isSharedReadEligibleNotification("task_due_soon", {
        type: "staff_tasks",
        instance_id: "task-1",
      }),
    ).toBe(false);
  });

  test("recency bucket separates today from earlier activity", async () => {
    const now = new Date("2026-04-23T15:30:00.000Z").getTime();

    expect(
      notificationRecencyBucket("2026-04-23T08:00:00.000Z", now),
    ).toBe("today");

    expect(
      notificationRecencyBucket("2026-04-22T23:59:59.000Z", now),
    ).toBe("earlier");

    expect(
      notificationRecencyBucket("not-a-date", now),
    ).toBe("earlier");
  });

  test("bulk lifecycle helpers only target safe visible inbox rows", async () => {
    const rows = [
      {
        staff_notification_id: "unread-visible",
        notification_id: "notif-1",
        created_at: "2026-04-23T08:00:00.000Z",
        kind: "task_due_soon",
        title: "Unread task",
        body: "",
        deep_link: { type: "staff_tasks", instance_id: "task-1" },
        source: "generator",
        read_at: null,
        completed_at: null,
        archived_at: null,
      },
      {
        staff_notification_id: "read-visible",
        notification_id: "notif-2",
        created_at: "2026-04-23T08:05:00.000Z",
        kind: "morning_low_stock",
        title: "Read stock alert",
        body: "",
        deep_link: { type: "inventory", section: "list" },
        source: "generator",
        read_at: "2026-04-23T08:06:00.000Z",
        completed_at: null,
        archived_at: null,
      },
      {
        staff_notification_id: "archived-row",
        notification_id: "notif-3",
        created_at: "2026-04-22T08:05:00.000Z",
        kind: "admin_broadcast",
        title: "Archived",
        body: "",
        deep_link: { type: "none" },
        source: "admin_broadcast",
        read_at: "2026-04-22T08:06:00.000Z",
        completed_at: null,
        archived_at: "2026-04-22T09:00:00.000Z",
      },
    ];

    expect(bulkReadableNotificationIds(rows)).toEqual(["unread-visible"]);
    expect(bulkArchivableNotificationIds(rows)).toEqual(["read-visible"]);
  });
});
