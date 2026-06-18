# Counterpoint SYNC Workbench

Standalone staging service for the Counterpoint transition.

The Workbench receives raw batches from the Counterpoint Bridge, stores source payloads and provenance, tracks run/section readiness, and exposes ROS-compatible JSON packages. It does not connect to ROS PostgreSQL and it does not perform final imports.

## Run

Packaged Windows deployment for the computer running the standalone SYNC app:

```text
Start-CounterpointSYNCWorkbench.cmd
```

The deployment ZIP includes this Workbench under `counterpoint-sync-workbench\`, a bundled `node-runtime\node.exe`, and the launcher at the package root. The launcher creates `.env` from `env.example` on first run, starts the Workbench API, verifies that `http://127.0.0.1:3015/api/bridge/health` returns Counterpoint SYNC JSON, stores data under `counterpoint-sync-workbench\data\`, listens on this computer's LAN, and opens `http://127.0.0.1:3015/` locally on the SYNC app computer.

Repo/dev run:

```bash
cd counterpoint-sync
cp env.example .env
npm start
```

The Workbench requires Node with built-in `node:sqlite` support. Use Node 22.5+; current development validation used Node 25.

The normal closed-store workflow does not require a Workbench token. Configure the Workbench URL in the Bridge and ROS Back Office. `COUNTERPOINT_SYNC_WORKBENCH_TOKEN` is optional; only set it if you deliberately want the local Workbench API to reject unauthenticated LAN requests.

Open the local review UI on the computer running the standalone SYNC app at:

```text
http://127.0.0.1:3015/
```

From the Counterpoint PC, the Bridge must use the standalone SYNC app computer's LAN URL. For example:

```text
http://10.64.70.196:3015/
```

`127.0.0.1` always means the same machine you are typing on. In the Bridge GUI, `127.0.0.1:3015` means the Counterpoint PC, so it will fail unless the SYNC Workbench is also running on that same Counterpoint PC.

If `/api/bridge/health` returns a page that starts with `<!doctype html>` instead of JSON, the Bridge is reaching a static UI/dev server or the wrong service on port `3015`. Stop that service and start `Start-CounterpointSYNCWorkbench.cmd` from the deployment package so the API owns the port.

The UI is the local preparation workbench for the computer running the standalone SYNC app. It shows the Bridge heartbeat, local store path, backup status, runs, section readiness, warnings, blockers, imported status, package previews, exceptions, inventory CSV inputs, and AI review controls. Operators can import the one Lightspeed inventory CSV and one Counterpoint inventory CSV as product/SKU/item-number/variation cleanup references, preview ROS-ready JSON packages, mark sections ready, or block sections that still need cleanup. Inventory quantities come from Counterpoint SQL unless SQL has no usable value. The AI Review panel is non-mutating until a human accepts suggestions; no records are changed automatically.

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
- `GET /api/bridge/health`
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

CSV endpoints are for the two inventory cleanup/reference files only: Lightspeed inventory export and Counterpoint inventory export. ROS handoff uses the package JSON endpoints, not CSV files.

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

Use `GET /api/export` to capture a portable backup before rehearsal or go-live import. The export includes `schema_version`, `exported_at`, `store_path`, and the complete store payload.

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
