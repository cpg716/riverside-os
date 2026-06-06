# Customer Notifications

**Audience:** POS staff, Back Office staff, and managers reviewing automated customer messages.

**Where in ROS:** Back Office → Operations → **Customer Notifications** or POS → **Customer Notifications**.

**Related permissions:** Authenticated staff can view and mark rows reviewed. **orders.lifecycle_manage** is required to send immediately, schedule batches, or skip pending pickup/alteration notifications.

---

## Overview

Customer Notifications tracks automated customer-facing messages only. It includes ready-for-pickup, alteration-ready, appointment confirmation, appointment reminder, receipt, unknown-sender welcome, and review-invite messages. Regular staff-written Podium texts and regular staff-written emails stay in Customer Messages / Mailbox, not this review center.

## When Notifications Are Queued Or Recorded

### Orders
- When an order line is marked **Ready for Pickup** in the Order Lifecycle
- Staff notification sent immediately to relevant staff
- Customer notification queued for batch sending

### Alterations
- When an alteration is marked **ready** in Alterations workspace
- Customer notification queued for batch sending
- No staff notification (different from orders)

### Appointments
- When a customer appointment is created, ROS sends a confirmation SMS and email based on customer transactional communication preferences.
- The confirmation SMS is sent as MMS with `riverside-appointment.ics` attached when Podium/carrier support allows it.
- The confirmation email also includes `riverside-appointment.ics`.
- ROS sends an appointment reminder 24 hours before the appointment time. Example: a 9:30 AM appointment on June 10 sends the reminder around 9:30 AM on June 9.

### Loyalty
- Loyalty rewards do **not** send automated SMS/email from this workflow.
- Customer notice for loyalty rewards remains the physical loyalty letter process.

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

1. Open **Customer Notifications** from Operations or POS.
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
- **Customer Notifications** (automated-message delivery status and staff review)

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

**Last reviewed:** 2026-06-06 (Customer Notifications naming, appointment ICS, and loyalty-letter policy updated)
