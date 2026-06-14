# Counterpoint SYNC Workbench

Main Hub staging service for the Counterpoint transition.

The Workbench receives raw batches from the Counterpoint Bridge, stores source payloads and provenance, tracks run/section readiness, and exposes ROS-compatible JSON packages. It does not connect to ROS PostgreSQL and it does not perform final imports.

## Run

```bash
cd counterpoint-sync
cp env.example .env
npm start
```

The Workbench requires Node with built-in `node:sqlite` support. Use Node 22.5+; current development validation used Node 25.

Use the same `COUNTERPOINT_SYNC_WORKBENCH_TOKEN` in:

- Counterpoint Bridge: `COUNTERPOINT_SYNC_WORKBENCH_TOKEN`
- ROS Back Office integration credentials: Counterpoint SYNC Workbench token

Open the local review UI at:

```text
http://127.0.0.1:3015/
```

The UI is a local operational dashboard for the Main Hub PC. It shows Workbench health, local store path, backup status, latest Bridge heartbeat, runs, section readiness, warnings, blockers, imported status, package previews, exceptions, and an AI Review placeholder. The AI Review panel is non-mutating; no records are changed automatically.

## No-hardware rehearsal simulator

From the repo root, start the Workbench and then run:

```bash
npm run dev:sync-workbench
npm run sync:simulate-counterpoint
```

The simulator posts deterministic, simulation-only Bridge heartbeat and batch payloads into the Workbench. It covers vendors, customers, catalog, inventory, and gift cards with:

- duplicate customer email warning
- missing customer email warning
- odd customer phone warning
- catalog row missing barcode warning
- inventory row referencing a missing catalog item blocker
- vendor missing optional contact warning
- simulation-only gift-card warning

It never writes to ROS. ROS writes happen only when an operator selects the simulated run in Back Office, runs ROS preflight for a section, confirms import, and the ROS backend imports through the existing Counterpoint pipeline. Do not import simulation packages against production ROS unless you are intentionally testing in a safe production-like environment.

Clear only simulator-generated SYNC data with:

```bash
npm run sync:clear-simulation
```

The cleanup command removes the deterministic simulator run and simulator heartbeat rows from the local Workbench JSON store, writes a `.bak` first, and leaves real Bridge/Counterpoint runs untouched. Use `cd counterpoint-sync && npm run clear:simulation -- --dry-run` to preview what would be removed.

## API

- `GET /health`
- `GET /api/runs`
- `GET /api/runs/:run_id`
- `GET /api/runs/:run_id/sections`
- `GET /api/runs/:run_id/exceptions`
- `GET /api/runs/:run_id/provenance`
- `GET /api/runs/:run_id/packages`
- `GET /api/runs/:run_id/packages/:section`
- `POST /api/runs/:run_id/sections/:section/mark-ready`
- `POST /api/runs/:run_id/sections/:section/mark-blocked`
- `POST /api/runs/:run_id/sections/:section/mark-imported`
- `POST /api/runs/:run_id/finalize`
- `POST /api/bridge/heartbeat`
- `POST /api/bridge/batches`
- `POST /api/csv/lightspeed/import`
- `POST /api/csv/counterpoint/import`
- `GET /api/export`

CSV endpoints are for input/review/debug staging only. ROS handoff uses the package JSON endpoints.

## Local Store

The default store is SQLite at `counterpoint-sync/data/sync-workbench-store.sqlite`. Configure it with:

```env
COUNTERPOINT_SYNC_WORKBENCH_DB=./data/sync-workbench-store.sqlite
```

The previous JSON store path remains as migration input:

```env
COUNTERPOINT_SYNC_WORKBENCH_STORE=./data/sync-workbench-store.json
```

On first SQLite startup, if the JSON store exists and the SQLite database does not, the Workbench imports the JSON data into SQLite and preserves the original JSON file. It does not delete the JSON store automatically.

The SQLite schema stores runs, sections, source batches, prepared packages, exceptions, provenance, AI review packages, AI suggestions, review decisions, status events, and Bridge heartbeats. The external SYNC API and SYNC-to-ROS JSON package contract remain stable.

Before each SQLite rewrite, the previous database file is copied to `sync-workbench-store.sqlite.bak`. `GET /health` reports store type, path, whether the main store and backup exist, last write time, size, format version, migration status, latest Bridge heartbeat, and run/section summary counts.

Use `GET /api/export` with the Workbench token to capture a portable backup before rehearsal or go-live import. The export includes `schema_version`, `exported_at`, `store_path`, and the complete store payload.

The export remains JSON so it can be copied, backed up, and reviewed with Codex/ChatGPT without giving the AI database access.

## Package fingerprints

Package fingerprints are generated from stable package content: section, entity, schema version, source counts, payload, and non-volatile exception/provenance fields. Volatile metadata such as generated timestamps and run-specific timestamps are excluded. `generated_at` remains unchanged when package content is unchanged.

ROS imports require a preflight already recorded for the selected `sync_run_id`, section, and package fingerprint. If package content changes after preflight, ROS refuses import until preflight is run again.

## AI/Codex review workflow

AI review is review-first and non-mutating until a human accepts suggestions.

1. Open the Workbench UI.
2. Select a run and section.
3. Click **Export AI Review Package**.
4. Paste/upload the JSON package into Codex or ChatGPT with the prompt below.
5. Paste the returned suggestion JSON into **Import AI Suggestions**.
6. Review each suggestion and choose **Accept**, **Reject**, or **Manual review**.
7. Click **Apply Accepted Suggestions** for the section.
8. Preview the regenerated package and run ROS preflight again before import.

Accepted suggestions update prepared/normalized SYNC data only. Raw source payloads and provenance remain unchanged. Applying accepted suggestions changes the package fingerprint when package content changes, which makes any previous ROS preflight stale.

High-risk sections such as gift cards, store credit, historical tickets, open docs, and loyalty history are manual-review only. AI may summarize issues but must not mutate balances, tenders, dates, tax, payments, refunds, gift-card amounts, store-credit amounts, quantities, costs, or accounting mappings.

### AI suggestion schema

```json
{
  "review_package_id": "uuid",
  "sync_run_id": "uuid",
  "section": "catalog",
  "package_fingerprint": "abc123",
  "suggestions": [
    {
      "suggestion_type": "description_readability",
      "source_record_id": "ITEM-123",
      "target_path": "payload.rows[0].description",
      "current_value": "BLU SLD SHT",
      "suggested_value": "Blue Solid Shirt",
      "reason": "Expanded abbreviations for staff-readable product description.",
      "confidence": "medium",
      "risk_level": "low"
    }
  ]
}
```

Suggestions are rejected when run, section, review package, or package fingerprint do not match; required fields are missing; the suggestion type is unsupported; the target path is not allowed for that section; or risk/confidence values are unsupported.

### Paste-ready Codex/ChatGPT prompt

```text
Analyze this Counterpoint SYNC AI review package for Riverside OS.

Return only valid JSON using the package's allowed_suggestion_schema.
Preserve review_package_id, sync_run_id, section, package_fingerprint, and source_record_id.
Mark confidence and risk_level for every suggestion.
Do not invent costs, quantities, balances, emails, tax values, payment values, refund values, or accounting mappings.
Do not auto-merge customers or vendors.
Do not change gift card, store credit, tax, tender, payment, refund, historical ticket, open-doc, loyalty, quantity, balance, or accounting values.
For high-risk sections, return manual-review suggestions only.
Do not say changes were applied. Riverside OS staff will review and accept/reject suggestions in SYNC.
```
