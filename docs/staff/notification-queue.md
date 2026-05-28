# Notification Queue

**Audience:** Managers and staff with **orders.view** permission.

**Where in ROS:** Back Office → Operations → **Notification Queue**.

**Related permissions:** **orders.view** to view queue, **orders.lifecycle_manage** to send immediately, schedule batches, or skip notifications.

---

## Overview

The Notification Queue manages automated "Ready for Pickup" SMS/email notifications for orders and alterations. Messages are queued when items become ready and sent in batches at scheduled times (9:30 AM and 3:00 PM, Monday-Saturday) or immediately via staff override.

## When Notifications Are Queued

### Orders
- When an order line is marked **Ready for Pickup** in the Order Lifecycle
- Staff notification sent immediately to relevant staff
- Customer notification queued for batch sending

### Alterations
- When an alteration is marked **ready** in Alterations workspace
- Customer notification queued for batch sending
- No staff notification (different from orders)

## Queue Statuses

| Status | Description |
|--------|-------------|
| **Pending** | Waiting for next scheduled batch (9:30 AM or 3:00 PM) |
| **Scheduled** | Assigned to specific send time (manual or batch) |
| **Sent** | Successfully delivered to customer |
| **Skipped** | Marked to skip (will not be sent) |
| **Failed** | Delivery failed with error |

## How to Use

### Review Pending Notifications

1. **Operations** → **Notification Queue**.
2. Filter by status (pending, scheduled, sent, failed).
3. Filter by entity type (order, alteration).
4. Review customer details, entity information, and scheduled time.

### Send Notification Immediately (Override)

1. Find pending notification in queue.
2. Click **Send Now**.
3. Provide reason (optional, for audit trail).
4. Notification sent immediately, bypassing schedule.
5. Use for urgent pickups or customer requests.

### Skip Notification

1. Find pending notification in queue.
2. Click **Skip**.
3. Mark as skipped (will not be sent).
4. Use when:
   - Customer already notified via other channel
   - Pickup already completed
   - Customer declined notification

### Schedule Batch

1. Click **Schedule Batch** button.
2. Target time defaults to next scheduled slot (9:30 AM or 3:00 PM).
3. Can override with custom time if needed.
4. All pending notifications scheduled for target time.

## Scheduled Send Times

- **9:30 AM** Monday-Saturday
- **3:00 PM** Monday-Saturday
- **No notifications** on Sunday

Background job runs every minute to check schedule and send due notifications.

## Customer Communication

All sent messages appear in:
- **Customer Messages section** (Podium SMS/email conversation history)
- **Customer History** (activity log)
- **Notification Queue** (delivery status tracking)

## Troubleshooting

### Notifications Not Sending

1. Check Podium configuration (Settings → Integrations → Podium)
2. Verify customer opt-in settings (SMS/email opt-in)
3. Check notification queue status (pending vs scheduled)
4. Review logs for delivery errors
5. Verify phone number normalization (E.164 format)

### Notifications Sent at Wrong Time

1. Check system timezone
2. Verify scheduled job is running
3. Review `scheduled_for` timestamp in queue
4. Check for manual override flags

### Duplicate Notifications

1. System prevents duplicates via unique constraint
2. If duplicates appear, check for manual queue operations
3. Contact manager if issue persists

## Common Issues

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Queue empty | Check if items marked ready | Verify order/alteration status |
| Send Now not working | Check **orders.lifecycle_manage** permission | Contact manager |
| SMS not delivered | Check Podium credentials | Verify customer phone number |
| Email not delivered | Check SMTP configuration | Verify customer email address |

## When to Get a Manager

- Bulk notification failures
- Podium integration issues
- Permission problems
- System-wide notification delays

---

## See also

- [operations-home.md](operations-home.md)
- [../CUSTOMER_NOTIFICATION_QUEUE.md](../CUSTOMER_NOTIFICATION_QUEUE.md)
- [podium-integration-staff-manual.md](podium-integration-staff-manual.md)

**Last reviewed:** 2026-05-28 (v0.80.9 Notification Queue added)
