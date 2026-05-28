# Customer Notification Queue System

## Overview

The Customer Notification Queue system manages automated "Ready for Pickup" SMS/email notifications for orders and alterations. Messages are queued when items become ready and sent in batches at scheduled times (9:30 AM and 3:00 PM, Monday-Saturday) or immediately via staff override.

## Architecture

### Database Schema

**Table: `customer_notification_queue`**

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `entity_type` | TEXT | 'order' or 'alteration' |
| `entity_id` | UUID | Order or alteration ID |
| `customer_id` | UUID | Customer to notify |
| `kind` | TEXT | 'ready_for_pickup' |
| `status` | TEXT | 'pending', 'scheduled', 'sent', 'skipped', 'failed' |
| `scheduled_for` | TIMESTAMP | When to send (for scheduled batches) |
| `sent_at` | TIMESTAMP | When actually sent |
| `send_immediately` | BOOLEAN | Override flag for immediate send |
| `override_reason` | TEXT | Reason for immediate send |
| `delivery_method` | TEXT | 'sms', 'email', or 'both' |
| `delivery_status` | TEXT | 'pending', 'delivered', 'failed' |
| `delivery_error` | TEXT | Error message if failed |
| `metadata` | JSONB | Additional context |
| `created_at` | TIMESTAMP | Queue creation time |
| `updated_at` | TIMESTAMP | Last update time |
| `created_by_staff_id` | UUID | Staff who queued (if manual) |

### Database Functions

- `queue_order_ready_notification(transaction_id, customer_id, staff_id)` - Queue order notification
- `queue_alteration_ready_notification(alteration_id, customer_id, staff_id)` - Queue alteration notification
- `mark_notification_sent(notification_id, delivery_method, delivery_status, error)` - Mark as sent
- `schedule_pending_notifications(target_time)` - Schedule all pending for batch
- `get_notifications_to_send(current_time)` - Get due notifications
- `override_send_immediately(notification_id, reason, staff_id)` - Override for immediate send

## API Endpoints

### List Pending Notifications
```
GET /api/notifications/queue?status=pending&entity_type=order
```
- Requires: `orders.view` permission
- Query params: `status` (optional), `entity_type` (optional)
- Returns: Array of notification queue rows

### Send Notification Immediately (Override)
```
POST /api/notifications/queue/:id/send-now
Body: { "reason": "Customer requested urgent pickup" }
```
- Requires: `orders.lifecycle_manage` permission
- Bypasses schedule, sends immediately
- Marks notification with override reason

### Schedule Batch
```
POST /api/notifications/queue/schedule-batch
Body: { "target_time": "2026-05-28T15:00:00Z" }
```
- Requires: `orders.lifecycle_manage` permission
- Schedules all pending notifications for target time
- Returns count of scheduled notifications

### Skip Notification
```
POST /api/notifications/queue/:id/skip
```
- Requires: `orders.lifecycle_manage` permission
- Marks notification as 'skipped' (will not be sent)

## Scheduled Job System

**Schedule:**
- 9:30 AM Monday-Saturday
- 3:00 PM Monday-Saturday
- No notifications on Sunday

**Background Task:**
- Runs every minute to check if current time matches schedule
- Calls `process_due_notifications()` to send queued messages
- Logs all sends and failures

## Integration Points

### Order Lifecycle
When an order line is marked `ReadyForPickup`:
1. Staff notification sent via `emit_order_item_ready_for_pickup()`
2. Customer notification queued via `queue_order_ready_notification()`
3. Status: `pending` until scheduled or manual send

### Alteration Lifecycle
When an alteration is marked `ready`:
1. Customer notification queued via `queue_alteration_ready_notification()`
2. Status: `pending` until scheduled or manual send
3. No staff notification (different from orders)

### Podium Integration
- SMS sent via `podium::try_send_operational_sms()`
- Email sent via `store_email::try_send_operational_email()`
- All sends recorded to `podium_message` table (Customer Messages section)
- Comprehensive logging via `tracing` with target `notification_scheduler`

## Customer History

All sent messages appear in:
1. **Customer Messages section** (`podium_message` table) - SMS/email conversation history
2. **Notification queue status** - Track delivery status, errors, timestamps

## Staff Workflow

### Review Pending Notifications
1. Navigate to Notifications Queue (UI component - to be built)
2. Filter by status (pending, scheduled, sent, failed)
3. Filter by entity type (order, alteration)
4. Review customer details and message content

### Send Immediately
1. Click "Send Now" on pending notification
2. Provide reason (optional, for audit trail)
3. Notification sent immediately, bypassing schedule

### Skip Notification
1. Click "Skip" on pending notification
2. Mark as skipped (will not be sent)
3. Use when customer already notified or pickup completed

### Schedule Batch
1. Click "Schedule Batch" to schedule all pending
2. Target time defaults to next scheduled slot (9:30 AM or 3:00 PM)
3. Can override with custom time if needed

## Configuration

### Podium Settings
- Configure in Settings → Integrations → Podium
- Required: `client_id`, `client_secret`, `refresh_token`, `location_uid`
- SMS templates: `ready_for_pickup`, `alteration_ready`

### Email Settings
- Configure in Settings → Integrations → Email
- Required: SMTP server, credentials
- Email templates: `ready_for_pickup_subject`, `ready_for_pickup_html`

### Customer Opt-In
- SMS: `transactional_sms_opt_in` or `marketing_sms_opt_in`
- Email: `transactional_email_opt_in` or `marketing_email_opt_in`
- Messages only sent if customer has opted in

## Logging

All notification events logged with target `notification_scheduler`:
- `Processing scheduled notification` - When batch job processes notification
- `Sending order ready for pickup notification` - Order notification send
- `Sending alteration ready notification` - Alteration notification send
- `Sending notification immediately (override)` - Manual override send
- `Marking notification as sent` - Delivery status update
- Errors logged with delivery error details

## Troubleshooting

### Notifications Not Sending
1. Check Podium configuration (API credentials, location UID)
2. Verify customer opt-in settings
3. Check notification queue status (pending vs scheduled)
4. Review logs for delivery errors
5. Verify phone number normalization (E.164 format)

### Notifications Sent at Wrong Time
1. Check system timezone
2. Verify scheduled job is running
3. Review `scheduled_for` timestamp in queue
4. Check for manual override flags

### Duplicate Notifications
1. Check unique constraint on `(entity_type, entity_id, kind, status)`
2. Verify queue functions use `ON CONFLICT DO NOTHING`
3. Review manual queue operations

## Migration

Apply migration `053_customer_notification_queue.sql`:
```bash
psql -U riverside -d riverside -f migrations/053_customer_notification_queue.sql
```

Record in migration ledger:
```sql
INSERT INTO migration_ledger (migration_name, applied_at, applied_by)
VALUES ('053_customer_notification_queue.sql', NOW(), 'manual');
```

## Future Enhancements

- Order-alteration dependency: Only queue order notifications when linked alterations are complete
- Frontend UI component for notification queue management
- Customer notification preferences per channel
- Notification retry logic for failed sends
- Bulk send operations for multiple notifications
