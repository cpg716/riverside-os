# Store Email and Mailbox

Riverside OS uses first-party store email for customer email communication. SMS remains handled through Podium.

## Mailbox

- Store address: `info@riversidemens.com`
- Settings location: Back Office -> Settings -> Email
- Operations location: Back Office -> Operations -> Mailbox
- Customer location: Customer Hub -> Messages

Inbound email is pulled from the configured IMAP inbox. If the sender email matches a customer email address, Riverside records the message in both Operations Mailbox and that customer's Messages tab. If the sender is not recognized, the message remains in Operations Mailbox for staff follow-up.

Outbound email sent from Operations Mailbox or Customer Messages is sent through the configured SMTP account. When the recipient email matches a customer, Riverside also records that outbound message on the customer timeline.

The server also runs a background inbox sync. The default interval is 300 seconds and can be adjusted with `RIVERSIDE_EMAIL_SYNC_INTERVAL_SECS` (minimum 60 seconds). Manual **Sync inbox** remains available in Settings -> Email and Operations -> Mailbox.

## IONOS Settings

Default settings are seeded for IONOS email:

- IMAP host: `imap.ionos.com`
- IMAP port: `993`
- IMAP security: SSL/TLS
- SMTP host: `smtp.ionos.com`
- SMTP port: `465`
- SMTP security: SSL/TLS
- Alternate SMTP: port `587` with STARTTLS

Credentials are stored through Settings -> Email -> IONOS email credentials. They are encrypted in the existing integration credential store. Environment fallbacks are also supported:

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

Riverside intentionally pins the Rust IMAP client to `imap = "=2.4.1"` in `server/Cargo.toml`. That version currently pulls `imap-proto v0.10.2`, which may emit a Rust future-compatibility warning during `cargo check`.

Do not override only the transitive `imap-proto` crate. The `imap` client owns that protocol-parser API contract, and forcing a newer parser without replacing the IMAP client has previously caused compatibility failures.

Until the mailbox code is migrated behind a tested IMAP adapter, treat the warning as accepted dependency risk. A safe migration must validate:

- mailbox health check
- inbound inbox sync
- message body parsing
- customer matching
- mark read/archive behavior
- notification fan-out for new mail

Preferred future path: move IMAP access behind a small internal mailbox adapter, then test either a stable `imap` release or `async-imap` with Tokio support. Do not switch to `imap 3.x` while it remains alpha unless the full mailbox validation suite passes.
