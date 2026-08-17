# Customer Interactions

**Audience:** POS staff, Back Office staff, and managers reviewing automated customer messages.

**Where in ROS:** Back Office → Operations → **Customer Interactions** or POS → **Customer Interactions**.

**Related permissions:** Authenticated staff can view automated activity and mark rows reviewed. **customers.hub_view** adds Podium and Mailbox activity. **customers.hub_edit** receives customer-contact failure alerts and can update the customer profile. Source permissions still govern retries: **reviews.view** for review requests and **orders.lifecycle_manage** for ready messages.

---

## Overview

Customer Interactions is a unified communication control center. **All activity** combines recent Podium SMS, store email, and automated delivery records. The Text, Email, and Automated Queue tabs keep the existing source workspaces intact for replies, delivery review, and recovery.

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
| **Pending** | Waiting for its scheduled batch or awaiting final provider/carrier delivery confirmation |
| **Scheduled** | Assigned to specific send time (manual or batch) |
| **Sent** | Sent without an outstanding provider delivery failure or pending confirmation |
| **Skipped** | Marked to skip (will not be sent) |
| **Failed** | The initial send failed, or Podium accepted it and later reported a provider/carrier delivery failure |

## How to Use

### Review Pending Notifications

1. Open **Customer Interactions** from Operations or POS.
2. Use **Needs attention** for unread replies and failed delivery, or filter by SMS, Email, or Automated.
3. Select **Review queue** to focus the exact automated row, **Open thread** to continue a text/email conversation, or **Customer** to open the linked customer.
4. Unmatched senders remain visible and are not linked automatically.

### Resolve Failed Phone Or Email Delivery

1. Open the failed row and read the provider error. Provider code `P0005` means Podium accepted the SMS but a downstream carrier rejected it without a more specific reason.
2. Select **Update customer** and verify the saved phone or email with the customer.
3. Return to the failure and select **Retry delivery** when available. Review requests, receipts, and ready messages retry through their existing source workflows. Appointment messages retry automatically after the correction and backoff window.
4. A successful later delivery automatically archives the older failed attempt.
5. Use **Mark reviewed without retry** only when the customer was contacted another way or the message should not be resent.

Each new delivery failure also creates a durable Notification Center alert for staff with customer-edit access and the Customers/Loyalty notification preference enabled. The alert opens the affected customer profile so bad contact data is corrected before the next automation runs; a later successful delivery clears the resolved alert.

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
- **Customer Interactions** (automated-message delivery status and staff review)

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
| Podium SMS shows provider code `P0005` | Podium accepted the message, but downstream carrier delivery failed without a specific carrier reason | Verify the customer has a current SMS-capable mobile number and contact them another way; do not repeatedly retry an unverified number |

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

**Last reviewed:** 2026-08-16 (unified activity and contact-failure recovery updated)
