# Counterpoint Transition Review Packs

Counterpoint Transition Review Packs are a manual export/import workflow for reviewing Counterpoint migration data with ChatGPT or Codex outside the Riverside OS runtime.

Riverside OS does not call OpenAI, ChatGPT, Codex, or any hosted AI service for this workflow. Staff generate a structured JSON pack, review it manually in the external tool of their choice, then import the returned JSON suggestions back into ROS for validation and Staff Access review.

## What Review Packs Do

Review packs help staff clean up and verify Counterpoint transition data while preserving financial and audit integrity.

Supported scopes:

- `inventory_catalog`
- `customer_dedupe`
- `ticket_financial`
- `tender_mapping`
- `gift_card_liability`
- `open_orders_layaways`
- `returns_readiness`
- `cutover_audit`

Fully implemented first-pass scopes:

- `inventory_catalog`: product naming/category review using ROS catalog, Counterpoint CSV reference, Lightspeed reference, and quarantine evidence.
- `ticket_financial`: historical ticket reconciliation flags. AI may flag issues only.
- `returns_readiness`: historical Counterpoint purchase-line readiness for returns/exchanges.

The remaining scopes generate summary/check rows and stage validated review suggestions, but their apply behavior is intentionally blocked until explicit safe domain logic exists.

## Staff Workflow

1. Open **Settings -> Integrations -> Counterpoint**.
2. In **Counterpoint Transition Review Packs**, choose a scope.
3. Click **Generate Pack**.
4. Download the JSON pack.
5. Copy the generated prompt and submit the prompt plus JSON pack manually to ChatGPT/Codex.
6. Save the returned JSON result.
7. Import the returned JSON into Riverside OS.
8. Review each staged suggestion and mark it accepted, rejected, edited, or blocked.
9. Apply approved suggestions only where the UI enables safe apply.

Invalid imports are rejected and logged. Accepted suggestions do not apply automatically.

## Safety Model

Riverside OS is the validator and source of truth. AI output is treated as untrusted operator input.

The import validator rejects or blocks suggestions when:

- the result schema is wrong
- the source pack ID is unknown
- the source hash does not match
- the scope is unknown or does not match the pack
- the row key was not in the original pack
- the action is not allowed for that row
- a forbidden field is referenced
- confidence is missing or outside `0..1`
- reason is missing
- suggested categories or merge targets do not exist where validation is possible

## Forbidden AI-Controlled Fields

AI suggestions may not change:

- historical ticket totals
- line subtotals
- discount amounts
- tax amounts
- tender/payment amounts
- gift card balances
- store credit balances
- customer balances
- deposit amounts
- quantity on hand
- inventory unit costs
- freight cost
- COGS
- booked dates or business dates
- fulfillment dates
- original Counterpoint ticket numbers
- original Counterpoint item keys
- original Counterpoint customer codes
- original payment/tender transaction IDs
- QBO or accounting mappings

## Apply Behavior

Safe apply currently supports only accepted `inventory_catalog` suggestions for:

- product name/display-name cleanup
- category assignment when the suggested Riverside OS category already exists

Safe apply records product catalog audit rows. It blocks all high-risk scopes and all financial, tender, gift card, tax, cost, quantity, date, Counterpoint ID, customer merge, and accounting changes.

## Returns/Exchanges Readiness

The `returns_readiness` scope exports historical Counterpoint ticket-line evidence needed to find old purchases during return/exchange workflows:

- original Counterpoint ticket number
- original business date
- original Counterpoint line/item evidence
- resolved ROS product/variant IDs where present
- original SKU/barcode and item description
- original price, discount, tax, and tender summary
- quantity purchased and quantity already returned
- detected readiness issues

Suggestions from this scope are staged for review only. Riverside OS preserves original Counterpoint ticket and line identity.

## Recommended Cutover Order

Before cutover, generate and review packs in this order:

1. `inventory_catalog`
2. `ticket_financial`
3. `returns_readiness`
4. `tender_mapping`
5. `gift_card_liability`
6. `open_orders_layaways`
7. `customer_dedupe`
8. `cutover_audit`

Treat `cutover_audit` warnings as a final review aid, not as an approval signal. Operational sign-off still depends on deterministic Counterpoint landing verification, staging queues, sync issues, and accounting review.

## API Surface

All endpoints are Staff Access gated under:

`/api/settings/counterpoint-sync/review-packs`

Routes:

- `GET /scopes`
- `POST /generate`
- `GET /`
- `GET /{pack_id}`
- `GET /{pack_id}/download.json`
- `GET /{pack_id}/prompt.txt`
- `POST /import-results`
- `GET /{pack_id}/suggestions`
- `PATCH /suggestions/{suggestion_id}`
- `POST /{pack_id}/apply-approved`

No public HTTP endpoints are added.
