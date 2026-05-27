# Constant Contact Integration

Riverside OS supports a direct, secure integration with **Constant Contact (v3 API)**. 

This integration supports:
1. **Outbound Customer Sync**: Synchronizes opted-in customers (`marketing_email_opt_in == true`) to a default mailing list.
2. **Dynamic Segments/Tags Mapping**: Allows mapping specific customer tags (like VIP status or customer group codes) to separate Constant Contact mailing lists.
3. **Timeline Event Ingestion**: Webhook ingestion logs email delivery events (sent, bounced, opened, clicked, unsubscribed) directly on the customer timeline.

---

## 1. Authentication & OAuth 2.0 Flow

Constant Contact uses OAuth 2.0 with the Authorization Code Flow. 

### Security & Storage
* All keys and tokens (`client_id`, `client_secret`, `access_token`, `refresh_token`, and list mapping configs) are stored encrypted at rest in the `integration_credentials` database table.
* On the server side, values are encrypted/decrypted transparently using ChaCha20-Poly1305 with the key `RIVERSIDE_CREDENTIALS_KEY`.
* System credentials fall back to the environment variables `RIVERSIDE_CC_CLIENT_ID`, `RIVERSIDE_CC_CLIENT_SECRET`, `RIVERSIDE_CC_ACCESS_TOKEN`, and `RIVERSIDE_CC_REFRESH_TOKEN` on startup if they are not saved in the database.

### Dynamic Token Refresh
* Tokens have limited lifetimes. Riverside OS automatically inspects the token expiration date (`token_expires_at`) before every sync or API call.
* If a token is within 10 minutes of expiration, it automatically performs a token refresh request via:
  `POST https://authz.constantcontact.com/oauth2/default/v1/token`
* The new tokens are automatically encrypted and saved back to the database.

---

## 2. API Configurations & Mappings

### Target List IDs
* **Default List ID**: In settings, select the default target list. All customers with a valid email and `marketing_email_opt_in = true` are pushed to this list.
* **Conditional Segment Lists**: Map customer tags or groups to specific list IDs.
  * Tag `VIP` -> mapped to a custom list ID.
  * Customer group codes (e.g. `Bridal`, `Staff`) -> mapped to separate list IDs.
  * In the sync job, customers who have matching tags or groups are automatically uploaded to those lists in addition to the default list.

---

## 3. Contact Sync Job Logic

The synchronization runs on-demand or as part of background tasks:
1. Riverside OS queries all opted-in customers from the database, including group membership codes.
2. Contacts are batched by target lists.
3. The sync uses the high-performance **bulk activity imports** API:
   `POST https://api.cc.email/v3/activities/contact_imports`
4. This performs an asynchronous batch upsert (import and update) on the Constant Contact servers, processing up to 40,000 contacts per request.
5. Stats and outcomes are logged to the `constant_contact_sync_logs` table and displayed on the Settings history table.

---

## 4. Webhooks Ingestion & Timeline logging

Constant Contact dispatches webhook payloads to capture real-time email delivery events:
* **Receiver Endpoint**: `POST /api/settings/constant-contact/webhooks/receive`
* Supported Event Types:
  * `campaign.delivery.send` / `sent` -> logs message send event
  * `campaign.delivery.bounce` / `bounced` -> logs email bounce event
  * `contact.optout` / `unsubscribed` -> logs marketing opt-out event
  * `campaign.activity.open` / `opened` -> logs email opened event
  * `campaign.activity.click` / `clicked` -> logs email link click event

When an event is received:
1. The server extracts the recipient email.
2. Looks up the customer in the database:
   `SELECT id FROM customers WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`
3. Inserts the normalized event into `customer_marketing_email_event`.
4. The timeline builder resolves these records and outputs them on the customer relationship timeline as `[Constant Contact] Email sent for campaign "..."`.

---

## 5. Troubleshooting Reference

### Token Exchange Fails
* Verify your Client ID and Client Secret in the Settings Credentials card.
* Confirm that your Constant Contact developer application has the correct redirect URI registered:
  `http://<SERVER-IP>:3000/api/settings/constant-contact/oauth/callback`

### Webhook Events Not Appearing
* Ensure the webhook receiver URL is entered correctly in the Constant Contact portal.
* Verify the webhook secret, and check the server console logs for `Constant Contact client error` trace messages.
