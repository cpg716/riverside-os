# Podium Messaging & Reviews

## Role: All Staff / Admins
### Purpose: Unified customer communication (SMS, Email, and Web Chat).

Riverside OS integrates with Podium to centralize customer interactions within the Relationship Hub and automate logistical notifications.

---

## Messaging from the Relationship Hub

1. **Find Customer**: Search in **Customers** and open the **Relationship Hub**.
2. **Messages Tab**:
   - View the full thread history of SMS and Email.
   - **Send SMS**: Instant text delivery to the customer's mobile number.
   - **Send Email**: Requires a Subject Line and supports HTML body text.
3. **Receipts**: In the POS Checkout summary, choose **Email Receipt** or **Text Receipt** to trigger an automated digital record.

---

## The Operations Inbox

Navigate to **Operations** > **Inbox** to see a unified stream of recent conversations. 
- Clicking a message opens the customer's profile.
- Unread messages are marked with a notification pulse on the **Action Board**.

---

## Automated Notifications

Admins can configure automated triggers in **Settings** > **Integrations** > **Podium**:
- **Pickup Ready**: Auto-fired when an order is marked as "Inventory Ready".
- **Alteration Milestone**: Auto-fired when a tailor updates a garment status.
- **Review Invite**: Triggered post-checkout to solicit feedback.

---

## Admin: Connection Health

If messaging fails, check the **Integrations Card** for:
- **Location UID**: Must match your store's Podium ID.
- **Credentials Status**: Displays "Ready" if the OAuth token is active.
- **Send Toggles**: Ensure "Operational SMS" is active for notifications to flow.

---

## Troubleshooting

| Symptom | Cause |
| :--- | :--- |
| **"Failed to Send"** | Likely a missing phone/email on the profile or an expired Podium token. |
| **No "Messages" Tab** | You lack the `customers.hub_edit` permission. |
| **Silent Notifications** | Webhooks may be misconfigured or the customer has opted out of marketing. |

> [!IMPORTANT]
> Never share Podium API secrets or signing keys in bug reports. These are sensitive credentials managed by IT.
