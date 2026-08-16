# Store Email and Mailbox

Riverside OS uses first-party store email for customer email communication. SMS remains handled through Podium.

## Mailbox

- Store address: `info@riversidemens.com`
- Settings location: Back Office -> Settings -> Email
- Operations location: Back Office -> Operations -> Mailbox
- POS location: POS -> Mailbox
- Customer location: Customer Hub -> Messages

Inbound email is pulled from the configured IMAP inbox. If the sender email matches a customer email address, Riverside records the message in both Operations Mailbox and that customer's Messages tab. If the sender is not recognized, the message remains in Operations Mailbox for staff follow-up.

Outbound email sent from Operations Mailbox or Customer Messages is sent through the configured SMTP account. When the recipient email matches a customer, Riverside also records that outbound message on the customer timeline.

The server also runs a background inbox sync. The default interval is 300 seconds and can be adjusted with `RIVERSIDE_EMAIL_SYNC_INTERVAL_SECS` (minimum 60 seconds). Manual **Sync inbox** remains available in Settings -> Email and Operations -> Mailbox.

The Mailbox navigation badge counts unread inbound `mailbox_messages` outside Trash, so it uses the same source state as the workspace. Each successful sync that inserts mail creates a fresh Notification Center alert; the client shows a short informational popup for newly observed alerts without replaying the existing inbox at sign-in.

### Staff workflow

Operations Mailbox uses a familiar three-pane mail layout: folders on the left, conversations in the middle, and the selected conversation on the right. The default folder is **Inbox**; **Important**, **Follow-up**, **Sent**, **Archived**, **Trash**, and **All mail** remain one click away. **New email** opens the composer only when staff needs it, preserving the message workspace for daily triage.

The primary mailbox request returns bounded message previews rather than every stored HTML body. The client loads the selected message through the permission-checked message-detail route, so large marketing emails do not delay the folder and conversation list. The **Unmatched** control filters the already-loaded list beside search and does not trigger another mailbox download.

- Opening an inbound conversation marks every unread message in that conversation read.
- **Mark unread** returns a conversation to follow-up state. Checkboxes support group **Read**, **Unread**, **Archive**, and **Delete** actions.
- **Archive** removes a conversation from Inbox without deleting its retained email record. **Restore** returns Archived or Trash conversations to Inbox.
- **Delete** is a recoverable move to **Trash**. Riverside does not permanently erase the stored email record from this staff action.
- **Reply**, **Forward**, **Important**, **Follow-up**, folder movement, and matched-customer access are available from the selected conversation.
- Formatted email is shown in a sandboxed viewer that blocks scripts, forms, embedded frames, and unsafe URLs. Links open separately, and staff can switch a multipart message to **plain text** when needed.

Mailbox actions apply to the complete Riverside conversation, not only the one expanded email row. This keeps a thread together when staff reads, archives, restores, or moves it.

## IONOS Settings

Default settings are seeded for IONOS email:

- IMAP host: `imap.ionos.com`
- IMAP port: `993`
- IMAP security: SSL/TLS
- SMTP host: `smtp.ionos.com`
- SMTP port: `465`
- SMTP security: SSL/TLS
- Alternate SMTP: port `587` with STARTTLS

Credentials are stored through Settings -> Email -> IONOS mailbox. Staff enter the mailbox email address and password once; Riverside saves that login for both IMAP and SMTP. The values are encrypted in the existing integration credential store. Environment fallbacks are also supported:

- `RIVERSIDE_EMAIL_IMAP_USERNAME`
- `RIVERSIDE_EMAIL_IMAP_PASSWORD`
- `RIVERSIDE_EMAIL_SMTP_USERNAME`
- `RIVERSIDE_EMAIL_SMTP_PASSWORD`

If SMTP credentials are not separately saved, Riverside uses the IMAP username and password for SMTP.

## Staff Signatures

Each logged-in staff member can save an email signature in Settings -> Email. Riverside appends that signature to email sent by that staff member from Customer Messages and Operations Mailbox.

## Automated Email

Automated customer email, including pickup and appointment notifications, uses the store email configuration. SMS notifications still use Podium where configured. Email sending requires:

- Email enabled in Settings -> Email
- SMTP credentials saved
- A valid customer email address
- The customer's operational email preference where that flow requires opt-in

## API Notes

The IONOS Cloud API is for IONOS cloud infrastructure management and is not used for normal mailbox send/receive. Riverside uses standard IMAP and SMTP for this integration.

## IMAP Dependency Policy

Riverside pins the Tokio-compatible Rust IMAP client to `async-imap = "=0.11.2"` in `server/Cargo.toml`. Keep mailbox dependency upgrades behind the focused send, health, sync, parsing, and message-state checks below.

Do not override only a transitive IMAP protocol parser. The client owns that parser API contract, so a piecemeal override can compile while breaking mailbox behavior.

Until the mailbox code is migrated behind a tested IMAP adapter, treat the warning as accepted dependency risk. A safe migration must validate:

- mailbox health check
- inbound inbox sync
- message body parsing
- customer matching
- mark read/archive behavior
- notification fan-out for new mail

The Settings health check validates both authenticated SMTP and authenticated IMAP access. **Sync Inbox Now** remains the final read-path check, and Receipt Builder **Send Test Email** is the final customer-delivery check.
